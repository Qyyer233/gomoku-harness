/*
 * test-log.js — 思维链 / 日志 的回归测试
 *
 * 这里守的是一个真实事故：置换表在根节点直接剪枝返回，导致 rootBest 从没被赋值，
 * 引擎整手棋一层都没搜就落到「静态评分最高点」兜底。
 * 它只在**引擎跨手复用**时出现（app 就是这么用的），离线每手新建引擎永远测不到，
 * 所以第一条测试刻意复用同一个引擎连走多手。
 */
const assert = require('assert');
const C = require('../js/core.js');
const E = require('../js/engine.js');
const L = require('../js/log.js');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

console.log('思维链与日志');

ok('引擎跨手复用时，每一手都真的搜索过（根节点不吃置换表剪枝）', () => {
  C.setSize(12);
  const eng = new E.Engine();                    // 一个引擎用到底，和 app 一样
  const b = new C.Board();
  const seq = 'F7 F6 E7 D6 E6 E5 G7 C7 G6 G5 H6 H5'.split(' ');
  let searched = 0, emptyDepth = 0;
  for (let i = 0; i < seq.length; i++) {
    const role = i % 2 === 0 ? C.BLACK : C.WHITE;
    const r = eng.bestMove(b, role, { level: 'hard', useBook: false, timeMin: 200, timeMax: 400, trace: true });
    if (r.source === 'search') {
      searched++;
      // 走搜索这条路却一层都没搜完 = 根节点被剪枝返回了，rootBest 没赋值
      if (r.depth === 0) emptyDepth++;
      assert.ok(r.trace, '打开 trace 后必须有思维链');
      assert.ok(r.trace.stop, '必须记下收手原因');
    }
    b.put(C.labelToP(seq[i]), role);
  }
  assert.ok(searched >= 3, '这组棋应该有几手走搜索，实际 ' + searched);
  assert.strictEqual(emptyDepth, 0, `有 ${emptyDepth} 手搜索深度为 0（根节点被置换表剪掉了）`);
});

ok('思维链记下逐层结果和收手原因', () => {
  C.setSize(15);
  const eng = new E.Engine();
  const b = new C.Board();
  ['H8', 'I9', 'I8', 'J8'].forEach((s, i) => b.put(C.labelToP(s), i % 2 === 0 ? C.BLACK : C.WHITE));
  const r = eng.bestMove(b, C.BLACK, { level: 'hard', useBook: false, timeMin: 300, timeMax: 800, trace: true });
  assert.ok(r.trace.iters.length >= 1, '至少要有一层的记录');
  const it = r.trace.iters[0];
  assert.ok(typeof it.depth === 'number' && it.move && typeof it.ms === 'number', '逐层记录字段不全');
  assert.ok(r.trace.roots.length > 0, '要记下根候选表');
  assert.ok(r.trace.ttSize >= 0, '要记下置换表条目数');
});

ok('不开 trace 时不产生额外对象', () => {
  C.setSize(15);
  const eng = new E.Engine();
  const b = new C.Board();
  b.put(C.labelToP('H8'), C.BLACK);
  const r = eng.bestMove(b, C.WHITE, { level: 'normal', useBook: false, timeMin: 50, timeMax: 100 });
  assert.strictEqual(r.trace, null, '没要 trace 就不该有');
});

ok('悔棋后日志会把多余的 AI 决策截掉', () => {
  const rec = new L.Recorder();
  rec.serverOk = false;                          // 测试环境没有服务器，直接走本地分支
  rec.local = function () { };                   // node 里没有 localStorage，吞掉落盘
  rec.start({ size: 15, aiColor: 'B', level: 'master', thinkCap: 6000 });
  rec.sync(['H8', 'I9', 'I8']);
  rec.decide(3, 1, { move: 0, source: 'search', note: '', score: 0, depth: 6, nodes: 10, timeMs: 5, phase: {}, trace: { stop: 's', iters: [], cap: 6000 } }, () => 'I8');
  assert.strictEqual(rec.game.ai.length, 1);
  rec.sync(['H8']);                              // 悔到第 1 手
  assert.strictEqual(rec.game.ai.length, 0, '第 3 手的决策应该被截掉');
  assert.deepStrictEqual(rec.game.moves, ['H8']);
});

ok('异常手会被自动打标记', () => {
  const rec = new L.Recorder();
  rec.serverOk = false;
  rec.local = function () { };
  rec.start({ size: 15, aiColor: 'B', level: 'master', thinkCap: 6000 });
  const ent = rec.decide(10, 1, {
    move: 0, source: 'search', note: '', score: 0, depth: 0, nodes: 14336, timeMs: 156,
    phase: {}, trace: { stop: '超时中断于第 2 层', iters: [], cap: 6000 }
  }, () => 'I3');
  assert.ok(ent.flags && ent.flags.length, '深度 0 的搜索必须被标记');
  assert.ok(ent.flags.join('').includes('搜索未完成'), '标记内容不对: ' + ent.flags);
});

ok('胜负和棋谱在同一次上报里（分两次报会在服务端互相覆盖）', () => {
  // 2026-09-23：sync 先报一份 result=''，finish 紧接着再报一份；两个 POST 同时在路上，
  // 服务端谁后到写谁，35 局里 5 局 AI 成五却记成「未完」。
  const rec = new L.Recorder();
  const sent = [];
  rec.serverOk = true; rec.endpoint = 'log';
  rec._post = function (url, g) { sent.push(JSON.parse(JSON.stringify(g))); };
  rec.start({ size: 12, aiColor: 'B', level: 'master', thinkCap: 6000 });
  rec.sync(['G6', 'F6', 'G7', 'F7', 'G8', 'F8', 'G9', 'F9', 'G10'], 'AI 胜');
  assert.strictEqual(sent.length, 1, '一手只该报一次，实际 ' + sent.length);
  assert.strictEqual(sent[0].result, 'AI 胜');
  assert.ok(sent[0].endedAt, '分出胜负要记结束时间');
  // 悔掉制胜那一手：胜负要跟着清掉，不能留一个「AI 胜」挂在还没下完的棋上
  rec.sync(['G6', 'F6', 'G7', 'F7', 'G8', 'F8', 'G9', 'F9'], '');
  assert.strictEqual(sent[1].result, '', '悔棋后结果应清空');
  assert.ok(!sent[1].endedAt, '悔棋后不该还有结束时间');
  // 序号严格递增，服务端据此丢掉晚到的旧快照
  assert.ok(sent[1].seq > sent[0].seq, 'seq 必须递增：' + sent[0].seq + ' -> ' + sent[1].seq);
});

console.log(`\n${pass} 项通过${fail ? '，' + fail + ' 项失败' : ''}`);
process.exit(fail ? 1 : 0);
