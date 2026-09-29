/* suki server — static files + FFMPEG render API.
   GET  anything                -> static file from this directory
   POST /api/render/audio       -> custom soundtrack bytes (mp3/ogg/wav/m4a/flac)
   POST /api/render/begin       -> body = .midi bytes; x-suki-render header =
                                   base64 JSON {W,H,fps,crf,src,speed,hz,vp,total}
                                   (src: program|custom|off). program renders the
                                   soundtrack offline via the real worklet first.
   POST /api/frame?n=i          -> one PNG frame, piped into ffmpeg stdin
   POST /api/render/end         -> close pipe, wait encoder, move to renders/
   POST /api/render/cancel      -> kill encoder, clean up
   GET  /api/render/status      -> {active,frames,total,done,out,ffmpeg}     */
const http = require('http'), fs = require('fs'), path = require('path'),
      os = require('os'), { execFile, spawn, spawnSync } = require('child_process');
const ROOT = __dirname;
const PORT = +process.env.PORT || 8123, HOST = process.env.HOST || '0.0.0.0';
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'suki-r-'));
const RENDERS = path.join(ROOT, 'renders');
try { fs.mkdirSync(RENDERS); } catch (e) {}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.mid': 'audio/midi', '.midi': 'audio/midi',
  '.png': 'image/png', '.wasm': 'application/wasm', '.bat': 'text/plain',
  '.md': 'text/plain', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac',
  '.opus': 'audio/ogg', '.ico': 'image/x-icon'
};
let ffmpegOk = false;                        // OPTIONAL since R47: only the legacy fallback render needs it
try { ffmpegOk = spawnSync(FFMPEG, ['-version'], { timeout: 8000 }).status === 0; } catch (e) {}
let job = null, lastAudio = null;
process.on('uncaughtException', (e) => {              // a bad job must never kill the server
  console.error('uncaught:', e && e.message);
  try { if (job) { job.done = true; cleanupJob(); } } catch (e2) {}
});

function audioExt(b) {
  if (b.length > 4 && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return '.ogg';
  if (b.length > 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return '.mp3';
  if (b.length > 2 && b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61) return '.flac';
  if (b.length > 11 && b.toString('ascii', 4, 8) === 'ftyp') return '.m4a';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF') return b.toString('ascii', 8, 12) === 'WAVE' ? '.wav' : null;
  if (b.length > 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return '.mp3';
  return null;
}
function readBody(req, cb) {
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => cb(Buffer.concat(parts)));
  req.on('error', () => cb(Buffer.alloc(0)));
}
function jres(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(s);
}
let seenBrowser = false;
function serveStatic(req, res, u) {
  if (!seenBrowser && (u === '/' || u.startsWith('/index'))) {
    seenBrowser = true;
    console.log('  browser connected \u2713  \u2014  suki is live, drop a .midi or hit RENDER');
  }
  let p;
  try { p = decodeURIComponent(u.split('?')[0]); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/') p = '/index.html';
  const fp = path.normalize(path.join(ROOT, p));
  if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (e, buf) => {
    if (e) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}
function cleanupJob() {
  if (!job) return;
  try { job.proc.kill('SIGKILL'); } catch (e) {}
  try { fs.unlinkSync(job.outTmp); } catch (e) {}
  job = null;
}
function beginRender(req, res, body) {
  if (job && !job.done) return jres(res, 409, { ok: false, err: 'a render is already running' });
  job = null;
  let cfg = null;
  try { cfg = JSON.parse(Buffer.from(req.headers['x-suki-render'] || '', 'base64').toString('utf8')); } catch (e) {}
  if (!cfg || !cfg.W || !cfg.H || !cfg.fps || !cfg.total) return jres(res, 400, { ok: false, err: 'bad render header' });
  if (!ffmpegOk) return jres(res, 500, { ok: false, err: 'ffmpeg not found on PATH — install ffmpeg or set FFMPEG_BIN' });
  const midPath = path.join(TMP, 'mid.mid');
  fs.writeFileSync(midPath, body);
  const startFfmpeg = (audioPath) => {
    const outTmp = path.join(RENDERS, '.part-' + Date.now() + '.mp4');   // same device as final rename
    const args = ['-y', '-f', 'image2pipe', '-framerate', String(cfg.fps), '-i', 'pipe:0'];
    if (audioPath) args.push('-i', audioPath);
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(cfg.crf || 23), '-pix_fmt', 'yuv420p');
    if (audioPath) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
    else args.push('-an');
    args.push(outTmp);
    const proc = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    proc.stdin.on('error', () => {});   // dead encoder must not crash the server
    proc.on('error', () => {});
    let errTail = '';
    proc.stderr.on('data', (d) => { errTail = (errTail + d).slice(-800); });
    const exitP = new Promise((rj) => proc.on('close', (code, sig) => rj({ code, sig, errTail })));
    job = { proc, exitP, frames: 0, total: cfg.total, outTmp, done: false, cfg };
    jres(res, 200, { ok: true, total: cfg.total });
  };
  const fail = (m) => jres(res, 400, { ok: false, err: m });
  if (cfg.src === 'custom') {
    if (!lastAudio) return fail('no custom audio uploaded — pick LOAD AUDIO first');
    const ext = audioExt(lastAudio) || '.bin';
    const ap = path.join(TMP, 'audio' + ext);
    fs.writeFileSync(ap, lastAudio);
    startFfmpeg(ap);
  } else if (cfg.src === 'program') {
    const jobJson = path.join(TMP, 'oa.json');
    fs.writeFileSync(jobJson, JSON.stringify({ midi: midPath, out: path.join(TMP, 'prog.wav'), speed: cfg.speed || 1, hz: cfg.hz || 48000, vp: cfg.vp || 128, tail: 3, fx: cfg.fx }));
    const c = spawn(process.execPath, [path.join(ROOT, 'offline_audio.js'), jobJson], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errTail = '';
    c.stderr.on('data', (d) => { errTail = (errTail + d).slice(-600); });
    c.on('close', (code) => {
      if (code !== 0) return fail('offline audio render failed: ' + errTail.trim().split('\n').pop());
      startFfmpeg(path.join(TMP, 'prog.wav'));
    });
    c.on('error', (e) => fail('cannot spawn offline renderer: ' + e.message));
  } else startFfmpeg(null);
}
const server = http.createServer((req, res) => {
  const u = req.url || '/';
  if (req.method === 'GET') {
    if (u.startsWith('/api/render/status')) {
      return jres(res, 200, { active: !!job && !job.done, frames: job ? job.frames : 0, total: job ? job.total : 0, done: job ? job.done : false, ffmpeg: ffmpegOk, renders: fs.readdirSync(RENDERS).length });
    }
    return serveStatic(req, res, u);
  }
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  if (u.startsWith('/api/render/audio')) {
    return readBody(req, (b) => { if (!b.length) return jres(res, 400, { ok: false, err: 'empty body' }); lastAudio = b; jres(res, 200, { ok: true, bytes: b.length }); });
  }
  if (u.startsWith('/api/render/begin')) return readBody(req, (b) => beginRender(req, res, b));
  if (u.startsWith('/api/render/wav')) {           // soundtrack-only render -> WAV download
    let acfg = null;
    try { acfg = JSON.parse(Buffer.from(req.headers['x-suki-audio'] || '', 'base64').toString('utf8')); } catch (e) {}
    return readBody(req, (b) => {
      if (!b.length) return jres(res, 400, { ok: false, err: 'empty body' });
      const mp = path.join(TMP, 'mid-wav.mid'), op = path.join(TMP, 'prog-wav.wav');
      fs.writeFileSync(mp, b);
      fs.writeFileSync(path.join(TMP, 'oa-wav.json'), JSON.stringify({ midi: mp, out: op, speed: (acfg && acfg.speed) || 1, hz: (acfg && acfg.hz) || 0, vp: (acfg && acfg.vp) || 128, tail: 3 }));
      const c = spawn(process.execPath, [path.join(ROOT, 'offline_audio.js'), path.join(TMP, 'oa-wav.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
      let errTail = '';
      c.stderr.on('data', (d) => { errTail = (errTail + d).slice(-600); });
      c.on('error', () => jres(res, 500, { ok: false, err: 'cannot spawn renderer' }));
      c.on('close', (code) => {
        if (code !== 0) return jres(res, 500, { ok: false, err: 'audio render failed: ' + errTail.trim().split('\n').pop() });
        let wav; try { wav = fs.readFileSync(op); } catch (e2) { return jres(res, 500, { ok: false, err: 'wav missing' }); }
        try { fs.unlinkSync(op); } catch (e2) {}
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Disposition': 'attachment; filename="suki-audio.wav"', 'Content-Length': wav.length, 'Cache-Control': 'no-store' });
        res.end(wav);
      });
    });
  }
  if (u.startsWith('/api/frame')) {
    if (!job || job.done) return jres(res, 409, { ok: false, err: 'no active render' });
    return readBody(req, (b) => {
      job.proc.stdin.write(b, (e) => {
        if (e) return jres(res, 500, { ok: false, err: 'encoder died' });
        job.frames++;
        jres(res, 200, { ok: true });
      });
    });
  }
  if (u.startsWith('/api/render/end')) {
    if (!job || job.done) return jres(res, 409, { ok: false, err: 'no active render' });
    job.proc.stdin.end();
    return job.exitP.then(({ code, errTail }) => {
      if (code !== 0) { const e = 'ffmpeg exited ' + code + ': ' + (errTail.trim().split('\n').pop() || ''); try { fs.unlinkSync(job.outTmp); } catch (e2) {} job.done = true; job = null; return jres(res, 500, { ok: false, err: e }); }
      const d = new Date(), z = (n) => (n < 10 ? '0' : '') + n;
      let name = 'suki-' + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds()) + '.mp4';
      let out = path.join(RENDERS, name);
      let k = 1; while (fs.existsSync(out)) { name = name.replace(/(\d+)\.mp4$/, (m, n) => (+n + 1) + '.mp4'); out = path.join(RENDERS, name); if (++k > 500) break; }
      fs.renameSync(job.outTmp, out);
      const wasProgram = job.cfg && job.cfg.src === 'program';
      let audio = null;
      if (wasProgram) {                                // save the soundtrack file too
        try { const base = name.replace(/\.mp4$/, '.wav'); fs.copyFileSync(path.join(TMP, 'prog.wav'), path.join(RENDERS, base)); audio = 'renders/' + base; } catch (eWav) {}
      }
      const frames = job.frames; job.done = true; job = null;
      jres(res, 200, { ok: true, out: 'renders/' + name, audio, frames });
    });
  }
  if (u.startsWith('/api/render/cancel')) {
    if (job) cleanupJob();
    return jres(res, 200, { ok: true });
  }
  res.writeHead(404); res.end();
});
server.listen(PORT, HOST, () => {
  const url = 'http://localhost:' + PORT;
  console.log('suki server on ' + HOST + ':' + PORT + '\n' +
    (ffmpegOk ? '  ffmpeg: found (legacy fallback renderer ready).' :
                '  ffmpeg: not found \u2014 NOT NEEDED. RENDER works in your browser (WebCodecs).\n' +
                '  (ffmpeg is only used by the legacy server-render fallback.)'));
  console.log('  opening ' + url + ' \u2026 (set SUKI_NO_OPEN=1 to disable)');
  if (!process.env.SUKI_NO_OPEN) {
    try {
      if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    } catch (e) {}
  }
});
