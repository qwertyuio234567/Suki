/* R62h regression: second big-file load must NOT die with
   "ACCESS HANDLES CANNOT BE CREATED IF THERE IS ANOTHER OPEN ACCESS HANDLE".
   Fake OPFS inside the worker enforces Chrome's rule; two consecutive loadPath loads must both reach 'ready'. */
const fs = require('fs');
const { Worker: NodeWorker } = require('worker_threads');
const html = fs.readFileSync('/home/user/midi-player/index.html', 'utf8');
const vw = html.match(/<script type="text\/plain" id="vwsrc">([\s\S]*?)<\/script>/)[1];

/* tiny format-0 midi (3 notes) */
const midi = Buffer.concat([
  Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 480 >> 8, 480 & 255]),
  Buffer.from([0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 3 + 3 * 4 + 4]),
  Buffer.from([0, 0x90, 60, 100, 0, 0x80, 60, 0, 0, 0x90, 64, 100, 0, 0x80, 64, 0, 0, 0x90, 67, 100, 0, 0x80, 67, 0]),
  Buffer.from([0, 0xff, 0x2f, 0])
]);
fs.writeFileSync('/tmp/opfs-test.mid', midi);

const prelude = `
const __open = {}; const __files = {};
const __mkH = (name) => {
  const st = __files[name] = __files[name] || { u8: new Uint8Array(0) };
  const at2 = (o) => ((o && typeof o === 'object' ? o.at : o) | 0);
  return {
    truncate(n) { st.u8 = new Uint8Array(0); },
    write(u8, o) { const at = at2(o), end = at + u8.length; if (end > st.u8.length) { const n = new Uint8Array(end); n.set(st.u8); st.u8 = n; } st.u8.set(u8, at); return u8.length; },
    read(u8, o) { const at = at2(o), end = Math.min(st.u8.length, at + u8.length); if (end > at) u8.set(st.u8.subarray(at, end), 0); return u8.length; },
    close() { try { require('worker_threads').parentPort.postMessage({ __closed: name }); } catch (e) {} if (!globalThis.__NOCLOSE) __open[name] = 0; }
  };
};
const __root = {
  getFileHandle: async (name, o) => ({
    createSyncAccessHandle: async () => {
      if (__open[name]) { try { require('worker_threads').parentPort.postMessage({ __rejected: name + '=' + __open[name] }); } catch (e) {} throw new Error("FAILED TO EXECUTE 'CREATESYNCACCESSHANDLE' ON 'FILESYSTEMHANDLE': ACCESS HANDLES CANNOT BE CREATED IF THERE IS ANOTHER OPEN ACCESS HANDLE ASSOCIATED WITH THE SAME FILE."); }
      const h = __mkH(name);
      __open[name] = 1;
      try { require('worker_threads').parentPort.postMessage({ __created: name }); } catch (e) {}
      return h;
    }
  }),
  removeEntry: async (name) => { delete __files[name]; }
};
globalThis.navigator = { storage: { getDirectory: async () => __root } };
console.error = () => {};
`;

const w = new NodeWorker(prelude + (process.env.OPFSTEST_NOCLOSE ? '\nglobalThis.__NOCLOSE = 1;' : '') + '\n' + vw, { eval: true });
let readies = 0, errors = [], created = [];
w.on('message', (m) => {
  if (m.__created) { created.push(m.__created); return; }
  if (m.__closed) { created.push('CLOSED:' + m.__closed); return; }
  if (m.__rejected) { created.push('REJECTED:' + m.__rejected); return; }
  if (m.op === 'ready') {
    readies++;
    if (readies === 1) w.postMessage({ op: 'loadPath', path: '/tmp/opfs-test.mid', SRQ: 12000, CHUNK: 8192, LTH: 1200 });
    else finish();
  } else if (m.op === 'error') { errors.push(m.msg); finish(); }
});
w.on('error', (e) => { errors.push('thread: ' + e.message); finish(); });
const t0 = Date.now();
w.postMessage({ op: 'loadPath', path: '/tmp/opfs-test.mid', SRQ: 12000, CHUNK: 8192, LTH: 1200 });
function finish() {
  const usedRetry = created.some((n) => n.includes('.bin.'));
  const ok = readies === 2 && errors.length === 0 && !usedRetry;
  console.log((ok ? 'pass  ' : 'FAIL  ') + 'second big-file load survives OPFS handle reuse');
  console.log('  created files: ' + JSON.stringify(created) + (usedRetry ? '  (fell back to unique-name retry — close path NOT working)' : '  (clean close + reuse)'));
  if (!ok) console.log('  readies=' + readies + ' errors=' + JSON.stringify(errors).slice(0, 300));
  w.terminate();
  process.exit(ok ? 0 : 1);
}
setTimeout(() => { console.log('FAIL  timeout — readies=' + readies + ' errors=' + JSON.stringify(errors).slice(0, 200)); process.exit(1); }, 15000);
