/* suki offline program-audio renderer — MIDI -> 16-bit stereo WAV.
   Uses the REAL parser + packer + worklet extracted verbatim from index.html
   (same as test.js), so the rendered soundtrack is bit-identical to playback
   at the same speed/voices/hz. Feed model: one batch in the air at a time,
   process 128-frame blocks until the worklet acks it, then the next batch
   (bounded memory, works for 27M-note files). Runs as a module (renderWavSync)
   or as a CLI child: node offline_audio.js '{"midi":..,"out":..}' so the
   server never blocks its event loop. */
const fs = require('fs'), path = require('path');

function renderWavSync(midiAB, outPath, opts) {
  opts = opts || {};
  const speed = opts.speed > 0 ? opts.speed : 1;
  const hz = opts.hz >= 8000 ? opts.hz : 48000;
  const vp = opts.vp > 0 ? opts.vp : 128;
  const tail = opts.tailSec != null ? opts.tailSec : 3;
  const onProg = opts.onProg;

  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const grab = (s, e) => { const a = html.indexOf(s); if (a < 0) throw new Error('marker missing: ' + s); return html.slice(a, html.indexOf(e, a)); };
  const parseSrc = grab('function parseMIDI(buf, onProg)', '\n/* =====');
  const packSrc = grab('function beginPack(m) {', '\n/* =====');
  const wkSrc = html.match(/<script type="text\/plain" id="wksrc">([\s\S]*?)<\/script>/)[1];
  const tb = /const\s+SRN\s*=\s*(\d+)\s*,\s*SRQ\s*=\s*(\d+)\s*;/.exec(html);
  if (!tb) throw new Error('index.html declares no SRN/SRQ');
  const SRN = +tb[1], SRQ = +tb[2];
  const lb = /const\s+LTH\s*=\s*(\d+)\s*;/.exec(html);
  if (!lb) throw new Error('index.html declares no LTH');
  const LTH = +lb[1];
  const cb = /const\s+CHUNK\s*=\s*(\d+)/.exec(html);
  if (!cb) throw new Error('index.html declares no CHUNK');
  const CHUNK = +cb[1];

  const AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null, postMessage() {} }; } };
  const registerProcessor = (name, cls) => { Synth = cls; };
  const sampleRate = hz;   // worklet-global mock (same trick as test.js)
  let Synth = null;
  eval(parseSrc); eval(packSrc); eval(wkSrc);
  if (!Synth) throw new Error('worklet did not register');

  const pm = parseMIDI(midiAB);
  const song = beginPack(pm);
  let r = null;
  do { r = packStep(song); } while (song.phase < 2 || !r.done);

  const node = new Synth();
  const acks = [];
  node.port.postMessage = (x) => { if (x && x.t === 'ack') acks.push(1); };
  node.port.onmessage({ data: { t: 'sync', smp: 0, tag: 1 } });
  node.port.onmessage({ data: { t: 'rate', step: (SRN * speed) / hz } });
  node.port.onmessage({ data: { t: 'vp', n: vp } });
  if (opts.fx != null) node.port.onmessage({ data: { t: 'fx', n: opts.fx ? 1 : 0 } });

  const nB = song.done ? Math.ceil(song.conv / CHUNK) : Math.floor(song.conv / CHUNK);
  const N = 128, L = new Float32Array(N), R = new Float32Array(N);
  const fd = fs.openSync(outPath, 'w');
  fs.writeSync(fd, Buffer.alloc(44), 0, 44, 0);            // header patched at the end
  const FLUSHN = 65536;                                     // frames between writes
  const i16 = new Int16Array(FLUSHN * 2);
  let bufN = 0, bytes = 0, frames = 0;
  const flush = () => {
    if (!bufN) return;
    fs.writeSync(fd, Buffer.from(i16.buffer, 0, bufN * 4));
    bytes += bufN * 4; bufN = 0;
  };
  const step = () => {
    node.process([], [[L, R]]);
    for (let i = 0; i < N; i++) {
      let v = L[i]; v = v > 1 ? 1 : v < -1 ? -1 : v; i16[bufN * 2] = (v * 32767) | 0;
      v = R[i]; v = v > 1 ? 1 : v < -1 ? -1 : v; i16[bufN * 2 + 1] = (v * 32767) | 0;
      if (++bufN === FLUSHN) flush();
    }
    frames += N;
  };

  for (let b = 0; b < nB; b++) {
    const ev = song.out.slice(b * CHUNK * 3, Math.min(song.out.length, (b + 1) * CHUNK * 3));
    node.port.onmessage({ data: { t: 'batch', ev, tag: 1 } });
    const need = acks.length + 1;
    while (acks.length < need) step();
    if (onProg) onProg((b + 1) / nB);
  }
  const qn = Math.ceil((tail * hz) / N);
  for (let q = 0; q < qn; q++) step();
  flush();

  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + bytes, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(2, 22); hdr.writeUInt32LE(hz, 24); hdr.writeUInt32LE(hz * 4, 28);
  hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(bytes, 40);
  fs.writeSync(fd, hdr, 0, 44, 0);
  fs.closeSync(fd);
  return { frames, hz, bytes };
}

if (require.main === module) {
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const ab = fs.readFileSync(job.midi);
  const resu = renderWavSync(ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength), job.out,
    { speed: job.speed, hz: job.hz, vp: job.vp, tailSec: job.tail, fx: job.fx });
  console.log('OFFLINE-AUDIO OK ' + resu.frames + ' frames ' + (resu.hz) + 'hz');
}
module.exports = { renderWavSync };
