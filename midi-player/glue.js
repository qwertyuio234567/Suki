/* R57 glue smoke: run the REAL page script under DOM stubs in Node, drive the
   virtual path end-to-end (loadFile > worker > ready > paged draws) and the
   legacy path (loadFile small > RAM pack > draw). Counts fillRects to prove
   notes actually render (the notes-invisible guard). */
const fs = require('fs'), path = require('path');
const html = fs.readFileSync('/home/user/midi-player/index.html', 'utf8');
const vwEnd = html.indexOf('</script>', html.indexOf('id="vwsrc"'));
const mainSrc = html.slice(html.indexOf('<script>', vwEnd) + 8, html.lastIndexOf('</script>'));

/* ---------- stubs ---------- */
const counts = {}; let probe = null, probeN = 0;
let CID = 0;
const mkCtx2D = (owner) => { if (owner) console.error('CTX CREATED cid=' + owner.__cid + ' id=' + (owner.tag || '?'));
  return new Proxy({}, {
  get(t, p) {
    if (p === 'canvas') return null;
    if (typeof p === 'symbol') return undefined;
    if (!(p in t)) {
      if (p === 'measureText') return () => ({ width: 10 });
      t[p] = (...a) => { const k = p + ':' + (owner && owner.__cid); counts[k] = (counts[k] || 0) + 1;
        if (p === 'fillRect' && owner && owner.__cid === 3) {
          const w = a[2], y = a[1];
          if (w >= 8 && w <= 12.5 && y < 700) { counts.noteish = (counts.noteish || 0) + 1; if (probe === 3 && probeN < 5) { probeN++; console.error('    noteish', JSON.stringify(a)); } }
        }
        return undefined; };
    }
    return t[p];
  },
  set(t, p, v) { t[p] = v; return true; }
}); }
const mkEl = (tag) => {
  const el = {
    tag, style: {}, dataset: {}, __cid: ++CID,
    classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    width: 300, height: 150, value: '1', textContent: '', innerHTML: '',
    files: [], checked: false, disabled: false, title: '',
    addEventListener(){}, removeEventListener(){}, appendChild(){}, removeChild(){},
    setAttribute(){}, getAttribute(){ return null; }, focus(){}, blur(){}, click(){},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900 }),
    querySelector: () => mkEl('q'), querySelectorAll: () => [],
    getContext: (k) => (k === '2d' ? mkCtx2D(el) : null),
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
  body: Object.assign(mkEl('body'), {}),
  documentElement: mkEl('html'),
  addEventListener(){}, removeEventListener(){},
  hidden: false, visibilityState: 'visible', fonts: { ready: Promise.resolve() }
};
document.body.appendChild = () => {};
const blobMap = new Map();
let blobId = 0;
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
const nav = { userAgent: 'node-glue', storage: undefined };
const win = {
  addEventListener(){}, removeEventListener(){}, innerWidth: 1600, innerHeight: 900,
  devicePixelRatio: 1, location: loc, navigator: nav, matchMedia: () => ({ matches: false, addEventListener(){} }),
  requestAnimationFrame: null, setTimeout, clearTimeout
};

/* run the page */
const api = new Function('document', 'window', 'location', 'navigator', 'localStorage', 'URL', 'Blob', 'Worker',
  'innerWidth', 'innerHeight', 'devicePixelRatio', 'requestAnimationFrame', 'cancelAnimationFrame',
  'AudioContext', 'webkitAudioContext', 'AudioWorkletNode', 'OffscreenCanvas', 'Mp4Muxer', 'VideoEncoder', 'VideoFrame', 'AudioEncoder', 'AudioData', 'screen',
  'addEventListener', 'removeEventListener', 'history', 'getComputedStyle',
  mainSrc + `
;return { ST, loadFile, drawBody, vwGetBatch: typeof vwGetBatch === 'function' ? vwGetBatch : null, vwIdxLower: typeof vwIdxLower === 'function' ? vwIdxLower : null,
          seek: typeof seek === 'function' ? seek : null, vwAhead: typeof vwAhead === 'function' ? vwAhead : null,
          probeVirt: (t) => {
            const s2 = ST.song; if (!s2 || !s2.virt) return 'no virt song';
            const hitY = H - KBH - 8, colW = W / 128, pps = ST.pps;
            const pr = vwPrep(s2, t, hitY, colW, pps);
            const V = ST.vw; let cnt = 0, holes = 0, checked = 0, firstAt = -1;
            let pg = null, pgN = -1;
            for (let i = pr.lo; i < s2.conv;) {
              const p = (i / VPG) | 0;
              if (p !== pgN) { pg = V.pages.get(p); pgN = p; }
              if (!pg) { holes++; i = (p + 1) * VPG; continue; }
              const j = (i - p * VPG) * 3, at = pg[j];
              if (at > pr.atMax) break;
              checked++;
              const pk = pg[j + 2];
              if (!(pk & 7)) { const dur = pg[j + 1]; if (dur <= LTH) { cnt++; if (firstAt < 0) firstAt = at; } }
              i++;
            }
            const save = cx.fillRect; let n = 0, ys = [], ws = [];
            cx.fillRect = (x, y, w, h) => { n++; if (ys.length < 6) { ys.push(Math.round(y)); ws.push(Math.round(w)); } return save.call(cx, x, y, w, h); };
            try { draw2D(s2, t, hitY, colW, pps); } catch (e) { cx.fillRect = save; return 'draw2D threw: ' + e.message; }
            cx.fillRect = save;
            return { lo: pr.lo, atMax: pr.atMax, hitY, pps: pps, cnt, holes, checked, firstAt, pages: [...V.pages.keys()], drawn: n, ys, ws };
          } };`)(
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

/* ---------- driver ---------- */
const gen = (N) => {   // N notes, legacy-small or virtual-big by N; writes to disk, returns {path,size,name}
  const vlqb = (n) => { const r = [n & 0x7f]; n >>= 7; while (n) { r.push((n & 0x7f) | 0x80); n >>= 7; } return Buffer.from(r.reverse()); };
  const per = 8, bodyLen = 7 + N * per + 4;
  const fd = fs.openSync('/tmp/glue.mid', 'w');
  const buf = Buffer.allocUnsafe(1 << 22);
  let off = 0;
  const W = (s) => { if (off + s.length > buf.length) { fs.writeSync(fd, buf, 0, off); off = 0; } buf.set(s, off); off += s.length; };
  W(Buffer.from([0x4d,0x54,0x68,0x64,0,0,0,6,0,1,0,1,480 >> 8,480 & 255]));
  W(Buffer.from([0x4d,0x54,0x72,0x6b,(bodyLen >>> 24) & 255,(bodyLen >>> 16) & 255,(bodyLen >>> 8) & 255,bodyLen & 255]));
  W(Buffer.from([0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20]));
  const tmp = Buffer.allocUnsafe(per);
  for (let i = 0; i < N; i++) {
    tmp[0] = 2; tmp[1] = 0x90 | (i & 15); tmp[2] = 36 + ((i * 7) % 80); tmp[3] = 100;
    tmp[4] = 1; tmp[5] = 0x80 | (i & 15); tmp[6] = 36 + ((i * 7) % 80); tmp[7] = 0;
    W(tmp);
  }
  W(Buffer.from([0, 0xff, 0x2f, 0]));
  if (off) fs.writeSync(fd, buf, 0, off);
  fs.closeSync(fd);
  const st = fs.statSync('/tmp/glue.mid');
  const pure = { __path: '/tmp/glue.mid', size: st.size, name: N > 1e6 ? 'virt.mid' : 'small.mid' };
  pure.arrayBuffer = async () => { const b = fs.readFileSync(pure.__path); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  return pure;
};
const rects = () => { let s = 0; for (const k in counts) if (k.startsWith('fillRect:')) s += counts[k]; return s; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitReady(maxMs) {
  const t0 = Date.now(); let lastLog = 0;
  while (Date.now() - t0 < maxMs) {
    if (ST.song && !ST.building && ST.song.conv) return true;
    if (Date.now() - lastLog > 30000) { lastLog = Date.now(); console.log('  ...waiting ' + Math.round((Date.now() - t0) / 1000) + 's building=' + ST.building); }
    await sleep(200);
  }
  return false;
}
(async () => {
  let fails = 0;
  process.on('unhandledRejection', (e) => { console.log('UNHANDLED:', e && e.message); });
  const ok = (name, cond, extra = '') => { console.log((cond ? 'pass  ' : 'FAIL  ') + name + (extra ? '  ' + extra : '')); if (!cond) fails++; };

  /* ---- legacy small file through the REAL loadFile ---- */
  let f = gen(20000);
  await loadFile(Object.assign({}, f));   // legacy: the page calls f.arrayBuffer() itself
  ok('legacy: loadFile builds RAM song', await waitReady(20000), 'conv=' + (ST.song && ST.song.conv));
  if (ST.song) {
    counts.fillRect = 0;
    ST.tau = 1.5; ST.playing = true; drawBody(performance.now());
    const legacyRects = rects();
    ok('legacy: notes render (fillRects > 300)', legacyRects > 300, legacyRects + ' rects');
  }

  /* ---- virtual path: 34M notes (needs > 256 MB on disk) ---- */
  f = gen(34000000);
  console.log('fixture: ' + (f.size / 1e6).toFixed(1) + ' MB (VIRT_MIN 268.4 MB) -> virtual expected');
  const pure = { __path: f.__path, size: f.size, name: f.name };   // worker postMessage needs pure data (cloneable)
  await loadFile(pure);
  const t0 = Date.now();
  ok('virtual: loadFile routes to streaming worker', await waitReady(900000), 'loaded in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's conv=' + (ST.song && ST.song.conv));
  if (ST.song && ST.song.virt) {
    ST.pcap = false;                                    // particles pollute rect counts: kill them
    const songSave = ST.song; ST.song = null;
    for (let i = 0; i < 300; i++) drawBody(performance.now());   // decay every live particle
    counts.fillRect = 0; counts.noteish = 0; drawBody(performance.now());
    const base = rects(), baseN = counts.noteish || 0;
    const hist = {};
    for (const k in counts) if (k.includes(':3')) hist[k.split(':')[0]] = counts[k];
    console.log('baseline frame histogram cid3:', JSON.stringify(hist));
    ST.song = songSave;
    // paged draw at t=3s (music present)
    counts.fillRect = 0; counts.noteish = 0;
    ST.tau = 3; ST.playing = true; drawBody(performance.now());
    await sleep(400);                                   // pages arrive async; draw again
    counts.fillRect = 0; counts.noteish = 0;
    drawBody(performance.now());
    const virtRects = rects(), musicN = counts.noteish || 0;
    ok('virtual: notes render from paged windows', musicN > 40, musicN + ' note-geometry rects (chrome ' + base + ')');
    // far beyond content: only chrome should draw
    counts.fillRect = 0; counts.noteish = 0;
    ST.tau = ST.song.total + 50; drawBody(performance.now());
    const endN = counts.noteish || 0;
    ok('virtual: empty region draws ~no note rects', endN < musicN * 0.02, endN + ' note-geometry rects past end vs ' + musicN);
    // draw a sweep of positions — every sampled second must produce notes above chrome
    let allDraw = true, samples = 0;
    for (let tt = 10; tt < Math.min(ST.song.total - 5, 600); tt += 37) {
      counts.fillRect = 0; counts.noteish = 0;
      ST.tau = tt; drawBody(performance.now());
      await sleep(400);
      counts.fillRect = 0; counts.noteish = 0;
      ST.tau = tt + 0.001; drawBody(performance.now());   // epsilon: defeat the idle-frame skip
      samples++;
      if ((counts.noteish || 0) < 30) {
        allDraw = false;
        const V = ST.vw, atMin = Math.round((tt - 0.14) * 12000), atMax = Math.round((tt + 0.34) * 12000);
        const keys = [...V.pages.keys()];
        console.log('  weak @t=' + tt.toFixed(0) + ': noteish=' + counts.noteish + ' probe=' + JSON.stringify(api.probeVirt(tt)));
        counts.noteish = 0; ST.playing = true; ST.tau = tt + 0.001; drawBody(performance.now());
        console.log('  redraw now: noteish=' + counts.noteish + ' playing=' + ST.playing + ' live=' + ST.live + ' tau=' + ST.tau);
        for (const pk of keys) {
          const pg = V.pages.get(pk);
          let n = 0, first = -1, last = -1;
          for (let q = 0; q < pg.length; q++) { const at = pg[q * 3]; if (at >= atMin && at <= atMax) { n++; if (first < 0) first = at; last = at; } }
          console.log('    page ' + pk + ': recs=' + (pg.length / 3) + ' atRange=' + pg[0] + '..' + pg[(pg.length / 3 - 1) * 3] + ' inWindow=' + n + ' (' + first + '..' + last + ') winLen=' + pg.length);
        }
      }
    }
    ok('virtual: sweep of ' + samples + ' positions all render notes', allDraw);
    // offline-render batch fetch works
    const b0 = await api.vwGetBatch(0);
    ok('virtual: vwGetBatch returns a rec batch', b0 && b0.length === 8192 * 3 && b0[2] !== undefined, 'len=' + b0.length);
  } else {
    ok('virtual: song flagged virt', false, 'virt=' + (ST.song && ST.song.virt));
  }
  try { fs.unlinkSync('/tmp/glue.mid'); } catch (e) {}
  console.log(fails ? 'GLUE SMOKE: ' + fails + ' FAILURES' : 'GLUE SMOKE: all pass');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('HARNESS ERROR:', e.stack.split('\n').slice(0, 4).join(' | ')); process.exit(1); });
