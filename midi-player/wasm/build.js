/* builds wasm/synth.wat -> synth.wasm, injects base64 into index.html, smoke-runs it */
const fs = require('fs'), path = require('path');
const wabt = require('wabt')();
const ROOT = path.join(__dirname, '..');
wabt.then((m) => {
  const src = fs.readFileSync(path.join(__dirname, 'synth.wat'), 'utf8');
  const mod = m.parseWat('synth.wat', src, {});
  mod.validate();
  const { buffer } = mod.toBinary({});
  global.__n = buffer.length;
  global.__b64n = Buffer.from(buffer).toString('base64').length;
  fs.writeFileSync(path.join(ROOT, 'synth.wasm'), Buffer.from(buffer));
  const b64 = Buffer.from(buffer).toString('base64');
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const re = /const b64 = '[^']*';/;
  if (!re.test(html)) { console.error('FAIL: b64 anchor missing in index.html'); process.exit(1); }
  html = html.replace(re, "const b64 = '" + b64 + "';");
  fs.writeFileSync(path.join(ROOT, 'index.html'), html);
  return WebAssembly.instantiate(buffer);
}).then((r) => {
  const ex = r.instance.exports;
  if (!ex.mix || !ex.memory) throw new Error('missing exports');
  /* smoke: one A4 key-formula voice, decay + envelope sanity */
  const M = ex.memory.buffer;
  const F64B = 8, I32B = 1048584, SUSP = 1310728, BFP = 1310792, NZP = 1310920, SEEDP = 1310936, OUTL = 1310944, OUTR = 1343712;
  const F = new Float64Array(M, F64B, 8192 * 16);
  const C = new Int32Array(M, I32B, 8192 * 8);
  const TAU = 6.283185307179586, SR = 48000;
  F[0] = 1;                                             /* envelope E: pure decay */
  F[15] = 0;                                            /* attack gain g */
  F[1] = 0.05; F[2] = Math.exp(-2.6 / SR); F[3] = 1;
  F[4] = Math.exp(-0.6931471805599453 / (0.16 * SR)); F[5] = Math.exp(-900 / SR);
  for (let i = 6; i < 13; i++) F[i] = 0;                /* p1..p7 */
  F[13] = 440; F[14] = 0.49;
  C[0] = 1; C[1] = 1; C[2] = 0; C[3] = 0; C[4] = 96000; C[5] = 0; C[6] = 0;
  const N = 128;
  new Float64Array(M, BFP, 16)[0] = 1;                  /* bf[ch0] = 1 (no bend) */
  const L = new Float32Array(M, OUTL, N);
  const blocks = [];
  for (let b = 0; b < 150; b++) {
    ex.mix(F64B, I32B, SUSP, BFP, NZP, SEEDP, OUTL, OUTR, N, b * 128, 1, 1, SR, TAU, 0.0016, 1);
    let m = 0; for (let i = 0; i < N; i++) { if (!isFinite(L[i])) throw new Error('smoke: non-finite'); m = Math.max(m, Math.abs(L[i])); }
    blocks.push(m);
  }
  if (!(blocks[0] > 0.2)) throw new Error('smoke: output silent');
  if (!(blocks[149] < blocks[0] * 0.55)) throw new Error('smoke: not decaying');
  console.log('smoke ok: peak', blocks[0].toFixed(3), '->', blocks[149].toFixed(3), '(decays)');
  console.log('synth.wasm', global.__n, 'bytes; b64', global.__b64n, 'chars; injected into index.html');
}).catch((e) => { console.error('BUILD FAIL:', e.message); process.exit(1); });
