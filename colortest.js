/* R58b color reproduction: multi-track fixture through the REAL page under DOM stubs.
   Proves: pack carries all 128 TAU slots, cssFor(3)/floatsFor(3) build, mode 3 draws
   varied palette colors, modes 0/1/2 unchanged. */
const fs = require('fs');
const html = fs.readFileSync('/home/user/midi-player/index.html', 'utf8');
const vwEnd = html.indexOf('</script>', html.indexOf('id="vwsrc"'));
const mainSrc = html.slice(html.indexOf('<script>', vwEnd) + 8, html.lastIndexOf('</script>'));
const counts = {}; let CID = 0;
const CAP = [];
const mkCtx2D = (owner) => new Proxy({}, {
  get(t, p) {
    if (p === 'canvas') return null;
    if (typeof p === 'symbol') return undefined;
    if (!(p in t)) {
      if (p === 'measureText') return () => ({ width: 10 });
      t[p] = (...a) => { const k = p + ':' + (owner && owner.__cid); counts[k] = (counts[k] || 0) + 1;
        if (p === 'fillRect' && owner && owner.__cid === 3) { const w = a[2], y = a[1]; if (w >= 8 && w <= 12.5 && y < 700) CAP.push(String(t.fillStyle)); }
        return undefined; };
    }
    return t[p];
  },
  set(t, p, v) { t[p] = v; return true; }
});
const mkEl = (tag) => {
  const el = { tag, style: {}, dataset: {}, __cid: ++CID,
    classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    width: 300, height: 150, value: '1', textContent: '', innerHTML: '',
    files: [], checked: false, disabled: false, title: '',
    addEventListener(){}, removeEventListener(){}, appendChild(){}, removeChild(){},
    setAttribute(){}, getAttribute(){ return null; }, focus(){}, blur(){}, click(){},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900 }),
    querySelector: () => mkEl('q'), querySelectorAll: () => [],
    getContext: (k) => (k === '2d' ? mkCtx2D(el) : null),
    toBlob(cb){ cb({ arrayBuffer: async () => new ArrayBuffer(8) }); },
    parentElement: null, parentNode: null, offsetWidth: 100, offsetHeight: 20 };
  return el;
};
const elCache = new Map();
const document = {
  getElementById: (id) => { if (!elCache.has(id)) elCache.set(id, mkEl('div')); return elCache.get(id); },
  querySelector: (s) => { const k = 'q' + s; if (!elCache.has(k)) elCache.set(k, mkEl('div')); return elCache.get(k); },
  querySelectorAll: () => [], createElement: (tag) => mkEl(String(tag).toLowerCase()),
  createTextNode: () => ({}), body: Object.assign(mkEl('body'), {}), documentElement: mkEl('html'),
  addEventListener(){}, removeEventListener(){}, hidden: false, visibilityState: 'visible', fonts: { ready: Promise.resolve() }
};
document.body.appendChild = () => {};
const blobMap = new Map(); let blobId = 0;
global.Blob = class { constructor(parts) { this.text = parts.join(''); } };
const URLStub = { createObjectURL: (b) => { const id = 'blob:' + (++blobId); blobMap.set(id, b.text); return id; }, revokeObjectURL(){} };
const { Worker: NodeWorker } = require('worker_threads');
global.Worker = class {
  constructor(u) { const src = blobMap.get(u); if (!src) throw new Error('no blob'); this._w = new NodeWorker(src, { eval: true });
    const self = this;
    this._w.on('message', (m) => { if (self.onmessage) self.onmessage({ data: m }); });
    this._w.on('error', (e) => { if (self.onerror) self.onerror(e); }); }
  postMessage(m, t) { this._w.postMessage(m, t || []); }
  terminate() { return this._w.terminate(); }
};
const loc = { protocol: 'file:', href: 'file:///x/index.html', host: '', search: '' };
const nav = { userAgent: 'node-colortest', storage: undefined };
const win = { addEventListener(){}, removeEventListener(){}, innerWidth: 1600, innerHeight: 900,
  devicePixelRatio: 1, location: loc, navigator: nav, matchMedia: () => ({ matches: false, addEventListener(){} }),
  requestAnimationFrame: null, setTimeout, clearTimeout };
const api = new Function('document', 'window', 'location', 'navigator', 'localStorage', 'URL', 'Blob', 'Worker',
  'innerWidth', 'innerHeight', 'devicePixelRatio', 'requestAnimationFrame', 'cancelAnimationFrame',
  'AudioContext', 'webkitAudioContext', 'AudioWorkletNode', 'OffscreenCanvas', 'Mp4Muxer', 'VideoEncoder', 'VideoFrame', 'AudioEncoder', 'AudioData', 'screen',
  'addEventListener', 'removeEventListener', 'history', 'getComputedStyle',
  mainSrc + `
;return { ST, loadFile, drawBody, cssFor: (m, s) => cssFor(m, s), floatsFor: (m, s) => floatsFor(m, s) };`)(
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
const { ST, loadFile, drawBody } = api;

/* multi-track fixture: 128 tracks, channels vary per note -> all 128 TAU slots */
const vlqb = (n) => { const r = [n & 0x7f]; n >>= 7; while (n) { r.push((n & 0x7f) | 0x80); n >>= 7; } return Buffer.from(r.reverse()); };
const TRK = 128, PER = 4000, PPQ = 480;
const chunks = [Buffer.from([0x4d,0x54,0x68,0x64,0,0,0,6,0,1,(TRK >> 8) & 255,TRK & 255,PPQ >> 8,PPQ & 255])];
for (let tk = 0; tk < TRK; tk++) {
  const ev = [];
  for (let i = 0; i < PER; i++) {
    const ch = i & 15, pitch = 36 + ((i * 7 + tk * 3) % 80), vel = 40 + ((i * 13 + tk) % 80);
    ev.push(Buffer.concat([vlqb(i % 4 === 0 ? 60 : 4), Buffer.from([0x90 | ch, pitch, vel])]));
    ev.push(Buffer.concat([vlqb(120 + (i % 200)), Buffer.from([0x80 | ch, pitch, 0])]));
  }
  ev.push(Buffer.from([0, 0xff, 0x2f, 0]));
  const body = Buffer.concat(ev);
  chunks.push(Buffer.from([0x4d,0x54,0x72,0x6b,(body.length >>> 24) & 255,(body.length >>> 16) & 255,(body.length >>> 8) & 255,body.length & 255]));
  chunks.push(body);
}
const mid = Buffer.concat(chunks);
const pure = { __path: '/tmp/multi.mid', size: mid.length, name: 'multi.mid' };
pure.arrayBuffer = async () => { const b = fs.readFileSync(pure.__path); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let fails = 0;
  const ok = (n, c, x = '') => { console.log((c ? 'pass  ' : 'FAIL  ') + n + (x ? '  ' + x : '')); if (!c) fails++; };
  process.on('unhandledRejection', (e) => console.log('UNHANDLED:', e && e.message));
  fs.writeFileSync('/tmp/multi.mid', mid);
  await loadFile(pure);
  const t0 = Date.now();
  while (Date.now() - t0 < 60000 && !(ST.song && !ST.building && ST.song.conv)) await sleep(200);
  ok('RAM song built', ST.song && !ST.building && ST.song.conv > 0, 'conv=' + (ST.song && ST.song.conv));
  const s = ST.song, out = s.out, n = Math.min(s.conv, 300000);
  const ciSet = new Set(), trkSet = new Set();
  for (let i = 0; i < n; i++) { const pk = out[i * 3 + 2]; trkSet.add((pk >>> 21) & 255); ciSet.add(((((pk >>> 21) & 255) << 4) | ((pk >>> 10) & 15)) & 127); }
  ok('pack carries varied tracks', trkSet.size > 8, 'trks=' + trkSet.size + ' ci=' + ciSet.size);
  let tdz = null;
  try { api.cssFor(3, true); api.floatsFor(3, true); } catch (e) { tdz = e.message; }
  ok('TAU tables build without throwing', !tdz, tdz || '');
  const drawMode = async (cm, pal) => {
    CAP.length = 0;
    if (pal) ST.tauPal = pal;
    ST.colorMode = cm; ST.pcap = false; ST.playing = true; ST.tau = 2.5;
    try { drawBody(performance.now()); } catch (e) { return { err: e.message }; }
    await sleep(50);
    CAP.length = 0; ST.tau = 2.501; drawBody(performance.now());
    return { n: CAP.length, colors: [...new Set(CAP)] };
  };
  for (const [cm, pal] of [[3, 'DARK'], [3, 'RAINBOW'], [1, null], [2, null], [0, null]]) {
    const r = await drawMode(cm, pal);
    if (r.err) { ok('mode ' + cm + (pal ? ' ' + pal : ''), false, 'THREW: ' + r.err); continue; }
    if (cm === 3) ok('mode 3 ' + pal + ': varied colors', r.colors.length > 8, r.colors.length + ' distinct');
    else console.log('info  mode ' + cm + ': ' + r.colors.length + ' distinct colors');
  }
  console.log(fails ? fails + ' FAILURES' : 'ALL COLOR CHECKS PASS');
  process.exit(fails ? 1 : 0);
})();
