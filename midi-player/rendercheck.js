/* Render guard: executes the REAL page script, then drives one draw() frame
   against a recording canvas and asserts note rectangles actually get painted.
   This is the bug class "notes invisible" — no bitmap, no gate, no excuses.  */
const fs = require('fs'), vm = require('vm'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const main = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));

const rects = [];
let curStyle = '';
const ctx2d = new Proxy({ fillStyle: '' }, {
  get(t, p) {
    if (p === 'fillRect') return (x, y, w, h) => rects.push([x, y, w, h, curStyle]);
    if (p === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
    return () => {};
  },
  set(t, p, v) { if (p === 'fillStyle') curStyle = String(v); return true; }
});
const rafs = [];
function stub(name) {
  const f = function () { return stub(name + '()'); };
  return new Proxy(f, {
    get(t, p) {
      if (typeof p === 'symbol') return p === Symbol.toPrimitive ? () => 1 : undefined;
      if (p === 'getContext') return (kind) => kind === '2d' ? ctx2d : null;   // force CPU fallback
      if (p === 'length') return 0; if (p === 'value') return 0.9; if (p === 'files') return [];
      if (['textContent','innerHTML','id','nodeName'].includes(p)) return '';
      if (['width','height'].includes(p)) return 800;
      return stub(name + '.' + String(p));
    },
    set() { return true; }, apply() { return stub(name + '()'); }, construct() { return stub(name + '()'); }
  });
}
const sandbox = Object.create(null);
for (const k of ['Math','JSON','Object','Array','Number','String','Boolean','Promise','Map','Set','Int32Array','Uint8Array',
 'Uint16Array','Int16Array','Int32Array','Uint32Array','Float32Array','Float64Array','Uint8ClampedArray','ArrayBuffer',
 'DataView','TextDecoder','TextEncoder','Error','TypeError','RangeError','Date','RegExp','Symbol','Function','parseInt',
 'parseFloat','isNaN','isFinite','decodeURIComponent','encodeURIComponent','console','URL','Blob','FileReader','structuredClone','queueMicrotask','setTimeout','clearTimeout'])
  if (k in globalThis) sandbox[k] = globalThis[k];
sandbox.document = stub('document');
sandbox.innerWidth = 1280; sandbox.innerHeight = 720; sandbox.devicePixelRatio = 1;
sandbox.location = { protocol: 'file:', href: 'file:///x/index.html' };
sandbox.addEventListener = () => {}; sandbox.performance = { now: () => 0 };
sandbox.requestAnimationFrame = (cb) => { rafs.push(cb); return rafs.length; };
sandbox.cancelAnimationFrame = () => {};
const g = new Proxy(sandbox, {
  has(t, p) { return typeof p !== 'string' ? true : p in t; },
  get(t, p) { if (typeof p === 'symbol') return p === Symbol.unscopables ? undefined : t[p]; return t[p]; },
  set(t, p, v) { t[p] = v; return true; }
});
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
vm.runInContext(main, vm.createContext(g), { timeout: 20000 });

// ---- build a real song through the real pipeline ----
const mb = sandbox.__mb;
function vlq(n) { const r = [n & 0x7f]; n >>= 7; while (n) { r.push((n & 0x7f) | 0x80); n >>= 7; } return Buffer.from(r.reverse()); }
const evs = [];
for (let i = 0; i < 40; i++) evs.push([i * 120, [0x90, 40 + (i % 40), 100]], [i * 120 + 100, [0x80, 40 + (i % 40), 0]]);
const body = Buffer.concat([...evs.flatMap(e => [vlq(0), Buffer.from(e[1])]), vlq(0), Buffer.from([0xFF, 0x2F, 0])]);
const tl = Buffer.alloc(4); tl.writeUInt32BE(body.length);
const h = Buffer.alloc(14); Buffer.from('MThd').copy(h, 0); h.writeUInt32BE(6, 4); h.writeUInt16BE(1, 8); h.writeUInt16BE(1, 10); h.writeUInt16BE(480, 12);
const bb = Buffer.concat([h, Buffer.from('MTrk'), tl, body]);
const sg = mb.beginPack(mb.parseMIDI(bb.buffer.slice(bb.byteOffset, bb.byteOffset + bb.byteLength)));
while (!mb.packStep(sg).done);

function frame(song) {
  const ST = mb.ST;
  ST.song = song; ST.live = false; ST.tau = 0; ST.playing = false; ST.colorMode = 0; ST.pps = 170; ST.pcap = 0; ST.bb = 0;
  rects.length = 0;
  rafs[rafs.length - 1](0);                                   // one frame of the real draw()
  return rects.filter(r => /^rgba\(/.test(r[4]));   // exclude the border ring
}

// --- case 1: sparse window, every note must appear ---
let notes = frame(sg);
const bad = notes.filter(r => !(r[2] > 0) || !(r[3] > 0));
console.log(`sparse: note rects ${notes.length} (40 notes + flashes); bad dims ${bad.length}`);
if (notes.length < 40) { console.log('FAIL  render: sparse window painted too few notes'); process.exit(1); }
if (bad.length) { console.log('FAIL  render: rects with non-positive size'); process.exit(1); }

// --- case 2: black-midi density, 200k notes inside the visible window ---
const D = 200000;
const big = new Int32Array(D * 3);
for (let i = 0; i < D; i++) { big[i*3] = (i % 400) * 30; big[i*3+1] = 4; big[i*3+2] = (((i * 7) % 128) << 14) | (100 << 3); }
const t0 = Date.now();
notes = frame({ out: big, conv: D, n: D, total: 60, lanes: {}, m: sg.m });
const ms = Date.now() - t0;
console.log(`dense:  ${D} notes in window -> ${notes.length} rects drawn in ${ms}ms`);
if (notes.length < 90000 || notes.length > 90200) { console.log('FAIL  render: dense window must draw the 90k budget, got ' + notes.length); process.exit(1); }
if (ms > 8000) { console.log('FAIL  render: dense frame too slow'); process.exit(1); }
// --- case 3: a 10s drone mid-file must NOT be culled (long notes never cut) ---
{
  const evs = [];
  for (let i = 0; i < 300; i++) evs.push([4700 + (i % 100), [0x90, 60 + (i % 20), 100]], [4700 + (i % 100), [0x80, 60 + (i % 20), 0]]);
  const body = Buffer.concat([
    vlq(0), Buffer.from([0x90, 36, 100]), vlq(9600), Buffer.from([0x80, 36, 0]),   // 10 s drone, pitch 36
    ...evs.flatMap(e => [vlq(0), Buffer.from(e[1])]), vlq(0), Buffer.from([0xFF, 0x2F, 0])
  ]);
  // note: trackBytes-style manual build needs proper deltas; use two tracks instead
  const trkA = Buffer.concat([vlq(0), Buffer.from([0x90, 36, 100]), vlq(9600), Buffer.from([0x80, 36, 0]), vlq(0), Buffer.from([0xFF, 0x2F, 0])]);
  const mk = (buf) => { const l = Buffer.alloc(4); l.writeUInt32BE(buf.length); return Buffer.concat([Buffer.from('MTrk'), l, buf]); };
  const trkB = Buffer.concat(evs.flatMap(e => [vlq(e[0]), Buffer.from(e[1])]), );
  const trkBfull = Buffer.concat([...evs.flatMap(e => [vlq(0), Buffer.from(e[1])]), vlq(0), Buffer.from([0xFF, 0x2F, 0])]);
  const h = Buffer.alloc(14); Buffer.from('MThd').copy(h, 0); h.writeUInt32BE(6, 4); h.writeUInt16BE(1, 8); h.writeUInt16BE(2, 10); h.writeUInt16BE(480, 12);
  const bb = Buffer.concat([h, mk(trkA), mk(trkBfull)]);
  const song = mb.beginPack(mb.parseMIDI(bb.buffer.slice(bb.byteOffset, bb.byteOffset + bb.byteLength)));
  while (!mb.packStep(song).done);
  if (!song.longN) { console.log('FAIL  render: drone not registered in sustained array'); process.exit(1); }
  const st3 = mb.ST;                                                     // look at t=5s: drone started 5s ago
  st3.song = song; st3.live = false; st3.tau = 5; st3.playing = false; st3.colorMode = 0; st3.pps = 170; st3.pcap = 0; st3.bb = 0;
  rects.length = 0;
  rafs[rafs.length - 1](0);
  const drone = rects.filter(r => r[0] >= 360 && r[0] <= 364 && r[3] > 298);   // fill OR border ring, any border width
  console.log('drone:  rects at pitch36 taller than 300px: ' + drone.length);
  if (!drone.length) { console.log('FAIL  render: long note culled mid-file (the cutting bug)'); process.exit(1); }
}
// --- case 4: particles spawn on strikes, stay bounded, die out ---
{
  const evs = [];
  for (let i = 0; i < 40; i++) evs.push([0, [0x90, 21 + i * 2, 100]]);
  const trk = Buffer.concat([...evs.flatMap(e => [vlq(0), Buffer.from(e[1])]), vlq(0), Buffer.from([0xFF, 0x2F, 0])]);
  const mk = (buf) => { const l = Buffer.alloc(4); l.writeUInt32BE(buf.length); return Buffer.concat([Buffer.from('MTrk'), l, buf]); };
  const h = Buffer.alloc(14); Buffer.from('MThd').copy(h, 0); h.writeUInt32BE(6, 4); h.writeUInt16BE(1, 8); h.writeUInt16BE(1, 10); h.writeUInt16BE(480, 12);
  const file = Buffer.concat([h, mk(trk)]);
  const song = mb.beginPack(mb.parseMIDI(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)));
  while (!mb.packStep(song).done);
  const st4 = mb.ST;
  st4.pcap = 1024; st4.bb = 0; st4.song = song; st4.live = false; st4.tau = 0; st4.playing = false; st4.colorMode = 0; st4.pps = 170;
  rects.length = 0;
  rafs[rafs.length - 1](0);                                  // one frame: 40 strikes x 6 particles
  const spawned = mb.PT.n;
  console.log('particles: spawned ' + spawned + ', pool ' + mb.PT.x.length);
  if (spawned !== 240) { console.log('FAIL  render: expected 240 particles (40 strikes x 6)'); process.exit(1); }
  for (let f = 0; f < 90; f++) rafs[rafs.length - 1](0);     // ~1.5s of frames -> all decayed
  console.log('particles: alive after 90 frames -> ' + mb.PT.n);
  if (mb.PT.n !== 0) { console.log('FAIL  render: particles must fully decay (bounded system)'); process.exit(1); }
  // backward time jump (loop wrap / seek): stamps from the "future" must not starve spawns
  for (let p2 = 0; p2 < 128; p2++) mb.PT.last[p2] = 999;     // simulate post-loop stale stamps
  rects.length = 0;
  rafs[rafs.length - 1](0);
  console.log('particles: after backward jump -> ' + mb.PT.n);
  if (mb.PT.n < 240) { console.log('FAIL  render: particles starve after loop/seek backward jump'); process.exit(1); }
}

// --- case 5: held long notes keep their key lit ---
{
  const evs = [];
  for (let i = 0; i < 40; i++) evs.push([0, [0x90, 21 + i * 2, 100]], [9600, [0x80, 21 + i * 2, 0]]);
  evs.sort((a, b) => a[0] - b[0]);
  let lastT = 0;
  const trk = Buffer.concat([...evs.flatMap(e => { const d = e[0] - lastT; lastT = e[0]; return [vlq(d), Buffer.from(e[1])]; }), vlq(0), Buffer.from([0xFF, 0x2F, 0])]);
  const mk = (buf) => { const l = Buffer.alloc(4); l.writeUInt32BE(buf.length); return Buffer.concat([Buffer.from('MTrk'), l, buf]); };
  const h = Buffer.alloc(14); Buffer.from('MThd').copy(h, 0); h.writeUInt32BE(6, 4); h.writeUInt16BE(1, 8); h.writeUInt16BE(1, 10); h.writeUInt16BE(480, 12);
  const file = Buffer.concat([h, mk(trk)]);
  const song = mb.beginPack(mb.parseMIDI(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)));
  while (!mb.packStep(song).done);
  const st5 = mb.ST;
  st5.pcap = 0; st5.bb = 0; st5.song = song; st5.live = false; st5.tau = 0.5; st5.playing = false; st5.colorMode = 0; st5.pps = 170;
  mb.FLASH.fill(0);
  rafs[rafs.length - 1](0);
  let lit = 0;
  for (let p = 0; p < 128; p++) if (mb.FLASH[p] === 1) lit++;
  console.log('held keys fully lit: ' + lit);
  if (lit !== 40) { console.log('FAIL  render: held long notes must keep their keys lit'); process.exit(1); }
}
console.log('ok    render: notes visible at sparse AND black-midi density; long notes never cut');
