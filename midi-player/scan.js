/* scope-flat undeclared-identifier scanner: catches the class of bug where a
   constant is referenced by the page but declared nowhere (test harness hid it) */
const fs = require('fs'), acorn = require('acorn'), walk = require('acorn-walk');
const html = fs.readFileSync(process.argv[2], 'utf8');
const main = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
const wksrc = html.match(/<script type="text\/plain" id="wksrc">([\s\S]*?)<\/script>/)[1];

const BROWSER = new Set(('window document navigator location console performance requestAnimationFrame cancelAnimationFrame ' +
 'setTimeout clearTimeout setInterval clearInterval fetch URL Blob FileReader AudioContext webkitAudioContext AudioWorkletNode ' +
 'GainNode Event CustomEvent addEventListener removeEventListener dispatchEvent Math JSON Object Array Number String Boolean ' +
 'Symbol Promise Map Set WeakMap WeakSet Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array ' +
 'Float32Array Float64Array BigInt64Array BigUint64Array ArrayBuffer DataView BigInt Error TypeError RangeError SyntaxError ' +
 'ReferenceError EvalError URIError isNaN isFinite parseInt parseFloat undefined NaN Infinity globalThis decodeURIComponent ' +
 'encodeURIComponent atob btoa alert confirm prompt getComputedStyle matchMedia localStorage sessionStorage Image Audio WebAssembly OfflineAudioContext Mp4Muxer AudioEncoder AudioData VideoEncoder VideoFrame ' +
 'TextDecoder TextEncoder innerWidth innerHeight self top parent OffscreenCanvas Path2D DOMMatrix ResizeObserver MutationObserver IntersectionObserver Worker SharedWorker MessageChannel ' +
 'structuredClone queueMicrotask Intl RegExp Function Date Proxy Reflect AudioWorkletProcessor registerProcessor sampleRate ' +
 'currentTime currentFrame numberOfInputs numberOfOutputs channelCount').split(/\s+/));

function scan(src, label) {
  const ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'script' });
  const declared = new Set();
  const addPat = (p) => { if (!p) return;
    if (p.type === 'Identifier') declared.add(p.name);
    else if (p.type === 'ObjectPattern' || p.type === 'ArrayPattern') (p.properties || p.elements).forEach(x => addPat(x && (x.value || x)));
    else if (p.type === 'RestElement' || p.type === 'AssignmentPattern') addPat(p.argument || p.left); };
  walk.full(ast, (n) => {
    if (n.type === 'VariableDeclarator') addPat(n.id);
    else if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') { if (n.id) declared.add(n.id.name); (n.params||[]).forEach(addPat); }
    else if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') (n.params||[]).forEach(addPat);
    else if (n.type === 'CatchClause') addPat(n.param);
  });
  const unknown = new Map();
  walk.full(ast, (n) => {
    if (n.type !== 'Identifier') return;
    const p = n; // skip property keys / member expressions on the right of a dot
    if (BROWSER.has(n.name) || declared.has(n.name)) return;
    unknown.set(n.name, (unknown.get(n.name) || 0) + 1);
  });
  // filter out member-access property names by re-walking with parent tracking
  const refs = [];
  (function visit(node, parent, key) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Identifier' && !(parent && parent.id === node)
        && !(parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed)
        && !(parent && (parent.type === 'Property' && parent.key === node && !parent.computed))
        && !(parent && parent.type === 'MethodDefinition' && parent.key === node)) {
      if (!BROWSER.has(node.name) && !declared.has(node.name)) refs.push([node.name, node.loc ? node.loc.start.line : 0]);
    }
    for (const k in node) { if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(c => c && typeof c.type === 'string' && visit(c, node, k));
      else if (v && typeof v.type === 'string') visit(v, node, k); }
  })(ast, null, null);
  const counts = new Map(); for (const [n] of refs) counts.set(n, (counts.get(n)||0)+1);
  console.log(`\n[${label}] declared=${declared.size}  UNKNOWN refs: ${counts.size ? [...counts.entries()].map(([n,c])=>`${n}(${c})`).join(', ') : 'none'}`);
  return counts.size;
}
const a = scan(main, 'main script');
const b = scan(wksrc, 'worklet');
process.exit(a + b ? 1 : 0);
