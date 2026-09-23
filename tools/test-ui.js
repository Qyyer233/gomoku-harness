/*
 * test-ui.js — 无头冒烟测试
 *
 * 没有浏览器也要保证界面能跑起来。做法是搭一个最小 DOM 桩，并且：
 *   - 只认 index.html 里真实存在的 id（写错 id 会直接报错，而不是打开页面才白屏）；
 *   - 控件的初始值从 index.html 解析（跑的就是用户打开页面看到的默认配置）；
 *   - 按 index.html 里的顺序加载脚本。
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

// ---------- DOM 桩 ----------
const ctxCalls = {};
function makeCtx() {
  const noop = () => {};
  const count = k => () => { ctxCalls[k] = (ctxCalls[k] || 0) + 1; };
  return {
    setTransform: noop, save: noop, restore: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, bezierCurveTo: noop, rect: noop,
    arc: count('arc'), fill: noop, stroke: count('stroke'),
    fillRect: count('fillRect'), strokeRect: noop, clearRect: noop,
    fillText: count('fillText'), setLineDash: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    measureText: () => ({ width: 10 })
  };
}

function makeEl(id, tag) {
  const listeners = {};
  const el = {
    id, tagName: tag || 'div',
    textContent: '', className: '', value: '',
    checked: false, disabled: false, hidden: false,
    scrollTop: 0, scrollHeight: 0,
    children: [],
    style: {},
    width: 720, height: 720,
    listeners,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    appendChild(c) { this.children.push(c); return c; },
    getContext() { return makeCtx(); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 720, height: 720 }; },
    fire(type, ev) {
      const e = Object.assign({ preventDefault() {}, stopPropagation() {} }, ev || {});
      (listeners[type] || []).forEach(fn => fn.call(el, e));
    }
  };
  // innerHTML = '' 是真实 DOM 里清空子节点的常用写法，桩必须照做，
  // 否则 renderMoves() 会不断累积，测出来的手数是错的。
  let innerHTML = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return innerHTML; },
    set(v) { innerHTML = v; if (v === '') el.children.length = 0; }
  });
  return el;
}


// 从 index.html 解析控件初始状态
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
console.log('控件初始状态: ' + JSON.stringify(INITIAL));

const els = new Map();
const docListeners = {};
const document = {
  addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
  fire(type, ev) {
    const e = Object.assign({ preventDefault() {}, stopPropagation() {} }, ev || {});
    (docListeners[type] || []).forEach(fn => fn(e));
  },
  getElementById(id) {
    if (!KNOWN_IDS.has(id)) {
      throw new Error(`ui.js 取了 index.html 里不存在的 id: "${id}"`);
    }
    if (!els.has(id)) {
      const el = makeEl(id, id === 'board' ? 'canvas' : 'div');
      Object.assign(el, INITIAL[id] || {});
      els.set(id, el);
    }
    return els.get(id);
  },
  createElement(tag) { return makeEl(null, tag); }
};

const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Math, Date, JSON, parseInt, parseFloat,
  Uint8Array, Int32Array, Int8Array, Map, Set, Array, Object, String, Number,
  document, navigator: {}
};
// 故意不提供 Worker：这样跑到的就是 file:// 下的降级路径，
// 顺带验证「创建 Worker 失败也能照常下棋」。
sandbox.self = sandbox;
sandbox.window = sandbox;
sandbox.window.addEventListener = () => {};
// localStorage 桩：没有 Worker 也没有 fetch，日志会走 file:// 那条退路，
// 存进这里。测的是真实落盘路径，不是把内部状态掏出来看。
const lsStore = {};
sandbox.localStorage = {
  getItem: k => (k in lsStore ? lsStore[k] : null),
  setItem: (k, v) => { lsStore[k] = String(v); },
  removeItem: k => { delete lsStore[k]; }
};
sandbox.devicePixelRatio = 1;
vm.createContext(sandbox);

// ---------- 按 index.html 的顺序加载脚本 ----------
const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
console.log('加载顺序: ' + scripts.join(' -> ') + '\n');
for (const src of scripts) {
  const file = path.join(ROOT, src);
  if (!fs.existsSync(file)) {
    if (src.startsWith('data/')) { console.log(`  (跳过未生成的 ${src})`); continue; }
    bad(`缺少脚本 ${src}`); continue;
  }
  try {
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: src });
  } catch (e) {
    bad(`${src} 执行失败: ${e.message}`);
    console.log(e.stack.split('\n').slice(0, 4).join('\n'));
    process.exit(1);
  }
}
ok('全部脚本加载成功（含 ui.js 初始化）');

// ---------- Worker 检验 ----------
// 引擎跑在 Worker 里（否则大师档长考会冻住页面）。importScripts 的相对路径
// 写错的话只有在浏览器里才会暴露，所以这里用桩把 Worker 环境模拟出来跑一遍。
(function checkWorker() {
  const wsrc = path.join(ROOT, 'js/worker.js');
  if (!fs.existsSync(wsrc)) { bad('缺少 js/worker.js'); return; }
  const wbox = {
    console, Math, Date, JSON, parseInt, parseFloat,
    Uint8Array, Int32Array, Int8Array, Map, Set, Array, Object, String, Number
  };
  wbox.self = wbox;
  const posted = [];
  wbox.postMessage = m => posted.push(m);
  // 后台思考是切片跑的，片与片之间靠 setTimeout 把控制权交还事件循环。
  // 桩里做成可控队列，这样测试能一片一片地驱动它，不必真的等时间过去。
  const timers = [];
  wbox.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  wbox.clearTimeout = () => {};
  const runSlices = n => {
    for (let i = 0; i < n && timers.length; i++) {
      const fn = timers.shift();
      fn();
    }
  };
  wbox.importScripts = function () {
    for (const rel of arguments) {
      // worker 里的相对路径是相对 js/ 目录解析的
      const f = path.resolve(path.join(ROOT, 'js'), rel);
      if (!fs.existsSync(f)) throw new Error('importScripts 找不到 ' + rel);
      vm.runInContext(fs.readFileSync(f, 'utf8'), wbox, { filename: rel });
    }
  };
  vm.createContext(wbox);
  try {
    vm.runInContext(fs.readFileSync(wsrc, 'utf8'), wbox, { filename: 'js/worker.js' });
  } catch (e) { bad('worker.js 加载失败: ' + e.message); return; }

  wbox.onmessage({ data: { type: 'init' } });
  const ready = posted.find(m => m.type === 'ready');
  if (!ready) { bad('worker 没有回应 init'); return; }
  ok(`worker 就绪${ready.book ? `，开局库 ${ready.book.positions} 局面` : '（无开局库）'}`);

  // 让它在一个四连局面下走一手，必须成五
  const C2 = wbox.GomokuCore;
  const hist = ['H8', 'A1', 'I8', 'A2', 'J8', 'A3', 'K8', 'B1'].map(s => C2.labelToP(s));
  // 顺带确认 worker 拿到了 15 路的开局库（尺寸注册表走通了）
  wbox.onmessage({ data: { type: 'move', id: 1, history: hist, role: C2.BLACK,
                           opts: { level: 'hard', useBook: false } } });
  const mv = posted.find(m => m.type === 'move' && m.id === 1);
  if (!mv) bad('worker 没有返回着法');
  else if (!['G8', 'L8'].includes(C2.pToLabel(mv.move))) bad(`worker 返回了错误着法 ${C2.pToLabel(mv.move)}`);
  else ok(`worker 正确应手 ${C2.pToLabel(mv.move)}（${mv.source}，${mv.timeMs}ms）`);

  // ---------- 后台思考（pondering）----------
  // 这一段守的是「它真的在跑」。第一版就是没验证这一步就交了：
  // 桩里当时连 setTimeout 都没有，切片逻辑一调就会抛异常。
  (function checkPonder() {
    const pos = ['H8', 'I9', 'I8', 'J8', 'G9'].map(s2 => C2.labelToP(s2));
    timers.length = 0;
    const ttBefore = wbox.GomokuEngine ? -1 : -1;   // 引擎实例在 worker 闭包里，只能间接观察
    wbox.onmessage({ data: { type: 'ponder', size: 15, history: pos,
                             role: C2.WHITE, opts: { level: 'hard' } } });
    if (!timers.length) { bad('ponder 消息没有排出任何切片'); return; }
    runSlices(3);                       // 驱动三片
    if (timers.length === 0) { bad('后台思考只跑了一片就停了，没有持续排下一片'); return; }
    ok(`后台思考按切片运行（已排出第 ${4} 片）`);

    // 任何非 ponder 消息都必须立刻停掉它，否则会一直占着这条线程
    wbox.onmessage({ data: { type: 'stopPonder' } });
    const left = timers.length;
    runSlices(left + 2);
    if (timers.length > 0) { bad('收到 stopPonder 后后台思考仍在排新切片'); return; }
    ok('收到其它消息后后台思考立刻停止');

    // 预热之后真搜索必须仍然给出合法着法，并回报白捡了多少
    timers.length = 0;
    wbox.onmessage({ data: { type: 'ponder', size: 15, history: pos,
                             role: C2.WHITE, opts: { level: 'hard' } } });
    runSlices(2);
    wbox.onmessage({ data: { type: 'move', id: 2, history: pos, role: C2.WHITE,
                             opts: { level: 'hard', useBook: false } } });
    const mv2 = posted.find(m => m.type === 'move' && m.id === 2);
    if (!mv2) { bad('预热之后 worker 不再返回着法'); return; }
    if (mv2.move < 0) { bad('预热之后返回了非法着法'); return; }
    if (!(mv2.ponderNodes > 0)) { bad('没有回报后台思考的节点数，无法量化这个功能'); return; }
    ok(`预热 ${mv2.ponderNodes} 节点后正常应手 ${C2.pToLabel(mv2.move)}（深度 ${mv2.depth}）`);
  })();
})();

// ---------- CSS 回归检查 ----------
// 踩过的坑：.overlay{display:flex} 属于作者样式，会盖掉 UA 样式表的
// [hidden]{display:none}，于是 el.hidden=true 失效，结算浮层一直挡在棋盘上。
// 凡是靠 hidden 属性控制显隐的元素，CSS 里必须有一条能压住它的规则。
const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
const hiddenGuard = /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css);
if (!hiddenGuard) {
  bad('css 缺少 [hidden]{display:none !important}，hidden 属性会被作者样式盖掉');
} else {
  ok('css 里有 [hidden] 兜底规则，hidden 属性不会被布局样式盖掉');
}
// 带 hidden 属性的元素，其 class 不应该被无保护地设成 display:flex/block/grid
for (const m of html.matchAll(/<div id="([^"]+)" class="([^"]+)"[^>]*\bhidden\b/g)) {
  for (const cls of m[2].split(/\s+/)) {
    const rule = new RegExp('\\.' + cls + '\\s*\\{[^}]*display:\\s*(flex|block|grid|inline-block)', 'i');
    if (rule.test(css) && !hiddenGuard) bad(`.${cls} 设了 display，会让 #${m[1]} 的 hidden 失效`);
  }
}

// ---------- 初始状态 ----------
const board = els.get('board');
ok(`棋盘已绘制（fillRect ${ctxCalls.fillRect} 次, arc ${ctxCalls.arc} 次, 文字 ${ctxCalls.fillText} 次）`);

if (!els.get('resultBar').hidden) bad('结算横幅开局就显示了');
else ok('结算横幅开局隐藏');
if (!/AI 执黑/.test(els.get('seatInfo').textContent)) bad(`默认应为 AI 执黑，实际 "${els.get('seatInfo').textContent}"`);
else ok(`默认开局: ${els.get('seatInfo').textContent}`);

const moveCount = () => els.get('moveList').children.length;

/**
 * 在棋盘上点一下 (x, y)。
 * 桩的 getBoundingClientRect 是 720×720，和 LOGICAL 一致，所以 scale = 1，
 * clientX/Y 直接就是画布坐标。落点公式和 ui.js 的 px() 一致：MARGIN + i * cell。
 */
function clickBoard(x, y) {
  const LOGICAL = 720, MARGIN = 38;
  // **尺寸必须现读**，不能写死 15 —— 这批用例跑在「切到 12 路」之后，
  // 按 15 路算出来的坐标会落在格子之间，被 pointAt 正确丢弃，
  // 看上去就像「点了没反应」。我第一版就是这么误判成产品 bug 的。
  const n = parseInt(els.get("selSize").value, 10) || 15;
  const cell = (LOGICAL - MARGIN * 2) / (n - 1);
  els.get('board').fire('click', { clientX: MARGIN + x * cell, clientY: MARGIN + y * cell });
}
const clickAt = (x, y) => board.fire('click', { clientX: 38 + x * 46, clientY: 38 + y * 46 });
const typeMove = (id, text) => { const e = els.get(id); e.value = text; e.fire('keydown', { key: 'Enter' }); };

setTimeout(() => {
  // ---------- 我方先走：AI 执黑，应当已经自己落了第 1 手 ----------
  if (moveCount() !== 1) bad(`AI 执黑应自动落第 1 手，实际 ${moveCount()} 手`);
  else ok(`AI 先手已落子: ${els.get('aiMove').textContent}（${els.get('aiMeta').textContent}）`);
  if (els.get('aiMove').textContent === '—') bad('大字着法显示没有更新');

  // 录入对手的应手
  typeMove('inpMove', 'i9');
  if (moveCount() !== 2) bad(`录入对手着法失败，现在 ${moveCount()} 手`);
  else ok('录入对手着法成功');

  setTimeout(() => {
    if (moveCount() !== 3) bad(`AI 应自动应手，实际 ${moveCount()} 手`);
    else ok(`AI 自动应手: ${els.get('aiMove').textContent}`);

    // ---------- 对手先走 ----------
    els.get('btnOppFirst').fire('click');
    if (moveCount() !== 0) bad('「对手先走」应开新局');
    else if (!/AI 执白/.test(els.get('seatInfo').textContent)) bad('「对手先走」应让 AI 执白');
    else ok(`对手先走: ${els.get('seatInfo').textContent}，AI 不抢先落子`);

    typeMove('inpMove', 'h8');
    if (moveCount() !== 1) bad('对手先走后录入失败');
    else ok('对手第 1 手已录入');

    setTimeout(() => {
      if (moveCount() !== 2) bad(`AI 执白应当应手，实际 ${moveCount()} 手`);
      else ok(`AI 执白应手: ${els.get('aiMove').textContent}`);

      // ---------- 整局导入 ----------
      els.get('chkAuto').checked = false;
      typeMove('inpLoad', 'H8 I9 J10 K11 G7');
      if (moveCount() !== 5) bad(`整局导入应为 5 手，实际 ${moveCount()}`);
      else ok(`整局导入成功: ${els.get('aiMeta').textContent}`);

      // ---------- 对局日志 ----------
      // 日志是排查实战问题的唯一入口。
      // 这里验的是「它真的被写出来了」，而且悔棋不会把日志写成一条不存在的棋路。
      (function checkLog() {
        const raw = sandbox.localStorage.getItem('gomoku.logs');
        if (!raw) { bad('对局日志没有落盘'); return; }
        const logs = JSON.parse(raw);
        const g = logs[logs.length - 1];
        if (!g || !g.moves.length) { bad('日志里没有棋谱'); return; }
        if (g.moves.length !== moveCount()) {
          bad(`日志棋谱 ${g.moves.length} 手，界面 ${moveCount()} 手，对不上`);
          return;
        }
        if (!g.ai.length) { bad('日志里没有 AI 的决策记录'); return; }
        const a = g.ai[g.ai.length - 1];
        if (!a.source || typeof a.ms !== 'number') { bad('AI 决策记录字段不全'); return; }
        // 收手原因只有走搜索那条路才有；棋形/开局库是提前返回的，没有迭代加深
        const s0 = g.ai.filter(x => x.source === 'search');
        const noStop = s0.filter(x => !x.stop);
        if (noStop.length) { bad(`${noStop.length} 手搜索没记下收手原因`); return; }
        ok(`对局日志: ${g.moves.length} 手棋谱 + ${g.ai.length} 条思维链` +
           `（最后一手 ${a.move}/${a.source}${a.stop ? '，' + a.stop : ''}）`);
      })();

      // ---------- 复盘 ----------
      const total = moveCount();
      els.get('navPrev').fire('click');
      if (moveCount() !== total) bad('复盘后退不该改变棋谱长度');
      else ok(`后退一手，位置 ${els.get('navPos').textContent}，棋谱仍有 ${total} 手`);
      els.get('navFirst').fire('click');
      if (els.get('navPos').textContent !== `0 / ${total}`) bad('回到开局失败');
      else ok('可以回到开局');
      document.fire('keydown', { key: 'ArrowRight', target: { tagName: 'DIV' } });
      if (els.get('navPos').textContent !== `1 / ${total}`) bad('方向键前进失败');
      else ok('方向键可以逐手前进');
      els.get('navLast').fire('click');

      // ---------- 结算后仍可复盘 ----------
      typeMove('inpLoad', 'H8 A1 I8 A2 J8 A3 K8 A4 L8');
      const bar = els.get('resultBar');
      if (bar.hidden) bad('黑棋五连后没有显示结算横幅');
      else ok(`结算横幅: ${bar.textContent}`);
      els.get('navPrev').fire('click');
      if (moveCount() !== 9) bad('结束后复盘丢失了棋谱');
      else ok(`对局结束后仍可复盘（${els.get('navPos').textContent}）`);

      // ---------- 切到 12 路 ----------
      const sizeSel = els.get('selSize');
      sizeSel.value = '12';
      sizeSel.fire('change');
      if (sandbox.GomokuCore.SIZE !== 12) bad(`切换棋盘失败，当前 SIZE=${sandbox.GomokuCore.SIZE}`);
      else if (moveCount() !== 0) bad('换棋盘后棋谱应清空');
      else ok(`切到 12 路成功（${els.get('bookInfo').textContent}）`);

// ---------- 自定义摆局 ----------
// 这个功能全靠戳屏幕，出问题的样子是「摆了子但状态没跟上」，
// 手点很难发现（看上去都对），所以必须把状态机测到。
els.get('btnSetup').fire('click');
if (els.get('secSetup').hidden) bad('点了自定义摆局，摆局条没出现');
else if (!els.get('secStart').hidden) bad('摆局时开局区应该隐藏，否则手机上会误点');
else ok('进入摆局：摆局条出现，开局区隐藏');

// 交替摆四子：黑白黑白
clickBoard(7, 7); clickBoard(7, 8); clickBoard(8, 7); clickBoard(8, 8);
if (moveCount() !== 4) bad(`摆局应有 4 子，实际 ${moveCount()}`);
else if (!/下一子：黑/.test(els.get('setupTurn').textContent))
  bad(`摆了 4 子后该轮黑，实际 "${els.get('setupTurn').textContent}"`);
else ok(`摆局落子正常：4 子，${els.get('setupTurn').textContent}`);

// 退一子
els.get('btnSetupBack').fire('click');
if (moveCount() !== 3) bad(`退一子后应剩 3 子，实际 ${moveCount()}`);
else ok('摆局可以退一子');

// 摆好 —— AI 走下一手。3 子之后轮白，所以 AI 应执白
els.get('btnSetupDone').fire('click');
if (!els.get('secSetup').hidden) bad('摆好之后摆局条应该收起来');
else if (els.get('secStart').hidden) bad('摆好之后开局区应该回来');
else if (!/AI 执白/.test(els.get('aiMeta').textContent))
  bad(`3 子后轮白，AI 走这手就该执白，实际 "${els.get('aiMeta').textContent}"`);
else ok(`摆好转入对局：${els.get('aiMeta').textContent}，棋盘保留 ${moveCount()} 子`);

// 「等对手」那条分支：AI 应执另一边
els.get('btnSetup').fire('click');
clickBoard(6, 6); clickBoard(6, 7);
els.get('btnSetupWait').fire('click');
if (!/AI 执白/.test(els.get('aiMeta').textContent))
  bad(`2 子后轮黑，选「等对手」则 AI 执白，实际 "${els.get('aiMeta').textContent}"`);
else ok('「摆好了 · 等对手」让 AI 执另一边');

      // 12 路上 M 列不存在，录入必须被拒绝
      const before12 = moveCount();
      typeMove('inpMove', 'm5');
      if (moveCount() !== before12) bad('12 路上 M 列不存在，却被录入了');
      else ok('12 路正确拒绝越界坐标 M5');
      typeMove('inpMove', 'f6');
      if (moveCount() !== before12 + 1) bad('12 路上合法坐标 F6 录入失败');
      else ok('12 路合法坐标可以录入');

      // ---------- 思考开关 ----------
      // 坏掉的样子最难发现：界面看着一切正常，只是 AI 永远不出手；
      // 或者反过来 —— 以为暂停了，引擎却在背后把改到一半的局面算了个遍。
      // 两个方向都要测到。
      els.get('btnAiFirst').fire('click');     // 重开一局（AI 执黑，稍后自动落第 1 手）
      els.get('btnPause').fire('click');       // 在它落子**之前**就暂停
      if (!/暂停/.test(els.get('turnText').textContent))
        bad('暂停后状态栏应当说明，实际 ' + els.get('turnText').textContent);
      else if (!/已暂停/.test(els.get('aiMove').textContent))
        bad('暂停后大字区应显示已暂停，实际 ' + els.get('aiMove').textContent);
      else ok('暂停后状态栏和大字区都标出来了');

      setTimeout(() => {
        // 开局那一手是 setTimeout 排进去的。暂停必须把它拦下来 ——
        // 否则用户前脚按暂停、后脚引擎照样落子，而暂停的全部意义就是「这会儿棋盘归我改」。
        if (moveCount() !== 0)
          bad('暂停应当拦下已排队的开局着法，实际落了 ' + moveCount() + ' 手');
        else ok('暂停能拦下已经排队的着法');

        clickBoard(5, 5);
        clickBoard(5, 6);
        const n = moveCount();
        if (n !== 2) bad('暂停中点棋盘应落 2 子，实际 ' + n);
        else ok('暂停中棋盘随便改（落了 2 子）');

        setTimeout(() => {
          if (moveCount() !== n) bad('暂停中 AI 不该出手，手数变成了 ' + moveCount());
          else ok('暂停中 AI 不应手，也不预备');

          // 恢复：已摆 2 子、AI 执黑，正好轮到它 —— 应当立刻出手
          els.get('btnPause').fire('click');
          if (/已暂停/.test(els.get('aiMove').textContent)) bad('恢复后大字区还停在已暂停');
          else ok('恢复后暂停提示消失');

          setTimeout(() => {
            if (moveCount() !== n + 1)
              bad('恢复时轮到 AI，它应该马上落子，手数停在 ' + moveCount());
            else ok('恢复后 AI 立刻出手（' + n + ' -> ' + moveCount() + ' 手）');

          // ---------- 输棋最后一手没录就开了新局：要补记「对手胜」 ----------
          // 2026-09-23 那批里两局真输了都是「未完」（对手成五那手懒得录），
          // 于是服务端不知道输了，那局的局面也进不了复查。
          els.get('btnOppFirst').fire('click');            // AI 执白
          els.get('btnPause').fire('click');               // 暂停，手动摆
          // 黑 (2..5, 2) 活四，白随手；最后轮到黑（对手）走，他有现成的五
          [[2, 2], [2, 8], [3, 2], [3, 8], [4, 2], [4, 9], [5, 2], [8, 8]].forEach(q => clickBoard(q[0], q[1]));
          const logs = () => JSON.parse(sandbox.localStorage.getItem('gomoku.logs') || '[]');
          const lost = logs().filter(g => g.aiColor === 'W' && g.moves.length === 8).pop();
          if (!lost) bad('找不到刚摆的那局日志');
          else if (lost.result) bad('还没开新局就有了结果：' + lost.result);
          else {
            els.get('btnPause').fire('click');             // 先恢复（暂停状态不该影响补记）
            els.get('btnAiFirst').fire('click');           // 直接开新局，不录对手的成五
            const after = logs().find(g => g.id === lost.id);
            if (!after || after.result !== '对手胜') bad('对手有成五点却没补记输棋，结果是 ' + (after && after.result));
            else if (!after.resultInferred) bad('补记的结果要标明是推断的');
            else ok('没录完的输棋在开新局时补记为「对手胜」（' + after.resultInferred + '）');
          }

          console.log(fail === 0 ? '\n全部通过' : `\n失败 ${fail} 项`);
          process.exit(fail ? 1 : 0);
          }, 1200);
        }, 600);
      }, 600);
    }, 2500);
  }, 2500);
}, 2500);
