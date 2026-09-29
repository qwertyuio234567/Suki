/* Execute the page's ENTIRE main script in node against a strict-global stub DOM.
   Any identifier the page references but never declares (and that isn't a real
   browser global) throws here — this is the check that would have caught the
   missing `const SRN, SRQ` that the extracted-block harness silently supplied. */
const fs = require('fs'), vm = require('vm'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const main = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));

function stub(name) {
  const f = function () { return stub(name + '()'); };
  return new Proxy(f, {
    get(t, p) {
      if (typeof p === 'symbol') return p === Symbol.toPrimitive ? () => 1 : p === Symbol.iterator ? function*(){} : undefined;
      if (p === 'length') return 0; if (p === 'value') return 1; if (p === 'files') return [];
      if (p === 'textContent' || p === 'innerHTML' || p === 'id' || p === 'nodeName') return '';
      if (p === 'width' || p === 'height') return 800; if (p === 'sampleRate') return 48000;
      if (p === 'currentTime') return 0; if (p === 'devicePixelRatio') return 1;
      return stub(name + '.' + String(p));
    },
    set() { return true; }, apply() { return stub(name + '()'); }, construct() { return stub(name + '()'); }
  });
}
const INTRINSICS = ['Math','JSON','Object','Array','Number','String','Boolean','Promise','Map','Set','WeakMap','WeakSet',
  'Int8Array','Uint8Array','Uint8ClampedArray','Int16Array','Uint16Array','Int32Array','Uint32Array','Float32Array',
  'Float64Array','ArrayBuffer','DataView','TextDecoder','TextEncoder','Error','TypeError','RangeError','SyntaxError',
  'ReferenceError','Date','RegExp','Symbol','BigInt','Proxy','Reflect','Function','parseInt','parseFloat','isNaN',
  'isFinite','decodeURIComponent','encodeURIComponent','atob','btoa','console','URL','Blob','File','FileReader',
  'structuredClone','queueMicrotask','setTimeout','clearTimeout','setInterval','clearInterval'];
const BROWSER = ['window','self','globalThis','document','location','navigator','performance','screen','history',
  'addEventListener','removeEventListener','dispatchEvent','requestAnimationFrame','cancelAnimationFrame','fetch',
  'matchMedia','getComputedStyle','localStorage','sessionStorage','innerWidth','innerHeight','devicePixelRatio',
  'scrollX','scrollY','scrollTo','alert','confirm','prompt','AudioContext','webkitAudioContext','AudioWorkletNode',
  'AudioWorkletProcessor','registerProcessor','sampleRate','Image','Audio','OffscreenCanvas','Path2D','DOMMatrix',
  'ResizeObserver','MutationObserver','IntersectionObserver','Worker','SharedWorker','MessageChannel','Event',
  'CustomEvent','PointerEvent','MouseEvent','KeyboardEvent','DragEvent','DragDrop','HTMLElement','CanvasRenderingContext2D'];

const misses = new Set();
const sandbox = Object.create(null);
sandbox.undefined = undefined; sandbox.NaN = NaN; sandbox.Infinity = Infinity;
for (const k of INTRINSICS) if (k in globalThis) sandbox[k] = globalThis[k];
for (const k of BROWSER) sandbox[k] = stub(k);
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
sandbox.location = { protocol: 'file:', href: 'file:///x/index.html', hostname: '' };
sandbox.document = stub('document');
sandbox.innerWidth = 1280; sandbox.innerHeight = 720; sandbox.devicePixelRatio = 1;
sandbox.performance = { now: () => Date.now() };

const ctx = vm.createContext(new Proxy(sandbox, {
  has(t, p) { return typeof p !== 'string' ? true : p in t; },   // strict: unknown globals must throw
  // V8's global-proxy lookup skips `has` and calls `get` straight through, so an
  // undeclared global reads as undefined instead of throwing. Record every miss and
  // fail afterwards (throwing inside the trap breaks global declaration instantiation).
  get(t, p) {
    if (typeof p === 'symbol') return p === Symbol.unscopables ? undefined : t[p];
    if (!(p in t)) { misses.add(p); return undefined; }
    return t[p];
  },
  set(t, p, v) { t[p] = v; return true; }
}));
try {
  vm.runInContext(main, ctx, { timeout: 20000, filename: 'index.html<main>' });
  // Node's contextify doesn't install the script's own hoisted function/var
  // declarations into a Proxy sandbox, so they show up as misses too. Subtract
  // every name the source itself declares; what remains is genuinely undeclared.
  const declared = new Set();
  for (const m of main.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of main.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of main.matchAll(/[,;{]\s*([A-Za-z_$][\w$]*)\s*=/g)) declared.add(m[1]);
  const real = [...misses].filter(n => !declared.has(n));
  if (real.length) {
    console.log('FAIL  page: main script reads ' + real.length + ' undeclared global(s): ' + real.join(', '));
    process.exit(1);
  }
  // functional checks through the REAL page pipeline (window.__mb)
  const mb = sandbox.__mb;
  if (!mb || typeof mb.parseMIDI !== 'function') { console.log('FAIL  page: window.__mb export missing'); process.exit(1); }
  const p128 = mb.PAL128;
  const tp = mb.TRKPAL;
  if (!Array.isArray(tp) || tp.length !== 256 || new Set(tp.map(c => c.join(','))).size !== 256) {
    console.log('FAIL  page: TRKPAL must be 256 distinct colors'); process.exit(1);
  }
  if (!Array.isArray(p128) || p128.length !== 128 || new Set(p128.map(c => c.join(','))).size !== 128) {
    console.log('FAIL  page: PAL128 must be 128 distinct colors'); process.exit(1);
  }
  // same-tick on/off micro note must survive pack with a 1-quarter-sample floor
  const vlq = n => { const r = [n & 0x7f]; n >>= 7; while (n) { r.push((n & 0x7f) | 0x80); n >>= 7; } return Buffer.from(r.reverse()); };
  const body = Buffer.concat([vlq(0), Buffer.from([0x90, 60, 100]), vlq(0), Buffer.from([0x80, 60, 0]), vlq(0), Buffer.from([0xFF, 0x2F, 0])]);
  const tl = Buffer.alloc(4); tl.writeUInt32BE(body.length);
  const trk = Buffer.concat([Buffer.from('MTrk'), tl, body]);
  const h = Buffer.alloc(14); Buffer.from('MThd').copy(h, 0); h.writeUInt32BE(6, 4); h.writeUInt16BE(1, 8); h.writeUInt16BE(1, 10); h.writeUInt16BE(480, 12);
  const bb = Buffer.concat([h, trk]);
  const sg = mb.beginPack(mb.parseMIDI(bb.buffer.slice(bb.byteOffset, bb.byteOffset + bb.byteLength)));
  while (!mb.packStep(sg).done);
  let mdur = -1; for (let i = 0; i < sg.conv; i++) if ((sg.out[i*3+2] & 7) === 0) { mdur = sg.out[i*3+1]; break; }
  if (mdur !== 1) { console.log('FAIL  page: micro note floor, dur=' + mdur); process.exit(1); }
  console.log('ok    page: runs end-to-end, 128 distinct colors, micro notes have no size limit');
  process.exit(0);
} catch (e) {
  const ln = /index\.html<main>:(\d+)/.exec(e.stack || '') || /<anonymous>:(\d+)/.exec(e.stack || '');
  console.log('FAIL  page: main script threw ' + e.constructor.name + ': ' + e.message + (ln ? ' (script line ' + ln[1] + ')' : ''));
  console.log((e.stack || '').split('\n').slice(1, 4).join('\n'));
  process.exit(1);
}
