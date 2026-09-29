/* R58c: >2047-track files collapsed to ONE track color (slot 255). Proves the fix
   on BOTH packers: RAM (parseMIDI+packStep) and the streaming worker (loadBuffer+win). */
const fs = require('fs'), path = require('path');
const { Worker: NodeWorker } = require('worker_threads');

/* fixture: 2100 tracks x 300 notes, ppq 480 */
const vlqb = (n) => { const r = [n & 0x7f]; n >>= 7; while (n) { r.push((n & 0x7f) | 0x80); n >>= 7; } return Buffer.from(r.reverse()); };
const TRK = 2100, PER = 300, PPQ = 480, parts = [];
parts.push(Buffer.from([0x4d,0x54,0x68,0x64,0,0,0,6,0,1,(TRK >> 8) & 255,TRK & 255,PPQ >> 8,PPQ & 255]));
for (let tk = 0; tk < TRK; tk++) {
  const ev = [Buffer.from([0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20])];
  for (let i = 0; i < PER; i++) {
    const ch = (i + tk) & 15, pitch = 36 + ((i * 7 + tk) % 80);
    ev.push(Buffer.concat([vlqb(30), Buffer.from([0x90 | ch, pitch, 100])]));
    ev.push(Buffer.concat([vlqb(60), Buffer.from([0x80 | ch, pitch, 0])]));
  }
  ev.push(Buffer.from([0, 0xff, 0x2f, 0]));
  const body = Buffer.concat(ev);
  parts.push(Buffer.from([0x4d,0x54,0x72,0x6b,(body.length >>> 24) & 255,(body.length >>> 16) & 255,(body.length >>> 8) & 255,body.length & 255]), body);
}
const mid = Buffer.concat(parts);
console.log('fixture: ' + TRK + ' tracks, ' + (TRK * PER) + ' notes, ' + (mid.length / 1e6).toFixed(1) + ' MB');

/* ---------- RAM packer census ---------- */
const html = fs.readFileSync('/home/user/midi-player/index.html', 'utf8');
const vwEnd = html.indexOf('</script>', html.indexOf('id="vwsrc"'));
const grab = (s, e) => { const a = html.indexOf(s); return html.slice(a, html.indexOf(e, a)); };
const SRQ = 12000, CHUNK = 8192, LTH = 1200;
const ST = { sortAlg: 'QUANTUM' };
eval(grab('function parseMIDI(buf, onProg)', '\n/* ====='));
eval(grab('function beginPack(m) {', '\n/* ====='));
eval(grab('function radixPass', '\nfunction makeClock'));
eval(grab('function packStep', '\n/* ======================================================================'));
const ab = mid.buffer.slice(mid.byteOffset, mid.byteOffset + mid.byteLength);
const sg = beginPack(parseMIDI(ab));
let r; do { r = packStep(sg); } while (sg.phase < 2 || !r.done);
const slot = (pk) => (pk >>> 21) & 255;
const census = (arr, n) => { const T = new Set(), C = new Set();
  for (let i = 0; i < n; i++) { const pk = arr[i * 3 + 2]; if (pk & 7) continue; T.add(slot(pk)); C.add(((((pk >>> 21) & 255) << 4) | ((pk >>> 10) & 15)) & 127); }
  return { trk: T.size, tau: C.size }; };
const ramC = census(sg.out, sg.conv);
console.log('RAM  : trk slots=' + ramC.trk + '  tau slots=' + ramC.tau);

/* ---------- worker census ---------- */
(async () => {
  const vwsrc = html.match(/<script type="text\/plain" id="vwsrc">([\s\S]*?)<\/script>/)[1];
  const w = new NodeWorker(vwsrc, { eval: true });
  let reqId = 0; const pending = new Map();
  const ask = (msg, transfer) => new Promise((res) => { const id = ++reqId; pending.set(id, res); w.postMessage(Object.assign({ reqId: id }, msg), transfer || []); });
  const msgs = [];
  w.on('message', (m) => { if (m.reqId && pending.has(m.reqId)) { pending.get(m.reqId)(m); pending.delete(m.reqId); } else msgs.push(m); });
  const waitOp = (op) => new Promise((res) => { const t0 = Date.now();
    const iv = setInterval(() => { const i = msgs.findIndex((x) => x.op === op); if (i >= 0) { clearInterval(iv); res(msgs.splice(i, 1)[0]); } else if (Date.now() - t0 > 60000) { clearInterval(iv); res(null); } }, 50); });
  const abw = mid.buffer.slice(mid.byteOffset, mid.byteOffset + mid.byteLength);
  w.postMessage({ op: 'loadBuffer', ab: abw, SRQ, CHUNK, LTH }, [abw]);
  const rd = await waitOp('ready');
  const win = await ask({ op: 'win', lo: 0, n: 200000 });
  const recs = new Int32Array(win.buf);
  const wkC = census(recs, Math.min(200000, recs.length / 3));
  console.log('WORKER: trk slots=' + wkC.trk + '  tau slots=' + wkC.tau);
  let fails = 0;
  const ok = (n, c, x = '') => { console.log((c ? 'pass  ' : 'FAIL  ') + n + (x ? '  ' + x : '')); if (!c) fails++; };
  ok('RAM packer: >2047 tracks give many colors', ramC.trk > 200, ramC.trk + '/256 slots');
  ok('WORKER: >2047 tracks give many colors', wkC.trk > 200, wkC.trk + '/256 slots');
  ok('TAU slots spread (both paths)', ramC.tau > 120 && wkC.tau > 120, ramC.tau + '/' + wkC.tau + '/128');
  ok('worker trk census == RAM census', Math.abs(ramC.trk - wkC.trk) <= 2, '');
  await w.terminate();
  console.log(fails ? fails + ' FAILURES' : 'TRACK COLOR FIX VERIFIED');
  process.exit(fails ? 1 : 0);
})();
