/* R62j XZ e2e: real p7zip wasm (from the page) + REAL xzdrv driver in a node worker:
   compress a real MIDI with lzma -> drive {op:'xz', mode:'opfs'} -> expect exact bytes back
   from the fake OPFS handle. Then 'ram' mode. Proves the XZ path + driver edits work. */
const fs = require('fs');
const { Worker: NodeWorker } = require('worker_threads');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const g = (id) => html.match(new RegExp('<script type="text/plain" id="' + id + '">([\\s\\S]*?)</script>'))[1];

/* fixture: small MIDI -> real .xz via python3 lzma (FORMAT_XZ) */
const midi = Buffer.concat([
  Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 480 >> 8, 480 & 255]),
  Buffer.from([0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 3 + 5 * 200 + 4])
]);
{
  let o = 0;
  const body = [];
  for (let i = 0; i < 200; i++) {
    body.push(0, 0x90, 40 + (i % 40), 100, 6, 0x80, 40 + (i % 40), 0);
    o++;
  }
  const bb = Buffer.concat([Buffer.from(body), Buffer.from([0, 0xff, 0x2f, 0])]);
  bb.writeUInt32BE(bb.length, 0);
  fs.writeFileSync('/tmp/xzt.mid', Buffer.concat([midi.subarray(0, 14), Buffer.from([0x4d, 0x54, 0x72, 0x6b]), bb.subarray(4), midi.subarray(0, 0)]));
}
/* simpler: write a clean file directly */
{
  const head = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0xe0 | 0, 0x01 & 255]);
  head[12] = 480 >> 8; head[13] = 480 & 255;
  const evs = [];
  for (let i = 0; i < 200; i++) evs.push(0, 0x90, 40 + (i % 40), 100, 6, 0x80, 40 + (i % 40), 0);
  const bodyB = Buffer.concat([Buffer.from(evs), Buffer.from([0, 0xff, 0x2f, 0])]);
  const trk = Buffer.concat([Buffer.from([0x4d, 0x54, 0x72, 0x6b]), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(bodyB.length); return b; })(), bodyB]);
  fs.writeFileSync('/tmp/xzt.mid', Buffer.concat([head, trk]));
}
require('child_process').execSync('python3 -c "import lzma,sys; d=open(\'/tmp/xzt.mid\',\'rb\').read(); open(\'/tmp/xzt.mid.xz\',\'wb\').write(lzma.compress(d, format=lzma.FORMAT_XZ))"');
const xzBuf = fs.readFileSync('/tmp/xzt.mid.xz');
const origBuf = fs.readFileSync('/tmp/xzt.mid');
console.log('fixture: ' + origBuf.length + 'B midi -> ' + xzBuf.length + 'B xz');

/* blob table + worker prelude (node shims for the browser worker env) */
let drvSrc = g('xzdrv').replace('__XZ_UMD_URL__', JSON.stringify('blob:umd'));
drvSrc = drvSrc.replace('const d = e.data;', 'const d = e.data; console.error("[drv] msg op=" + d.op + " wasm=" + (d.wasm && d.wasm.length) + " buf=" + (d.buf && d.buf.length) + " mode=" + d.mode);');
drvSrc = drvSrc.replace('const M = await SZ({ wasmBinary: d.wasm, print() {}, printErr() {}, quit() {} });',
  'console.error("[drv] SZ init..."); const M = await SZ({ wasmBinary: d.wasm, print() {}, printErr() {}, quit() {} }); console.error("[drv] SZ ready");');
drvSrc = drvSrc.replace("M.callMain(['e', '/in.arc', '-o/out', '-y']);",
  "console.error('[drv] callMain go'); M.callMain(['e', '/in.arc', '-o/out', '-y']); console.error('[drv] callMain done acc=' + acc);");
const blobTable = { 'blob:umd': Buffer.from(g('xzumd').trim(), 'base64').toString('binary') };   // page does atob() — same decode
const prelude = `
const __BLOBS = ${JSON.stringify(blobTable)};
const __pp = require('worker_threads').parentPort;
globalThis.self = globalThis;
globalThis.postMessage = (m, t) => __pp.postMessage(m, t || []);
__pp.on('message', (m) => { if (globalThis.onmessage) globalThis.onmessage({ data: m }); });   // node needs the browser onmessage dispatch wired by hand
globalThis.importScripts = (u) => {
  const src = __BLOBS[u];
  if (!src) throw new Error('no blob ' + u);
  (function () { const module = undefined, exports = undefined; eval(src); if (typeof SevenZip !== 'undefined') globalThis.SevenZip = SevenZip; })();   // eval var lands in fn scope: promote it
};
globalThis.onmessage = null;
const __fileStore = {};
globalThis.__mkFakeFH = (nm) => {
  const st = __fileStore[nm] = __fileStore[nm] || { u8: new Uint8Array(0) };
  return {
    createSyncAccessHandle: async () => ({
      truncate() { st.u8 = new Uint8Array(0); },
      write(u8, o) { const at = ((o && o.at) | 0), end = at + u8.length; if (end > st.u8.length) { const n = new Uint8Array(end); n.set(st.u8); st.u8 = n; } st.u8.set(u8, at); return u8.length; },
      read(u8, o) { const at = ((o && o.at) | 0), end = Math.min(st.u8.length, at + u8.length); if (end > at) u8.set(st.u8.subarray(at, end)); return u8.length; },
      flush() {}, getSize() { return st.u8.length; }, close() {}
    })
  };
};
`;
const w = new NodeWorker(prelude + '\n' + drvSrc + `
const __om = self.onmessage;
self.onmessage = (e) => {
  if (e.data && (e.data.__dump || e.data.op === '__dump')) { __pp.postMessage({ __dump: (__fileStore.out || { u8: new Uint8Array(0) }).u8 }, []); return; }
  if (e.data && e.data.fh) { const fh2 = __mkFakeFH('out'); e.data = Object.assign({}, e.data, { fh: fh2 }); }
  if (e.data && e.data.infh) { const fh3 = __mkFakeFH('in'); e.data = Object.assign({}, e.data, { infh: fh3 }); }
  if (e.data && e.data.__path) {                    /* duck-typed File: functions can't cross threads */
    const p = e.data.__path, st2 = require('fs').statSync(p);
    e.data = Object.assign({}, e.data, { file: { size: st2.size, slice: (a2, b2) => ({ arrayBuffer: async () => {
      const fd2 = require('fs').openSync(p, 'r'); const len = Math.min(b2, st2.size) - a2;
      const u82 = new Uint8Array(len); require('fs').readSync(fd2, u82, 0, len, a2); require('fs').closeSync(fd2);
      return u82.buffer; } }) } });
    delete e.data.__path;
  }
  __om(e);
};`, { eval: true });

const wasm = Uint8Array.from(atobW(g('xzwasm')), (c) => c.charCodeAt(0));
function atobW(s) { return Buffer.from(s, 'base64').toString('binary'); }

let phase = 0, fails = 0, timer, lastDump = null;
const done = (ok, label, extra) => { console.log((ok ? 'pass  ' : 'FAIL  ') + label + (extra ? '  ' + extra : '')); if (!ok) fails++; };
/* phases: opfs+file (R62k main path), opfs+buf (legacy compat), ram+file (xzOpen ram path) */
const PHASES = [
  { label: 'opfs mode, FILE streamed (R62k main path)', mode: 'opfs', file: true },
  { label: 'opfs mode, whole-buffer (legacy)', mode: 'opfs', file: false },
  { label: 'ram mode, FILE streamed', mode: 'ram', file: true }
];
function startPhase() {
  const P = PHASES[phase];
  const b2 = Buffer.from(xzBuf);
  const u8 = new Uint8Array(b2.buffer, b2.byteOffset, b2.byteLength);
  const msg = { op: 'xz', wasm, mode: P.mode };
  if (P.mode === 'opfs') { msg.fh = { __fake: 1 }; msg.infh = { __fake: 1 }; }
  if (P.file) msg.__path = '/tmp/xzt.mid.xz';
  else { msg.buf = u8; w.postMessage(msg, [u8.buffer]); return; }
  w.postMessage(msg);
}
function nextPhase() {
  phase++;
  if (phase >= PHASES.length) { console.log(fails ? 'XZ TEST: ' + fails + ' FAILURES' : 'XZ TEST: ALL PASS'); process.exit(fails ? 1 : 0); }
  startPhase();
}
w.on('message', (m) => {
  if (m.__dump) {
    lastDump = m.__dump;
    if (lastDump && PHASES[phase].mode === 'opfs') {
      const got = Buffer.from(lastDump);
      done(got.equals(origBuf), PHASES[phase].label + ': extracted bytes == original midi', got.length + 'B');
      nextPhase();
    }
    return;
  }
  if (m.op === 'xzDone') {
    if (PHASES[phase].mode === 'opfs') { w.postMessage({ op: '__dump' }, []); return; }
    const got = Buffer.from(m.bufs[0]);
    done(!!m.names && got.equals(origBuf), PHASES[phase].label + ': extracted bytes == original midi', (m.names || []).join(',') + ' ' + got.length + 'B');
    nextPhase();
  } else if (m.op === 'xzErr' || m.op === 'error') {
    done(false, 'worker error (phase ' + phase + ')', String(m.msg).slice(0, 200));
    process.exit(1);
  }
});
w.on('error', (e) => { console.log('FAIL  thread error: ' + (e.stack || e).toString().slice(0, 300)); process.exit(1); });
startPhase();
timer = setTimeout(() => { console.log('FAIL  timeout in phase ' + phase); process.exit(1); }, 60000);
