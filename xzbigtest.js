/* R62k big-input probe: does the real driver's file-streamed path survive a ~400MB .xz?
   Dumps only the SIZE back (not 400MB of bytes). */
const fs = require('fs');
const { Worker: NodeWorker } = require('worker_threads');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const g = (id) => html.match(new RegExp('<script type="text/plain" id="' + id + '">([\\s\\S]*?)</script>'))[1];
let drvSrc = g('xzdrv').replace('__XZ_UMD_URL__', JSON.stringify('blob:umd'));
drvSrc = drvSrc.replace('const d = e.data;', 'const d = e.data; console.error("[drv] op=" + d.op + " infh=" + !!d.infh + " fh=" + !!d.fh + " file=" + !!d.file + " mode=" + d.mode);');
const blobTable = { 'blob:umd': Buffer.from(g('xzumd').trim(), 'base64').toString('binary') };
const prelude = `
const __BLOBS = ${JSON.stringify(blobTable)};
const __pp = require('worker_threads').parentPort;
globalThis.self = globalThis;
globalThis.postMessage = (m, t) => __pp.postMessage(m, t || []);
__pp.on('message', (m) => { if (globalThis.onmessage) globalThis.onmessage({ data: m }); });
globalThis.importScripts = (u) => { (function () { const module = undefined, exports = undefined; eval(__BLOBS[u]); if (typeof SevenZip !== 'undefined') globalThis.SevenZip = SevenZip; })(); };
globalThis.onmessage = null;
const __fsN = require('fs');
globalThis.__mkFakeFH = (nm) => {
  const p2 = '/var/tmp/fakeopfs-' + nm + '.bin';
  try { __fsN.unlinkSync(p2); } catch (e) {}
  const fd = __fsN.openSync(p2, 'w+');
  return {
    createSyncAccessHandle: async () => ({
      truncate() { __fsN.ftruncateSync(fd, 0); },
      write(u8, o) { return __fsN.writeSync(fd, u8, 0, u8.length, (o && o.at) | 0); },
      read(u8, o) { return __fsN.readSync(fd, u8, 0, u8.length, (o && o.at) | 0); },
      flush() {}, getSize() { return __fsN.fstatSync(fd).size; }, close() { __fsN.closeSync(fd); }
    })
  };
};
`;
const w = new NodeWorker(prelude + '\n' + drvSrc + `
const __om = self.onmessage;
self.onmessage = (e) => {
  if (e.data && (e.data.__dump || e.data.op === '__size')) { const sz = __fsN.statSync('/var/tmp/fakeopfs-out.bin').size; __pp.postMessage({ __size: sz }, []); return; }
  if (e.data && e.data.fh) { const fh2 = __mkFakeFH('out'); e.data = Object.assign({}, e.data, { fh: fh2 }); }
  if (e.data && e.data.infh) { const fh3 = __mkFakeFH('in'); e.data = Object.assign({}, e.data, { infh: fh3 }); }
  if (e.data && e.data.__path) {
    const p = e.data.__path, st2 = require('fs').statSync(p);
    e.data = Object.assign({}, e.data, { file: { size: st2.size, slice: (a2, b2) => ({ arrayBuffer: async () => {
      const fd2 = require('fs').openSync(p, 'r'); const len = Math.min(b2, st2.size) - a2;
      const u82 = new Uint8Array(len); require('fs').readSync(fd2, u82, 0, len, a2); require('fs').closeSync(fd2);
      return u82.buffer; } }) } });
    delete e.data.__path;
  }
  __om(e);
};`, { eval: true });
w.on('message', (m) => {
  if (m.__size !== undefined) { console.log('extracted size: ' + (m.__size / 1048576 | 0) + 'MB'); process.exit(0); }
  if (m.op === 'xzDone') { w.postMessage({ op: '__size' }, []); return; }
  if (m.op === 'xzErr' || m.op === 'error') { console.log('REPRO CONFIRMED: ' + String(m.msg).slice(0, 200)); process.exit(2); }
});
w.on('error', (e) => { console.log('REPRO (thread): ' + (e.message || e)); process.exit(2); });
w.postMessage({ op: 'xz', wasm: Uint8Array.from(Buffer.from(g('xzwasm').trim(), 'base64').toString('binary'), (c) => c.charCodeAt(0)), mode: 'opfs', fh: { __fake: 1 }, infh: { __fake: 1 }, __path: '/var/tmp/big.mid.xz' });
setTimeout(() => { console.log('TIMEOUT (killed? OOM?)'); process.exit(3); }, 300000);
