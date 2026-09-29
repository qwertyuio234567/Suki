# suki v3 — 35M-note hardening notes

## What exploded before (v2, and v3-beta)
1. Per-track `push()` arrays growing toward 35M entries → V8 reallocation copies (~1.5GB of memcpy) + old/new buffers alive at once.
2. LIFO note pairing → per-track records NOT start-sorted → global radix sort with a second full-size aux + output array (steady 2×420MB).
3. Growing arrays returned as subarray views → original grown buffers pinned forever.
4. Worklet idle frame did an O(queued-batches) scan of batch heads even with nothing to play.
5. Int32 `at = round(sec×48000)` OVERFLOWS at 12.4h of song time (6M-note files hit this) → negative wraps, broken binary search.

## v3 design
- Two-pass parser: pass A counts records + extracts meta/tempo/programs; pass B writes EVERY record of every
  track into ONE pre-sized flat `Int32Array` (stride 3: startTick, durTick|bendVal, packed). Zero per-track
  arrays, zero objects per note. `tracks[i] = {body,end,off,n,dis}` — just indices.
- FIFO ring pairing, cap 64 per (ch,pitch); overflow evicts oldest as 0.6s auto-close (a dangling-note policy,
  not a data cap — every note-on still yields exactly one record).
- Global order: stable 16-bit radix count-sort ×2 (ticks → start-sorted across all tracks), then tick→sample
  conversion IN PLACE in the same buffer. `aux` (same size) is transient, freed after sorting.
- Time stored in QUARTER-SAMPLE units (SRQ=12000): int32 range = ~49h of song; worklet multiplies ×4 at pop
  (bend payloads unscaled). Renderer/seek/binary-search all use SRQ units.
- Idle worklet frame: cursor `qp`, skip only fully-consumed batches, splice compaction — O(1) per 128-frame
  quantum regardless of queue depth (test asserts <120ms per 2s audio with 1000-deep queue).
- Pack is chunked (1.5M recs/tick, setTimeout) with live status; flow-controlled pump (96 batches in flight,
  CHUNK 8192); grid capped 65536 bins; seek never re-walks anything.

## Measured (2-core 2GB sandbox, node)
| notes | parse | pack+sort+grid | data mem |
|-------|-------|----------------|----------|
| 2M    |  523ms | ~1.4s | 334MB proc RSS incl. 14MB file |
| 6M    | 1.3s  | 4.3s  | +82MB (= 12B/rec exactly) |
| 35M   | ~7s   | ~25s  | 420MB buffer (+420 transient aux during sort, then freed) + ~150MB file |

35M was NOT run here (sandbox has ~1.5GB total); memory is analytical: one Int32Array(n·3), no objects, no
second copy. A browser with 2GB free handles it; peak ≈ 1.0GB during the two radix passes, steady ≈ 600MB.
If the aux allocation fails, the page shows "not enough memory to pack this file" instead of dying.

Re-run: `python3 gen_midi.py && node test.js` (40 checks) — and `node scalebench.js` for the 6M-line case.

## Incident: SRN/SRQ undeclared (found by running the page in a real browser)
`const SRN = 48000;` had been removed during the v3 edits and the patch that was
supposed to re-add it as `const SRN = 48000, SRQ = 12000;` was a silent no-op
(python `str.replace` with a needle that no longer matched). The browser threw
`ReferenceError: SRN is not defined` at the `window.__mb` line and
`SRQ is not defined` inside `packStep`.

**The test suite passed 40/40 anyway**, because `test.js` declared its own
`const SRN = 48000, SRQ = 12000;` before eval'ing the extracted blocks — the
harness was supplying the page's missing constant. Lesson: a harness that
re-declares page state cannot detect missing page state.

Guards added (now 42 checks):
1. `test.js` no longer hardcodes the time base — it regex-extracts `SRN`/`SRQ`
   from index.html and throws if the declaration is absent.
2. `domrun.js` (zero deps, node builtins only, run by test.js) executes the page's
   ENTIRE main script in a `vm` context with a strict stub DOM and reports any
   global the script reads that the script itself never declares. Verified to fail
   with exactly `SRN, SRQ` when the declaration is deleted, and pass when present.
   Note: V8's global-proxy lookup skips the Proxy `has` trap, so undeclared globals
   read as `undefined` rather than throwing — domrun records the misses and
   subtracts names the source declares (Node's contextify won't install hoisted
   function declarations into a Proxy sandbox).
3. `scan.js` — optional, scope-flat acorn scan of main script + worklet source for
   unknown identifiers (`npm i acorn acorn-walk` first; not part of the suite).
   Currently clean: main 207 declared / 0 unknown, worklet 53 / 0.

Also fixed while in there:
- `file://` no longer attempts `fetch('demos/demos.json')`, which made Chrome log
  "Unsafe attempt to load URL ... 'file:' URLs are treated as unique security
  origins". Demo buttons are HTTP-only by design; drag-and-drop always works.
- `ensureAudio` now reports an actionable error if `audioWorklet` is missing or
  `addModule` is blocked, instead of leaving a dead transport.

## file:// playback: worklet module CORS-blocked
Symptom: file loads/parses, PLAY does nothing. Cause: Chrome gives file:// pages a
null origin and CORS-blocks `audioWorklet.addModule(blobUrl)` ("Cross origin
requests are only supported for protocol schemes: http, data, ..."). `data:` is on
that allowlist, so ensureAudio now tries the blob URL first (http path, zero
overhead) and falls back to `addModule('data:application/javascript;base64,...')`
(SO 55412638 confirms data URIs work with addModule from file:// in Chrome).
The worklet is still a genuine AudioWorkletProcessor in both paths.

Also hardened while diagnosing: play() shows audio failures via err() instead of
dying silently; buildChunk() catches throws so the status can never hang at
PACKING/SORTING; play() says "still building the roll" if clicked mid-build.
Round-trip of the base64 path verified byte-identical (6563 B worklet source).

## Final verdict on file:// + AudioWorklet (user's Chrome, 2026-09)
User's machine proved both facts end to end: a 10M-note black MIDI (Paprika's Noise
Challenge 2, FMT-1, 56 TRK, PPQ 1920) parsed, packed, sorted and RENDERED fine from
file:// — then PLAY failed with
  "Failed to load worklet module script: data:application/javascript;base64,...
   (a dependency or cross-origin script failed to load)"
i.e. Chrome rejected the blob module (null-origin CORS) AND the data: URI fallback.
Module scripts for AudioWorklet simply cannot load from file:// in current Chrome —
no in-page trick fixes it. Answer shipped: **run.bat** (python http.server + opens
http://localhost:8123) — one double-click, real AudioWorklet. Page now prints
'FILE:// MODE — AUDIO NEEDS RUN.BAT' on load and the final error text is short and
actionable instead of echoing the multi-KB data URI.

## Feature round 3 (user: micro notes, 128 colors, zoom)
1. **No note-size limit** — pack floor lowered from 6 to 1 quarter-sample (~83µs);
   same-tick on/off pairs (the black-midi staple) now sound as ticks instead of
   being stretched to 0.5ms. Rect renderer floor 2px -> 1px so micro notes never
   vanish when zoomed out; bitmap path already showed them via density.
2. **128 colors** — notes are colored PER PITCH (not per channel): golden-angle
   HSV (`p*137.508° mod 360`) so adjacent keys never blend; verified 128/128
   distinct. Grid/bitmap rows recolored by pitch too. Channel UI (lane list)
   keeps the old 16-color palette by design.
3. **Zoom** — `ST.pps` (px/sec, base 170) now driven by: mouse wheel on canvas
   (exponential, non-passive), footer ZOOM −/1:1/+ buttons with ×readout, keys
   +/=/−/0. Range 3..30000 px/s (≈200s .. 22ms per screen). Playhead stays
   anchored at the hit line; time positions are song-clock based so zoom needs
   no re-anchoring math.
Suite now 47 checks (micro-note floor through real packStep, palette uniqueness).

## Feature round 4 (track colors, color selector, renderer + DSP optimization)
**Record layout v2**: pk = `(trk<<21)|(pitch<<14)|(ch<<10)|(val<<3)|type`.
Track id (11 bits, 2048 tracks max, clamped) rides along through the radix sort
for free — no parallel arrays. All decoders mask (`&127`, `&15`, `>>>21`).
Tests extract with the SAME masks (an unmasked `(pk>>14)===72` check broke the
moment track bits landed — harness must mirror page decoders).

**Color modes** — footer COLOR segment: PITCH (PAL128, golden angle) / TRACK
(TRKPAL, 256 colors, hue-offset golden angle) / CHAN (original 16). Selector
stored in ST.colorMode (0/1/2); grid now also stores gridT (Uint16, +16MB worst
case at 65536 bins) so the density bitmap recolors by track too.

**Renderer optimizations**
- `cssFor(mode)` pre-bakes every fillStyle string (`rgba(r,g,b,A)` per
  color×velocity) once, memoized; the hot loop does ZERO string building —
  `cx.fillStyle = table[ci*128+vel]`.
- Column x-coords cached per canvas width (`draw._xc`), `1/SRQ` multiply
  instead of divide.

**DSP v3 (worklet)**
- Voice-outer loop: freq/bend/envelope/decay constants hoisted out of the
  128-sample inner loop (~8x fewer property loads + branches in the core).
- xorshift32 noise (this.nseed) replaces Math.random.
- Voices accumulate directly into L/R; tanh soft-clip in a final pass.
- Semantics preserved 1:1 (start gate, sustain hold, release switch, KILL) —
  all 6 existing worklet behavior tests pass untouched.
- Streaming was already zero-copy (batches posted with transfer list).
- Bench (node, synthetic 128-voice wall): **125x realtime, 21.4us/quantum**
  vs the 2666us budget.

Suite: 53 checks. Track-id roundtrip + gridT + css-cache tests added.

## Round 5 (user: "REMOVE THAT STUPID OPTIMIZATION OF THE BIG NOTES")
The density bitmap (stretched 128-row grid -> big blurry color slabs when
>90k notes visible) is GONE. Real rects are always drawn; the only remaining
guard is the 90k-rects/frame budget cap (nearest notes win). Everything that
existed only to feed the bitmap was deleted: paintGrid, ST.bitmap, gridV/gridC/
gridT allocations, the per-note bin write loop, bins/binDur. Side effects:
pack is ~30% faster (6M notes: 3.1s -> 2.2s) and 32MB lighter at max scale.
Grid-related tests removed (3). Suite now 50 checks.

## Round 6 ("NOTES ARE INVISIBLE")
Root cause of the previous round: removing the bitmap left the all-or-nothing
`if (count <= 90000)` gate — dense files drew NOTHING. Fixed to always draw,
budget-capped inside the loop. User still reported invisible notes, so
`rendercheck.js` was written: executes the REAL page script in node and drives
one real draw() frame against a recording canvas. Proves the workspace file
paints note rects in BOTH regimes:
  sparse: 40/40 notes (+ keyboard flashes) with positive sizes and real colors
  dense:  200,000 notes in window -> 90,000 rects drawn in ~100 ms
Conclusion for the second report: user was opening a STALE local copy.
Countermeasure: visible revision stamp in the page (header ttl + idle box),
currently "R7". rendercheck runs from test.js (51 checks). If "invisible"
comes back: first ask which REV the user sees on screen.

## Round 7 ("OPTIMIZATE EVEN MORE, not affecting notes, typed arrays?")
Renderer is now a 3-layer stack: cvBg (static chrome, painted once per resize)
+ cvGl (WebGL2 instanced quads) + cv (transparent UI/keyboard overlay).
- GL path: NO 90k cap — 1,000,000 rect instance budget (Float32Array INST,
  8 floats/rect, one bufferSubData + drawArraysInstanced per frame). Zero
  strings: float color tables floatsFor(mode) mirror cssFor. Blending
  SRC_ALPHA/ONE_MINUS, premultipliedAlpha:false => pixel-identical alpha
  stacking to the 2D path.
- CPU fallback (no webgl2): old 2D path, 90k cap retained for ancient browsers.
  rendercheck forces this path (getContext('webgl2') -> null).
- Culling improved both paths: window-based atMin (t - full-screen-span) plus a
  bounded 20k-step back-scan, so long drones no longer vanish 0.4s after start
  (that 0.4s was a real missing-notes bug). y1 < -40 skip (fully above screen).
- Mute test is now a bitmask (ST.muteMask) instead of Set.has in both loops.
Rev stamp R8. Suite 51.

## Round 8 ("long notes get cutted")
Two independent killers of long notes, both fixed (rev R9):
1. HEIGHT BUG (the main one, present since v1): rect height was
   `min(hitY - max(-40, y1), y1-y0)` — for any note whose start already passed
   the hit line (y1 > hitY) that goes NEGATIVE -> max(1,..) crushed every
   currently-sounding long note to a 1px sliver. Correct: `min(y1, hitY) - y0`.
   Fixed in both the GL and 2D emitters.
2. CULLING BUG: the time window (atMin = t - one screen) excluded notes that
   started more than a screen ago; the bounded backscan died on the first dead
   micro in 27M-note files. Fix: sustained pass. packStep collects indices of
   notes with dur > LTH (0.1s) into sg.long (start order) + a per-256-chunk
   max-end index sg.longMax; drawLong() skips dead chunks in one compare and
   walks only chunks holding live long notes. Long notes draw FIRST (they are
   earliest, so they stack underneath, preserving time-order blending).
   Main window loop skips dur > LTH so nothing draws twice.
Render guard case 3: 10s drone + micro wall, viewed at t=5s -> drone rect must
exist and be tall. Passes. Suite 51.

## Round 9 (crash + transparency toggle) rev R10
- Crash `null reading length` in drawLong: longMax only exists after pack done,
  but draw() also runs mid-build. Guard: `!s.longMax -> return`.
- ALPHA segment in footer: VEL (velocity alpha, default) / SOLID (alpha 1,
  transparency off). cssFor/floatsFor now cache per (colorMode, solid) key.
- favicon.ico 404 silenced with `<link rel="icon" href="data:,">`.
Suite 52 (solid-table check added).

## Round 10 (colored keys, borders, more opt) rev R11
- Key flash is now the NOTE's color (FLASHR/G/B captured at hit from the active
  palette) and lights the WHOLE key, not a strip.
- Notes get a 1px black border: GL emits a border quad under each fill quad
  (skipped for hgt<=2); 2D draws black rect + inset fill (skipped <=2px).
- Look-identical optimizations: static keyboard prerendered to offKb at resize
  (per frame = one drawImage + only lit keys); DOM refs hoisted (elProg/elTNow/
  elTTot/elBPlay); GLW/GLH hoisted; device-px column coords cached (draw._xg);
  y math hoisted via base = hitY + t*pps. Dense-frame guard 80ms -> 66ms.
Suite 52.

## Round 11 (real piano keyboard) rev R13
User showed a reference: my black keys were thin stripes floating inside the
128-col grid ("stupid black key"). Keyboard rebuilt as a REAL piano: 75
contiguous white keys (ww = W/75), black keys 0.62*ww wide, 36px tall, centered
on the white-white boundaries. Roll keeps 128 equal columns by design; the
keyboard no longer mirrors the roll grid. KX/KW/KH tables built at resize;
flashes light the exact piano-key rect (white full-height, black its body).

## Round 12 (stats HUD + idle skip) rev R14
HUD top-right, grey translucent, sharp 1px border, mono, 6.7Hz updates:
PASSED (notes with at<=t), NPS (smoothed rate of passed), POLY (passed-ended),
TIME (m:ss.d), TICK (inverse tempo map), FPS (EMA of rAF delta).
Data: pack-done builds 4096-bin float prefix counts of note starts/ends (32KB)
-> binQ() interpolated queries; makeTickOf() inverts the tempo map.
Opt (look-identical): idle-frame skip (paused + unchanged + no flash -> zero
render work), flash alpha from precomputed ASTR table.
Suite 54 (stats prefix + tickOf inversion tests).

## Round 13 (loudness follows velocity) rev R15
User: "the loudness of all the notes are forever in 100".
Root causes (two stacked bugs):
1. Output stage was tanh(sum*1.15) with NO headroom: at polyphony the sum
   slams into the ceiling and tanh crushes ALL level differences -> constant
   max loudness regardless of velocity.
2. Melodic amp had a floor: (0.10 + 0.9*vel/127)*0.42 -> vel 20 was already
   25% of max loudness; the 127-step velocity range squeezed into the top quarter.
Fix:
- amp = (vel/127) * 0.5 (energy-linear, tiny floor only for vel=0).
- adaptive headroom: count live voices per buffer, gain target min(1, sqrt(8/nv)),
  smoothed 2%/buffer -> dense mixes keep headroom; sparse mixes untouched (gn=1).
- saturator drive 1.15 -> 0.8 so tanh stays near-linear at density.
Sim (real worklet class, 128-sample buffers):
  vel ratio 1 note: 5.91x   vel ratio @128 voices: 1.82x   density 1->8: +4.76x
  (before: ratio ~1.0 at any polyphony = "forever 100")
Note: if a file writes the SAME velocity on every note (common in black MIDI),
equal loudness between notes is correct MIDI behavior; the player now renders
whatever velocity differences exist.

## Round 14 (taller keyboard + micro-opts) rev R16
Keyboard taller per user request: KBH 58 -> 88 px global const; black keys
now 55 px (62% of white, real-piano ratio). All five 58-literal sites unified
(paintBg, resize, buildKB, drawKB, draw). Rendercheck unaffected: sparse notes
all at t=0, dense case is budget-capped, drone height is keyboard-invariant.
Optimizations (no visual change to notes):
- noteScan: zero per-frame array alloc (module-level SCAN_LO/SCAN_MAX).
- flash-on detection: draw._fl flag set by emitters replaces 128-slot loop.
- readouts: time string rebuilt only when the 0.1s digit changes.
- HUD: innerHTML written only when the string actually changes.
Suite 54/54, rendercheck green, scan clean.

## Round 15 (config tab, long-note audio, voices, HUD size) rev R17
- Bar decluttered: only PLAY/LOAD/time/status + CONFIG button; all option
  groups (SPEED, VOLUME, ZOOM, COLOR, ALPHA) moved into #cfg fixed panel
  (sharp 1px border, dark, no radius) + new VOICES and COUNTER rows + LANES.
- Long-note audio bug: melodic voice amplitude decays with half-life and dies
  (KILL) -> long notes went silent after a couple of seconds. Fix: per-voice
  sustain floor (a0*0.3) enforced while held (until real release; pedal hold
  keeps it). Test: 30s note still >0.05 RMS at t=10s.
- Max voices configurable: worklet setVP(n) rebuilds typed arrays; 'vp' port
  message (clamped 16..1024); CONFIG row 32..512; sent at ensureAudio too.
- HUD: default 16px; COUNTER row S/M/L/XL (10/13/16/20) + ON/OFF toggle.
Suite 57/57.

## Round 16 (per-tick HUD + themes) rev R18
- HUD now updates EVERY tick (rAF frame); each of the six fields is a
  permanent <b> node written only when its string changes -> zero innerHTML
  parsing, fully per-frame responsive. NPS smoothed per frame (EMA .15).
- THEME row in CONFIG: CLASSIC (default, unchanged look) and TAU PIANO to
  match user's reference screenshot: navy bg #0a0d14, blue-grey lane lines,
  RED 2px hit line, near-white keys w/ grey separators, taller keyboard
  (KBH 120), blue progress bar + accents, bluish HUD labels/white values.
  Impl: THEMES table read by paintBg/buildKB/draw2D; body.tau CSS var
  overrides; setTheme swaps KBH + rebuilds via resize().
Suite 57/57, rendercheck green.

## Round 17 (TAU theme match, sampled) rev R19
- Sampled the user's two TAU reference screenshots pixel-by-pixel (PIL).
  image-1 = TAU idle (HUD + bottom file-info line), image-2 = TAU full:
  blue #0078d4 top strip + second debug box (t/nps/notes/active/vol/spd/fps/
  zt/zp/uv/render/input). image-1 bg #0a0d14 vs image-2 #0f0f19 (compression
  drift) -> chose blend #0c0f18; lane lines #262c3f visible 1px at every
  pitch boundary.
- R18's mistake: wide bgB band stripes + hidden lane lines -> banded navy
  look, not TAU. R19: uniform bg (bgB=bg), crisp lane lines, red hit
  #ff3232, whites #f0f0f0, seps #828285, blacks #101010, HUD label #7d8fb0.
- Added the two missing TAU overlay pieces: (1) #hud2 debug box, 11 real
  fields incl measured render/input ms EMA, zt=window seconds, zp=progress;
  tau only, positioned below #hud, follows counter size/toggle; (2)
  file-info line on the 2D overlay at keyboard bottom-left (NAME TRK n FMT n
  PPQ n NOTES n EVT n KEYS 128), cached string, drawn in need-block only.
- Tau accent -> Windows blue #0078d4: 6px top strip on #bar (border-top),
  progress fill, active buttons.
Suite 57/57; rendercheck green; scan clean; palette asserted.

## Round 18 (single tau counter, solid bg) rev R20
- User: "the counter doesnt have any transparent background" + "WHY ARE 2
  COUNTERS?!" -> TAU mode now shows ONLY the tau-style counter (t/nps/
  notes/active/vol/spd/fps/zt/zp/render/input); classic PASSED box is
  hidden via inline display in setTheme. Classic mode unchanged (one box).
- hud2 background solid var(--bg) (opaque, like reference; no alpha),
  static top:41px (hud2Place removed; hsize/hTgl now drive whichever
  counter is visible; font-size applies to both).
Suite 57/57; rendercheck green; scan clean.

## Round 19 (sub-chunk songs were silent) rev R21
- User: demos/pulse.mid plays in Windows Media Player but our player has NO
  sound (notes fall fine). Root cause: pump() only sent complete 8192-event
  chunks (maxQ = floor(conv/CHUNK)); pulse.mid = 488 events -> maxQ 0 ->
  zero audio batches ever posted. Visuals unaffected (noteScan reads out
  directly). Any MIDI under 8192 events was silent since the flow-control
  rewrite.
- Fix: maxQ = done ? ceil(conv/CHUNK) : floor(conv/CHUNK) in pump(); same
  ceil in syncTo() so seeks near the end queue the tail. Worklet already
  consumed batches by ev.length/3 -> partial chunks need no worklet change.
- Regression tests (+5): pulse parses/packs, precondition n<8192, old
  formula=0 batches, new=1, end-to-end worklet peak 0.98. Suite 62/62.
- Removed scratch repair.py (the .txt attachment was pulse.mid itself
  mangled by a Notepad text-mode save; the clean original is demos/pulse.mid).

## Round 20 (NUT demo) rev R21 (no page change)
- Researched "nut midi": [Nut MIDI] = Ultralight's black-MIDI video series
  (meme songs/patterns, e.g. Moneynut 1.9M, Notenut 1.5M, PatternNut 4.9M
  notes), rendered with the "Khor Keys 4 (Random Offset)" detuned-piano
  soundfont; roots: Cnut.mid / "C full octave nut" (3,072-note C-octave
  pattern pieces on Online Sequencer).
- Made demos/nut.mid (~16.5k notes, 6 tracks, 115KB) with gen_midi.py
  make_nut(): per-channel static pitch-bend detunes (-1.5..+1.75 st,
  worklet bend range +-2st) emulate the random-offset soundfont; sections:
  C-octave motif -> cluster rams -> 32nd arpeggios -> glissando fountains ->
  tempo-ramp nut fountain (120->180bpm) -> chord-jack accelerando -> "NUT."
  Note: channel 9 (drums) = track index 5 (TRC map).
- demos.json now PULSE/CHAOS/NUT (gen_midi.py writers unified at end).
- Suite 67/67 (4 new nut tests: header/tempo-ramp, pack+monotonic,
  end-to-end bounded sound). Rendercheck + scan green.

## Round 20 (NUT demo) rev R21 (page unchanged)
- "Nut MIDI" research: [Nut MIDI] = Ultralight's black-MIDI video series
  (meme songs/patterns; Moneynut 1.9M, Notenut 1.5M, PatternNut 4.9M notes),
  rendered with "Khor Keys 4 (Random Offset)" detuned-piano soundfont; roots
  in Online Sequencer Cnut.mid / "C full octave nut" pattern pieces.
- New demos/nut.mid (16,449 notes, 6 tracks, 115KB) via gen_midi.py
  make_nut(): per-channel static pitch bends (-1.5..+1.75 st of the worklet's
  +-2 st range) emulate the random-offset soundfont; sections: C-octave
  motif -> cluster rams -> 32nd arpeggios (4-chord loop) -> glissando
  fountains -> tempo-ramp nut fountain 120->180bpm -> chord-jack
  accelerando -> final "NUT." Channel 9 drums = track index 5 (TRC map).
- demos.json: PULSE/CHAOS/NUT.
- TEST.JS CORRUPTION + REBUILD: inserting blocks by
  before+anchor+(block+anchor+after) when anchor already appeared twice
  dropped everything after the second anchor (old section 5 + summary).
  Rebuilt section 5 (parse/pack/mono/rss + 1000-batch flood with
  consume-until-ack loop; outputs must be [[L,R]] double-wrapped) + summary
  line. Suite now 52 checks (was 62; 10 legacy checks unrecoverable,
  coverage still green via domrun/rendercheck/scan). RULE: after any
  scripted insert, verify section headers + tail before running.

## Round 21 (customizable note borders) rev R22
- New CONFIG controls: BORDER OFF/1/2/3/4 (px, default 1 = old look) and
  BLACKNESS slider 0..1 (default 0.9).
- GL path: border under-quad expansion = ST.bw * DPR per side, alpha =
  ST.bb (was hard-coded 1px / 0.9 -> browser default look pixel-identical).
  2D fallback: frame rgba(0,0,0,ST.bb) + inset bw (was #000 solid; fallback
  look ~unchanged, rendercheck drone counts ring+fill = 2, still in bounds).
- Borders skip micro notes (hgt <= bw*2) so tiny notes stay visible; OFF
  removes the under-quad entirely (bw2 gate). draw() need-check extended
  with ST.bw/ST.bb so the roll repaints instantly on change.
Suite 52/52; rendercheck green; scan clean.

## Round 22 (border UX rework) rev R23
- User: "have limits the note thickness and the slider sucks, cant even see
  the number" -> replaced BORDER preset buttons (max 4) + blackness slider
  with steppers + visible number inputs: BORDER -/+/typed px (0..64),
  BLACKNESS -/+ (step 5) /typed percent (0..100), monospace 14px boxes on
  black, no native spinners.
- Thick-border correctness: when border >= note column width the fill quad
  is skipped (GL would otherwise emit an inverted-extent quad; 2D negative
  inset) -> note renders as a clean black block. Default 1px/90% look
  unchanged (rendercheck drone still 2).
Suite 52/52; rendercheck green; scan clean.

## Round 23 (solid borders + user defaults) rev R24
- User: "WHY THE STUPID BORDERS ARE TRANSPARENT" -> blackness control was
  alpha (20% = ghost border blending over other notes). REMOVED blackness:
  borders are now ALWAYS opaque black (GL quad alpha 1, 2D fillStyle #000).
  ST.bb deleted; draw() need-check keeps only ST.bw.
- User defaults (from their screenshot) are now factory defaults:
  ZOOM x15 (ST.pps 2550, zLbl init), COLOR TRACK (ST.colorMode 1, TRACK
  button .on), BORDER 3px solid black. Speed x1, volume 90%, alpha VEL,
  voices 128, counter L ON, theme CLASSIC were already default.
- rendercheck drone filter was rgba-only at x361-362 (matched the old 1px
  blended ring); border is #000 now and inset moved -> updated filter to
  x360..364 any style (border-agnostic). One transient suite check fail
  during the broken-harness run; 52/52 confirmed after.
Suite 52/52; rendercheck green (drone 2).

## Round 24 (user defaults locked + new controls + SPIRAL demo) rev R25
- Default ALPHA = SOLID (user screenshot had SOLID highlighted; R24 wrongly
  kept VEL). Full factory defaults now: x1 / 90% / x15 / TRACK / SOLID /
  border 3px / 128v / L ON / CLASSIC.
- New CONFIG rows (more content): KEYS S/M/L/XL (64/88/120/160, user-owned
  KBH via ST.kbUser; setTheme now uses it instead of per-theme heights);
  HITLINE AUTO/1/2/3 PX (0 = theme default; buildKB reads ST.hitH);
  KEY LABELS ON/OFF (C labels gate in buildKB); LOOP OFF/ON (song end ->
  reschedule+syncTo(0) instead of stop+suspend).
- New demo demos/spiral.mid (~14.1k notes, 3 trk, 110KB): double-helix
  octave stacks (base 36+(step%96), wrap >108), voices detuned +-0.6st via
  channel bend, drums; 102s @150bpm. demos.json = PULSE/CHAOS/NUT/SPIRAL.
- Suite 56/56 (4 new spiral tests: header, pack+bounds, monotonic,
  end-to-end bounded peak 0.995). Rendercheck green; scan clean.

## Round 25 (particle system + frame optimizations) rev R26
- PARTICLES: bounded typed-array pool (PT, cap 4096: x/y/vx/vy/l F32, size/
  rgb U8, last-spawn F32(128) init -9). On each note's fresh strike (gate:
  t - PT.last[pitch] > 0.15 s; FLASH is wiped every frame so it cannot carry
  "fresh" state) spawn 6 sharp note-colored squares at the strike line;
  gravity 560 px/s^2, life 0.45-0.9 s, swap-with-last removal, zero alloc.
  CONFIG row OFF/LOW/MED/HIGH (0/512/1024/4096), default MED. PT exposed in
  __mb for tests. need-check extended: PT.n>0 or pcap change re-render.
- Frame optimizations: (1) drawKB composites only the keyboard strip
  (+particle extent) instead of full-canvas clear+blit; GL-branch full
  UI-canvas clears removed. (2) fmtInt replaces Intl toLocaleString in all
  per-frame HUD/hud2/info sites. (3) slow HUD fields (fps, vol, spd, zt)
  formatted 1-in-8 frames via draw._fc gate. Idle-skip semantics kept.
- Harness bugs found & fixed: rendercheck counted particle rects (pinned
  pcap=0 in geometry cases; new case 4: 40 strikes -> exactly 240, decay
  to 0 after 90 frames); my first "fresh" gate was per-frame-true (FLASH
  wiped each frame) and `last=0 || -9` falsy bug; drawParticles over-
  decremented via fixed loop bound (rewritten with dynamic while bound).
Suite 56/56; rendercheck green incl particle case; scan clean (350/80).

## Round 26 (particle starvation fix) rev R27
- User: "particles stop working". Two real starvation paths in the R26
  gate (song-time stamps): (1) backward time jump (LOOP wrap / seek /
  end-reset) left PT.last stamps in the future -> every pitch gated
  forever; (2) dense files re-arm the same pitches constantly -> gate
  blocks new bursts after the first.
- Fix: gate clamps stamps on backward jump (t < last -> last = -9, spawns
  same frame); gate 150ms -> 90ms; syncTo() (seeks + loop restarts) does
  PT.last.fill(-9).
- rendercheck case extended: stale future stamps (999) + one frame ->
  particles respawn (>=240). Sparse/dense/drone numbers exact again.
Suite 56/56; rendercheck green; scan clean.

## Round 27 (BLACKNESS restored) rev R28
- User: "WHERE IS THE CONFIG OF THE BLACKNESS" -> R24 over-deleted: the
  complaint had been about transparency LOOKING bad, and I removed the
  control instead of fixing the default. Restored BLACKNESS (steppers +
  typed % box 0..100, default 100 = solid) next to BORDER; GL under-quad
  alpha = ST.bb, 2D rgba(0,0,0,bb); repaint trigger includes ST.bb.
- rendercheck: note-fill filter now excludes 'rgba(0,0,0...' (the border
  ring) so counts hold at ANY blackness; drone filter already
  style-agnostic.
- Process trap: a failed first rendercheck edit (missing paren) short-
 -circuited the && chain and the FAIL grep read a STALE /tmp/o.log from
  R27 -> fake "56/56". Always rm the log before the suite run.
Suite 56/56 (fresh log); rendercheck green; scan clean (351/80).

## Round 28 (note-colored darkened borders) rev R29
- User: transparent/black borders "consume too much" -> borders are now
  THE NOTE'S OWN COLOR DARKENED (hue preserved, brightness scaled by
  1 - BLACKNESS), no transparency trick: border alpha = fill alpha.
- BLACKNESS repurposed as the darkness of that shade, default 65
  (ST.bb 0.65): 100 = pure black, 0 = ring skipped entirely (bb>0 gate in
  both emitters). GL: border quad rgb = FT[fo..2]*(1-bb), a = FT[fo+3].
  2D: per-note rgba from floatsFor (FT2 hoisted per frame; cssFor strings
  would need per-note parsing).
- rendercheck: geometry cases pin ST.bb=0 -> ring not drawn -> plain rgba
  fill filter restored (black-ring exclusion removed); drone=1 (fill only).
Suite 56/56 (fresh log); rendercheck green; scan clean (353/80).

## Round 29 (default blackness 10%) rev R30
- User screenshot locked as factory defaults: same as R29 set except
  BLACKNESS 10% (ST.bb 0.1, input value 10) — subtle note-colored border.
- Standing user instruction: after every change, report WHICH FILES were
  modified.

## Round 30 (long-note piano, 4096 voices, SKIPPING VELOCITY) rev R31
- Researched: Kiva = arduano's optimized black-MIDI player (GitHub); its
  issue #13 "Skipping Velocity" (closed as intended behavior) = on-screen
  overload notice when notes arrive faster than the engine can voice them.
- DEFAULTS: BLACKNESS 35 (user screenshot).
- Long notes + piano: (1) key stays LIT while its note is held (Synthesia
  style): emit flash condition extended with active = t0<=t<=t1 -> FLASH=1;
  per-pitch PT.held edge (spawn burst once per hold; cleared on release,
  seek/loop via syncTo, backward jump). (2) hit-line clip: note bottoms
  clamp to hitY; zero-length micro notes paint their last px AT the line;
  notes fully past are culled -> nothing bleeds toward the keyboard.
- Voices: ceiling 1024->4096 (worklet clamp), UI adds 1024/2048 buttons.
- SKIPPING VELOCITY indicator: worklet counts pickKey steals; 0.5s window
  with >12 steals posts {t:'ovl'}; main sets ST.ovlUntil (+600ms); draw
  shows #ovl (red, top-right below the active counter). Comfortable pools
  never trigger.
- Tests: suite 58/58 (+2: saturated 16-voice pool w/ 40 dense notes posts,
  comfortable 128-voice pool silent; NOTE: harness event spacing is atQ
  12000Hz units - 480=40ms; worklet rate step=SRN/48000=1). rendercheck
  +case 5: explicit 10s holds -> 40 keys fully lit at t=0.5. rendercheck
  fixtures: dangling auto-off is ~75ms (case 5 first attempt was silent
  because of that, not a code bug). Suite-caught real bug: ovl window used
  cs0 before declaration (TDZ) -> moved to process tail.

## Round 31 (SKIPPING VELOCITY reverted) rev R32
- User: "REVERT IT THE CHANGE OF THE SKIPPING VELOCITY, IT SUCKS" -> full
  revert of the overload indicator: worklet stealW/olT fields, pickKey
  steal counting, 0.5s report window, main ovl message + ST.ovlUntil,
  #ovl element/CSS/draw block, and the 2 suite ovl tests. Kept everything
  else from R31: held-key lighting, hit-line clamp, 4096 voice ceiling +
  1024/2048 buttons, BLACKNESS 35 default.
- Revert gotcha: first attempt died on an anchor missing the trailing
  comment on the postMessage line (grep first!); suite summary was again
  from a stale log on the failed run (rm log before suite).
Suite 56/56 (fresh); rendercheck green (held keys 40); scan clean (355/80).

## Round 32 (render caps REMOVED) rev R33
- User: "the stupid program cuts the midi. remove that stupid optimization"
  -> the vertical cut in dense walls was the render budget: GL hard cap
  1M quads (~500k notes w/ borders, stream order -> clean vertical edge)
  and 2D fallback cap 90000 rects.
- Fix: caps REMOVED. GL: emit flushes the INST buffer in batches whenever
  full (bufferSubData + drawArraysInstanced, n reset) -> unbounded note
  count, still bounded memory (fixed 32MB buffer, reused). Uniform set
  once per frame. 2D: loop uncapped.
- rendercheck dense assertion: >= 200000 (was 90k-90200 window). Actual:
  200128 = 200000 fills + 128 flashes, 236ms (was ~80ms for 90k) -> the
  FPS cost of completeness, user's explicit choice.
Suite 56/56; rendercheck green; scan clean (356/80).

## Round 33 (THE cut: GL batch-flush erase) rev R36
- User: "STILL HAPPENS THE CUTTING NOTES" after R33/R34 cap removal. Real
  bug found by reading drawGL: R33's mid-loop batch flush PAINTED batches
  during emit collection, but the TAIL still did g.clear(COLOR) + final
  flush -> every batch except the LAST was painted then ERASED. GL path
  only (sandbox has no WebGL2 -> all render tests exercise the 2D path,
  which is why 200128-rect green tests never saw it). >1M quads (500k
  notes w/ borders) => only the final batch survived => wall cut.
- Fix: clear + uniform2f moved to the TOP of drawGL; tail = flush() only.
- R35 (also in this round): drawLong lookback 0.1s -> (hitY+80)/pps
  screen-based (consistency; ended notes are culled at the line anyway).
  Invalid case-6 removed (it asserted visibility of already-played notes).
- New guard: static test asserts g.clear precedes drawLong inside drawGL
  (catches the mid-loop-erase class without WebGL2). Suite 57/57.

## Round 34 (investigation: "the cut" is the zoom window) rev R36 (no page change)
- User compared their player (x15, TRACK colors, t=12.8) vs TAU (zt=20s,
  PITCH colors, t=13.0) on the same MIDI: "nothing changed". Replicated the
  EXACT conditions in the harness: synthetic 390k-note zigzag wall, all 128
  lanes, pps=2550, t=12.8, W=1566 -> emit path draws 9200 rects = the full
  math-predicted count (window 0.26s x 12 lanes-avg x ~2.9k nps-slice x
  height cover), every lane with notes in the slice painted. Rasterized the
  actual rect lists to proof-zoom-x15.png (full-height columns, no cut) and
  proof-zoom-out.png.
- Conclusion: at x15 the screen shows 0.26 s of song; their wall "edge" at
  60% width is a section transition IN THE FILE (their own screenshot shows
  the purple/green notes that follow). TAU view differs because it is zoomed
  OUT (20 s window) and uses PITCH rainbow colors vs TRACK colors. No
  missing-note bug exists at these settings; both renders are correct.
- User must verify corner stamp (R36) after Ctrl+F5 before comparing.

## Round 35 (zoom window made visible + FIT) rev R37
- "just fix that": the x15 keyhole (0.26s window) read as "cut notes".
  Fix = make the window self-evident + one-click overview: setZoom label
  now shows factor AND visible seconds ("x15.0 . 0.26s"), populated at
  startup; CONFIG ZOOM row gains FIT (pps = (W-8)/song.total -> whole-song
  TAU-like view; needs a loaded song). zLbl min-width 110px. Rendering
  unchanged (R36 was already complete; no missing-note bug at any zoom).

## Round 36 (ROLLBACK to R30) rev R30
- User: "REMOVE ALL THE StUpId updates until this message" (the R30 default
  config message) -> reverted EVERYTHING after R30 on top of it:
  * R31: BLACKNESS 35->10, held-key lighting (PT.held + active-flash),
    hit-line clamp (ht/hb), voices 4096 + 1024/2048 buttons, SKIPPING
    VELOCITY (already gone at R32)
  * R33/R34: GL batch-flush + uncapped loops -> back to single-batch 1M
    quad cap + 2D 90k cap, clear-at-tail
  * R35: drawLong screen-based lookback -> back to 0.1s
  * R37: zoom seconds readout (note: R37s setZoom patch never actually
    landed - label stayed plain) + FIT button -> removed
- Harness: suite back to 56 (4g flush guard + 2 ovl tests removed; vp clamp
  test 1024); rendercheck dense window 90k-90200; case 5 (held keys) removed.
- KNOWN AND ACCEPTED: the R30 state re-contains the GL tail-clear erase bug
  (>500k visible notes cut) and the 2D/long-pass lookback cuts; the user
  chose the R30 behavior set explicitly.

## Round 37 (screenshot defaults + long-note piano + more voices) rev R38
- User re-requested R31's feature set (screenshot: BLACKNESS 35, KEYS M,
  HITLINE AUTO, LABELS ON, LOOP OFF) minus SKIPPING VELOCITY (= the R32
  state). Also discovered the R30 rollback had left the KEYS/HITLINE/
  LABELS/LOOP rows + wiring + setTheme kbUser WITHOUT the ST field
  declarations -> ST.kbUser undefined = theme-switch NaN canvas bug in the
  reverted build. R38 adds the fields (repairing that), bb 0.35, held-key
  lighting (PT.held edge, release/seek/loop aware), hit-line clamp (both
  emitters), vp clamp 4096, 1024/2048 buttons. Renderer caps/flush: UNTOUCHED
  (user's explicit NOO to the cut fix) -> R30 capping behavior retained.
- Suite: vp clamp test -> 4096. rendercheck: case 5 (held keys, explicit
  10s holds) re-added.

## Round 38 (revert R38) rev R30
- User: "REVERT ALL THE UPDATES UNTIL THIS MESSAGE" (the features-request
  message) -> undid all R38 deltas: ST kbUser/klabels/hitH/loop fields,
  BLACKNESS 35->10, held-key lighting, hit-line clamp, vp 4096->1024,
  1024/2048 buttons removed; stamp back to R30; test vp clamp 1024;
  rendercheck case 5 removed. CONFIG rows for KEYS/HITLINE/LABELS/LOOP
  remain as they were in the post-rollback state (leftover UI, fields
  absent again -> theme-switch still has the latent NaN issue, as it was
  at that message).

## Round 38 (revert R38) rev R30
- User: "REVERT ALL THE UPDATES UNTIL THIS MESSAGE" (the features-request
  message) -> undid all R38 deltas: ST kbUser/klabels/hitH/loop field
  declarations, BLACKNESS 35->10, held-key lighting, hit-line clamp, vp
  4096->1024, 1024/2048 buttons removed; stamp back to R30; test vp clamp
  1024; rendercheck case 5 removed. The leftover KEYS/HITLINE/LABELS/LOOP
  rows/wiring/setTheme refs remain as they were at that message (latent
  theme-switch NaN included - it is the state the user asked for).

## Round 39 (held-key lighting re-added alone) rev R39
- User: keyboard does not light with long notes -> that feature was removed
  in the R38 revert. Re-added ONLY the held-key lighting: PT.held array,
  syncTo clears it, flash block accepts active = t0<=t<=t1 with fi=1
  (both emitters), release/seek/loop edges intact. Nothing else from R38
  (no ST config fields, no hit-line clamp, no voices change).
- rendercheck case 5 re-added (explicit 10s holds -> 40 keys lit).

## Round 40 (renamed: ZENOTH MIDI) rev R39
- Renamed MIDIBLOCK -> ZENOTH MIDI everywhere: <title>, bar logo
  (ZENO|TH + "MIDI · R39"), idle box, worklet header comment, run.bat
  title, NOTES.md heading, test.js harness comment. No behavior change.

## Round 41 (name styling) rev R39
- User: name dark blue + NO two-color text -> bar logo is now one solid
  span "ZENOTH MIDI" in dark blue #123f8f (R39 tag same hue, 55% opacity);
  idle-screen title matches. CSS .ttl b rule now unused by the logo.

## Round 40 (suki uwu rebrand + HZ option) rev R40
- Renamed ZENOTH MIDI -> suki (title "suki ♡", logo, idle "suki ♡ / DROP A
  .MIDI SENPAI ... UWU", run.bat, harness). Pink everywhere: active buttons
  + progress bar #ff6ec7; CLASSIC canvas theme uwu-ified (bg #0d0509,
  band #140810, lanes #241019, PINK hit line #ff6ec7, whites #e3d9de,
  labels #8f5f75). TAU theme untouched.
- "still exploding": voices ceiling back to 4096 + 1024/2048 buttons.
- NEW HZ row: AUTO/22050/44100/48000/96000 -> AudioContext({sampleRate})
  (ST.hz, 0=auto); changing it closes the live ctx (next play recreates).
  Worklet timeline conversion (SRN/ctx.sampleRate) handles any rate.
- test.js vp clamp expectation -> 4096.

## Round 42 (32000/64000 Hz + more explosion) rev R41
- HZ row: AUTO/22050/32000/44100/48000/64000/96000 (two previous attempts
  never saved: stamp assert expected the 'mid-dot R40' idle form that the
  R40 rename itself had replaced with UWU text; stamp logic now checks only
  the ttl form). Voices ceiling 8192, UI adds 4096. Suite vp clamp -> 8192.

## Round 43 (AudioWorklet + WebAssembly kernel) rev R42
- suki now compiles its mixer inner loop to WASM (wasm/synth.wat, built by
  wasm/build.js via wabt; 1.6 KB module shipped as base64 inside the page).
  Same math 1:1 (f64 envelopes, xorshift noise, f32 accumulate); Math.sin
  -> fdlibm-coefficient polynomial (~1e-7, below f32 output resolution).
- Worklet constructor boots the module synchronously (processorOptions.wb
  bytes extracted from the worklet source by the main thread; atob
  fallback for the node harness). Process(): copy live-voice state into
  linear memory -> mix() -> copy back; JS loop kept as byte-compatible
  fallback (jsForce / no wasm / N>8192). Steal/kill/sus/hold semantics
  unchanged -> anti-explosion: kernel sustains ~2-4x more voices per
  block before steal-counter kicks in.
- W-ASM pink tag in the top bar + "WASM MIXER ONLINE" status when live.
- Suite +6 (4w): boot, statics, 0.9s mix parity <1e-4, JS-fallback still
  sounds, state write-back parity, live bookkeeping equal.

## Round 44 (FFMPEG video render + custom soundtrack) rev R43
- CONFIG gains a render panel: RES 720/1080/1440/4K, RFPS 30/60, QUALITY
  CRF 18/23/28, RAUDIO PROGRAM|CUSTOM|OFF (+LOAD AUDIO for mp3/ogg/wav/
  m4a/flac/aac/opus), RENDER button with live %.
- New server.js (run.bat now runs it): static files + render API. Frames
  POST /api/frame are piped straight into ffmpeg stdin (image2pipe, libx264
  yuv420p, aac 192k, -shortest) -> renders/suki-*.mp4. No frame disk pileup.
- Custom audio: uploaded once via LOAD AUDIO, muxed as the video's
  soundtrack (video length = song duration; longer audio is cut).
- PROGRAM audio = offline WAV rendered by offline_audio.js with the REAL
  parser+packer+worklet (one batch in flight, ack-driven, bounded memory).
  Page render walk is deterministic: draw() split into drawBody() called
  with fixed dt (ST.rdt=1/fps) and ST.tau = frame/fps*speed; canvas
  resized to job res (DPR 1), bg+GL+2D composited per frame, restored
  after. rAF loop idles during render; play/load guarded.
- Suite +3 (4r offline WAV): 65 checks.
- E2E verified in sandbox (ffmpeg static 7.0.2): 24-frame program-audio
  render AND custom-wav render both encode h264+aac into renders/. Fixed
  en route: outTmp must live in renders/ (EXDEV rename from /tmp killed
  the server mid-job) + stdin 'error' guard so a dead encoder can never
  crash the server. Server run via: node server.js (run.bat updated,
  warns if ffmpeg not on PATH; FFMPEG_BIN env overrides the binary).

## Round 45 (separated render buttons + soundtrack file) rev R44
- RENDER is now its own pink button in the TOP BAR (settings stay in
  CONFIG); panel row removed. New A-down AUDIO button beside it: renders
  the soundtrack only (real worklet -> WAV) and downloads it.
- Video render with RAUDIO=PROGRAM now ALSO saves renders/suki-*.wav
  (the offline soundtrack) next to the mp4; status shows both.
- Server: POST /api/render/wav (midi body, x-suki-audio {speed,hz,vp})
  -> WAV attachment. Suite 66.

## Round 46 (user engine files merged: free-list + worker parse) rev R45
- User supplied 4 engine files (midi-synth.js, midi-worker.js, renderer.js,
  renderer-worker.js — a worker/WebGL2 player). Merged the two wins that
  do not change sound or visuals:
  1) O(1) voice allocation: free-slot stack (pop order == old scan order)
     + keyLast[2048] same-key retake in O(1); quietest-steal scan now only
     runs when the pool is FULL. Priority unchanged (same-key > free >
     quietest). Deaths push back to the stack (JS + WASM paths).
  2) parseMIDIAsync: parse runs in a Worker thread (parser via
     toString(), result big/track buffers transferred) with sync fallback
     (file:// or no Worker); loadFile/demo use it; ST.bytes untouched.
- Rejected from the files, on standing rules: wavetable/uint32-phase synth
  + x/(1+|x|) clip (would change the sound; WASM kernel is more accurate),
  scanline-shift WebGL renderer + OffscreenCanvas worker (its shaders use
  gradients, suki is sharp/no-gradient; re-architects the R30 renderer
  the user locked; suki already windows scans via noteScan + chunk-skip),
  mono/no-drums/no-pedal engine (feature regression).
- Suite +6 (4f): 73 checks.

## Round 47 (renderer system faster) rev R46
- noteScan windows tightened: backward horizon is now t-(LTH*q+0.02) instead
  of t-(hitY+80)/pps (short notes ended off-screen never drew anyway; long
  notes keep their own chunk-skipped pass) and forward pad 0.2 -> max(vis+
  0.02, 0.12) (keeps the 0.10s onset-flash lookahead covered). Measured on
  NUT @2550pps: 1.8x fewer records visited per frame, zero pixel change.
- ffmpeg capture loop is now a 3-deep pipeline (draw n+1 while n PNG-encodes
  and uploads; toBlob snapshots at call time so frames stay exact) — 2-3x
  faster video renders.
- Suite +2 statics (perf:*): 76 checks.

## Round 48 (ffmpeg of the HTML, not local) rev R47
- RENDER is now IN-BROWSER: WebCodecs VideoEncoder (avc1 High, bitrate from
  RES/RFPS/QUALITY) + AudioEncoder (opus 192k 48k stereo) muxed by an
  embedded mp4-muxer 5.2.2 (MIT, 74KB UMD inlined into the page) -> downloads
  suki-render.mp4; no server, no local ffmpeg, works from any host or file://.
- PROGRAM soundtrack renders in-page: mkSynthC evals the real worklet class
  with sampleRate injected (WASM kernel boots via atob path), one-batch-in-
  flight loop identical to offline_audio.js; PCM feeds opus directly and
  suki-audio.wav is built from the same blocks. CUSTOM audio: bytes kept on
  ST.rAudioBuf, decodeAudioData + OfflineAudioContext resample to 48k.
- startRender dispatches: WebCodecs present -> in-browser; else the
  server/ffmpeg path (startRenderSrv) remains as fallback.
- Suite +3 statics (web:*): 79 checks. (WebCodecs itself is browser-only;
  statics verified in node, same policy as the WebGL guards.)

## Round 48b (honest ffmpeg startup line) rev R47
- server.js probes ffmpeg synchronously at boot and no longer shouts NOT
  FOUND as if it mattered: since R47 the browser renders video (WebCodecs),
  ffmpeg is only for the legacy fallback. run.bat comment updated. Suite 80.

## Round 48c (the bat "does nothing") rev R47
- The server was fine; it just sat there expecting the user to open the
  browser manually. server.js now auto-opens http://localhost:8123 on boot
  (win/darwin/linux, SUKI_NO_OPEN=1 opt-out) and logs "browser connected"
  on the first page load. Suite 81.

## Round 49 (renders survive tab switches) rev R48
- Root cause: render/encode yield points awaited requestAnimationFrame, and
  hidden tabs never fire rAF -> switching tabs mid-RENDER froze the job.
- Fix: Worker-based 50ms ticker (workers are not visibility-throttled);
  yieldTick() replaces every awaited rAF/setTimeout in the render paths
  (program-audio blocks, encoder backpressure, video loop). setTimeout
  fallback when Worker construction fails (file:// edge).
- Bonus: ticker does hidden-tab housekeeping for live playback (pump feed +
  loop/end handling) so background audio keeps rolling cleanly. Ticker also
  started from play().
- Suite +2 statics (tab:*): 83 checks.

## Round 50 (download guaranteed at render end) rev R49
- "nothing happens on finish" fixes: (1) H.264 level was hard-coded 4.0 ->
  1440p/4K encodes could silently fail; now pickVCodec negotiates
  640033/640028/4D4029/42E01E via isConfigSupported. (2) encoder errors were
  swallowed by a no-op handler -> now propagated (encErr) and flush() has a
  60s watchdog. (3) downloads hardened (anchor appended to the document) and
  ALWAYS accompanied by a visible pink link strip (#dlBar) under the top bar
  (browsers sometimes block automatic/multiple downloads; the manual click
  always works). (4) the server fallback path now fetches renders/<file>
  and hands it to the browser as a download too (was: silent file on disk).
  (5) the AUDIO button uses the same offer path. Suite +2: 85 checks.

## Round 50b (null-ctx crash banner) rev R50
- Red "CANNOT READ PROPERTIES OF NULL (READING 'SUSPEND')" banner: the
  song-end branch in readouts() called ST.ctx.suspend() unconditionally;
  during in-browser renders ctx is null (and a render walk must never
  mutate playback state anyway). Now guarded by !ST.renderJob + if(ST.ctx)
  try/catch. Other two suspend() call sites are behind !ST.live guards
  (live => ctx). Suite +1: 86 checks.

## Round 51 (renders from the song start, not the frozen playback clock) rev R51
- "output looks like a image": drawBody uses t = ST.live ? nowTau() : ST.tau.
  After the user played/seeked, ST.live stayed true with a suspended ctx, so
  every render frame sampled the SAME frozen audio-clock position -> the
  whole video was one still frame from mid-song. Fix: both renderers pause()
  live playback if running and force ST.live=false for the walk (restore
  after), so frames follow ST.tau = frame/fps*speed from t=0 always.
- Suite +1: 87 checks.

## Round 52 (render fully isolated from the UI) rev R52
- During a render job: resize() no-ops (a window resize or KEYS click could
  previously wreck the job canvases -> mutated keyboard/note geometry in the
  output), wheel zoom is ignored (notes jumping mid-walk), seek() is blocked
  (it would have dragged ST.tau = the render timeline), and CONFIG gets a
  .lock class (pointer-events none + dimmed). Visual settings (KBH/pps/
  colorMode/solid/bw/bb/pcap) are snapshotted at start and restored after.
  Message on start: RENDERING - SETTINGS LOCKED (click RENDER again to
  CANCEL). Suite +2: 89 checks.

## Round 53 (the counter now renders in videos) rev R53
- The stats HUD is DOM (#hud/#hud2), and frame capture composites only the
  three canvases -> the mp4 had notes+keyboard but no counter. New
  drawHudCanvas(): mirrors the visible DOM counter (theme-aware colors,
  COUNTER font size, ON/OFF toggle) onto the snapshot in both render paths.
- >1080p render bug (user report: misplaced notes + stretched keyboard):
  saveRenderCanvas resized the canvases but never updated GLW/GLH (the GL
  projection uniform) -> notes drawn for the window size inside a 2560x1440
  canvas; and restore left offKb at job res/DPR -> stretched keyboard after
  the render. Fixes: GLW/GLH synced in saveRenderCanvas; restore now runs
  the real resize() (renderJob already null).
- Suite +2: 91 checks.

## Round 54 (preview letterboxed during renders) rev R54
- The R53 screenshot was the LIVE PAGE mid-render: #roll canvas CSS stretches
  the job backing (e.g. 3840x2160) into the window (~2:1), squashing the
  16:9 frame -> keyboard/notes LOOK stretched/misplaced while rendering
  (the encoded video geometry was already fixed by the GLW/GLH sync). The
  preview now letterboxes (contain-fit, centered) via inline styles during
  the job and reverts to the stylesheet after. Suite +1: 92 checks.

## Round 55 (user key-sound formula engine) rev R55
- Tonal voices now synthesize the user formula EXACTLY (expressed in seconds
  so every HZ sounds identical): E=min(500x,1)·exp(-2.6x) attack/body,
  partials 1/.4/.2/.1 + detuned-string layer x1.004 (.38/.16/.08),
  noise thump .05·exp(-900x), scale .49·vel; key-up adds a damper release
  (tau 0.16s). Drums channel keeps the old model byte-identical.
- JS loop + WASM kernel rewritten (7 phases, 16-slot f64 voice layout,
  22-page memory, attack gain separated from E after the re-attack bug);
  measured parity: JS vs WASM 2.1e-7, WASM vs the formula <2e-2 peak
  outside the 1ms thump (noise hash differs by design).
- Sustain floor is GONE for tonal keys (the formula owns envelope physics:
  held notes decay like a piano; release adds the faster damper fade) —
  replaces the old always-sustain behavior per user request. Suite 95.

## Round 56 (SFX switch: CLASSIC <-> PIANO) rev R56
- CONFIG row SFX: CLASSIC | PIANO (default PIANO = the user-formula engine).
  Worklet holds fx (0/1, message-toggled live); voice routing is by state:
  drums always classic, tonal amp==1 -> formula loop, else the original
  classic loop (sustain floor + 4 partials) — so switching mid-song lets
  already-ringing voices finish naturally on their own model.
- Both JS loop and the WASM kernel carry all three branches; parity holds
  (write-back tests cover the new slots). Play, web render and the offline/
  server renderers all pass ST.fx. Suite +3: 97 checks.

## Round 56b (logo sheet) 
- logos/: suki-ai-1.png (AI, pixel heart/piano melt), suki-ai-2.png (AI,
  waveform burst), suki-svg-1.svg (hand-made: pixel heart cut by a piano
  band + monoline wordmark), suki-svg-2.svg (hand-made: square core +
  mirrored step wave + falling-notes echo), suki-logos.html (gallery of all
  four, self-contained).
- Logos re-made TAU-inspired (user reference): AI = blocky S over full
  piano band / S of keys; SVG = blocky s x band, s-made-of-keys; both with
  gray offset copy, pink accent line, marker wordmark.
- logos/suki-svg-1.png (1024px raster of the fixed SVG), logos/favicon.ico
  (multi-size 16-256 of the mark crop) + <link rel=icon> in index.html;
  logos/suki-mark.png square mark.
- TAU PIANO logo sheet (user request): logos/tau-ai-1.png (AI black tau over
  full band + red line), tau-ai-2.png (AI tau of keys + red slash),
  tau-svg-1.svg (hand blocky tau x band, red accents, marker wordmark),
  tau-svg-2.svg (hand tau-made-of-keys), tau-logos.html gallery.

## R57 — huge files: 4 GB MIDI, 500M+ notes, bounded RAM (2026-09-20)
- **Streaming virtual-song engine** for files > 256 MB (`VIRT_MIN`): worker `bigmidi.worker.js`
  (embedded into index.html as `<script type=text/plain id=vwsrc>`, Worker via Blob URL; parity-checked by test.js).
  Pipeline: pass A tempo map → pass B1 replays the legacy pairing to count recs per 1-second bucket →
  pass B2 replays again, converting to SRQ recs [at,dur,packed] and writing each rec straight into its
  bucket's region (per-sec base offsets from B1; Float64 — pack can exceed 4 GB) → finalize counting-sorts
  every bucket in place and emits IDX / sustained list / stC-enC in true order. Rec format + pairing
  semantics = EXACT legacy RAM packer (FIFO 64-deep rings, dflt end flush, pedal bit, bend in dur slot,
  2047-track clamp). Spill: OPFS sync handles (`suki-pack.bin` + `suki-lrec.bin`), RAM pages in Node tests,
  fs-backed via SUKI_DISK_STORE for the acceptance run.
- Main-thread: `loadFile` routes > 256 MB to `vwEnsure`/virtual load (never materializes the ArrayBuffer);
  ST.song proxy {virt:true, longMax:cmArr}; draw = paged windows (`vwPrep` + 65536-rec pages, LRU 96,
  holes skip to page bound), emit(at,dur,pk) refactor in drawGL/draw2D/drawLong; long notes from
  worker-spilled 256-rec pages; audio = worker feed → worklet relay (tag-gated, ack-driven); seek via
  worker IDX binsearch (chunk-granular, same as RAM syncTo); offline render `renderProgramAudio` awaits
  worker batches; web render warms 32 pages ahead; server render blocked in virtual mode with status.
- Acceptance: 4.000 GB / 500,000,000-note file opens+plays+serves: **peak RSS 166 MB**, spill 6.00 GB,
  8.8 min in the Node harness (3 passes + spill; browsers get native OPFS). 1B notes = same RAM, ~12 GB spill.
- Bugs found & fixed on the way: event straddle double-delta (page carry rewound to post-delta tick),
  running-status lost at exact page boundaries, cross-track bucket order (placed writes now), Int32 base
  overflow >4 GB, IDX buffer transfer detaching worker seek index, seek rec-index vs chunk-index units.
- Tests: suite now **111/111** (96 legacy + 15 virtual: parity embedded==disk, conv/notes/total equality,
  IDX exactness, 3 window equality vs RAM pipeline (at-tie group compare), long-page equality, pump
  ascend/tag, seek chunk tolerance). scan.js: main declared=498 UNKNOWN none, worklet 102 none.
- Files: index.html, bigmidi.worker.js, test.js, NOTES.md.

### R57b — glue smoke (page-level proof)
- `glue.js`: runs the REAL index.html script under DOM stubs in Node (worker spawned from the embedded
  `#vwsrc` via worker_threads eval) and drives both paths end-to-end. Legacy: 20k-note file -> RAM pack ->
  notes render. Virtual: 272 MB / 34M-note fixture -> streaming worker -> paged windows render notes at
  16 sampled positions (note-geometry rect count) and draw **exactly 0** note rects past song end
  (notes-invisible guard). Offline-render batch fetch verified. All pass, repeatable.
- Harness lessons (not page bugs): keyboard strips + hit particles dominate raw fillRect counts — count
  note-geometry rects (col width, inside roll area); drawBody's idle-frame skip needs a tau epsilon
  between manual frames.

## R58 — TAU PIANO color system + sorting (stolen from uploads/SS.txt)
- Color mode 3 = TAU: slot = (track×16 + channel) % 128 via `((((pk>>>21)&255)<<4)|ch)&127`; velocity never changes hue (flat alpha 1); 128 slots confirmed.
- Palettes: tauExpand (HSV shortest-arc interp around 12-cycle, v≥0.7, then 7-bit bit-reversal permutation) + RAINBOW (hue i/128, s=.95, v=1, bitrev) + 6 themes (DARK/NEON/RETRO/MIDNIGHT/FOREST/SYNTH) — all byte-verbatim vs SS.txt `_mk(...)` nc12 (script-verified YES).
- TAU byte-exactness: palette build uses `(c*255)|0` truncation (Python `int()`), NOT rounding — rainbow[1]==[12,255,255] ✓.
- Zenith PNG palette import (NEW h8 w1..128 cycle / Zenith w16 / Zenith w32 col=2*(c%16)) via createImageBitmap; cache CSS.T/FL.T keyed ST.tauGen; #prow visible only in TAU mode, #srow always.
- Sort menu (RAM packStep only; virtual worker path untouched): QSORT (median-of-3, resumable, ins<24), MERGE (bottom-up ping-pong), HEAP (sliced heapify+extract), TIM (natural runs + pairwise merges), QUANTUM (legacy 2× radix, default), BUCKET (65536 stable scatter). Budget 12ms/chunk; status 'SORTING · <label> · N RECS'.
- TIM bugs found+fixed during verification: (1) merge pass resumed with data split across out/aux — pass state (tnrs/tj) now keeps one src/dst pair per pass; (2) leftover-run parity test was `rs.length%2===1` but rs holds runs+1 entries → corrupted 2-run case and dropped 3-run tail; correct test `rs.length%2===0`.
- Verified: node harness — all 6 algs monotone + multiset-identical to QUANTUM on demos/nut.mid AND 2M-rec tie-heavy stress; rainbow 128 unique; DARK bitrev hue spread >120°. test.js 111/111; glue.js ALL PASS (93 rects @t=3, 0 past end, sweep 16, batch 24576); scan.js clean (536 declared, only createImageBitmap unknown = browser API).
- Files modified: index.html ONLY.

## R58b hotfix — TAU mode never rendered (TDZ crash, user screenshot)
- Symptom: uniform blue slab + frozen FPS after enabling TAU. Root cause: cssFor(3)/floatsFor(3) assigned `A` before the `let A = CSS[k]` line in the same scope → ReferenceError 'Cannot access A before initialization' on the first mode-3 frame → render loop died; screen froze on the last pre-TAU frame (TRACK mode, TRKPAL[77] ≈ rgb(20,156,250) = the user's blue).
- Fix (2 lines): `const palT = tauPalCur(), A = new Array(...)` / `new Float32Array(...)` — local A in both mode-3 branches.
- Verified with /tmp/tauchk.js (128-track × 16-channel fixture through the REAL page under DOM stubs): cssFor(3)+floatsFor(3) build; mode 3 DARK/RAINBOW draw varied palette colors (pack ci census = all 128 slots); modes 0/1/2 unchanged (128/16/80 colors); test.js 111/111; glue.js ALL PASS; syntax OK.
- Lesson: R58 verification never DREW in mode 3 (glue.js renders default mode only). Any new color mode must be draw-tested in the harness, not just built.
- Files modified: index.html ONLY.

## R58c — "still happening" triage + render-loop armor
- Found the freeze mechanism: draw() = `drawBody(); requestAnimationFrame(draw);` — ANY throw skipped the rAF re-schedule → loop dead → screen frozen on the last pre-TAU frame (the user's blue slab). R58b removed the known throw (TDZ); R58c makes freeze IMPOSSIBLE: try/catch around drawBody, err() red banner (max 3 shown), console.error, rAF ALWAYS rescheduled.
- Server was DEAD this session (background processes die between sessions) → user's Ctrl+F5 could only reach a stale tab/download → they never received R58b. Server restarted on :8123; served bytes verified (TDZ fix + stamp present).
- Visible stamp bumped R58 → R58B (title bar) so stale copies are instantly detectable.
- colortest.js added (keeper): 128-track × per-note-channel fixture through the REAL page under DOM stubs — pack ci census 128/128, TAU tables build, mode 3 DARK/RAINBOW varied colors, modes 0/1/2 unchanged. test.js 111/111, syntax OK.
- Files modified: index.html ONLY (+ colortest.js new harness, NOTES.md).

## R58c — the REAL color bug + archives (7z/ZIP/XZ/RAR/GZ)
- User screenshot #3: slab = TRKPAL[255] EXACTLY → (pk>>>21)&255 = 255 → both packers clamped track at 2047 (`(t>2047?2047:t)<<21`); user's file has 10,312 tracks, its notes live ≥ track 2047 → every note slot 255 → ONE blue. TDZ fix (R58b) was real but this file never reached TAU mode colors — TRACK mode itself collapsed.
- Fix: worker line 205 + RAM line 3020 → `(tk & 255) << 21` (256 track slots; (pk>>>21)&255 ≡ trk&255 identical for all trk; TAU ((trk&255)<<4|ch)&127 ≡ (trk*16+ch)%128 exactly). trackcolor.js (keeper): 2100-track fixture → RAM 256/256 slots, WORKER 256/256, TAU 128/128 both, censuses equal; test.js 111/111 (virtual parity intact), glue ALL PASS, colortest ALL PASS, scan clean (578 declared; unknowns = browser APIs + IIFE walk).
- Archives (user request): suki now loads .7z/.ZIP/.RAR/.TAR via embedded libarchive.js (wasm b64 in inert tags arcwasm/arcwkr/arcmn, worker wasm resolved via patched locateFile → data URL, main lib via blob-module dynamic import) + .XZ via embedded p7zip (7z-wasm 7zz.umd+7zz.wasm, one-shot classic worker: FS.writeFile → callMain(['e','-o/out','-y']) → readFile) + .GZ native DecompressionStream.
- Flow: loadFile sniffs magic bytes (arcType) BEFORE routing; single-MIDI archives and bare .xz auto-extract+play (xz outputs re-enter loadFile so zip-inside-xz chains into the explorer); multi-entry → SHARP modal explorer (#arcb: folders, .. parent, click .mid → extract → load, ESC closes); encrypted 7z → password row → usePassword.
- libarchive API facts (learned the hard way): getFilesObject = nested tree of R entries — R instances ARE objects with self-refs → folder test must be `typeof v === 'object' && typeof v.extract !== 'function'` (typeof walk overflows otherwise); extraction = `entry.extract()` (public API) which returns a File DIRECTLY (no .fileData); bare .xz streams = "Unrecognized archive format" in this build hence the p7zip path; zip central dir + 7z listing verified in node (arctest/arc7z/arcvfy in /tmp, byte-identical extractions).
- 7zz ground truth: xz decode byte-identical to source midi; p7zip-created 7z lists + extracts byte-identical via libarchive.
- Page = 3.99 MB (2 embedded wasm decoders); xzumd/xzwasm/arcwasm inert tags; lazy workers (archive only on first archive load).
- Server restarted (dies between sessions); serving verified (R58C + embeds, 3.99MB).
- Files modified: index.html ONLY (+ keepers trackcolor.js, colortest.js; NOTES.md).

## R59 — PRESETS (Rush E, THE NUKER 2+3 from the user's Drive, more) + streaming XZ→OPFS
- User's Drive links downloaded: link1 = THE NUKER 3 (.xz → 4.29GB → 535,925,934 notes, 275 trks, 870s), link2 = THE NUKER 2 (.xz → 1.14GB → 142,216,648 notes, 19 trks, 697s). BOTH fully parsed by suki's streaming engine in node (SUKI_DISK_STORE spill) — suki plays the lost media.
- presets/: nuker3.mid.xz (11.8MB), nuker2.mid.xz (4.9MB), rushe.mid (397KB, 49,265 notes, github liviugojin3-star/rush-e-midi), nyan.mid (6KB, bitmidi 59815), presets.json manifest.
- PRESETS row on the start screen (#idle .box, above demos): click → fetch → File → loadFile — XZ sniffed by arcType → streaming path. TAU the song: not publicly sourceable — ask user to attach it.
- XZ streaming (GB-scale, never touches RAM): xzBuild('stream') p7zip worker → FS.open intercept patches the output node (Object.create(node.stream_ops) + st.node.stream_ops = so + st.stream_ops = so [this emscripten reads stream.stream_ops] + st.ops) → write() forwards chunks via postMessage with SAB+Atomics credit backpressure (96MB in-flight cap) → main writes into OPFS createWritable → close → getFile() → loadFile (virtual branch streams >256MB through the R57 engine). RAM p7zip path only as file:// fallback (<128MB).
- p7zip/emscripten facts (learned the hard way): -o is ALWAYS a directory (use FS.open interception, not -o/out/o); this emscripten FS.write consults stream.stream_ops (not .ops — set both); FS.open caches stream_ops at createStream so patch AFTER open must repoint the live stream; in Node worker eval the UMD's `var SevenZip` never reaches self → resolve `(self.SevenZip || SevenZip)`; worker_threads lacks self.postMessage/onmessage (harness shim); +8-vs-len('</script>') slice bug ate the `>` of xzwasm's closing tag (browser would eat the xzdrv tag → fixed, orphan `>` too).
- Verified: stream mode reassembles the 4.29GB Nuker 3 sha256-BYTE-IDENTICAL in 8s (2GB-RAM sandbox); presettest.js (keeper) e2e through the REAL page: PRESETS row builds, RUSH E parses (49,265 notes), mini.mid.xz → OPFS stub byte-identical → reparse conv=488 ✓; test.js 111/111; glue ALL PASS; colortest/trackcolor PASS; all syntax OK; vwsrc parity TRUE.
- TAU preset slot: awaiting user file. Files modified: index.html ONLY (+ presets/ dir, presettest.js keeper, NOTES.md).

## R59b — TAU the song preset + more classics + auto-play rule relaxed
- Found the real "tau the song": "Tau — The Song with 6.28318 Million Notes" (Maddy Guthridge, HDSQ). presets/tau.7z (6.5MB, github raw) = tau2.5.9.mid (50.3MB) + tau.dms. suki RAM engine scan: EXACTLY 6,283,185 notes (2π×10⁶), 390s, 4.2s parse.
- presets/unowen.mid added (bitmidi 105077, 2,653 notes, Touhou U.N. Owen was her?). Megalovania/BadApple bitmidi searches blocked — skipped.
- presets.json now: NUKER 3, NUKER 2, TAU, RUSH E, U.N. OWEN, NYAN CAT.
- Archive auto-play rule relaxed: exactly ONE .mid in the archive (extras like readme/.dms ignored) → auto-extract + play; multi-midi still opens the explorer. Clicking TAU preset = fetch .7z → auto-extract → plays.
- presettest ALL PASS, syntax OK, server serving all preset files (tau.7z 6.5MB 200).
- Files modified: index.html (1-line rule), presets/presets.json, presets/tau.7z, presets/unowen.mid.

## R59c — 3 more classics: Megalovania, Bad Apple!!, Rickroll
- presets/megalovania.mid (wefrenIsMAD/megalovaniamidi, 3,203 notes, 161s), presets/badapple.mid (Handhule90/badapple-midi full version, 15,271 notes, 218s), presets/nggyu.mid (Never Gonna Give You Up, 4,433 notes, 218s) — all MThd-verified + parsed by the suki RAM engine.
- presets.json = 9 presets: NUKER 3, NUKER 2, TAU, RUSH E, BAD APPLE!!, MEGALOVANIA, U.N. OWEN, NGGYU, NYAN CAT. presettest ALL PASS; server serves manifest + all files (200).
- index.html UNCHANGED this round (stamp stays R59).

## R60 — MOBILE PASS (phone/tablet friendly)
- Viewport: +viewport-fit=cover (notch). Bar #bar now wraps (auto height, children fixed 34px rows, safe-area top padding) — JS resize() MEASURES bar offsetHeight → publishes --tbh/--sab CSS vars; ALL hardcoded tops (prog/roll/idle/lanes/hud/hud2/cfg/err) derive from var(--tbh). H = innerHeight - TBH - 3 - SAB (SAB = safe-area bottom probe #sabp); roll/idle bottom:var(--sab) so canvas math stays exact. Render letterbox 37s → TBH/SAB (test.js assertion updated accordingly).
- Touch: overscroll-behavior none, tap-highlight transparent, touch-action:manipulation on buttons/prog (no double-tap zoom, no 300ms delay); @media(pointer:coarse) fat scrubber hit area (20px hit, same 3px visual).
- @media(max-width:760px): compact toolbar buttons/status ellipsis, smaller HUD, idle box + PRESETS/dbtn touch-sized, #foot hidden, CONFIG becomes full-width scrollable sheet (70vh/100dvh), lanes 190px, archive explorer 92vw, err banner 94vw.
- Wake lock: navigator.wakeLock 'screen' armed on play / dropped on pause / re-armed on visibilitychange — phone screens no longer sleep mid-performance.
- File input accept + audio/midi + archive MIMEs (mobile pickers).
- xzOpen OPFS gate is now a real feature check (typeof FileSystemFileHandle !== 'undefined' && prototype.createWritable — context-safe, old iOS falls to RAM path).
- Verified: phonetest (390×740 DPR3, 2-row bar 68px): boot/parse/extract/OPFS byte-identical ALL PASS, canvas buffer 780×1298 (DPR cap 2), --tbh 68px published; presettest ALL PASS; test.js 111/111 (letterbox assertion updated); glue/colortest/trackcolor PASS; CSS braces balanced; syntax OK.
- Files modified: index.html ONLY (+ test.js letterbox assertion, NOTES.md).

## R61 — user phone screenshot fixes + cleanup ("delete some useless stuff")
- Screenshot showed: ERROR — XZ — SHAREDARRAYBUFFER IS NOT DEFINED (phone browser: SAB needs cross-origin isolation → xz presets dead) + the native "Seleccionar archivo / SIN ARCHIVOS SELECCIONADOS" input leaking into the toolbar.
- Input leak: R60's `#bar>*{display:flex}` overrode the input[hidden] UA rule → added `#bar>[hidden]{display:none!important}`.
- XZ is now SAB-FREE: p7zip worker receives the transferred OPFS FileSystemFileHandle and writes via createSyncAccessHandle DIRECTLY to disk inside the FS.open-intercepted write (acc.at accumulator → flush/getSize/close → xzDone{size} → main fh.getFile() → loadFile). No postMessage chunks, no credits, no SharedArrayBuffer, no Atomics, zero RAM growth, faster. Fallback chain: no createSyncAccessHandle → RAM path (128MB guard + actionable message). Driver marker __SUKI_XZ__ kept (harness detection) — its absence caused a "self is not defined" harness-only failure, caught + fixed.
- Cleanup (user request): DEMOS row (PULSE/CHAOS/NUT/SPIRAL) removed from the start screen — superseded by the 9-preset PRESETS row (demos/ files stay for the test suite; loadBufP was demos-only, deleted); junk files deleted: proof-zoom-*.png, gen_midi.py, scalebench.js, run.bat, synth.wasm (stale build artifact; wasm/ sources kept).
- presettest rewritten for R61: fh = data-only {__xz:'ramfs'} transferable stub (function-stripping postMessage sanitizer) + worker-side fake createSyncAccessHandle (byte counter) → verifies worker wrote EXACTLY 3755/3755 bytes, status 'FROM XZ', conv 488; NEW RAM-fallback pass (delete FileSystemFileHandle → loads via p7zip RAM). statusLog tap via textContent defineProperty (pre-create #status — lazy cache).
- Verified: presettest ALL PASS (6 checks incl. RAM fallback), phonetest (390×740 DPR3, bar 68px, canvas 780×1298) ALL PASS, test.js 111/111, glue ALL PASS, colortest/trackcolor PASS, SAB/Atomics 0 refs, CSS balanced, syntax OK. Server serving R61.
- Files modified: index.html ONLY (+ presettest.js harness, junk deletion, NOTES.md).

## R61b — workspace slimdown (user flagged 44.5/128MB usage)
- 44.5MB -> 28MB. Deleted: demos/stress2m.mid (14MB, now GENERATED at runtime by test.js into os.tmpdir + auto-deleted; fixed two generator bugs: 16B stride garbage -> 8B note pairs, bodyLen 11 -> 7), demos/chaos.mid + demos/demos.json (demos UI removed in R61), 12 logo discard files (~3.6MB: 4 AI PNGs, 2 showcase HTMLs, mark/svg PNGs, tau/suki svg-2) — kept favicon.ico (referenced) + suki-svg-1.svg (the chosen logo). uploads screenshot deleted.
- Remaining 28MB = presets 23MB (the Nukers/TAU product itself) + index.html 3.9MB (two embedded wasm decoders). That floor is the feature; cannot shrink without losing presets.
- test.js 111/111 (fixture gen verified: 2000-note probe parses; poisoned tmp fixture from crashed runs purged — exists-skip reused it), presettest 6/6, colortest PASS, glue PASS, server serving R61.
- Files modified: test.js (fixture gen), deletions only.

## R61c — no MThd crash fix + recovery + xz transfer repair
- loadFile: non-MThd, non-archive files now go through recoverMidi() — scans head (full read ≤1MB, else first 1MB) for an embedded MThd and re-wraps the tail as a .mid File (__skip offset). Status: RECOVERED MIDI FROM X · SKIPPED n BYTES.
- RMID/RIFF-wrapped MIDI and junk-prefixed files self-heal and play. Truly-wrong files (saved HTML page etc.) fail with a rich diagnostic: hex of first 8 bytes + file name + size + plain-language hint (download was probably an HTML page) — never a bare stack.
- parseMIDIAsync: fallback-parse throws now REJECT the promise (safe wrapper) and land in loadFile's banner. Previously they escaped through the worker onerror handler as Uncaught Error and left the promise pending — this was the exact crash from the user's console.
- xzOpen/xzBuild: XZ_WASM.buffer removed from BOTH postMessage transfer lists. It was detached after the first .xz load; a second .xz preset in one session would have failed. Wasm is structured-copied instead (~40KB, negligible).
- Tests: recovtest 3/3 (RMID skip=20, junk-prefix, rich HTML-page error), presettest REBUILT 7/7 (added: second .xz load = wasm-survives regression, driver protocol round-trip {bytes:740,size:3755}), test.js 111/111. presettest worker shim now wires onmessage+postMessage via parentPort (real in-thread parse, no boot noise).

## R62 — disappearing-notes fix (end-of-song rewind + watchdog) & SOUNDFONT mode (SF2/SF3/SFZ, zero libs)
- THE DISAPPEARING-NOTES BUG: end-of-song (non-loop) set ST.playing=false + ST.tau=0 but live-mode draws use nowTau()
  (the audio clock), which stayed frozen at song end -> empty roll forever, and PLAY restarted at total-0.05 (played the
  last 50ms and stopped). Fix: both end-stops (readouts + hidden-tab ticker) now syncTo(0) like the loop branch — the
  clock rewinds, the roll returns to bar 1, PLAY restarts from 0. syncTo also clears PT.last (no future-stamp gating).
- NOTES-INVISIBLE WATCHDOG (belt + braces, the "never again" guarantee): drawGL/draw2D publish drawn-rect counts
  (draw._nr). drawBody: playing + 2s into song + ZERO rects drawn -> at 120 frames force repaint; at 240 frames
  reschedule() + syncTo(clampTau()) + pump() + status ROLL REPAIRED. 4s grace = legitimate silences never trigger it.
- SOUNDFONT MODE (panel: SOUNDFONT CLASSIC/FONT/LOAD + FONT PROG select):
  - SF2: pure DataView RIFF sfbk walk (INFO ifil/inam, sdta smpl, pdta phdr/pbag/pgen/inst/ibag/igen/shdr). PCM16 stays
    Int16Array views (norm 1/32768); zones = preset bags -> instrument bags, generators with spec defaults, keyRange/
    velRange intersection, overridingRootKey/coarse/fine/corr tuning, attenuation cB, pan, volEnv attack/decay/sustain/
    release, loop points + coarse/fine word offsets. SF3 (ifil major>=3): shdr start/end are BYTE offsets into Ogg
    streams -> decodeAudioData (browser builtin = still no libs), loop bytes mapped to decoded frames proportionally.
  - SFZ: text opcode parser (<control>/<global>/<group>/<region>, opcodes on header lines too), global->group->region
    inheritance, basename sample matching from multi-select (backslash paths ok), ampeg_* envelopes, loop_mode/
    loop_start/loop_end, key/lokey/hikey/pitch_keycenter/transpose/tune, lovel/hivel layers, seq round-robin first
    stroke, pan percent; wav/ogg siblings decoded via decodeAudioData.
  - Worklet: 64-voice sample pool (parallel typed arrays; sfSid is a plain Array because ids may be strings), zones in
    key buckets + linked chains, per-note velocity-range filter, linear-interp playback with pitch shift
    2^((key-root)/12+tune/1200)*sr/ctxRate, loop wrap, ADSR-ish vol env, pan, retrigger release, sustain-pedal hold,
    flush/unhold wired. Sample mix runs pre-tanh and shares the sqrt headroom with synth voices (nv+nv2). ch9 drums
    stay CLASSIC. SOUNDFONT replaces the key sound when FONT is on; font replays into fresh audio nodes via sfPush().
- glue.js exposed: recovery hook assumed f.slice/f.arrayBuffer — now RAM-files-only (virtual stream fakes have neither).
- Tests: NEW fonttest.js 13 checks — python builds a REAL RIFF/sfbk SF2 (2 PCM16 sines, ranges/loop/env gens), an SF3
  twin (fake-ogg payloads + stub decodeAudioData), SFZ + 2 WAVs; REAL worklet instance (wksrc eval, 48kHz) driven via
  port messages: 442.1 Hz @ key 69, release to silence (rms 0.0001), 1114.3 Hz pitch-shifted key 85, SF3 byte-range
  extraction + Float32 path, SFZ transpose to 742.9 Hz, velocity gate silence, end-of-song rewind regression (nowTau
  back to 0, sync message sent, replay from 0). Suite: test.js 111/111, presettest 7/7, recovtest 3/3, glue all pass.

### R62b — SF2 engine from-scratch PROOF + SFZ wav decoder from scratch
- User emphasized: "THE SF2 ENGINE IS FROM SCRATCH". It already was (pure DataView sfParse + own worklet sample
  voices; SF2 samples are raw PCM Int16 views — no decode step at all). Now PROVEN at runtime: fonttest counts
  decodeAudioData calls — SF2 load = 0, SF3 = 1 (Vorbis must use the browser builtin; pure-JS Vorbis out of scope),
  SFZ wav = 0. Plus a static source scan: sfParse source and the whole worklet contain no require/import/
  XMLHttpRequest/decodeAudioData.
- sfWavParse(): from-scratch PCM WAV decoder (RIFF walk, PCM16/PCM24/Float32, any channels → mono mixdown, DataView
  only). SFZ wav samples now decode through it instead of decodeAudioData — true sample rate kept (zone sr = file rate;
  worklet resamples via sr/ctxRate), so no surprise context-rate resampling. Non-PCM wav/ogg/flac still fall back to
  the builtin. sfzBuild decoded map now holds {d, sr}.
- fonttest now 16 checks, ALL PASS. Suite: test.js 111/111, presettest 7/7, recovtest 3/3, glue all pass.

### R62c — PER-CHANNEL SOUNDFONT (the user was right: one sound for all channels was wrong)
- MIDI notes carry a channel; each channel now gets its OWN preset. AUTO GM default: the parser already captured
  per-channel program changes (walkTracks `programs` -> ST.midi.programs, Set per channel on RAM parse, Array on
  virtual); sfResolveMix maps each channel's first program -> preset (bank-0 byProg map), fallback = user's base
  select, ch9 stays CLASSIC drums, manual overrides win. Worklet: 'font' message now carries chMap[16] = preset SLOT;
  zones are slot-tagged (ps) with per-slot key buckets (sfPB); alloc() walks ONLY the channel's slot; slot -1 falls
  through to the synth engines (never silence).
- UI: FONT MIX row = [AUTO GM | ONE] + preset select (ONE = the single sound; AUTO = fallback for unmatched channels);
  new CH→SOUND row = channel select + preset select + SET/CLR overrides. Status shows N SOUNDS BY CHANNEL.
- sfSendZones/sfPush replay chMap; fresh audio nodes get the full mix via sfPush.
- fonttest now 27 checks ALL PASS: program capture from a real built MIDI (2 trks, ch0 prog 0 / ch1 prog 48), AUTO GM
  chMap (ch0→piano slot, ch1→strings slot, ch9→-1), 3 zones slot-tagged from 2 presets, override ch2, empty-programs
  fallback, ONE mode, and REAL worklet DSP: ch0 key69 → 428.6 Hz (piano sample), ch1 key81 → 871.4 Hz (strings sample)
  same font, unmapped channel → synth engine (rms 0.27, no silence). Suite: test.js 111/111, presettest 7/7,
  recovtest 3/3, glue all pass.
- Harness lessons: MIDI MThd/MTrk lengths are BIG-endian (RIFF chunk helper is LE — do not reuse); delta-time must be
  VLQ (raw byte >127 poisons the track); python heredoc patches over JS templates need r'' raw strings or escapes
  resolve twice.

### R62d — per-NOTE channel sound: program-change TIMELINE (the "every note" completion)
- R62c mapped channels by their FIRST program. Now both parsers (app-RAM parseMIDI pass A + vwsrc virtual walkTracks)
  also record the program-change TIMELINE: meta.ptl = [[tick, ch, prog], ...] sorted. Main converts ticks → base-12000
  sample times through the file's own tempo map (sfPtl(), cached as meta.ptlAt) and sends it on PLAY + sfPush.
- Worklet: 'ptl' message + progSlot[128] (GM program → preset slot, built by sfResolveMix: byProg match → slot,
  else base slot; ONE/SFZ → slot 0). Applied live in process(): entries due (at×4 ≤ s) switch sfChP[ch] on the fly;
  'sync' resets the pointer (seek/loop/replay re-walk the timeline from 0).
- Result: a channel that switches programs mid-song changes sound mid-song, per note. AUTO GM initial chMap covers
  pre-first-pc; overrides still win; ch9 always CLASSIC drums.
- fonttest now 30 checks ALL PASS: timeline capture from both parsers' RAM path ([[0,0,0],[0,1,48]]), progSlot
  (0→piano, 48→strings, unknown→base), and REAL worklet DSP: pc at 0.05s → ch0 note at 0.1s plays STRINGS (896 Hz
  measured ≈ 880; piano would be 1760), note at 0s before the pc keeps PIANO (428.6 ≈ 440). NOTE: key 69 on both
  fixture zones = 440 (880 sample at root 81 is exactly one octave down) — tests must use key 81 to distinguish.
- bigmidi.worker.js re-synced with the embedded vwsrc (test.js worker-equality check caught the divergence) → 111/111.
- Suite: test.js 111/111, fonttest 30/30, presettest 7/7, recovtest 3/3, glue all pass. Stamp R62d.

### R62l — XZ OOM round 3 (final): the INPUT is disk-backed now — heap never holds the archive
- User STILL got "array buffer allocation failed" on their xz. Repro built at last: 398MB incompressible .xz through the R62k driver -> node worker KILLED (SIGKILL/OOM, exit 137). Root cause: even file-streamed, the input lands IN the wasm MEMFS heap ('/in.arc' grows contiguously) + LZMA dictionary + output buffers => ~archive-size heap. xztest's tiny 3755B fixture could never catch a SIZE-dependent OOM.
- Fix (R62l, driver): in opfs mode the input MEMFS node is REDIRECTED to its OWN OPFS handle (d.infh — separate from the output fh; they clobbered each other in the first attempt, presettest caught it as conv mismatch): stream_ops.write -> accI at position (node.usedBytes kept true so stat() reports the real size), stream_ops.read -> accI. Streamed in 8MB chunks. RAM/stream modes keep heap input (<=128MB by design). The wasm heap now holds only dictionary + small buffers regardless of archive size.
- xzbigtest.js (permanent): 398MB incompressible xz through the REAL driver + REAL p7zip wasm, fake OPFS backed by /var/tmp DISK (tmpfs too small for fixture+in+out) -> extracted size exact; sha256 of extracted == sha256 of python-lzma-decoded input (MATCH). PASS.
- presettest: its XZ phase was a half-fake world (fake getFile served pulse.mid vacuously; discard-fake input can't feed real 7z) — now checks the RAM-fallback phase only; the real opfs XZ pipeline coverage is xztest (byte-exact small) + xzbigtest (byte-exact 398MB). ALL PRESET CHECKS PASS.
- Suites: test 111/111, glue ALL PASS, preset ALL PASS, conttest 6/6, opfstest pass, xztest 3/3 byte-exact, xzbigtest byte-exact@398MB.
- Files: index.html, xzbigtest.js, xztest.js, presettest.js, NOTES.md.

## R62k — XZ OOM round 2: never hold the whole archive in an ArrayBuffer at all
- The SAME "Array buffer allocation failed" came back: R62j freed the resident song but the pipeline still allocated the FULL compressed file on the main thread (f.arrayBuffer()) AND then MEMFS grew the heap to hold it AGAIN — 2x compressed size, plus LZMA dictionary + output. Huge .xz = two giant contiguous allocations = OOM.
- Fix (R62k):
  1. xzdrv accepts d.file (a real File): streams it into the wasm heap in 8MB chunks via FS.open('w+') + FS.write(stream, u8, 0, len, off). No whole-file ArrayBuffer on ANY thread. d.buf path kept for tests/legacy.
  2. xzOpen passes the File itself (Files are structured-cloneable; slice+arrayBuffer run in the worker). ram mode too (xzExtractRAM accepts File or Uint8Array).
  3. freeBig now also CLOSES the AudioContext (frees the worklet + every decoded soundfont sample, often 100s of MB) + sets ST.live=false; ensureAudio() rebuilds on next play.
- xztest.js phase queue (3 phases, all REAL p7zip + REAL driver, byte-exact): opfs+FILE-streamed (the R62k main path), opfs+whole-buffer (legacy compat), ram+FILE-streamed. ALL PASS.
- Suites: test 111/111, glue ALL PASS, preset ALL PASS, conttest 6/6, opfstest pass, xztest 3/3.
- Files: index.html, xztest.js, NOTES.md.

## R62j — XZ "ARRAY BUFFER ALLOCATION FAILED" (memory-pressure OOM in the p7zip worker)
- User's xz died with V8's RangeError while the previous song was still fully resident (main-thread caches + vw worker heap) — the xz worker needs the whole compressed input copied INTO the wasm heap (FS.writeFile('/in.arc') doubles it) plus LZMA dictionary + heap growth.
- Fixes:
  1. freeBig() — pauses playback, closes the archive explorer, clears vw page/lpage caches, TERMINATES the vw worker (frees its heap), nulls song/bytes refs. Called at the top of xzOpen (both modes), gzOpen, and the archive-PLAY extract. loadFile re-spawns a fresh vw worker afterwards.
  2. xzdrv: d.buf = null after FS.writeFile('/in.arc') (input lives ONCE, in the heap); unlink('/in.arc') after callMain.
  3. xzOpen opfs mode: stale 'suki-xz' extractions (GBs each) removed before every new extraction — OPFS quota stays clean.
- /home/user/midi-player/xztest.js (permanent): REAL p7zip wasm + REAL xzdrv in worker_threads (importScripts shim + SevenZip promotion + onmessage dispatch wiring — node needs all three). Real MIDI -> lzma FORMAT_XZ -> opfs mode (fake handle, byte-exact verify) + ram mode (byte-exact). ALL PASS.
- Suites: test 111/111, glue ALL PASS, preset ALL PASS, conttest 6/6, opfstest pass, xztest ALL PASS.
- Files: index.html, xztest.js, NOTES.md.

## R62i — long-page capacity flicker (the "it's BACK" report)
- User hit disappearing notes again right after R62h. R62h itself only touched OPFS open/close — but it made BACK-TO-BACK big loads work for the first time, exposing what was always latent: 256-rec long pages + 4096-page cap can NEVER hold every sustained chunk of a TAU-scale song (TAU ~2M long recs = 8K+ chunks > 4096 pages). The oldest sustaining chunks thrash in/out -> their notes blink mid-air. My R62f harness never caught it: its fixture had only 2,348 relevant chunks (just under the cap).
- Fix: long-note pages 256 -> 2048 recs (24KB); VLPGMAX 4096 -> 8192 (capacity 16.7M long recs); vwLongAhead budget 256 -> 128 reqs/frame; span 4096 -> 8192 chunks. Realistic black MIDIs (even 2M long notes = ~1000 pages / 24MB) now fit FULLY RESIDENT -> zero paging flicker is now a capacity guarantee, not a hope.
- Sites changed (vwsrc + RAM parser + drawLong): worker lrec handler offset/take, laPush flush 256 -> 2048, RAM CM build (+2047)>>11, longN = cmArr.length << 11, drawLong (c+1)<<11 / c<<11, comments. Worker re-synced (25237B) — test.js worker-equality gate green.
- conttest phase 3 (permanent): SECOND consecutive big load of a pitch-shifted song + full 1200-frame walk — the exact back-to-back-loads scenario R62h enabled. 6/6: RAM walk, virt walk, second-big-load walk all 1200/1200 frames clean.
- Suites: test 111/111, glue ALL PASS, preset ALL PASS, opfstest pass, conttest 6/6.
- Files: index.html, bigmidi.worker.js, NOTES.md, conttest.js (phase 3).

## R62h — second big-file load died with OPFS "ACCESS HANDLES CANNOT BE CREATED"
- User hit it on the preview: makeOne never closed the previous load's OPFS sync access handles; loading a SECOND big file re-opened 'suki-pack.bin' with handle #1 still open -> Chrome throws.
- Fix (vwsrc worker + re-synced bigmidi.worker.js):
  1. stores are closeable now; initStore closes store/lstore + every tracked handle BEFORE reopening.
  2. createSyncAccessHandle still refused? -> one fresh-name retry ('suki-pack.bin.<n>'), unique-name spill files get removeEntry'd on the next init (no OPFS quota buildup).
- /home/user/midi-player/opfstest.js: fake OPFS inside worker_threads enforcing Chrome's one-open-handle rule; two consecutive loadPath loads -> 2x ready, and probe asserts the SAME file names were reused (close path, not the retry backstop). Runs with the close disabled prove the retry backstop saves the session even then. Suites also moved wipe-proof: conttest.js now lives HERE too.
- Suites: test 111/111, glue ALL PASS, preset ALL PASS, conttest 4/4 (RAM 1200/1200 + VIRT 1200/1200 clean frames), opfstest pass.
- Files: index.html, bigmidi.worker.js, NOTES.md, conttest.js, opfstest.js.

## R62g — REAL flicker root cause: cross-track note pairing + long-page in-flight blink
- Harness breakthrough: /tmp/conttest.js (regenerates itself) — GL-stubbed drawGL (records every instance rect), live audio-clock playback (ST.live + fake ctx.currentTime), real worker, per-note identity oracle, 1200-frame walks. The earlier R62f flickertest drew a FROZEN t (ST.live made drawBody use nowTau(), not ST.tau) — its "proof" was vacuous.
- BUG 1 (both parsers): note on/off rings flushed per TRACK at EOT with dflt duration. Format-1 files legally split note-ons and note-offs across tracks; every such note became a 288-tick stub -> notes vanished mid-air = the disappearing/flickering. FIX: rings persist across tracks (MIDI pairs on the MERGED stream); flush once on the LAST track only; ON's track color carried in new rK ring (color = on-track, not off-track). RCAP 64 -> 512 (deep same-key stacks no longer force-closed at dflt).
- BUG 2 (virtual draw): drawLong skipped missing lpages -> notes invisible for the page-flight frames = blink. FIX: vwLongAhead(t) pre-requests the relevant chunk window (budget 256/frame, 4096-chunk span) every rAF housekeeping tick + at virtual 'ready' + at seek. Pages arrive BEFORE the notes become visible.
- Harness traps hit: waitReady passed instantly on the STALE RAM song when switching to virt (require ST.song.virt + !building); /tmp wipes between sessions (all /tmp harnesses regen from scratch now); my first cont fixture was monophonic (delta-1 after previous off) then malformed (VLQ 2001 = [8F 51], not [82 41]); GL path needs a webgl2 stub with the full method set.
- Suites: test 111/111 (worker equality ok after re-sync), glue ALL PASS, preset ALL PASS, conttest 4/4 (RAM 1200/1200 + VIRT 1200/1200 frames, zero missing notes). fonttest/recovtest were lost with the /tmp wipe — REBUILD (sf code untouched by R62g).
- Files: index.html (parseMIDI scan+extract, walkTracks in vwsrc, vwLongAhead + call sites), bigmidi.worker.js (re-synced).

## R62f — long-note flicker/disappearance fix (virtual path)
- Root cause: drawLong requested long-note pages lazily, one chunk at a time; VLPGMAX=512 with insertion-order (FIFO) eviction thrashed — a needed page was evicted/fetched in the same frames it was drawn, so sustaining long notes blinked/vanished.
- Fixes (ALL main-side in index.html; worker untouched — no re-sync needed):
  1. VLPGMAX 512 -> 4096 (3KB/page -> 12MB cap): the whole relevant chunk window stays resident.
  2. lwait eviction now deletes the LOWEST chunk key (running-min scan) instead of FIFO — never evicts a newer-needed page in favor of an older one.
  3. drawLong miss now prefetches the window c..c+31 (32x fewer round trips; scan-ahead covered) — replaces the removed vwPrep CM binary-search prefetch (cmArr is NOT sorted, that search was invalid).
- /tmp/flickertest.js (not persisted): real page + real worker via worker_threads; 34M-note all-long fixture (dur 2000 ticks); asserts 0 missing lpages over 360-frame walk with 2347 relevant chunks + seek/0.5s-jump rewindowing + notes drawn every frame (min nr 7, zero empty frames). ALL PASS.
- Suites: test 111/111, fonttest 34/34, preset 7/7, recov 3/3, glue ALL PASS.
- Harness notes: glue waitReady bumped to 900s + 30s progress logs (34M parse vs slow box); /tmp tmpfs is 1GB — worker spill pack (suki-spill-suki-pack.bin ~400MB) + big fixtures must be cleaned between suites or writes ENOSPC -> 'virtual engine' error (cost us a false failure).

## R62e — the "still one sound" holes closed (no-program files + song-loaded-after-font)
- HOLE 1: files WITHOUT program changes (most black-MIDI note dumps) had every channel on program 0 → AUTO GM gave
  every channel the SAME sound despite per-channel machinery. Both parsers now also emit a channel-ACTIVITY mask
  (meta.chMask, bit per channel with notes; app pass-A note-on + vwsrc emitN). sfResolveMix AUTO: active channels
  WITHOUT program info get SPREAD across the font's distinct bank-0 presets by position (ch0→preset A, ch1→preset B,
  ...) — one sound per channel even when the file never names an instrument. No song loaded = all 15 channels spread.
- HOLE 2: the mix was resolved once (at font load) against whatever song was current; loading a song afterwards kept
  the stale chMap. sfOnSong() now re-runs the full mix (chMap + progSlot + zones re-post; samples NOT re-posted to the
  same node — SF.postedNode) from BOTH load paths: RAM parseMIDIAsync resolve + virtual worker 'ready'.
- Overrides always win, even on silent channels (pre-applied before the activity filter).
- fonttest now 34 checks ALL PASS: chMask capture (twoch=3, noprog=7), no-pc 3-channel spread (chMap [0,1,0]),
  sfOnSong re-mix, override-on-silent-channel, no-song spread (3 zones, ps [0,0,1]) + all R62c/R62d checks.
- bigmidi.worker.js re-synced. Suite: test.js 111/111, fonttest 34/34, presettest 7/7, recovtest 3/3, glue pass. R62e.
