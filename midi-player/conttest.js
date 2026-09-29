/* R62g/R62h continuity harness: REPRODUCE + regression-test the disappearing-notes bug under
   real conditions — live audio-clock playback (ST.live), REAL worker, drawGL path (GL stub
   records every instance rect), per-note identity oracle, 1200-frame walks.
   Phase 1: RAM path. Phase 2: same file stubbed to 300MB -> virtual streaming path.
   Also /tmp wipe-proof: lives in the workspace next to the other suites. */
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const vwEnd = html.indexOf('</script>', html.indexOf('id="vwsrc"'));
let mainSrc = html.slice(html.indexOf('<script>', vwEnd) + 8, html.lastIndexOf('</script>'));

/* ---------- stubs (from glue.js) + GL instance recorder ---------- */
const counts = {};
let CID = 0;
const mkCtx2D = (owner) => new Proxy({}, {
  get(t, p) {
    if (p === 'canvas') return null;
    if (typeof p === 'symbol') return undefined;
    if (!(p in t)) { t[p] = (...a) => { counts[p + ':' + (owner && owner.__cid)] = (counts[p + ':' + (owner && owner.__cid)] || 0) + 1; return undefined; }; }
    return t[p];
  },
  set(t, p, v) { t[p] = v; return true; }
});
const G = () => ({
  ARRAY_BUFFER: 34962, DYNAMIC_DRAW: 35040, VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632, COMPILE_STATUS: 35713,
  LINK_STATUS: 35714, BLEND: 3042, SRC_ALPHA: 770, ONE_MINUS_SRC_ALPHA: 771, COLOR_BUFFER_BIT: 16384, TRIANGLE_STRIP: 5,
  createShader: () => ({}), shaderSource(){}, compileShader(){}, getShaderParameter: () => true,
  createProgram: () => ({}), attachShader(){}, linkProgram(){}, getProgramParameter: () => true, useProgram(){},
  createVertexArray: () => ({}), bindVertexArray(){}, createBuffer: () => ({}), bindBuffer(){},
  bufferData(){}, vertexAttribPointer(){}, enableVertexAttribArray(){}, vertexAttribDivisor(){},
  enable(){}, blendFunc(){}, getUniformLocation: () => ({}), uniform2f(){}, viewport(){},
  clearColor(){}, clear(){},
  bufferSubData(t, off, src, srcOff, len) { if (GLFRAMES.cur) GLFRAMES.cur.insts.push(src.slice(srcOff, srcOff + len)); },
  drawArraysInstanced(m, a, b, count) { if (GLFRAMES.cur) { GLFRAMES.cur.count = count; GLFRAMES.done(GLFRAMES.cur); GLFRAMES.cur = null; } }
});
const GLFRAMES = { cur: null, done: null, last: null };
const mkEl = (tag) => {
  const el = {
    tag, style: {}, dataset: {}, __cid: ++CID,
    classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    width: 300, height: 150, value: '1', textContent: '', innerHTML: '',
    files: [], checked: false, disabled: false, title: '',
    addEventListener(){}, removeEventListener(){}, appendChild(){}, removeChild(){},
    setAttribute(){}, getAttribute: () => null, focus(){}, blur(){}, click(){},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900 }),
    querySelector: () => mkEl('q'), querySelectorAll: () => [],
    getContext: (k) => (k === '2d' ? mkCtx2D(el) : k === 'webgl2' ? G() : null),
    toBlob(cb){ cb({ arrayBuffer: async () => new ArrayBuffer(8) }); },
    parentElement: null, parentNode: null, offsetWidth: 100, offsetHeight: 20
  };
  return el;
};
const elCache = new Map();
const document = {
  getElementById: (id) => { if (!elCache.has(id)) elCache.set(id, mkEl('div')); return elCache.get(id); },
  querySelector: (s) => { const k = 'q' + s; if (!elCache.has(k)) elCache.set(k, mkEl('div')); return elCache.get(k); },
  querySelectorAll: () => [],
  createElement: (tag) => mkEl(String(tag).toLowerCase()),
  createTextNode: () => ({}),
  body: mkEl('body'), documentElement: mkEl('html'),
  addEventListener(){}, removeEventListener(){},
  hidden: false, visibilityState: 'visible', fonts: { ready: Promise.resolve() }
};
document.body.appendChild = () => {};
const blobMap = new Map(); let blobId = 0;
global.Blob = class { constructor(parts) { this.text = parts.join(''); } };
const URLStub = { createObjectURL: (b) => { const id = 'blob:' + (++blobId); blobMap.set(id, b.text); return id; }, revokeObjectURL(){} };
const { Worker: NodeWorker } = require('worker_threads');
global.Worker = class {
  constructor(u) {
    const src = blobMap.get(u);
    if (!src) throw new Error('no blob for worker url');
    this._w = new NodeWorker(src, { eval: true });
    const self = this;
    this._w.on('message', (m) => { if (self.onmessage) self.onmessage({ data: m }); });
    this._w.on('error', (e) => { if (self.onerror) self.onerror(e); });
  }
  postMessage(m, t) { this._w.postMessage(m, t || []); }
  terminate() { return this._w.terminate(); }
};
const loc = { protocol: 'file:', href: 'file:///x/index.html', host: '', search: '' };
const nav = { userAgent: 'node-cont', storage: undefined };
const win = {
  addEventListener(){}, removeEventListener(){}, innerWidth: 1600, innerHeight: 900,
  devicePixelRatio: 1, location: loc, navigator: nav, matchMedia: () => ({ matches: false, addEventListener(){} }),
  requestAnimationFrame: null, setTimeout, clearTimeout
};

/* ---------- run the page ---------- */
const api = new Function('document', 'window', 'location', 'navigator', 'localStorage', 'URL', 'Blob', 'Worker',
  'innerWidth', 'innerHeight', 'devicePixelRatio', 'requestAnimationFrame', 'cancelAnimationFrame',
  'AudioContext', 'webkitAudioContext', 'AudioWorkletNode', 'OffscreenCanvas', 'Mp4Muxer', 'VideoEncoder', 'VideoFrame', 'AudioEncoder', 'AudioData', 'screen',
  'addEventListener', 'removeEventListener', 'history', 'getComputedStyle',
  mainSrc + `
;return { ST, loadFile, drawBody, pump: typeof pump === 'function' ? pump : null, nowTau: typeof nowTau === 'function' ? nowTau : null,
  dims: () => ({ H, W, KB: KBH, hitY: H - KBH - 8, colW: W / 128 }),
  vwGetBatch: typeof vwGetBatch === 'function' ? vwGetBatch : null,
  nr: () => draw._nr | 0 };`  )(
  document, win, loc, nav, { getItem: () => null, setItem(){}, removeItem(){} },
  URLStub, global.Blob, global.Worker,
  1600, 900, 1,
  (f) => setTimeout(() => f(performance.now()), 16),
  (id) => clearTimeout(id),
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  { width: 1600, height: 900 },
  () => {}, () => {}, { pushState(){}, replaceState(){}, state: null },
  () => ({ getPropertyValue: () => '' })
);
document.getElementById('vwsrc').textContent = html.match(/<script type="text\/plain" id="vwsrc">([\s\S]*?)<\/script>/)[1];
document.getElementById('wksrc').textContent = html.match(/<script type="text\/plain" id="wksrc">([\s\S]*?)<\/script>/)[1];
const { ST, loadFile, drawBody, pump, nowTau, dims } = api;

/* ---------- fixture: format 1, 3 tracks, POLYPHONIC, cross-track offs
   (format-1 files legally pair note-ons/offs on the MERGED stream — the
   per-track flush bug turned every such note into a 288-tick stub) ---------- */
const vlqb = (n) => { const r = [n & 0x7f]; n >>= 7; while (n) { r.push((n & 0x7f) | 0x80); n >>= 7; } return Buffer.from(r.reverse()); };
const N = 40000;
const mkFix = (FPATH, pbase) => {
  if (fs.existsSync(FPATH)) return;
  const fd = fs.openSync(FPATH, 'w'); const buf = Buffer.allocUnsafe(1 << 20); let off = 0;
  const W2 = (s2) => { if (off + s2.length > buf.length) { fs.writeSync(fd, buf, 0, off); off = 0; } buf.set(s2, off); off += s2.length; };
  const trk = (body) => { W2(Buffer.from([0x4d, 0x54, 0x72, 0x6b, (body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255])); W2(body); };
  W2(Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 3, 480 >> 8, 480 & 255]));
  const b1 = Buffer.concat([Buffer.from([0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20])]);
  const onb = Buffer.allocUnsafe(N * 4); let o1 = 0;
  for (let i = 0; i < N; i++) { onb[o1++] = 1; onb[o1++] = 0x90 | (i & 15); onb[o1++] = pbase + ((i * 7) % 80); onb[o1++] = 100; }
  trk(Buffer.concat([b1, onb, Buffer.from([0, 0xff, 0x2f, 0])]));
  const offRaw = (ch, p) => Buffer.from([0x80 | ch, p, 0]);
  const b2 = [Buffer.from([0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20]), vlqb(2001), offRaw(0 & 15, pbase)];
  for (let i = 2; i < N; i += 2) b2.push(vlqb(2), offRaw(i & 15, pbase + ((i * 7) % 80)));
  b2.push(Buffer.from([0, 0xff, 0x2f, 0])); trk(Buffer.concat(b2));
  const b3 = [Buffer.from([0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20]), vlqb(9), offRaw(1 & 15, pbase + 7)];
  for (let i = 3; i < N; i += 2) b3.push(vlqb(2), offRaw(i & 15, pbase + ((i * 7) % 80)));
  b3.push(Buffer.from([0, 0xff, 0x2f, 0])); trk(Buffer.concat(b3));
  if (off) fs.writeSync(fd, buf, 0, off);
  fs.closeSync(fd);
};
const FPATH = '/tmp/cont.mid', FPATHB = '/tmp/contb.mid';
mkFix(FPATH, 36); mkFix(FPATHB, 48);
if (!fs.existsSync(FPATH) || fs.statSync(FPATH).size !== 14 + 8 * 3 + 7 + N + 4 + (7 + 3 + N / 2 * 6 + 4) * 2) {
  const fd = fs.openSync(FPATH, 'w'); const buf = Buffer.allocUnsafe(1 << 20); let off = 0;
  const W2 = (s2) => { if (off + s2.length > buf.length) { fs.writeSync(fd, buf, 0, off); off = 0; } buf.set(s2, off); off += s2.length; };
  const trk = (body) => { W2(Buffer.from([0x4d, 0x54, 0x72, 0x6b, (body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255])); W2(body); };
  W2(Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 3, 480 >> 8, 480 & 255]));
  const b1 = Buffer.concat([Buffer.from([0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20])]);
  const onb = Buffer.allocUnsafe(N * 4); let o1 = 0;
  for (let i = 0; i < N; i++) { onb[o1++] = 1; onb[o1++] = 0x90 | (i & 15); onb[o1++] = 36 + ((i * 7) % 80); onb[o1++] = 100; }
  trk(Buffer.concat([b1, onb, Buffer.from([0, 0xff, 0x2f, 0])]));
  const offRaw = (ch, p) => Buffer.from([0x80 | ch, p, 0]);
  const b2 = [Buffer.from([0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20]), vlqb(2001), offRaw(0 & 15, 36)];
  for (let i = 2; i < N; i += 2) b2.push(vlqb(2), offRaw(i & 15, 36 + ((i * 7) % 80)));
  b2.push(Buffer.from([0, 0xff, 0x2f, 0])); trk(Buffer.concat(b2));
  const b3 = [Buffer.from([0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20]), vlqb(9), offRaw(1 & 15, 36 + 7)];
  for (let i = 3; i < N; i += 2) b3.push(vlqb(2), offRaw(i & 15, 36 + ((i * 7) % 80)));
  b3.push(Buffer.from([0, 0xff, 0x2f, 0])); trk(Buffer.concat(b3));
  if (off) fs.writeSync(fd, buf, 0, off);
  fs.closeSync(fd);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitReady(maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) { if (ST.song && !ST.building && ST.song.conv) return true; await sleep(100); }
  return false;
}

/* ---------- oracle: note i: onset (i+1)/960 s, dur (i&1?8:2000)/960 s ---------- */
const TPS = 960;
function expectedAt(t, hitY, pps, pbase) {
  const out = [];
  const i0 = Math.max(0, Math.floor((t - 45 / pps) * TPS) - 3000), i1 = Math.min(N - 1, Math.ceil((t + (hitY + 40) / pps) * TPS) + 5);
  for (let i = i0; i <= i1; i++) {
    const t0 = (i + 1) / TPS, t1 = t0 + ((i & 1) ? 8 : 2000) / TPS;
    const y1 = hitY + (t - t0) * pps; if (y1 < 2) continue;          /* above screen top = invisible */
    const y0 = hitY + (t - t1) * pps; if (y0 > hitY + 36) continue;  /* app culls at +40 */
    out.push({ i, pitch: pbase + ((i * 7) % 80), y0, y1: Math.max(y0 + 1, Math.min(y1, hitY)) });
  }
  return out;
}
function verify(t, rects, count, hitY, colW, pps, pbase) {
  const cols = new Map();
  for (let k = 0; k < count; k++) {
    const x = rects[k * 8], y = rects[k * 8 + 1], h = rects[k * 8 + 3];
    const c = Math.round((x - 1) / colW);
    let L = cols.get(c); if (!L) { L = []; cols.set(c, L); }
    L.push([y, y + h]);
  }
  const exp = expectedAt(t, hitY, pps, pbase);
  let missing = 0; const miss = [];
  for (const e of exp) {
    const L = cols.get(e.pitch); if (!L) { if (miss.length < 3) miss.push(e); missing++; continue; }
    let hit = false;
    const eh = e.y1 - e.y0;
    for (const [a, b] of L) {
      const ov = Math.min(b, e.y1) - Math.max(a, e.y0);
      if (ov >= Math.min(2, eh * 0.5)) { hit = true; break; }
      if (eh < 4 && Math.abs(a - e.y0) < 3) { hit = true; break; }   /* 1px release slivers: +-1-rec rounding */
    }
    if (!hit) { if (miss.length < 3) miss.push(e); missing++; }
  }
  return { missing, expN: exp.length, miss };
}

(async () => {
  let fails = 0;
  const ok = (name, cond, extra = '') => { console.log((cond ? 'pass  ' : 'FAIL  ') + name + (extra ? '  ' + extra : '')); if (!cond) fails++; };
  const st = fs.statSync(FPATH);
  await loadFile({ __path: FPATH, size: st.size, name: 'cont.mid', arrayBuffer: async () => { const b = fs.readFileSync(FPATH); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } });
  ok('RAM mixed song loads', await waitReady(30000), 'conv=' + (ST.song && ST.song.conv));

  const { hitY, colW } = dims();
  let worst = 0, badFrames = 0, firstBad = null, frames = 0, noDraw = 0, walkErr = null;

  const walk = async (label, pbase, skipFirst) => {
    worst = 0; badFrames = 0; firstBad = null; frames = 0; noDraw = 0; walkErr = null;
    for (let f = 0; f < 1200; f++) {
      ST.ctx.currentTime = 5 + f / 60;
      if (pump) pump();
      GLFRAMES.last = null;
      GLFRAMES.cur = { count: 0, insts: [] };
      try { drawBody(performance.now()); } catch (e) { if (!walkErr) { walkErr = e; console.error('[walk threw]', (e.stack || e).toString().split('\n').slice(0, 4).join(' | ')); } }
      const t = nowTau();
      let all = new Float32Array(0), count = 0;
      if (GLFRAMES.last) {
        count = GLFRAMES.last.count;
        const parts = GLFRAMES.last.insts;
        all = new Float32Array(parts.reduce((a2, b2) => a2 + b2.length, 0));
        let o = 0; for (const s2 of parts) { all.set(s2, o); o += s2.length; }
      } else noDraw++;
      const v = verify(t, all, count, hitY, colW, ST.pps, pbase);
      frames++;
      if (f >= (skipFirst ? 10 : 0)) {
        if (v.missing > worst) { worst = v.missing; firstBad = { t: +t.toFixed(2), f, expN: v.expN, gotN: count, miss: v.miss }; }
        if (v.missing > 0) badFrames++;
      }
    }
    ok(label + ': every expected note has a rect EVERY frame', badFrames === 0, 'frames=' + frames + ' badFrames=' + badFrames + ' worstMissing=' + worst + ' noDrawFrames=' + noDraw);
    if (firstBad) console.log('  worst frame:', JSON.stringify(firstBad).slice(0, 400));
  };
  const goLive = () => {
    ST.live = true; ST.playing = true; ST.speed = 1;
    ST.ctx = { currentTime: 0 }; ST.tSync = 0; ST.rOrigin = 0;
    ST.node = { port: { postMessage(){} } }; ST.inflight = 0; ST.qSent = 0; ST.tag = (ST.tag | 0) + 1;
    ST.bw = 0; ST.bb = 0; ST.muteMask = 0; ST.pcap = false; ST.pps = 650;
    GLFRAMES.done = (fr) => { GLFRAMES.last = fr; };
  };

  /* ---------- RAM phase ---------- */
  goLive();
  await walk('RAM live playback', 36, false);

  /* ---------- VIRTUAL phase: stubbed size routes through the streaming worker ---------- */
  await loadFile({ __path: FPATH, size: 300000000, name: 'cont-virt.mid' });
  { const t0v = Date.now(); let okv = false;
    while (Date.now() - t0v < 60000) { if (ST.song && ST.song.virt && !ST.building && ST.song.conv) { okv = true; break; } await sleep(100); }
    ok('virtual: song flagged virt + loads', okv, 'conv=' + (ST.song && ST.song.conv) + ' wait=' + ((Date.now() - t0v) / 1000).toFixed(1) + 's'); }
  goLive();
  await walk('VIRTUAL live playback', 36, true);

  /* ---------- SECOND BIG LOAD (R62h's new path): pitch-shifted song, full walk ---------- */
  await loadFile({ __path: FPATHB, size: 300000000, name: 'cont-virt2.mid' });
  { const t0v = Date.now(); let okv = false;
    while (Date.now() - t0v < 60000) { if (ST.song && ST.song.virt && !ST.building && ST.song.conv) { okv = true; break; } await sleep(100); }
    ok('second big load: ready', okv, 'conv=' + (ST.song && ST.song.conv)); }
  goLive();
  await walk('SECOND big load live playback', 48, true);

  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('HARNESS ERROR:', e.stack.split('\n').slice(0, 5).join(' | ')); process.exit(1); });
