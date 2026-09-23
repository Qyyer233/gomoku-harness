/*
 * test-move-timeout.js — 服务器不回话时，界面不能干等
 *
 * 实战里服务器事件循环被堵过 5 秒、13 秒（Windows 控制台快速编辑、卡顿……）。
 * 以前 /engine/move 没有超时，界面就一直等，读秒制下等于直接输棋。
 * 这里搭和 test-ui.js 同样的 DOM 桩，再加一个假 fetch：Rapfi「在线」，但着法请求
 *   1. 永远不回话 -> 过了上限 + 2.5 秒，这一手必须由自研引擎出手，并在说明里写清楚；
 *   2. 正常回话   -> 用服务端的着法，保险不能再误触发（不能多落一子）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const KNOWN_IDS = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));

let fail = 0;
const bad = msg => { fail++; console.log('  FAIL ' + msg); };
const ok = msg => console.log('  ok   ' + msg);

// ---------- DOM 桩（和 test-ui.js 同一套思路，精简版） ----------
function makeCtx() {
  const noop = () => {};
  return new Proxy({}, { get: (t, k) => k === 'measureText' ? () => ({ width: 10 })
    : (k === 'createLinearGradient' || k === 'createRadialGradient') ? () => ({ addColorStop: noop }) : noop,
    set: () => true });
}
function makeEl(id, tag) {
  const listeners = {};
  const el = {
    id, tagName: tag || 'div', textContent: '', className: '', value: '',
    checked: false, disabled: false, hidden: false, scrollTop: 0, scrollHeight: 0,
    children: [], style: {}, width: 720, height: 720,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    appendChild(c) { this.children.push(c); return c; },
    getContext() { return makeCtx(); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 720, height: 720 }; },
    fire(type, ev) {
      const e = Object.assign({ preventDefault() {}, stopPropagation() {} }, ev || {});
      (listeners[type] || []).forEach(fn => fn.call(el, e));
    }
  };
  // innerHTML = '' 要真的清空子节点（棋谱列表每次重绘都这么清），否则手数会越数越多
  let inner = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return inner; },
    set(v) { inner = v; if (v === '') el.children.length = 0; }
  });
  return el;
}
const INITIAL = {};
for (const m of html.matchAll(/<select id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
  const opts = [...m[2].matchAll(/<option value="([^"]+)"([^>]*)>/g)];
  const chosen = opts.find(o => /\bselected\b/.test(o[2])) || opts[0];
  if (chosen) INITIAL[m[1]] = { value: chosen[1] };
}
for (const m of html.matchAll(/<input([^>]*)id="([^"]+)"([^>]*)>/g)) {
  const attrs = m[1] + m[3];
  if (/type="checkbox"/.test(attrs)) INITIAL[m[2]] = { checked: /\bchecked\b/.test(attrs) };
}
const els = new Map();
const document = {
  hidden: false,
  addEventListener() {}, removeEventListener() {},
  getElementById(id) {
    if (!KNOWN_IDS.has(id)) throw new Error(`ui.js 取了 index.html 里不存在的 id: "${id}"`);
    if (!els.has(id)) { const el = makeEl(id, id === 'board' ? 'canvas' : 'div'); Object.assign(el, INITIAL[id] || {}); els.set(id, el); }
    return els.get(id);
  },
  createElement(tag) { return makeEl(null, tag); }
};

// ---------- 假服务器 ----------
let moveMode = 'hang';            // 'hang' = 着法请求永远不回话；'answer' = 马上回一手
let moveCalls = 0;
const reply = obj => Promise.resolve({ ok: true, json: () => Promise.resolve(obj) });
function fakeFetch(url, init) {
  const u = String(url);
  if (u.endsWith('/engine/info')) return reply({ available: true, exe: 'pbrain-rapfi-windows-avx2.exe', threads: 8, prepEngines: 2, prepThreads: 8, cpus: 24 });
  if (u.endsWith('/engine/memo')) return reply({ positions: 0 });
  if (u.endsWith('/engine/move')) {
    moveCalls++;
    if (moveMode === 'hang') return new Promise(() => {});
    // 回一手合法的：在请求的局面里找第一个空点
    const b = JSON.parse(init.body), used = new Set(b.moves.map(m => m[0] + ',' + m[1]));
    for (let y = 0; y < b.size; y++) for (let x = 0; x < b.size; x++)
      if (!used.has(x + ',' + y)) return reply({ x, y, ms: 5, depth: 20, eval: 0, evalText: '0', mate: 0, nodes: 1, incremental: true, source: 'rapfi', timing: { total: 5 } });
  }
  return reply({ ok: true });                  // /engine/ponder、/engine/end、/log
}

const lsStore = {};
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Math, Date, JSON, parseInt, parseFloat, Promise,
  Uint8Array, Int32Array, Int8Array, Map, Set, Array, Object, String, Number,
  document, navigator: {}, fetch: fakeFetch,
  localStorage: { getItem: k => (k in lsStore ? lsStore[k] : null), setItem: (k, v) => { lsStore[k] = String(v); }, removeItem: k => { delete lsStore[k]; } },
  devicePixelRatio: 1, location: { port: '8080' }
};
sandbox.self = sandbox; sandbox.window = sandbox; sandbox.window.addEventListener = () => {};
vm.createContext(sandbox);
for (const src of [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1])) {
  const file = path.join(ROOT, src);
  if (fs.existsSync(file)) vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: src });
}

const moveCount = () => els.get('moveList').children.length;
const typeMove = t => { const e = els.get('inpMove'); e.value = t; e.fire('keydown', { key: 'Enter' }); };
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('服务器不回话时的保险');
  await wait(300);                                        // 等探测到「Rapfi 在线」
  if (els.get('selEngine').value !== 'rapfi') { bad('默认内核不是 rapfi，测不到这条路'); process.exit(1); }
  if (!/Rapfi 已就绪/.test(els.get('engineNote').textContent)) { bad('假服务器没让界面认为 Rapfi 在线：' + els.get('engineNote').textContent); process.exit(1); }
  els.get('selThink').value = '3000';                     // 上限 3 秒 -> 5.5 秒后保险触发

  // ---- 1. 着法请求永远不回话 ----
  els.get('btnOppFirst').fire('click');                   // AI 执白，等对手
  moveMode = 'hang';
  const calls0 = moveCalls;
  typeMove('h8');
  await wait(4500);
  if (moveCalls === calls0) bad('没有向服务器要着法（测试没走到 Rapfi 那条路）');
  else if (moveCount() !== 1) bad('还没到保险时间就落了子（' + moveCount() + ' 手）');
  else ok('上限 + 2.5 秒之内一直在等服务器');
  await wait(4000);
  if (moveCount() !== 2) bad('服务器不回话，保险没有让 AI 出手（' + moveCount() + ' 手）');
  else if (!/没回话/.test(els.get('aiMeta').textContent + els.get('aiMove').textContent))
    bad('兜底出手了，但说明里没讲是服务器没回话：' + els.get('aiMeta').textContent);
  else ok('服务器不回话 -> 自研引擎兜底出手：' + els.get('aiMeta').textContent.slice(0, 40));
  if (/调用失败|临时退回/.test(els.get('engineNote').textContent)) bad('一次超时就把 Rapfi 整个关掉了');
  else ok('超时只影响这一手，Rapfi 仍是在线状态');

  // ---- 2. 正常回话：用服务端的着法，保险不能误触发 ----
  moveMode = 'answer';
  const calls1 = moveCalls;
  typeMove('j10');
  await wait(600);
  if (moveCalls === calls1) bad('超时之后下一手没有再找 Rapfi');
  else if (moveCount() !== 4) bad('服务器正常回话，AI 却没落子（' + moveCount() + ' 手）');
  else ok('下一手照常找 Rapfi，并用了服务端的着法');
  await wait(6000);                                       // 越过保险时间，确认它被取消了
  if (moveCount() !== 4) bad('服务器已经回话，保险仍然触发，多落了一子（' + moveCount() + ' 手）');
  else ok('正常回话时保险被取消，没有多落子');

  console.log(fail === 0 ? '\n全部通过' : `\n失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})();
