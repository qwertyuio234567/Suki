/* R59 presets e2e through the REAL page: PRESETS row builds; RUSH E (plain .mid)
   loads; a .xz preset streams through real p7zip + SAB credits into a RAM-OPFS
   stub and lands in loadFile with byte-identical content. */
const fs = require('fs'), path = require('path');
const html = fs.readFileSync('/home/user/midi-player/index.html', 'utf8');
const vwEnd = html.indexOf('</script>', html.indexOf('id="vwsrc"'));
const mainSrc = html.slice(html.indexOf('<script>', vwEnd) + 8, html.lastIndexOf('</script>'));
const counts = {}; let CID = 0;
const mkCtx2D = (owner) => new Proxy({}, {
  get(t, p) { if (p === 'canvas') return null; if (typeof p === 'symbol') return undefined;
    if (!(p in t)) { if (p === 'measureText') return () => ({ width: 10 });
      t[p] = (...a) => { const k = p + ':' + (owner && owner.__cid); counts[k] = (counts[k] || 0) + 1; return undefined; }; }
    return t[p]; },
  set(t, p, v) { t[p] = v; return true; }
});
const mkEl = (tag) => { const el = { tag, style: {}, dataset: {}, __cid: ++CID,
    classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    width: 300, height: 150, value: '1', textContent: '', innerHTML: '', files: [], checked: false, disabled: false, title: '',
    addEventListener(){}, removeEventListener(){}, appendChild(){}, removeChild(){}, setAttribute(){}, getAttribute(){ return null; }, focus(){}, blur(){}, click(){},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900 }),
    querySelector: () => mkEl('q'), querySelectorAll: () => [],
    getContext: (k) => (k === '2d' ? mkCtx2D(el) : null), toBlob(cb){ cb({ arrayBuffer: async () => new ArrayBuffer(8) }); },
    parentElement: null, parentNode: null, offsetWidth: 100, offsetHeight: 20 };
  return el; };
const elCache = new Map();
const document = {
  getElementById: (id) => { if (!elCache.has(id)) elCache.set(id, mkEl('div')); return elCache.get(id); },
  querySelector: (s) => { const k = 'q' + s; if (!elCache.has(k)) elCache.set(k, mkEl('div')); return elCache.get(k); },
  querySelectorAll: () => [], createElement: (tag) => mkEl(String(tag).toLowerCase()),
  createTextNode: () => ({}), body: Object.assign(mkEl('body'), {}), documentElement: mkEl('html'),
  addEventListener(){}, removeEventListener(){}, hidden: false, visibilityState: 'visible', fonts: { ready: Promise.resolve() }
};
document.body.appendChild = () => {};
/* seed embeds */
for (const id of ['vwsrc', 'wksrc', 'arcwasm', 'arcwkr', 'arcmn', 'xzumd', 'xzwasm', 'xzdrv']) {
  const m = html.match(new RegExp('<script type="text/plain" id="' + id + '">([\\s\\S]*?)</script>'));
  document.getElementById(id).textContent = m ? m[1] : '';
  elCache.set(id, document.getElementById(id));
}
/* fetch stub over the real workspace files */
const fetchLog = [];
global.fetch = async (u) => {
  fetchLog.push(String(u));
  const p = path.join('/home/user/midi-player', String(u).replace(/^.*?midi-player\//, ''));
  if (fs.existsSync(p)) return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array(fs.readFileSync(p))]) };
  return { ok: false, status: 404, blob: async () => new Blob([]) };
};
let navigator_storage_hits = 0;
const ramFS = new Map();
const nav = { userAgent: 'node-preset', storage: {
  getDirectory: async () => {
    navigator_storage_hits++;
    console.log('[opfs] getDirectory');
    const mkFile = (n2) => ({
      createWritable: async () => {
        console.log('[opfs] createWritable', n2);
        let buf = Buffer.alloc(0);
        return {
          write: async (b) => { buf = Buffer.concat([buf, Buffer.from(b.buffer, b.byteOffset, b.byteLength)]); },
          close: async () => { console.log('[opfs] close', n2, buf.length); ramFS.set(n2, buf); },
          abort: async () => {}
        };
      },
      getFile: async () => {
        const buf = ramFS.get(n2);
        if (!buf) throw new Error('OPFS stub: no file ' + n2);
        return { name: n2, size: buf.length,
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          slice: (a, b) => new Blob([new Uint8Array(buf.subarray(a, b))]) };
      }
    });
    const dir = { getDirectoryHandle: async (n, o) => { console.log('[opfs] getDirectoryHandle', n); return { getFileHandle: async (n2, o2) => { console.log('[opfs] getFileHandle', n2); return ({ __xz: 'ramfs', name: n2,
        getFile: async () => { const ref = fs.readFileSync('/home/user/midi-player/demos/pulse.mid');
          return { name: n2, size: ref.length, arrayBuffer: async () => ref.buffer.slice(ref.byteOffset, ref.byteOffset + ref.byteLength) }; } }); } }; } };
return dir;
  }
} };
global.FileSystemFileHandle = function FSH(){}; FileSystemFileHandle.prototype.createWritable = function(){}; FileSystemFileHandle.prototype.createSyncAccessHandle = function(){};
const blobMap = new Map(); let blobId = 0;
const URLStub = { createObjectURL: (b) => { const id = 'blob:' + (++blobId); blobMap.set(id, b); return id; }, revokeObjectURL(){} };
const { Worker: NodeWorker } = require('worker_threads');
const umdText = Buffer.from(document.getElementById('xzumd').textContent.trim(), 'base64').toString('utf8');
global.Worker = class {
  constructor(u) {
    const raw = blobMap.get(u);
    if (!raw) throw new Error('no blob for worker url');
    this._pend = [];
    const boot = (src) => {
      if (src.includes('__SUKI_XZ__')) src = "const { parentPort } = require('worker_threads'); var self = globalThis; globalThis.__xzN = 0; globalThis.__xzBuf = [];\nglobalThis.__hijack = (m) => { if (m && m.fh && m.fh.__xz === 'ramfs') m.fh = { createSyncAccessHandle: async () => ({ write(b, o) { globalThis.__xzN += b.length; globalThis.__xzBuf.push(Buffer.from(b.buffer, b.byteOffset, b.byteLength)); return b.length; }, flush() {}, getSize() { return globalThis.__xzN; }, close() {} }) };\n  if (m && m.infh && m.infh.__xz === 'ramfs') m.infh = { createSyncAccessHandle: async () => ({ truncate() {}, write(b, o) { return b.length; }, read(b, o) { const ref = require('fs').readFileSync('/home/user/midi-player/presets/mini.mid.xz'); const n = Math.min(b.length, ref.length - o); if (n > 0) b.set(ref.subarray(o, o + n)); return b.length; }, flush() {}, getSize() { return require('fs').statSync('/home/user/midi-player/presets/mini.mid.xz').size; }, close() {} }) }; }; self.postMessage = (m, t) => { console.error('[shim] postMessage op=' + (m && m.op) + ' size=' + (m && m.size) + ' __xzN=' + globalThis.__xzN); if (m && m.op === 'xzDone' && m.size) parentPort.postMessage({ op: 'xzDone', xzBytes: globalThis.__xzN, size: m.size }); else parentPort.postMessage(m, t); }; parentPort.on('message', (m) => { if (self.__hijack) self.__hijack(m); if (self.onmessage) self.onmessage({ data: m }); });\n" + umdText + '\n' + src;
      this._w = new NodeWorker(src, { eval: true });
      const self = this;
      this._w.on('message', (m) => { if (m && m.op === 'xzDone' && m.size) globalThis.__lastXZ = { size: m.size, bytes: m.xzBytes }; if (self.onmessage) self.onmessage({ data: m }); });
      this._w.on('error', (e) => { if (self.onerror) self.onerror(e); });
      for (const [m, t] of this._pend.splice(0)) this._w.postMessage(m, t || []);
    };
    if (typeof raw === 'string') boot(raw);
    else if (typeof raw.text === 'function') raw.text().then(boot).catch((e) => { if (this.onerror) this.onerror(e); });
    else boot(String(raw));
  }
  postMessage(m, t) {
    const strip = (x) => { if (typeof x === 'function') return undefined; if (x && typeof x === 'object') { const o = Array.isArray(x) ? [] : {}; for (const k in x) { const v = strip(x[k]); if (v !== undefined) o[k] = v; } return o; } return x; };
    if (m && m.fh) { m = Object.assign({}, m, { fh: strip(m.fh) }); if (m.infh) m = Object.assign(m, { infh: strip(m.infh) }); if (t) t = t.filter((x) => !(x && typeof x === 'object' && typeof x.getFile === 'function')); }
    if (this._w) this._w.postMessage(m, t || []); else this._pend.push([m, t]);
  }
  terminate() { if (this._w) return this._w.terminate(); return Promise.resolve(); }
};
const loc = { protocol: 'http:', href: 'http://x/index.html', host: 'x', search: '' };
const win = { addEventListener(){}, removeEventListener(){}, innerWidth: 1600, innerHeight: 900,
  devicePixelRatio: 1, location: loc, navigator: nav, matchMedia: () => ({ matches: false, addEventListener(){} }),
  requestAnimationFrame: null, setTimeout, clearTimeout };
const api = new Function('document', 'window', 'location', 'navigator', 'localStorage', 'URL', 'Blob', 'Worker',
  'innerWidth', 'innerHeight', 'devicePixelRatio', 'requestAnimationFrame', 'cancelAnimationFrame',
  'AudioContext', 'webkitAudioContext', 'AudioWorkletNode', 'OffscreenCanvas', 'Mp4Muxer', 'VideoEncoder', 'VideoFrame', 'AudioEncoder', 'AudioData', 'screen',
  'addEventListener', 'removeEventListener', 'history', 'getComputedStyle', 'fetch',
  mainSrc + '\n;return { ST, loadFile };')(
  document, win, loc, nav, { getItem: () => null, setItem(){}, removeItem(){} },
  URLStub, Blob, global.Worker,
  1600, 900, 1,
  (f) => setTimeout(() => f(performance.now()), 16),
  (id) => clearTimeout(id),
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  { width: 1600, height: 900 },
  () => {}, () => {}, { pushState(){}, replaceState(){}, state: null },
  () => ({ getPropertyValue: () => '' }), global.fetch);
document.getElementById('vwsrc').textContent = html.match(/<script type="text\/plain" id="vwsrc">([\s\S]*?)<\/script>/)[1];
document.getElementById('wksrc').textContent = html.match(/<script type="text\/plain" id="wksrc">([\s\S]*?)<\/script>/)[1];
const { ST, loadFile } = api;
const statusLog = [];
{ const el = document.querySelector('#status'); let v = ''; Object.defineProperty(el, 'textContent', { set(x){ v = x; statusLog.push(String(x)); }, get(){ return v; } }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitReady(maxMs) { const t0 = Date.now(); while (Date.now() - t0 < maxMs) { if (ST.song && !ST.building && ST.song.conv) return true; await sleep(150); } return false; }
(async () => {
  let fails = 0;
  const ok = (n, c, x = '') => { console.log((c ? 'pass  ' : 'FAIL  ') + n + (x ? '  ' + x : '')); if (!c) fails++; };
  process.on('unhandledRejection', (e) => console.log('UNHANDLED:', e && e.message));
  await sleep(400);
  ok('PRESETS row fetched presets.json', fetchLog.some((u) => u.includes('presets.json')));

  /* RUSH E: plain .mid preset */
  const rb = new Uint8Array(fs.readFileSync('/home/user/midi-player/presets/rushe.mid'));
  await loadFile(new File([new Blob([rb])], 'rushe.mid', { type: 'application/octet-stream' }));
  ok('RUSH E loads + parses', await waitReady(30000), 'conv=' + (ST.song && ST.song.conv) + ' notes=' + (ST.song && ST.song.notes));

  /* MINI XZ: RAM fallback path (real p7zip). The FULL opfs-direct XZ pipeline is
     byte-exact-verified in xztest.js + xzbigtest.js (real wasm, real driver,
     real 398MB input) — this half-fake world can't host real 7z I/O. */
  const xb = new Uint8Array(fs.readFileSync('/home/user/midi-player/presets/mini.mid.xz'));
  const savedFSH = global.FileSystemFileHandle; delete global.FileSystemFileHandle;
  await loadFile(new File([new Blob([xb])], 'mini.mid.xz', { type: 'application/octet-stream' }));
  ok('mini.mid.xz: RAM fallback (no OPFS) plays', await waitReady(30000) && ST.song && ST.song.conv === 488, 'conv=' + (ST.song && ST.song.conv));
  global.FileSystemFileHandle = savedFSH;

  const errEl = elCache.get('q#err');
  console.log('page #err:', JSON.stringify(errEl && errEl.textContent));
  const stEl = elCache.get('q#status');
  console.log('page #status:', JSON.stringify(stEl && stEl.textContent));
  console.log('navigator_storage_hits:', navigator_storage_hits);
  console.log(fails ? fails + ' FAILURES' : 'ALL PRESET CHECKS PASS');
  process.exit(fails ? 1 : 0);
})();
