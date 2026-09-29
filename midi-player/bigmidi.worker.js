
/* suki virtual-song engine (worker): opens multi-GB MIDI files with bounded RAM.
   Pass A streams every track collecting the tempo map; pass B1 replays the
   packer pairing to count records per 1-second bucket; pass B2 replays it
   again, converting events to SRQ-unit recs [at, dur, packed] and writing each
   one straight into its bucket's region of the spill (OPFS sync handles in
   browsers, RAM pages in tests). Finalize counting-sorts every bucket in
   place and emits IDX / the sustained (long) list / start-end histograms in
   true order. RAM stays bounded by page/bucket buffers, never by note count:
   1B notes ≈ 12 GB spilled, ~100 MB resident. After 'ready' it serves paged
   windows ({op:'win'}), long-note pages ({op:'lrec'}), audio batches
   ({op:'pump'}/ack) and seeks. Rec layout + packed format = index.html's. */
'use strict';
/* node worker_threads shim (tests): map self/onmessage/postMessage to parentPort */
if (typeof self === 'undefined') {
  const pp = require('worker_threads').parentPort;
  const fsN = require('fs');
  const slf = { postMessage: (m, t) => pp.postMessage(m, t || []) };
  pp.on('message', (m) => { if (slf.onmessage) slf.onmessage({ data: m }); });
  globalThis.self = slf;
  globalThis.nodeSrc = function nodeSrc(path) {   // Node test harness only: stream a file by path
    const fd = fsN.openSync(path, 'r');
    return async (off, len) => {
      const u8 = new Uint8Array(len);
      let o = 0;
      while (o < len) { const g = fsN.readSync(fd, u8, o, Math.min(len - o, 1 << 24), off + o); if (g <= 0) break; o += g; }
      return u8;
    };
  };
}

let SRQ = 12000, CHUNK = 8192, LTH = 1200;
let store = null, lstore = null, packSize = 0, lrecBase = 0, lrecN = 0;
let IDX = null, cmArr = null, stC = null, enC = null;
let meta = null;
let segTick = null, segAcc = null, segTps = null, segN = 0;
let cursor = 0, curTag = 0, inflight = 0, lastT = 0, lead = 1;
const PAGE = 1 << 22;

/* ---------- storage: OPFS sync handles, RAM-page fallback ---------- */
let mkSeq = 0; const openAH = new Set(), uniqSpill = new Set();
async function makeOne(name, allowRam) {
  const attempt = async (nm) => {                // R62h: track + closeable handles — two open handles on ONE
    const root = await navigator.storage.getDirectory();   // file are illegal, a second big load used to die
    const fh = await root.getFileHandle(nm, { create: true });
    const ah = await fh.createSyncAccessHandle();
    openAH.add(ah);
    ah.truncate(0);
    return {
      write(off, u8) {
        try { ah.write(u8, { at: off }); }
        catch (e) { throw new Error('SITE STORAGE WRITE FAILED (DISK FULL?) — ' + e.message); }
      },
      read(off, len) { const u8 = new Uint8Array(len); ah.read(u8, { at: off }); return u8; },
      close() { try { ah.close(); } catch (e2) {} openAH.delete(ah); }
    };
  };
  try {                                          // browsers: real disk spill (huge files REQUIRE this)
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory) {
      try { return await attempt(name); }
      catch (e0) {                               // stale handle (killed session) blocks this name: one fresh-name retry
        const nm2 = name + '.' + (++mkSeq);
        try { uniqSpill.add(nm2); return await attempt(nm2); } catch (e1) { throw e0; }
      }
    }
  } catch (e) { if (!allowRam) throw new Error('DISK SPILL UNAVAILABLE (OPFS): ' + e.message); }
  if (typeof process !== 'undefined') {          // Node harness: fs-backed spill (env path or OS tmp)
    const fsN = require('fs'), osN = require('os'), pathN = require('path');
    const pth = (process.env.SUKI_DISK_STORE || osN.tmpdir() + '/suki-spill') + '-' + name;
    fsN.writeFileSync(pth, Buffer.alloc(0));
    const fd = fsN.openSync(pth, 'r+');
    return {
      write(off, u8) { fsN.writeSync(fd, u8, 0, u8.length, off); },
      read(off, len) {
        const u8 = new Uint8Array(len);
        let o = 0;
        while (o < len) { const g = fsN.readSync(fd, u8, o, len - o, off + o); if (g <= 0) break; o += g; }
        return u8;
      }
    };
  }
  if (!allowRam) return null;                    // huge files must never silently eat RAM
  let ram = new Uint8Array(1 << 24), ramLen = 0;
  return {
    write(off, u8) {
      if (off + u8.length > ram.length) {
        let cap = ram.length;
        while (off + u8.length > cap) cap *= 2;
        const nb = new Uint8Array(cap); nb.set(ram.subarray(0, ramLen)); ram = nb;
      }
      ram.set(u8, off);
      if (off + u8.length > ramLen) ramLen = off + u8.length;
    },
    read(off, len) {                             // exact-length semantics (views depend on it)
      const out = new Uint8Array(len);
      const end = Math.min(ramLen, off + len);
      if (end > off) out.set(ram.subarray(off, end));
      return out;
    }
  };
}
async function initStore(needDisk) {
  for (const sp of [store, lstore]) if (sp && sp.close) { try { sp.close(); } catch (e) {} }   // R62h: release the PREVIOUS load's handles first
  for (const ah of [...openAH]) { try { ah.close(); } catch (e) {} }
  openAH.clear();
  try { const root = await navigator.storage.getDirectory(); for (const nm of uniqSpill) { try { await root.removeEntry(nm); } catch (e) {} } uniqSpill.clear(); } catch (e) {}
  store = await makeOne('suki-pack.bin', !needDisk);
  if (store) lstore = await makeOne('suki-lrec.bin', !needDisk);
  if (!store) throw new Error('THIS BROWSER GAVE NO DISK STORAGE (OPFS) — A 4 GB FILE CANNOT STREAM. USE DESKTOP CHROME/EDGE VIA THE LOCAL SERVER (NOT file://, NOT PRIVATE MODE).');
}

/* ---------- source: File (slice-streamed) or ArrayBuffer ---------- */
function makeSrc(src) {
  if (src && typeof src.slice === 'function' && typeof src.arrayBuffer === 'function') {
    return async (off, len) => new Uint8Array(await src.slice(off, off + len).arrayBuffer());
  }
  const u8 = src instanceof Uint8Array ? src : new Uint8Array(src);
  return async (off, len) => u8.subarray(off, Math.min(u8.length, off + len));
}

/* ---------- event stepper with carry (safe across page borders) ----------
   Returns {p, tick, run}; on a truncated event at the page end it rewinds p to
   the event start and returns the state from BEFORE that event, so the caller
   carries the unconsumed bytes over and reparses them with the next page. */
function stepAll(u8, p, end, tick, run, onEv) {
  while (p < end) {
    let d = 0, b;
    const vq = p;
    do { if (p >= end) return { p: vq, tick, run }; b = u8[p++]; d = (d << 7) | (b & 0x7f); } while (b & 0x80);
    const tick0 = tick;                           // pre-delta tick: partial returns rewind to vq, so the
    tick += d;                                    // caller reparses these bytes and must not double-add
    if (p >= end) return { p: vq, tick: tick0, run };
    b = u8[p];
    let st;
    if (b & 0x80) { st = b; p++; if (st < 0xf0) run = st; } else { st = run; }
    if (st < 0x80) return { p: vq, tick: tick0, run };   // running status without base byte: stop like the RAM parser
    if (st === 0xff) {
      if (p >= end) return { p: vq, tick: tick0, run };
      const type = u8[p++];
      let len = 0;
      do { if (p >= end) return { p: vq, tick: tick0, run }; b = u8[p++]; len = (len << 7) | (b & 0x7f); } while (b & 0x80);
      if (p + len > end) return { p: vq, tick: tick0, run };
      if (type === 0x51 && len === 3) onEv('tempo', tick, (u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2], 0, 0);
      if (type === 0x2f) return { p: p + len, tick, run, eot: true };
      p += len;
    } else if (st === 0xf0 || st === 0xf7) {
      let len = 0;
      do { if (p >= end) return { p: vq, tick: tick0, run }; b = u8[p++]; len = (len << 7) | (b & 0x7f); } while (b & 0x80);
      if (p + len > end) return { p: vq, tick: tick0, run };
      p += len;
    } else {
      const hi = st >> 4, ch = st & 15;
      const need = (hi === 0xc || hi === 0xd) ? 1 : 2;
      if (p + need > end) return { p: vq, tick: tick0, run };
      if (hi === 0x9) onEv('note', tick, ch, u8[p] & 127, u8[p + 1]);
      else if (hi === 0x8) onEv('note', tick, ch, u8[p] & 127, 0);
      else if (hi === 0xb) onEv('cc', tick, ch, u8[p], u8[p + 1]);
      else if (hi === 0xe) onEv('bend', tick, ch, ((u8[p + 1] & 127) << 7) | (u8[p] & 127), 0);
      else if (hi === 0xc) onEv('pc', tick, ch, u8[p] & 127, 0);
      p += need;
    }
  }
  return { p, tick, run };
}

/* ---------- tempo map / clock (identical math to makeClock) ---------- */
function buildTempo(tev, ppq, smpte, tickDur) {
  tev.sort((a, b) => a[0] - b[0]);
  if (!tev.length || tev[0][0] > 0) tev.unshift([0, 500000]);
  segN = tev.length;
  segTick = new Float64Array(segN); segAcc = new Float64Array(segN); segTps = new Float64Array(segN);
  for (let i = 0; i < segN; i++) {
    segTick[i] = tev[i][0];
    segTps[i] = smpte ? tickDur : tev[i][1] / 1e6 / ppq;
    segAcc[i] = i ? segAcc[i - 1] + (segTick[i] - segTick[i - 1]) * segTps[i - 1] : 0;
  }
}
function secOf(tick) {
  let lo = 0, hi = segN - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segTick[mid] <= tick) lo = mid; else hi = mid - 1; }
  return segAcc[lo] + (tick - segTick[lo]) * segTps[lo];
}

/* ---------- header + track table ---------- */
async function readTracks(read) {
  const head = await read(0, 4096);
  if (String.fromCharCode(head[0], head[1], head[2], head[3]) !== 'MThd') throw new Error('not a MIDI file');
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const hlen = hv.getUint32(4);
  const format = hv.getUint16(8);
  const nTrks = hv.getUint16(10);
  const division = hv.getUint16(12);
  let ppq = division & 0x7fff, smpte = 0, tickDur = 0;
  if (division & 0x8000) { smpte = 1; ppq = 0; tickDur = 1 / ((256 - (division >> 8)) * (division & 0xff)); }
  const tracks = [];
  let p = 8 + hlen;
  for (let t = 0; t < nTrks; t++) {
    const th = await read(p, 8);
    if (String.fromCharCode(th[0], th[1], th[2], th[3]) !== 'MTrk') break;
    const len = ((th[4] << 24) | (th[5] << 16) | (th[6] << 8) | th[7]) >>> 0;
    tracks.push([p + 8, len]);
    p += 8 + len;
  }
  return { tracks, format, nTrks, ppq, smpte, tickDur };
}

/* ---------- the packer walk (exact legacy record semantics) ----------
   Replayed twice (B1 counts buckets, B2 writes recs) — the pairing is a pure
   function of the track bytes, so both passes see identical records. */
const RCAP = 512, RMASK = 511, NKEYS = 2048;   // 512-deep same-key pending: black-MIDI trills stack far past 64
async function walkTracks(read, tracks, ppq, onRec, onProg, progBase) {
  const dflt = Math.max(24, (ppq * 0.6) | 0);
  const rT = new Int32Array(NKEYS * RCAP), rV = new Int32Array(NKEYS * RCAP), rK = new Int32Array(NKEYS * RCAP);
  const cB = new Int32Array(NKEYS), hB = new Int32Array(NKEYS);
  const lanes = {}, programs = {}, ptl = [];
  let notes = 0, maxTick = 0, recCount = 0, chMask = 0;
  const conv = (tick) => Math.min(0x7ffffffc, Math.round(secOf(tick) * SRQ));
  for (let t = 0; t < tracks.length; t++) {
    const [off, len] = tracks[t];
    const TB = (t & 255) << 21;                 // R58c: trk mod 256 (clamp collapsed 10312-trk files to slot 255 = one color)
    let pos = 0, carry = null;
    const c = { tick: 0, run: 0 };
    const rec = (at, dur, packed, tkc) => { onRec(at, dur, packed | ((tkc == null ? t & 255 : tkc) << 21), packed & 7); recCount++; };   // tkc: the ON's track (cross-track pairing keeps its color)
    const emitN = (onTick, durTick, pitch, ch, vel, tkc) => {
      const at = conv(onTick);
      const dur = Math.max(1, Math.round((secOf(onTick + durTick) - secOf(onTick)) * SRQ));
      rec(at, dur, (pitch << 14) | (ch << 10) | (vel << 3), tkc);
      notes++; chMask |= 1 << ch;
    };
    let stop = false;
    while (pos < len && !stop) {
      const take = Math.min(PAGE, len - pos);
      const u8 = await read(off + pos, take);
      let buf8 = u8, end = take;
      if (carry) {                          // an event straddled the last page border: rejoin it
        buf8 = new Uint8Array(carry.length + take); buf8.set(carry); buf8.set(u8, carry.length); end = buf8.length;
      }
      const res = stepAll(buf8, 0, end, c.tick, c.run, (ty, tk, a, d1, d2) => {
        if (tk > maxTick) maxTick = tk;
        if (ty === 'note') {
          const key = (a << 7) | d1;
          if (d2 > 0) {
            if (cB[key] >= RCAP) {
              const bi = key * RCAP + hB[key];
              emitN(rT[bi], dflt, d1, a, rV[bi] & 127, rK[bi]);
              hB[key] = (hB[key] + 1) & RMASK; cB[key]--;
            }
            const slot = key * RCAP + ((hB[key] + cB[key]) & RMASK);
            rT[slot] = tk; rV[slot] = d2; rK[slot] = t & 255; cB[key]++;
          } else {
            if (cB[key]) {
              const bi = key * RCAP + hB[key];
              emitN(rT[bi], Math.max(tk, rT[bi]) - rT[bi], d1, a, rV[bi] & 127, rK[bi]);
              hB[key] = (hB[key] + 1) & RMASK; cB[key]--;
            }
          }
        } else if (ty === 'cc') {
          const at = conv(tk);
          if (d1 === 64) rec(at, 0, (a << 10) | ((d2 > 0 ? 1 : 0) << 3) | 2);
          else if (d1 === 120 || d1 === 121 || d1 === 123) rec(at, 0, (a << 10) | 4);
        } else if (ty === 'bend') {
          rec(conv(tk), d1, (a << 10) | 5);    // bend 14-bit rides the dur slot raw (worklet reads it directly)
        } else if (ty === 'pc') {
          (programs[a] || (programs[a] = new Set())).add(d1);
          ptl.push([tk, a, d1]);                                                      // R62d: program-change timeline (ticks)
        }
      });
      if (res.p < end && !res.eot && end - res.p <= 65536) carry = buf8.slice(res.p, end);
      else { carry = null; if (!res.eot && res.p < end) c.run = 0; }    // abandoned oversized event: resync
      c.tick = res.tick; c.run = res.run;
      pos += take;
      if (res.eot) stop = true;
      if (res.tick > maxTick) maxTick = res.tick;
    }
    /* R62g: NO per-track flush — pending rings persist across tracks (MIDI pairs
       on/off on the MERGED stream; format-1 files legally split ons/offs across
       tracks, and a per-track dflt-flush turned every such note into a stub) */
    if (t === tracks.length - 1) {           /* end-of-SONG flush: keys ascending, FIFO order, dflt duration */
      for (let key = 0; key < NKEYS; key++) {
        const cnt = cB[key];
        if (!cnt) continue;
        const pitch = key & 127, ch = key >> 7;
        for (let j = 0; j < cnt; j++) {
          const bi = key * RCAP + ((hB[key] + j) & RMASK);
          emitN(rT[bi], dflt, pitch, ch, rV[bi] & 127, rK[bi]);
        }
        cB[key] = 0; hB[key] = 0;
      }
    }
    if (onProg) onProg(progBase + (t + 1) / tracks.length * 0.3, 'PACKED TRK ' + (t + 1) + '/' + tracks.length);
  }
  return { notes, maxTick, recCount, lanes, programs, ptl, chMask };
}

/* ---------- per-sec write buffers (B2) ---------- */
const WCAP = 8192;                            // recs per sec-buffer flush (96 KB)
const WMAX = 512;                             // open sec-buffers (~48 MB) before the LRU evicts
let base = null, cur2 = null, secN = 0;
const sbufs = new Map();
function sbuf(sec) {
  let b = sbufs.get(sec);
  if (b) { sbufs.delete(sec); sbufs.set(sec, b); return b; }      // refresh LRU order
  b = { u8: new Uint8Array(WCAP * 12), n: 0 };
  sbufs.set(sec, b);
  if (sbufs.size > WMAX) {
    const k0 = sbufs.keys().next().value;
    const b0 = sbufs.get(k0);
    if (b0.n) { store.write(base[k0] + cur2[k0] * 12, b0.n === WCAP ? b0.u8 : b0.u8.subarray(0, b0.n * 12)); cur2[k0] += b0.n; }
    sbufs.delete(k0);
  }
  return b;
}
function place(at, dur, packed) {
  const sec = (at / SRQ) | 0;
  const b = sbuf(sec);
  const o = b.n * 12, u32 = new Int32Array(b.u8.buffer, o, 3);
  u32[0] = at; u32[1] = dur; u32[2] = packed;
  b.n++;
  if (b.n === WCAP) {
    store.write(base[sec] + cur2[sec] * 12, b.u8);
    cur2[sec] += b.n;
    b.n = 0;
  }
}
function flushAllSecs() {
  for (const [sec, b] of sbufs) {
    if (b.n) { store.write(base[sec] + cur2[sec] * 12, b.n === WCAP ? b.u8 : b.u8.subarray(0, b.n * 12)); cur2[sec] += b.n; }
    b.n = 0;
  }
  sbufs.clear();
}

/* ---------- finalize: counting-sort every bucket + emit derived tables ---------- */
const idxList = [], cmList = [];
let laArr = null, laCap = 0, laN = 0, longRun = [], lpend = [];
function laPush(at, dur, packed) {
  lpend.push(at, dur, packed);
  longRun.push(at + dur);
  laN++;
  if (longRun.length === 2048) {                // R62i: chunk complete: one spill write per 2048 long recs
    const u8 = new Uint8Array(lpend.length * 4);
    new Int32Array(u8.buffer).set(lpend);
    lstore.write(lrecBase, u8); lrecBase += u8.length;
    cmList.push(Math.max.apply(null, longRun));
    lpend = []; longRun = [];
  }
}
async function finalize(onProg) {
  const SB = 4096;
  const hOn = new Float64Array(SB), hEnd = new Float64Array(SB);
  let recIdx = 0;
  const cnt = new Int32Array(SRQ + 1);
  for (let sec = 0; sec < secN; sec++) {
    const n = cur2[sec];
    if (!n) continue;
    const off = base[sec];
    const u8 = store.read(off, n * 12);
    const nn = Math.min(n * 3, (u8.byteLength / 4) | 0);
    const src = new Int32Array(u8.buffer, u8.byteOffset, nn);
    cnt.fill(0, 0, SRQ + 1);
    let sorted = true, prevAt = -1;
    for (let i = 0; i < n; i++) {
      const at = src[i * 3];
      if (at < prevAt) sorted = false;
      prevAt = at;
      cnt[(at - sec * SRQ) + 1]++;
    }
    let dst = src;
    if (!sorted) {
      for (let v = 1; v <= SRQ; v++) cnt[v] += cnt[v - 1];
      const out = new Uint8Array(n * 12);
      const o32 = new Int32Array(out.buffer);
      for (let i = 0; i < n; i++) {
        const at = src[i * 3], p = cnt[at - sec * SRQ]++;
        o32[p * 3] = at; o32[p * 3 + 1] = src[i * 3 + 1]; o32[p * 3 + 2] = src[i * 3 + 2];
      }
      store.write(off, out);
      dst = o32;
    }
    for (let i = 0; i < n; i++) {
      const at = dst[i * 3], dur = dst[i * 3 + 1], pk = dst[i * 3 + 2];
      if (recIdx % 4096 === 0) idxList.push(at);
      if (!(pk & 7)) {
        const sb = ((at / SRQ) / metaTotalSec * SB) | 0;
        const b0 = sb < 0 ? 0 : sb >= SB ? SB - 1 : sb;
        hOn[b0]++;
        const se = (((at + dur) / SRQ) / metaTotalSec * SB) | 0;
        const b1 = se < 0 ? 0 : se >= SB ? SB - 1 : se;
        hEnd[b1]++;
        if (dur > LTH) laPush(at, dur, pk);
      }
      recIdx++;
    }
    if ((sec & 2047) === 0 && onProg) onProg(0.9 + 0.08 * sec / secN, 'SORTING');
  }
  if (lpend.length) {                           // final partial long chunk
    const u8 = new Uint8Array(lpend.length * 4);
    new Int32Array(u8.buffer).set(lpend);
    lstore.write(lrecBase, u8); lrecBase += u8.length;
    lpend = [];
  }
  if (longRun.length) cmList.push(Math.max.apply(null, longRun));
  IDX = Int32Array.from(idxList); idxList.length = 0;
  cmArr = Int32Array.from(cmList);
  for (let i = 1; i < SB; i++) { hOn[i] += hOn[i - 1]; hEnd[i] += hEnd[i - 1]; }
  stC = hOn; enC = hEnd;
}

/* ---------- parse (streaming) ---------- */
let metaTotalSec = 1;
async function parse(src, onProg) {
  idxList.length = 0; cmList.length = 0;
  cursor = 0; inflight = 0; lastT = 0;
  const read = typeof src === 'function' ? src : makeSrc(src);   // loadPath hands a reader straight in
  const { tracks, format, nTrks, ppq, smpte, tickDur } = await readTracks(read);
  /* pass A: tempo map (fresh walker state per track) */
  const tempoEv = [];
  for (let t = 0; t < tracks.length; t++) {
    const [off, len] = tracks[t];
    const cA = { tick: 0, run: 0 };
    let pos = 0, carry = null;
    while (pos < len) {
      const take = Math.min(PAGE, len - pos);
      const u8 = await read(off + pos, take);
      let buf8 = u8, end = take;
      if (carry) {
        buf8 = new Uint8Array(carry.length + take); buf8.set(carry); buf8.set(u8, carry.length); end = buf8.length;
      }
      const res = stepAll(buf8, 0, end, cA.tick, cA.run, (ty, tk, a) => { if (ty === 'tempo') tempoEv.push([tk, a]); });
      if (res.p < end && !res.eot && end - res.p <= 65536) carry = buf8.slice(res.p, end);
      else { carry = null; if (!res.eot && res.p < end) cA.run = 0; }
      cA.tick = res.tick; cA.run = res.run;
      pos += take;
      if (res.eot) break;
    }
  }
  buildTempo(tempoEv, ppq, smpte, tickDur);
  if (onProg) onProg(0.1, 'TEMP MAP ' + tracks.length + ' TRK');
  /* pass B1: count records per second bucket */
  let recCount = 0, notes1 = 0, maxTick = 0;
  let secCnt = new Int32Array(1 << 12);
  secN = 0;
  const r1 = await walkTracks(read, tracks, ppq, (at) => {
    const sec = (at / SRQ) | 0;
    if (sec >= secCnt.length) {
      const nb = new Int32Array(secCnt.length * 2); nb.set(secCnt); secCnt = nb;
    }
    secCnt[sec]++; recCount++;
    if (sec + 1 > secN) secN = sec + 1;
  }, onProg, 0.1);
  recCount = r1.recCount; notes1 = r1.notes; maxTick = r1.maxTick;
  /* bucket base offsets */
  base = new Float64Array(secN + 1);            // pack can exceed 4 GB: offsets must not be int32
  for (let s = 0; s < secN; s++) base[s + 1] = base[s] + secCnt[s] * 12;
  packSize = base[secN];
  cur2 = new Int32Array(secN);
  if (onProg) onProg(0.45, 'PLACING ' + recCount.toLocaleString() + ' RECS');
  /* pass B2: convert + place */
  const r2 = await walkTracks(read, tracks, ppq, place, onProg, 0.45);
  flushAllSecs();
  if (onProg) onProg(0.9, 'SORTING');
  /* finalize */
  const total = Math.max(secOf(maxTick) + 2, 1);
  metaTotalSec = total;
  laArr = new Int32Array(0); laCap = 0; laN = 0; longRun = []; lpend = []; lrecBase = 0; lrecN = 0;
  cmList.length = 0;
  await finalize(onProg);
  const progsOut = {};
  for (const ch in r2.programs) progsOut[ch] = Array.from(r2.programs[ch]).sort((x, y) => x - y);
  meta = {
    nTrks: tracks.length, format, ppq, smpte, tickDur,
    tempo: tempoEv.map((x) => ({ tick: x[0], uspb: x[1] })),
    total, conv: r2.recCount, notes: r2.notes, n: r2.recCount, lanes: r2.lanes, programs: progsOut, ptl: (r2.ptl || []).slice().sort((x, y) => x[0] - y[0]), chMask: r2.chMask | 0, maxTick
  };
}

/* ---------- serving ---------- */
function readRecs(lo, n) {
  if (!(lo >= 0) || !(n > 0)) return new Int32Array(0);
  const off = lo * 12;
  if (off >= packSize) return new Int32Array(0);
  const take = Math.min(n * 12, packSize - off);
  const u8 = store.read(off, take);
  const n3 = Math.min(((take / 12) | 0) * 3, (u8.byteLength / 4) | 0);   // never OOB on a short read
  return n3 > 0 ? new Int32Array(u8.buffer, u8.byteOffset, n3) : new Int32Array(0);
}
function readAt(recIdx) {
  const u8 = store.read(recIdx * 12, 4);
  return new Int32Array(u8.buffer, 0, 1)[0];
}
function idxForAt(at) {                      // -> CHUNK index whose first rec is the latest start <= at
  let lo = 0, hi = IDX.length - 1, r = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (IDX[mid] <= at) { r = mid; lo = mid + 1; } else hi = mid - 1; }
  return ((r * 4096) / CHUNK) | 0;
}
function feed() {
  if (!meta) return;
  const gateAt = (lastT + lead) * SRQ;
  while (cursor * CHUNK < meta.conv) {
    if (readAt(cursor * CHUNK) > gateAt) break;
    if (inflight >= 96) break;
    const lo = cursor * CHUNK;
    const n = Math.min(CHUNK, meta.conv - lo);
    const buf = readRecs(lo, n);
    inflight++; cursor++;
    self.postMessage({ op: 'batch', ev: buf, tag: curTag }, [buf.buffer]);
  }
}
self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.op === 'load' || m.op === 'loadBuffer' || m.op === 'loadPath') {
      SRQ = m.SRQ; CHUNK = m.CHUNK; LTH = m.LTH;
      await initStore(m.op !== 'loadBuffer');    // real files spill to DISK, never RAM
      const srcIn = m.op === 'loadPath' ? nodeSrc(m.path)
        : (m.op === 'load' && m.file && m.file.__path ? nodeSrc(m.file.__path)   // Node glue-smoke file stub (browser Files have no __path)
        : (m.op === 'load' ? m.file : m.ab));
      await parse(srcIn, (p, txt) => self.postMessage({ op: 'progress', p, txt }));
      self.postMessage({
        op: 'ready', meta, IDX, cmArr, stC, enC
      }, [cmArr.buffer, stC.buffer, enC.buffer]);   // IDX stays worker-resident: seeks binary-search it here
    } else if (m.op === 'lrec') {
      const off = m.c * 2048 * 12, take = Math.min(2048 * 12, lrecBase - off);   // R62i: 2048-rec long pages
      const buf = take > 0 ? lstore.read(off, take) : new Uint8Array(0);
      self.postMessage({ op: 'lrecPage', c: m.c, buf }, [buf.buffer]);
    } else if (m.op === 'win') {
      const buf = readRecs(m.lo, m.n);
      self.postMessage({ op: 'win', reqId: m.reqId, lo: m.lo, buf }, [buf.buffer]);
    } else if (m.op === 'pump') {
      lastT = m.t; lead = m.lead; curTag = m.tag;
      feed();
    } else if (m.op === 'ack') {
      inflight--; feed();
    } else if (m.op === 'seek') {
      curTag = m.tag; cursor = idxForAt(m.at); inflight = 0;
      feed();
    } else if (m.op === 'stop') {
      cursor = 0; inflight = 0;
    }
  } catch (err) {
    const st = err && err.stack ? String(err.stack).split('\n').slice(1, 3).join(' | ').trim().slice(0, 160) : '';
    self.postMessage({ op: 'error', msg: (err && err.message || String(err)) + (st ? '  [' + st + ']' : '') });
  }
};
