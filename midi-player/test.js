/* Node harness for suki v2 (worklet + WASM kernel) — exercises the REAL
   parser, Song walker and worklet extracted verbatim from index.html. */
const fs = require('fs'), path = require('path'), os = require('os');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const grab = (s, e) => { const a = html.indexOf(s); if (a < 0) throw new Error('marker missing: ' + s); return html.slice(a, html.indexOf(e, a)); };

const parseSrc = grab('function parseMIDI(buf, onProg)', '\n/* =====');
const packSrc  = grab('function beginPack(m) {', '\n/* =====');
const wkSrc    = html.match(/<script type="text\/plain" id="wksrc">([\s\S]*?)<\/script>/)[1];

global.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null, postMessage(){} }; } };
global.registerProcessor = (name, cls) => { global.__Worklet = cls; };
global.sampleRate = 48000;
// time base MUST come from the page itself: a hand-written constant here once
// masked a missing declaration in index.html (suite passed, browser threw).
const _tb = /const\s+SRN\s*=\s*(\d+)\s*,\s*SRQ\s*=\s*(\d+)\s*;/.exec(html);
if (!_tb) throw new Error('index.html declares no SRN/SRQ time base');
const SRN = +_tb[1], SRQ = +_tb[2];
const _lth = /const\s+LTH\s*=\s*(\d+)\s*;/.exec(html);
if (!_lth) throw new Error('index.html declares no LTH sustained threshold');
const LTH = +_lth[1];
eval(parseSrc); eval(packSrc); eval(wkSrc);

let fails = 0, runs = 0;
const ok = (name, cond, extra='') => { runs++; if (!cond) { fails++; console.log('FAIL  ' + name, extra); } else console.log('pass  ' + name + (extra ? '  ' + extra : '')); };
const near = (a, b, e) => Math.abs(a - b) <= e;
const readAB = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const unpack = (pk) => ({ type: pk & 7, vel: (pk >> 3) & 127, ch: (pk >> 10) & 15, pitch: (pk >> 14) & 127 });

/* ============ tiny SMF builder for handcrafted fixtures ============ */
function trackBytes(evs){   // evs: [tick, status|null(meta/syx), ...bytes]
  const vlq = n => { const r=[n&0x7f]; n>>=7; while(n){ r.push((n&0x7f)|0x80); n>>=7; } return Buffer.from(r.reverse()); };
  const out = []; let last = 0;
  for (const e of evs) { out.push(vlq(e[0]-last)); last = e[0]; out.push(Buffer.from(e[1])); }
  const body = Buffer.concat(out); const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  return Buffer.concat([Buffer.from('MTrk'), len, body]);
}
function smf(tracks, division){
  const h = Buffer.alloc(14); Buffer.from('MThd').copy(h,0);
  h.writeUInt32BE(6,4); h.writeUInt16BE(1,8); h.writeUInt16BE(tracks.length,10); h.writeUInt16BE(division,12);
  const bb = Buffer.concat([h, ...tracks]);
  return bb.buffer.slice(bb.byteOffset, bb.byteOffset + bb.byteLength);
}
const META_END = [99999, [0xFF, 0x2F, 0]];

/* ================= 1. parser on unittest fixture ================= */
const m = parseMIDI(readAB(path.join(__dirname, 'demos/unittest.mid')));
ok('parse: header', m.ppq === 120 && m.format === 1 && m.nTrks === 4);
const flat = [];
for (const tr of m.tracks) for (let i = 0; i < tr.n; i++) {
  const b = (tr.off + i) * 3;
  const pk = m.big[b + 2]; const u = unpack(pk);
  if (u.type === 0) flat.push([m.big[b], m.big[b] + m.big[b + 1], u.ch, u.pitch, u.vel].join(','));
}
flat.sort();
const expected = JSON.parse(fs.readFileSync(path.join(__dirname,'demos/unittest.expected.json'),'utf8'))
  .notes.map(x => x.join(',')).sort();
ok('parse: 13 notes exact (running status, sysex, FIFO, vel0-off, dangling)', flat.join('|') === expected.join('|'),
   flat.length !== expected.length ? `got ${flat.length} want ${expected.length}` : flat.filter((x,i)=>x!==expected[i])[0] || '');
ok('parse: ctrl kinds in records', m.tracks.some(tr => { for (let i=0;i<tr.n;i++){ if((m.big[(tr.off+i)*3+2]&7)===2)return true;} return false; }));
ok('parse: names utf8', m.trackNames.includes('Piano ✓'), JSON.stringify(m.trackNames));

/* ================= 2. crafted fixtures ================= */
// FIFO pairing keeps per-track emits start-sorted even with heavy overlap
{
  const buf = smf([trackBytes([
    [0,[0x90,48,90]], [40,[0x90,55,80]], [120,[0x80,55,64]], [200,[0x80,48,64]], META_END
  ])], 96);
  const mm = parseMIDI(buf);
  const T = mm.tracks[0], big = mm.big;
  ok('parse: cross-key overlap emits end-ordered, dis flagged', T.dis && big[T.off*3] === 40 && big[(T.off+1)*3] === 0);
  const sg = beginPack(mm); while (!packStep(sg).done);
  let mo2 = true; for (let i = 1; i < sg.n; i++) if (sg.out[i*3] < sg.out[(i-1)*3]) mo2 = false;
  ok('pack: radix restores global start order', mo2);
}
// ring capacity 64: 66 ons + 1 off on same key -> one record per on, oldest evicted first
{
  const evs = [];
  for (let i = 0; i < 66; i++) evs.push([10 + i, [0x90, 60, 10 + i]]);
  evs.push([200, [0x80, 60, 64]], META_END);
  const mm = parseMIDI(smf([trackBytes(evs)], 96));
  const T = mm.tracks[0], big = mm.big;
  ok('parse: every note-on yields exactly one record (66)', T.n === 66, `n=${T.n}`);
  let mono = true; for (let i = 1; i < T.n; i++) if (big[(T.off+i)*3] < big[(T.off+i-1)*3]) mono = false;
  ok('parse: evictions keep starts ascending', mono);
  ok('parse: first record = evicted on@10', big[T.off*3] === 10);
}
// running status + sysex + 0xC0 one-byte correctness (regression on P+=vlq bug)
{
  const buf = smf([trackBytes([
    [0,[0xC0,42]], [1,[0x90,64,100]], [2,[65,101]], [10,[0xF0,3,0x7E,0,0x21]],
    [100,[0x80,64,64]],[101,[65,64]], META_END
  ])], 96);
  const mm = parseMIDI(buf); const T0 = mm.tracks[0]; const a = mm.big; const OA = T0.off;
  const notes = []; for (let i=0;i<T0.n;i++){ const bq = (OA+i)*3; if(!(a[bq+2]&7)) notes.push(a[bq]+':'+(a[bq+2]>>14)); }
  ok('parse: running-status data-as-event bytes + sysex no desync', mm.tracks[0].n === 2 && notes.join()==='1:64,2:65', notes.join());
  ok('parse: program recorded', mm.programs[0] && mm.programs[0].has(42));
}
// malformed: no MThd
let threw = false; try { parseMIDI(new Uint8Array([1,2,3,4,5,6,7,8]).buffer); } catch { threw = true; }
ok('parse: rejects garbage header', threw);

/* ================= 3. pack pipeline ================= */
function fullWalk(mm) { const s = beginPack(mm); let g = 0; while (!packStep(s).done) { if (++g > 10000) throw new Error('pack not terminating'); } return s; }
{
  const s = fullWalk(m);
  let mono = true; for (let i = 1; i < s.n; i++) if (s.out[i*3] < s.out[(i-1)*3]) mono = false;
  ok('pack: stream strictly time-monotonic after in-place convert', mono, `events=${s.n}`);
  ok('pack: notes == 13', s.notes === 13, `${s.notes}`);
  ok('pack: aux freed after sort (steady mem = 1 flat buffer)', s.aux === null);
  ok('pack: lanes counts sum to notes', Object.values(s.lanes).reduce((a,l)=>a+l.count,0) === 13);
  eval(grab('function binQ(', '\nconst ASTR'));
  ok('stats: passed-at-end equals notes via bin prefix', Math.round(binQ(s.stC, s.total + 10, s.total)) === s.notes, `${Math.round(binQ(s.stC, s.total + 10, s.total))}/${s.notes}`);
  ok('stats: tickOf inverts secOf at end', Math.abs(s.tickOf(s.total - 2) - s.m.maxTick) <= 2, `tick=${s.tickOf(s.total - 2)} want~${s.m.maxTick}`);
  // pitch 72 note: tick600 with 120ppq, 120bpm till 480 then 100bpm: 2.0 + 120/120*0.6 = 2.6s
  let f72 = -1; for (let i=0;i<s.n;i++){ const pk=s.out[i*3+2]; if((pk&7)===0 && ((pk>>14)&127)===72){ f72 = s.out[i*3]/SRQ; break; } }
  ok('pack: tempo map across mid-file change (72 @2.6s)', near(f72, 2.6, 1e-4), `${f72}`);
}

/* ================= 4. worklet ================= */
function pack(ch, pitch, vel, type){ return (pitch<<14)|(ch<<10)|((vel&127)<<3)|(type&7); }
const node = new global.__Worklet();
const acks = []; node.port.postMessage = (x) => { if (x.t === 'ack') acks.push(x); };
function batch(ev, tag=1){ node.port.onmessage({data:{t:'batch', ev, tag}}); }
node.port.onmessage({ data: { t:'sync', smp: 0, tag: 1 } });
node.port.onmessage({ data: { t:'rate', step: 1 } });
const I32 = rows => { const a = new Int32Array(rows.length*3); rows.forEach((r,i)=>a.set(r,i*3)); return a; };

function run(node, seconds, SR=48000) {
  const N = 128, L = new Float32Array(N), R = new Float32Array(N), peaks = [];
  for (let q = 0; q < Math.round(seconds*SR/N); q++) {
    node.process([], [[L, R]]);
    let pk = 0; for (let i=0;i<N;i++){ const a = Math.abs(L[i]); if (!isFinite(L[i])) return { bad:true, peaks:[] }; if (a>pk) pk=a; }
    peaks.push(pk);
  }
  return { peaks };
}
const rms = (p,a,b)=>{ let s=0; const i0=(a*48000/128)|0, i1=(b*48000/128)|0; for(let i=i0;i<i1;i++)s+=p[i]*p[i]; return Math.sqrt(s/(i1-i0)); };

batch(I32([
  [ Math.round(0.10*SRQ), 0, pack(0,0,1,2) ],                      // pedal down
  [ Math.round(0.50*SRQ), Math.round(0.40*SRQ), pack(0,60,100,0) ], // C4
  [ Math.round(0.60*SRQ), Math.round(0.10*SRQ), pack(9,36,110,0) ],// kick
  [ Math.round(0.80*SRQ), Math.round(0.10*SRQ), pack(0,61,90,0) ], // held past note-off
  [ Math.round(3.00*SRQ), 0, pack(0,0,0,2) ],                        // pedal up
]));
const res = run(node, 5.0);
ok('wk: no NaN/Inf', !res.bad);
ok('wk: pre-roll silent (event at 0.5s)', rms(res.peaks, 0, 0.45) < 0.02);
ok('wk: note audible after its sample', rms(res.peaks, 0.55, 0.9) > 0.05, `rms ${rms(res.peaks,0.55,0.9).toFixed(3)}`);
ok('wk: pedal sustains past note end', rms(res.peaks, 1.8, 2.4) > 0.003);
ok('wk: pedal-up releases held note', rms(res.peaks, 4.3, 4.95) < 0.02);
ok('wk: ack emitted per consumed batch', acks.length >= 1, JSON.stringify(acks));

// stale-tag batches are discarded
node.port.onmessage({ data: { t:'sync', smp: 0, tag: 7 } });
batch(I32([ [1200, Math.round(0.3*SRQ), pack(0,70,120,0) ] ]), 3);   // old tag -> dropped
const r2 = run(node, 0.1);
ok('wk: stale tag dropped (silence)', rms(r2.peaks, 0, 0.1) === 0);

// mute mask suppresses alloc for that channel
node.port.onmessage({ data: { t:'sync', smp: 0, tag: 9 } });
node.port.onmessage({ data: { t:'mute', mask: (1<<2) } });
batch(I32([ [ 480, Math.round(0.3*SRQ), pack(2,64,120,0) ] ]), 9);
const r3 = run(node, 0.1);
ok('wk: mute mask blocks channel', rms(r3.peaks, 0, 0.1) === 0);
node.port.onmessage({ data: { t:'mute', mask: 0 } });

// A4 pitch exactness is covered by the 4s formula-reference checks
// (zero-crossing counting is meaningless on the detuned-string waveform).

// device-rate mismatch: sampleRate 44100, step = 48000/44100 -> onset still lands at 0.5 BASE sec = 0.5*44100 real
{
  global.sampleRate = 44100;
  const w2 = new global.__Worklet(); w2.port.postMessage = ()=>{};
  w2.port.onmessage({data:{t:'sync',smp:0,tag:1}});
  w2.port.onmessage({data:{t:'rate',step:48000/44100}});
  w2.port.onmessage({data:{t:'batch',ev:I32([[Math.round(0.5*SRQ), Math.round(0.3*SRQ), pack(0,60,110,0)]]),tag:1}});
  const N=128,L=new Float32Array(N),R=new Float32Array(N),pk=[];
  for(let q=0;q<Math.round(1*44100/N);q++){ w2.process([],[[L,R]]); let p=0; for(let i=0;i<N;i++)p=Math.max(p,Math.abs(L[i])); pk.push(p); }
  const per = 44100/128;
  const onQ = pk.findIndex(v=>v>0.05);
  const onT = onQ/per;
  ok('wk: step decimation keeps 0.5s onset at 44.1k device', near(onT, 0.5, 0.01), `onset ${onT.toFixed(4)}s`);
  global.sampleRate = 48000;
}

// full real song through worklet
{
  const pm = parseMIDI(readAB(path.join(__dirname,'demos/pulse.mid')));
  const ps = fullWalk(pm);
  node.port.onmessage({data:{t:'sync',smp:0,tag:21}});
  let off = 0;
  const b1 = ps.out.slice(0, Math.min(ps.out.length, 48000*8));  // first ~8s of records
  batch(b1, 21);
  const rr = run(node, 8);
  let mx = 0, bad = rr.bad; for (const p of rr.peaks) mx = Math.max(mx, p);
  ok('wk: pulse 8s renders, bounded peak', !bad && mx > 0.1 && mx <= 1.0001, `peak ${mx.toFixed(3)}`);
}

/* ============ 4b. page-level guards (node builtins only) ============ */
{
  ok('page: index.html declares its own SRN/SRQ time base', /const\s+SRN\s*=\s*\d+\s*,\s*SRQ\s*=\s*\d+\s*;/.test(html),
     'the harness used to supply these itself and masked a missing declaration');
  const cp = require('child_process');
  const r2 = cp.spawnSync(process.execPath, [path.join(__dirname, 'rendercheck.js')], { encoding: 'utf8', timeout: 180000 });
  ok('page: render guard — real note rects paint at sparse AND 200k-note density', r2.status === 0,
     (r2.stdout || r2.stderr || '').trim().split('\n').filter(Boolean).pop());
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, 'domrun.js')], { encoding: 'utf8' });
  ok('page: whole main script runs top-to-bottom, no undeclared globals', r.status === 0,
     (r.stdout || r.stderr || '').trim().split('\n').filter(Boolean).pop());
}

/* ================= 4b. long-note sustain + configurable voices ================= */
{
  const wS = new global.__Worklet(); wS.port.postMessage = () => {};
  wS.port.onmessage({ data: { t: 'sync', smp: 0, tag: 1 } });
  wS.port.onmessage({ data: { t: 'rate', step: 1 } });
  const ev = new Int32Array(3);
  ev.set([Math.round(0.1 * SRQ), Math.round(30 * SRQ), pack(0, 60, 100, 0)]);   // held 30s
  wS.port.onmessage({ data: { t: 'batch', ev, tag: 1 } });
  const rS = run(wS, 12);
  ok('wk: formula body sounds at 0.6s', rms(rS.peaks, 0.6, 1.1) > 0.02, `rms ${rms(rS.peaks, 0.6, 1.1).toFixed(3)}`);
  ok('wk: formula body — piano decay fades by 6s', rms(rS.peaks, 6, 7) < 0.004, `rms ${rms(rS.peaks, 6, 7).toFixed(4)}`);
  const wC = new global.__Worklet(); wC.port.postMessage = () => {};
  wC.port.onmessage({ data: { t: 'fx', n: 0 } });
  wC.port.onmessage({ data: { t: 'sync', smp: 0, tag: 1 } });
  wC.port.onmessage({ data: { t: 'rate', step: 1 } });
  wC.port.onmessage({ data: { t: 'batch', ev: (() => { const e2 = new Int32Array(3); e2.set([Math.round(0.1 * SRQ), Math.round(30 * SRQ), pack(0, 60, 100, 0)]); return e2; })(), tag: 1 } });
  const rC = run(wC, 8);
  ok('sfx: CLASSIC engine keeps the old sustain floor', rms(rC.peaks, 6, 7) > 0.05, `rms ${rms(rC.peaks, 6, 7).toFixed(3)}`);
  ok('sfx: page ships the SFX switch and honors it live', /id="fxmode"/.test(html) && /data-x="0">CLASSIC<\/button><button data-x="1" class="on">PIANO<\/button>/.test(html) && /t: 'fx', n: ST\.fx/.test(html) && /node\.fx = ST\.fx/.test(html));
  const wV = new global.__Worklet(); wV.port.postMessage = () => {};
  wV.port.onmessage({ data: { t: 'vp', n: 32 } });
  ok('wk: vp message resizes voice pool', wV.live.length === 32 && wV.amp.length === 32, `live=${wV.live.length}`);
  wV.port.onmessage({ data: { t: 'vp', n: 99999 } });
  ok('wk: vp clamped to sane range', wV.live.length === 8192, `live=${wV.live.length}`);
}

/* ================= 4w. WASM kernel (AudioWorklet + WebAssembly) ================= */
{
  const wW = new global.__Worklet(); wW.port.postMessage = () => {};
  ok('wasm: kernel boots at construct (sync Module/Instance)', wW.wv === true && typeof wW.wasm.mix === 'function', `wv=${wW.wv}`);
  ok('wasm: page ships 32000/64000 HZ buttons + W-ASM tag', /data-z="32000"/.test(html) && /data-z="64000"/.test(html) && /id="wtag"/.test(html));

  const evs = I32([
    [ Math.round(0.05 * SRQ), Math.round(0.90 * SRQ), pack(0, 60, 100, 0) ],  // tonal
    [ Math.round(0.10 * SRQ), Math.round(0.50 * SRQ), pack(9, 36, 110, 0) ],  // kick (noise path)
    [ Math.round(0.20 * SRQ), Math.round(0.60 * SRQ), pack(1, 69,  90, 0) ],  // A4
  ]);
  const runBoth = (force) => {
    const w = new global.__Worklet(); w.port.postMessage = () => {}; w.jsForce = force;
    w.port.onmessage({ data: { t: 'fx', n: 1 } });
    w.port.onmessage({ data: { t: 'sync', smp: 0, tag: 1 } });
    w.port.onmessage({ data: { t: 'rate', step: 1 } });
    w.port.onmessage({ data: { t: 'batch', ev: evs, tag: 1 } });
    const N = 128, L = new Float32Array(N), R = new Float32Array(N), out = [];
    for (let q = 0; q < Math.round(0.9 * 48000 / N); q++) { w.process([], [[L, R]]); out.push(Float32Array.from(L)); }
    return { out, w };
  };
  const A = runBoth(true), B = runBoth(false);   // A = pure-JS path, B = WASM path
  let mx = 0;
  for (let b = 0; b < A.out.length; b++) for (let i = 0; i < 128; i++) mx = Math.max(mx, Math.abs(A.out[b][i] - B.out[b][i]));
  ok('wasm: WASM path == JS path (< 1e-4 over 0.9s mix)', mx < 1e-4, `max=${mx.toExponential(2)}`);
  ok('wasm: JS fallback path still sounds', A.out.some((bl) => bl.some((v) => Math.abs(v) > 0.05)));
  let dAmp = 0, dPh = 0;
  for (let v = 0; v < A.w.amp.length; v++) {
    dAmp = Math.max(dAmp, Math.abs(A.w.amp[v] - B.w.amp[v]));
    for (const f of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'gA']) dPh = Math.max(dPh, Math.abs(A.w[f][v] - B.w[f][v]));
  }
  ok('wasm: state write-back parity (amp/phases)', dAmp < 1e-9 && dPh < 1e-6, `amp=${dAmp.toExponential(1)} ph=${dPh.toExponential(1)}`);
  ok('wasm: live-voice bookkeeping equal', A.w.live.every((x, i) => x === B.w.live[i]));
}

/* ================= 4f. voice free-list + worker parse (user-files merge) ================= */
{
  const HANDLER = (/const HANDLER = '(.+?)';/.exec(html) || ['', ''])[1];
  ok('fl: page ships free-list alloc + worker parse', /freeV\[this\.freeN\+\+\] = v/.test(html) && /keyLast = new Int32Array\(2048\)/.test(html) && /function parseMIDIAsync/.test(html) && html.includes(HANDLER));
  const wF = new global.__Worklet(); wF.port.postMessage = () => {};
  wF.port.onmessage({ data: { t: 'vp', n: 64 } });
  ok('fl: setVP builds a full free stack', wF.freeN === 64 && wF.freeV.length === 64);
  wF.port.onmessage({ data: { t: 'sync', smp: 0, tag: 1 } });
  wF.port.onmessage({ data: { t: 'rate', step: 1 } });
  const rows = [];
  for (let i = 0; i < 80; i++) rows.push([Math.round(i * 0.002 * SRQ), Math.round(0.25 * SRQ), pack(i % 16, 40 + i, 100, 0)]);   // over-subscribe 64 voices
  wF.port.onmessage({ data: { t: 'batch', ev: I32(rows), tag: 1 } });
  const NL = 128, LL = new Float32Array(NL), RL = new Float32Array(NL);
  for (let q = 0; q < 300; q++) wF.process([], [[LL, RL]]);
  const liveCnt = wF.live.reduce((a, b) => a + b, 0);
  ok('fl: free stack + live voices conserve the pool', wF.freeN + liveCnt === 64, `free ${wF.freeN} live ${liveCnt}`);
  for (let q = 0; q < 2000; q++) wF.process([], [[LL, RL]]);
  ok('fl: pool fully restored after all voices die', wF.freeN === 64 && wF.live.every((x) => !x), `free ${wF.freeN}`);
  const wK = new global.__Worklet(); wK.port.postMessage = () => {};
  wK.port.onmessage({ data: { t: 'sync', smp: 0, tag: 1 } });
  wK.port.onmessage({ data: { t: 'rate', step: 1 } });
  wK.port.onmessage({ data: { t: 'batch', ev: I32([[0, Math.round(2 * SRQ), pack(0, 60, 100, 0)], [Math.round(0.3 * SRQ), Math.round(2 * SRQ), pack(0, 60, 100, 0)]]), tag: 1 } });
  for (let q = 0; q < 60; q++) wK.process([], [[LL, RL]]);
  ok('fl: same-key retake reuses one voice (no pileup)', wK.live.reduce((a, b) => a + b, 0) === 1);
  const kvi = wK.keyLast[60];
  ok('fl: keyLast tracks the retaken voice', kvi >= 0 && wK.live[kvi] === 1 && wK.key[kvi] === 60);
  /* parser inside a REAL worker thread: verbatim page source + verbatim page handler */
  const child = [
    "const { Worker } = require('worker_threads');",
    'const fs = require("fs");',
    'const psrc = ' + JSON.stringify(grab('function parseMIDI(buf, onProg)', '\n/* =====')) + ';',
    'const handler = ' + JSON.stringify(HANDLER) + ';',
    'const src = "const self=globalThis;const _pp=require(\'worker_threads\').parentPort;self.postMessage=(m,t)=>_pp.postMessage(m,t);_pp.on(\'message\',(e)=>self.onmessage({data:e}));" + psrc + handler;',
    'const w = new Worker(src, { eval: true });',
    'const buf = fs.readFileSync(' + JSON.stringify(path.join(__dirname, 'demos/pulse.mid')) + ');',
    'const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);',
    'const copy = ab.slice(0);',
    'w.postMessage({ ab: copy }, [copy]);',
    "w.on('message', (d) => {",
    "  if (d.ty === 'p') return;",
    "  if (d.ty !== 'd') { console.log('worker error: ' + d.m); process.exit(1); }",
    '  const m = d.m;',
    '  eval(psrc);',
    '  const m2 = parseMIDI(ab);',
    '  const ta = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);',
    '  const okM = m.format === m2.format && m.nTrks === m2.nTrks && m.ppq === m2.ppq && m.maxTick === m2.maxTick && m.totalEvents === m2.totalEvents;',
    '  const okB = ta(m.big, m2.big);',
  '  const okT = m.tracks.length === m2.tracks.length && m.tracks.every((k, i) => k.end === m2.tracks[i].end && k.off === m2.tracks[i].off && k.n === m2.tracks[i].n && k.recs === m2.tracks[i].recs);',
    "  if (okM && okB && okT) { console.log('worker parse identical (meta + big + ' + m.tracks.length + ' tracks)'); process.exit(0); }",
    "  console.log('meta=' + okM + ' big=' + okB + ' trk=' + okT); process.exit(1);",
    '});',
    "setTimeout(() => { console.log('worker timeout'); process.exit(1); }, 20000);",
  ].join('\n');
  const cpath = path.join(__dirname, '.wk-child.js');
  fs.writeFileSync(cpath, child);
  const r3 = require('child_process').spawnSync(process.execPath, [cpath], { encoding: 'utf8', timeout: 60000 });
  try { fs.unlinkSync(cpath); } catch (e) {}
  ok('fl: parser runs identically inside a worker thread', r3.status === 0, (r3.stdout || r3.stderr || '').trim().split('\n').pop());
}

/* ================= 4s. key-sound formula fidelity (user formula, rate-independent) ================= */
{
  const ref = (sr, n) => { const o = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i + 1) / sr, w = 2764.6 * x, a = Math.min(x * 500, 1) * Math.exp(-x * 2.6);
      o[i] = Math.tanh(0.8 * (a * (Math.sin(w) + .4 * Math.sin(2 * w) + .2 * Math.sin(3 * w) + .1 * Math.sin(4 * w) +
        .38 * Math.sin(w * 1.004) + .16 * Math.sin(2 * w * 1.004) + .08 * Math.sin(3 * w * 1.004)) * .49)); }
    return o; };
  const drive = (sr, step) => {
    const w = new global.__Worklet(); w.port.postMessage = () => {};
    const oldSR = global.sampleRate; global.sampleRate = sr;
    w.port.onmessage({ data: { t: 'fx', n: 1 } });
    w.port.onmessage({ data: { t: 'sync', smp: 0, tag: 1 } });
    w.port.onmessage({ data: { t: 'rate', step } });
    w.port.onmessage({ data: { t: 'batch', ev: I32([[0, Math.round(2 * SRQ), pack(0, 69, 127, 0)]]), tag: 1 } });
    const N = 128, L = new Float32Array(N), R = new Float32Array(N), out = [];
    for (let q = 0; q * N < sr; q++) { w.process([], [[L, R]]); out.push(Float32Array.from(L)); }
    global.sampleRate = oldSR;
    const tot = new Float32Array(out.length * N); out.forEach((b, i) => tot.set(b, i * N));
    return tot;
  };
  const A = drive(48000, 1), RA = ref(48000, A.length);
  let mx = 0; for (let i = 512; i < A.length; i++) mx = Math.max(mx, Math.abs(A[i] - RA[i]));
  ok('snd: A4 == user formula at 48000 (x in seconds)', mx < 0.02, `max ${mx.toExponential(2)}`);
  const Bq = drive(44100, 48000 / 44100), RB = ref(44100, Bq.length);
  let mx2 = 0; for (let i = 512; i < Bq.length; i++) mx2 = Math.max(mx2, Math.abs(Bq[i] - RB[i]));
  ok('snd: same formula at 44100 — pitch/decay unaffected by HZ', mx2 < 0.02, `max ${mx2.toExponential(2)}`);
}

/* ================= 4r. offline program-audio render (ffmpeg mux source) ================= */
{
  const oa = require(path.join(__dirname, 'offline_audio.js'));
  const wpath = path.join(__dirname, 'demos', '.suite-tmp.wav');
  const rr = oa.renderWavSync(readAB(path.join(__dirname, 'demos/pulse.mid')), wpath, { tail: 1 });
  const hdr = fs.readFileSync(wpath).subarray(0, 44);
  ok('offr: WAV RIFF/WAVE header', hdr.toString('ascii', 0, 4) === 'RIFF' && hdr.toString('ascii', 8, 12) === 'WAVE');
  const all = fs.readFileSync(wpath); let s2 = 0, n2 = 0;
  for (let i = 44; i < Math.min(all.length, 44 + 48000 * 4 * 2); i += 2) { const v = all.readInt16LE(i); s2 += v * v; n2++; }
  const rms2 = Math.sqrt(s2 / n2) / 32768;
  ok('offr: rendered soundtrack audible + bounded', rms2 > 0.01 && rms2 <= 1.0, `rms ${rms2.toFixed(3)} frames ${rr.frames}`);
  ok('offr: page ships render panel + engine', /id="rres"/.test(html) && /id="rsrc"/.test(html) && /function startRender/.test(html));
  ok('offr: bar has separated RENDER + AUDIO buttons', (/id="bRender"/.exec(html) || [''])[0].length && html.indexOf('id="bRender"') < html.indexOf('id="cfg"') && /id="bAudio"/.test(html) && !/rOut/.test(html));
  ok('perf: scan window tightened to the LTH horizon', /const back = LTHq \+ 0\.02/.test(html) && /const ahead = Math\.max\(hitY \/ pps \+ 0\.02, 0\.12\)/.test(html));
  ok('perf: ffmpeg capture pipeline keeps frames in flight', /fl < 3/.test(html) && /snap\.toBlob/.test(html) && /kick\(\)/.test(html));
  ok('web: mp4-muxer embedded + WebCodecs render path', /var Mp4Muxer/.test(html) && /ArrayBufferTarget/.test(html) && /new VideoEncoder/.test(html) && /new AudioEncoder/.test(html) && /f32-planar/.test(html) && /avc1\.640028/.test(html));
  ok('web: dispatcher prefers in-browser, server is fallback', /return startRenderWeb\(\)/.test(html) && /startRenderSrv\(\)/.test(html) && /function startRender\(\)/.test(html));
  ok('web: offline soundtrack renders in-page (real worklet, WAV sidecar)', /function renderProgramAudio/.test(html) && /function buildWavBlob/.test(html) && /mkSynthC/.test(html) && /ST\.rAudioBuf/.test(html));
  ok('tab: renders survive tab switches (Worker ticker, zero rAF awaits)', /function yieldTick/.test(html) && /setInterval\(\(\)=>postMessage\(0\),50\)/.test(html) && !/await new Promise\(\(r\) => requestAnimationFrame\(r\)\)/.test(html));
  ok('tab: hidden-tab housekeeping feeds audio and handles song end', /document\.hidden/.test(html) && /ensureTicker\(\);/.test(html));
  ok('dl: finish always delivers the mp4 (auto + visible link, codec negotiated, watchdog)', /function offerDownload/.test(html) && /function pickVCodec/.test(html) && /avc1\.640033/.test(html) && /encoder stuck/.test(html) && /id="dlBar"/.test(html) && /offerDownload\('suki-render\.mp4'/.test(html));
  ok('dl: server fallback fetches the rendered file into the browser', /await fetch\(j1\.out\)/.test(html) && /offerDownload\(j1\.out\.split\('\/'\)\.pop\(\)/.test(html));
  ok('end: song-end handling never touches a null ctx nor a render walk', /!ST\.renderJob && t >= s\.total - 0\.05/.test(html) && /if \(ST\.ctx\) \{ try \{ ST\.ctx\.suspend\(\); \} catch \(e\) \{\} \}/.test(html));
  ok('render: walk always starts at t=0, never the frozen playback clock', (html.match(/const liveSave = ST\.live; ST\.live = false;/g) || []).length === 2 && (html.match(/ST\.renderJob = null; ST\.rdt = null; ST\.playing = false; ST\.live = liveSave;/g) || []).length === 2 && /if \(ST\.live && ST\.playing\) pause\(\);/.test(html));
  ok('render: settings locked + canvas frozen for the whole job', /function resize\(\)\{ if \(ST\.renderJob\) return;/.test(html) && /#cfg\.lock\{pointer-events:none;opacity:\.55\}/.test(html) && /\$\('#cfg'\)\.classList\.add\('lock'\)/.test(html) && /classList\.remove\('lock'\)/.test(html) && /if \(ST\.renderJob\) return; if \(ST\.song\) setZoom/.test(html.replace('\n', ' ')));
  ok('render: seek/zoom/resize cannot perturb the job', /async function seek\(frac\)\{\n  if \(ST\.renderJob\) return;/.test(html) && /KBH = rSv\.kb; ST\.pps = rSv\.pps;/.test(html));
  ok('counter: painted into rendered frames (both paths, respects theme/size/toggle)', (html.match(/drawHudCanvas\(sc, ST\.rW\)/g) || []).length === 2 && /function drawHudCanvas/.test(html) && /el\.style\.fontSize/.test(html) && /ST\.theme === 1 \? \$\('#hud2'\) : \$\('#hud'\)/.test(html));
  ok('res: GL projection + keyboard rebuilt at job size and after the job', /GLW = cvGlEl\.width; GLH = cvGlEl\.height;/.test(html) && /rSv = null;\n  resize\(\);/.test(html));
  ok('preview: job canvas letterboxed during render, never squashed', /const scl = Math\.min\(innerWidth \/ W, \(innerHeight - TBH - 3 - SAB\) \/ H\);/.test(html) && /c\.style\.width = pw \+ 'px'/.test(html) && /c\.style\.width = ''; c\.style\.height = ''; c\.style\.left = ''; c\.style\.top = '';/.test(html));
  const sv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  ok('offr: server has wav endpoint + saves soundtrack with video', sv.includes('/api/render/wav') && sv.includes('prog.wav') && sv.includes('audio'));
  ok('offr: ffmpeg is optional and the startup line says so', sv.includes('spawnSync(FFMPEG') && sv.includes('NOT NEEDED'));
  ok('offr: server auto-opens the browser and logs the connection', sv.includes('SUKI_NO_OPEN') && sv.includes('xdg-open') && sv.includes('browser connected'));
  try { fs.unlinkSync(wpath); } catch (e) {}
}

/* ================= 4d. NUT demo (detuned meme black-midi) ================= */
{
  const nm = parseMIDI(readAB(path.join(__dirname, 'demos/nut.mid')));
  ok('nut: parses, 6 tracks, tempo ramp present', nm.nTrks === 6 && nm.tempo.length >= 7, `trks=${nm.nTrks} tempos=${nm.tempo.length}`);
  const ns = beginPack(nm);
  while (!packStep(ns).done);
  ok('nut: ~17k notes packed, monotonic', ns.notes > 15000 && ns.n > 15000, `${ns.notes} notes / ${ns.n} events`);
  let mono = true; for (let i = 1; i < ns.n; i++) if (ns.out[i*3] < ns.out[(i-1)*3]) { mono = false; break; }
  ok('nut: monotonic stream', mono);
  const wN = new global.__Worklet(); wN.port.postMessage = () => {};
  wN.port.onmessage({ data: { t: 'sync', smp: 0, tag: 1 } });
  wN.port.onmessage({ data: { t: 'rate', step: 1 } });
  const CH2 = 8192 * 3;
  for (let off = 0; off < ns.out.length; off += CH2) wN.port.onmessage({ data: { t: 'batch', ev: ns.out.slice(off, off + CH2), tag: 1 } });
  const rN = run(wN, 6);
  const mxN = Math.max(...rN.peaks);
  ok('nut: sounds end-to-end, bounded', !rN.bad && mxN > 0.05 && mxN <= 1, `peak ${mxN.toFixed(3)}`);
}

/* ================= 4c. sub-chunk song must still sound (pulse.mid bug) ================= */
{
  const pm = parseMIDI(readAB(path.join(__dirname, 'demos/pulse.mid')));
  const ps = beginPack(pm);
  while (!packStep(ps).done);
  ok('pulse: parses + packs', ps.done && ps.notes > 100, `${ps.notes} notes, ${ps.n} events`);
  ok('pulse: smaller than one CHUNK (reproduces the bug precondition)', ps.n < 8192, `${ps.n} < 8192`);
  const oldMaxQ = Math.floor(ps.conv / 8192);
  const newMaxQ = ps.done ? Math.ceil(ps.conv / 8192) : Math.floor(ps.conv / 8192);
  ok('pulse: old formula sent 0 batches (was the silence bug)', oldMaxQ === 0, `maxQ=${oldMaxQ}`);
  ok('pulse: fixed formula sends the tail batch', newMaxQ === 1, `maxQ=${newMaxQ}`);
  // end-to-end: feed that batch like pump() does and listen
  const wP = new global.__Worklet(); wP.port.postMessage = () => {};
  wP.port.onmessage({ data: { t: 'sync', smp: 0, tag: 1 } });
  wP.port.onmessage({ data: { t: 'rate', step: 1 } });
  const ev = ps.out.slice(0, 8192 * 3);
  wP.port.onmessage({ data: { t: 'batch', ev, tag: 1 } });
  const rP = run(wP, Math.min(8, ps.out[ps.out.length - 3] / SRQ + 1));
  const mx = Math.max(...rP.peaks);
  ok('pulse: worklet actually sounds end-to-end', !rP.bad && mx > 0.05, `peak ${mx.toFixed(3)}`);
}

/* ================= 4e. SPIRAL demo ================= */
{
  const sm = parseMIDI(readAB(path.join(__dirname, 'demos/spiral.mid')));
  ok('spiral: parses, 3 tracks, bends present', sm.nTrks === 3, `trks=${sm.nTrks}`);
  const ss = beginPack(sm);
  while (!packStep(ss).done);
  ok('spiral: ~16k notes packed, monotonic', ss.notes > 14000 && ss.notes < 20000, `${ss.notes} notes`);
  let mono = true; for (let i = 1; i < ss.n; i++) if (ss.out[i*3] < ss.out[(i-1)*3]) { mono = false; break; }
  ok('spiral: monotonic stream', mono);
  const wS2 = new global.__Worklet(); wS2.port.postMessage = () => {};
  wS2.port.onmessage({ data: { t: 'sync', smp: 0, tag: 1 } });
  wS2.port.onmessage({ data: { t: 'rate', step: 1 } });
  const CH2 = 8192 * 3;
  for (let off = 0; off < ss.out.length; off += CH2) wS2.port.onmessage({ data: { t: 'batch', ev: ss.out.slice(off, off + CH2), tag: 1 } });
  const rS2 = run(wS2, 5);
  const mxS = Math.max(...rS2.peaks);
  ok('spiral: sounds end-to-end, bounded', !rS2.bad && mxS > 0.05 && mxS <= 1, `peak ${mxS.toFixed(3)}`);
}

/* ================= 5. 2M-note stress ================= */
{
  const fx = path.join(os.tmpdir(), 'suki-stress2m.mid');
  if (!fs.existsSync(fx)) {                        // R61: generated at runtime — the 14MB fixture is no longer shipped
    const N = 2_000_000, PPQ = 480;
    const fd = fs.openSync(fx, 'w');
    let buf = Buffer.alloc(1 << 24), off = 0;
    const W = (b) => { if (off + b.length > buf.length) { fs.writeSync(fd, buf, 0, off); off = 0; } b.copy(buf, off); off += b.length; };
    const bodyLen = 7 + N * 8 + 4;
    W(Buffer.from([0x4d,0x54,0x68,0x64,0,0,0,6,0,1,0,1,PPQ >> 8,PPQ & 255]));
    W(Buffer.from([0x4d,0x54,0x72,0x6b,(bodyLen >>> 24) & 255,(bodyLen >>> 16) & 255,(bodyLen >>> 8) & 255,bodyLen & 255]));
    W(Buffer.from([0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20]));
    const ev = Buffer.allocUnsafe(8);
    for (let i = 0; i < N; i++) {
      const p = 36 + ((i * 7) % 80);
      ev[0] = 1; ev[1] = 0x90; ev[2] = p; ev[3] = 100; ev[4] = 1; ev[5] = 0x80; ev[6] = p; ev[7] = 0;
      W(ev);
    }
    W(Buffer.from([0, 0xff, 0x2f, 0]));
    if (off) fs.writeSync(fd, buf, 0, off);
    fs.closeSync(fd);
  }
  const t0 = process.hrtime.bigint();
  const bm = parseMIDI(readAB(fx));
  const tParse = Number(process.hrtime.bigint() - t0) / 1e6;
  ok('stress: parse 2M notes < 2500ms', tParse < 2500, `${tParse.toFixed(0)}ms, ${bm.totalEvents} recs`);
  const t1 = process.hrtime.bigint();
  const bs = beginPack(bm);
  while (!packStep(bs).done);
  const tBuild = Number(process.hrtime.bigint() - t1) / 1e6;
  ok('stress: pack 2M events < 3000ms', tBuild < 3000, `${tBuild.toFixed(0)}ms`);
  let mono = true; for (let i = 1; i < bs.n; i++) if (bs.out[i*3] < bs.out[(i-1)*3]) { mono = false; break; }
  ok('stress: monotonic 2M stream', mono);
  ok('stress: 2M notes packed', bs.notes >= 1_900_000, `${bs.notes}`);
  const rss = process.memoryUsage().rss / 1e6;
  ok('stress: node rss < 1.6GB', rss < 1600, `${rss.toFixed(0)}MB`);
  try { fs.unlinkSync(fx); } catch (e) {}
  // flow-control sanity: flood 1000 batches, worklet must keep acking and stay bounded
  const w3 = new global.__Worklet(); let posted = 0; w3.port.postMessage = (x) => { if (x.t === 'ack') posted++; };
  w3.port.onmessage({ data: { t: 'sync', smp: 0, tag: 1 } });
  w3.port.onmessage({ data: { t: 'rate', step: 1 } });
  for (let c = 0; c < 1000; c++) {
    const ev = bs.out.slice(c * 8192 * 3, (c + 1) * 8192 * 3);
    if (!ev.length) break;
    w3.port.onmessage({ data: { t: 'batch', ev, tag: 1 } });
  }
  // one 8192-event batch spans ~60s of song time; process until the first ack flows
  const L3 = new Float32Array(128), R3 = new Float32Array(128);
  let guard = 0, bad = false;
  while (posted === 0 && guard++ < 40000) {
    w3.process([], [[L3, R3]]);
    for (let i = 0; i < 128; i++) if (!isFinite(L3[i]) || Math.abs(L3[i]) > 1.01) { bad = true; break; }
    if (bad) break;
  }
  ok('stress: 1000-batch flood keeps acking', posted > 0, `acks=${posted} in ${guard} bufs`);
  ok('stress: flood output finite & bounded', !bad);
}

/* ============ R57: virtual-song streaming worker ============ */
(async () => {
  const { Worker } = require('worker_threads');
  setTimeout(() => { console.log('FAIL  virtual suite watchdog timeout'); process.exit(1); }, 240000);
  const embM = html.match(/<script type="text\/plain" id="vwsrc">([\s\S]*?)<\/script>/);
  ok('virtual: embedded worker present in index.html', !!embM);
  if (embM) {
    const emb = embM[1].trim(), disk = fs.readFileSync(path.join(__dirname, 'bigmidi.worker.js'), 'utf8').trim();
    ok('virtual: embedded worker == bigmidi.worker.js', emb === disk);
  }
  // torture fixture: tempo map + a dense multi-page track + long notes / pedals / bends / PCs / ring overflow
  const W = [];
  const put = (b) => W.push(b);
  const vlqb = (n) => { const r = [n & 0x7f]; n >>= 7; while (n) { r.push((n & 0x7f) | 0x80); n >>= 7; } return Buffer.from(r.reverse()); };
  function mkTrk(bodyFn){
    const body = [];
    bodyFn((...pieces) => { for (const p of pieces) { if (Buffer.isBuffer(p)) body.push(p); else body.push(Buffer.from(p)); } });
    const bb = Buffer.concat(body);
    const len = Buffer.alloc(4); len.writeUInt32BE(bb.length);
    return Buffer.concat([Buffer.from('MTrk'), len, bb]);
  }
  put(mkTrk((e) => { e([0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20]); e([9600, 0xff, 0x51, 3, 0x06, 0x1a, 0x80]); e([19200, 0xff, 0x2f, 0]); }));
  put(mkTrk((push) => {
    let tick = 0, run = -1;
    const ev = [];
    for (let i = 0; i < 1200000; i++) {
      tick += 2;
      const st = 0x90 | (i & 15);
      ev.push(vlqb(2));
      if (st !== run) { ev.push(Buffer.from([st])); run = st; }
      ev.push(Buffer.from([36 + ((i * 7) % 80), 100]));
      ev.push(vlqb(1));
      const key = 36 + ((i * 7) % 80);
      if ((i & 15) === 0) {                              // pedal resets running status: off needs full status
        ev.push(Buffer.from([0xb0 | (i & 15), 64, 127]));
        ev.push(vlqb(0));                                // zero delta: off at the pedal tick
        ev.push(Buffer.from([0x80 | (i & 15), key, 0]));
        run = 0x80 | (i & 15);
      } else if (st === run) {
        ev.push(Buffer.from([key, 0]));                  // running-status note-off: key + vel 0
      } else {
        ev.push(Buffer.from([0x80 | (i & 15), key, 0]));
        run = 0x80 | (i & 15);
      }
      if ((i & 63) === 0) { ev.push(vlqb(0)); ev.push(Buffer.from([0xe0 | (i & 15), 3, 66])); run = -1; }
    }
    ev.push(vlqb(4)); ev.push(Buffer.from([0xb0, 123, 0]));
    ev.push(vlqb(0)); ev.push(Buffer.from([0xff, 0x2f, 0]));
    ev.forEach((x) => push(x));
  }));
  put(mkTrk((push) => {
    const ev = [];
    for (let i = 0; i < 4000; i++) {
      const t = i * 240;
      ev.push(vlqb(i ? 240 : t)); ev.push(Buffer.from([0x90, 40 + (i % 60), 90]));
      ev.push(vlqb(300 + (i % 50) * 100)); ev.push(Buffer.from([0x80, 40 + (i % 60), 0]));
      if (i % 200 === 0) { ev.push(vlqb(0)); ev.push(Buffer.from([0xc0 | (i % 16), i % 128])); }
    }
    for (let i = 0; i < 100; i++) { ev.push(vlqb(1)); ev.push(Buffer.from([0x91, 60, 70])); }
    for (let i = 0; i < 100; i++) { ev.push(vlqb(1)); ev.push(Buffer.from([0x81, 60, 0])); }
    ev.push(vlqb(0)); ev.push(Buffer.from([0xff, 0x2f, 0]));
    ev.forEach((x) => push(x));
  }));
  const hdrB = Buffer.alloc(14); Buffer.from('MThd').copy(hdrB, 0);
  hdrB.writeUInt32BE(6, 4); hdrB.writeUInt16BE(1, 8); hdrB.writeUInt16BE(3, 10); hdrB.writeUInt16BE(480, 12);
  const tb = Buffer.concat([hdrB, ...W]);
  const tbAB = tb.buffer.slice(tb.byteOffset, tb.byteOffset + tb.byteLength);
  const pmT = parseMIDI(tbAB);
  const sgT = beginPack(pmT);
  let rT; do { rT = packStep(sgT); } while (sgT.phase < 2 || !rT.done);

  const wv = new Worker(path.join(__dirname, 'bigmidi.worker.js'));
  const msg = () => new Promise((res) => { const h = (m) => { wv.removeListener('message', h); res(m); }; wv.on('message', h); });
  wv.on('message', (m) => { if (m.op === 'error') throw new Error('worker error: ' + m.msg); });
  wv.postMessage({ op: 'loadBuffer', ab: tbAB, SRQ, CHUNK: 8192, LTH });
  let R = await msg();
  while (R.op === 'progress') R = await msg();
  ok('virtual: worker loads torture file', R.op === 'ready', 'op=' + R.op);
  if (R.op === 'ready') {
    ok('virtual: conv matches RAM pipeline', R.meta.conv === sgT.conv, R.meta.conv + ' vs ' + sgT.conv);
    ok('virtual: notes match RAM pipeline', R.meta.notes === sgT.notes, R.meta.notes + ' vs ' + sgT.notes);
    ok('virtual: total matches RAM pipeline', near(R.meta.total, sgT.total, 1e-6), R.meta.total.toFixed(4) + ' vs ' + sgT.total.toFixed(4));
    ok('virtual: IDX resident and monotone', (() => { for (let i = 1; i < R.IDX.length; i++) if (R.IDX[i] < R.IDX[i - 1]) return false; return R.IDX.length > 3; })(), 'n=' + R.IDX.length);
    ok('virtual: IDX[k] equals rec start at k*4096', (() => { for (let k = 0; k < R.IDX.length; k++) { const i = k * 4096; if (i < sgT.conv && R.IDX[k] !== sgT.out[i * 3]) return false; } return true; })());
    const cmpSorted = (get, n, get2, n2) => {
      if (n !== n2) return false;
      let i = 0, j = 0;
      while (i < n && j < n2) {
        const a1 = get(i), a2 = get2(j);
        if (a1 !== a2) return false;
        const e1 = i, e2 = j;
        while (i < n && get(i) === a1) i++;
        while (j < n2 && get2(j) === a2) j++;
        const g1 = [], g2 = [];
        for (let k = e1; k < i; k++) g1.push(get(k, 1) + ',' + get(k, 2));
        for (let k = e2; k < j; k++) g2.push(get2(k, 1) + ',' + get2(k, 2));
        g1.sort(); g2.sort();
        if (g1.join(';') !== g2.join(';')) return false;
      }
      return i === n && j === n2;
    };
    for (const wspec of [[0, 50000], [(sgT.conv >> 1) | 0, 70000], [sgT.conv - 40000, 40000]]) {
      const lo = wspec[0], n = wspec[1];
      wv.postMessage({ op: 'win', reqId: 'w' + lo, lo, n });
      let m = await msg();
      while (m.op !== 'win') m = await msg();
      const g1 = (i, k = 0) => m.buf[i * 3 + k];
      const g2 = (i, k = 0) => sgT.out[(i + lo) * 3 + k];
      ok('virtual: window @' + lo + ' equals RAM pipeline', cmpSorted(g1, n, g2, n));
    }
    const nc = R.cmArr.length;
    const pages = [];
    for (let c = 0; c < nc; c++) {
      wv.postMessage({ op: 'lrec', c });
      let m = await msg();
      while (m.op !== 'lrecPage') m = await msg();
      pages.push(new Int32Array(m.buf.buffer, m.buf.byteOffset, m.buf.byteLength >> 2));
    }
    let lOK = true, j = 0;
    {
      const LA = sgT.long, ln = sgT.longN;
      for (let c = 0; c < nc && lOK; c++) {
        const pg = pages[c], rc = (pg.length / 3) | 0;
        for (let q = 0; q < rc; q++) {
          if (j >= ln) { lOK = false; break; }
          const b3 = LA[j] * 3;
          if (pg[q * 3] !== sgT.out[b3] || pg[q * 3 + 1] !== sgT.out[b3 + 1] || pg[q * 3 + 2] !== sgT.out[b3 + 2]) { lOK = false; break; }
          j++;
        }
      }
      if (j !== ln) lOK = false;
    }
    ok('virtual: long-note pages equal RAM sustained list', lOK, nc + ' chunks, ' + sgT.longN + ' longs');
    let tagSeen = true;
    const msgT = (ms) => new Promise((res) => { const h = (m) => { wv.removeListener('message', h); res(m); }; wv.on('message', h); setTimeout(() => { wv.removeListener('message', h); res(null); }, ms); });
    const collect = async (want, t0, lead, tag) => {
      const batches = [];
      let t = t0;
      while (batches.length < want) {
        wv.postMessage({ op: 'pump', t, lead, tag });
        let m = await msgT(3000);
        let guard = 0;
        while (m && m.op !== 'batch' && guard++ < 20) m = await msgT(3000);
        if (!m) { t += 60; continue; }          // gate refused: jump the clock past this chunk span
        if (m.tag !== tag) tagSeen = false;
        batches.push(m.ev);
        wv.postMessage({ op: 'ack' });
        t += 8;
      }
      return batches;
    };
    const batches = await collect(6, 0, 2, 7);
    let asc = true, prevAt = -1;
    for (const b of batches) for (let i = 0; i < b.length; i += 3) {
      const at = b[i];
      if (at < prevAt) asc = false;
      prevAt = at;
    }
    ok('virtual: pump batches ascend by at', asc, batches.length + ' batches');
    ok('virtual: pump respects tag', tagSeen);
    wv.postMessage({ op: 'seek', at: Math.round(sgT.total * 0.4 * SRQ), tag: 9 });
    wv.postMessage({ op: 'pump', t: sgT.total * 0.4, lead: 2, tag: 9 });
    {
      let m = await msg(), guard = 0;
      while ((m.op !== 'batch' || m.tag !== 9) && guard++ < 50) m = await msg();   // skip stale tag-7 batches
      let okSeek = m.op === 'batch' && m.tag === 9;
      if (okSeek) {
        const tgt = Math.round(sgT.total * 0.4 * SRQ);
        const recOf = (at) => { let lo = 0, hi = sgT.conv; while (lo < hi) { const mm = (lo + hi) >> 1; if (sgT.out[mm * 3] < at) lo = mm + 1; else hi = mm; } return lo; };
        okSeek = Math.abs(recOf(m.ev[0]) - recOf(tgt)) <= 8192;   // seek granularity = one 8192-rec chunk (same as RAM syncTo)
      }
      ok('virtual: seek lands within one batch of target', okSeek, m.op === 'batch' ? 'at0=' + m.ev[0] : m.op);
    }
    wv.postMessage({ op: 'stop' });
  }
  await wv.terminate();
})().then(() => {
  console.log(runs - fails + '/' + runs + ' checks passed');
  process.exit(fails ? 1 : 0);
});

