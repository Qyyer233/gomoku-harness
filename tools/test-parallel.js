/*
 * test-parallel.js — 并行搜索（Lazy SMP）的正确性
 *
 * 浏览器里是多个 Worker 共享一块 SharedArrayBuffer 当置换表。
 * Node 的 worker_threads 有完全相同的两样东西，所以这里跑的是**真的多线程**，
 * 不是模拟 —— 共享内存的竞态只有真跑才会暴露。
 *
 * 守三件事：
 *
 * 1. **撕裂的记录必须被丢掉。** 多线程同时写同一条记录时，可能出现
 *    key 已更新而 score/meta 还是旧的。JS 没有跨 int32 的原子写，
 *    所以用异或校验（把数据异或进校验位）让撕裂必然校验失败。
 *    这类错不会抛异常，只会让引擎拿一个根本不存在的结论去剪枝。
 * 2. **共享表真的在共享。** 一个线程写进去的结论，另一个线程要读得到 ——
 *    这是并行唯一的加速通道，不通的话 N 个线程只是 N 份重复劳动。
 * 3. **并行不能改变结论。** 副线程的返回值一律丢弃，只有主线程的算数；
 *    有唯一解的局面，开不开并行都必须走出同一手。
 */
const assert = require('assert');
const path = require('path');
const C = require('../js/core.js');
const E = require('../js/engine.js');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}
async function okAsync(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

console.log('并行搜索');

ok('置换表可以建在 SharedArrayBuffer 上，两个引擎共用一块内存', () => {
  assert.ok(E.TT.bytes > 0, '没有导出所需字节数，主线程无法分配共享内存');
  const sab = new SharedArrayBuffer(E.TT.bytes);
  const a = new E.Engine({ ttBuffer: sab });
  const b = new E.Engine({ ttBuffer: sab });
  assert.strictEqual(a.tt.a.buffer, b.tt.a.buffer, '两个引擎没有共用同一块内存');
  // a 写，b 必须读得到
  a.tt.store(0x1234, 0x5678, 7, 4242, 0, 99);
  const i = (0x1234 & (a.tt.a.length / 4 - 1)) << 2;
  const meta = b.tt.a[i + 3], x = b.tt.a[i + 2] ^ meta;
  assert.strictEqual(b.tt.a[i] ^ x, 0x1234, 'b 读不到 a 写进共享表的记录');
  assert.strictEqual(b.tt.a[i + 2], 4242, '分数对不上');
  assert.strictEqual(meta & 0xffff, 99, '着法对不上');
});

ok('撕裂的记录会被异或校验挡掉（不会被当成有效结论）', () => {
  const tt = new E.TT();
  tt.store(0x1000, 0xabcd, 8, 777, 0, 55);
  const i = (0x1000 & (tt.a.length / 4 - 1)) << 2;
  // 完好时应当校验通过
  let meta = tt.a[i + 3], x = tt.a[i + 2] ^ meta;
  assert.strictEqual(tt.a[i] ^ x, 0x1000, '完好的记录反而校验不过');

  // 模拟撕裂：另一个线程刚写完 score/meta，还没来得及写校验位
  tt.a[i + 2] = 999;                      // 新分数
  tt.a[i + 3] = meta ^ 0x30000;           // 新深度
  meta = tt.a[i + 3]; x = tt.a[i + 2] ^ meta;
  assert.notStrictEqual(tt.a[i] ^ x, 0x1000,
    '撕裂的记录仍然通过了校验 —— 引擎会拿一个不存在的结论去剪枝');
});

ok('有唯一解的局面：并行与否必须走出同一手', () => {
  C.setSize(12);
  const g = ('F8 F6 E7 D6 E6 E5 G7 C7 B8 F4 G3 F5 F3 D5 G5 C5 B5 D3 D4 G6 E4 E9 H7 F7 ' +
    'D8 E8 H5 D9 C10 C8 C6 B7 E10 C9 F9 G8 H6 H4 I5 J4 I6 G4 I4').split(' ');
  const b = new C.Board();
  g.forEach((s, i) => b.put(C.labelToP(s), i % 2 === 0 ? C.BLACK : C.WHITE));
  const OPT = { level: 'master', useBook: false, timeMin: 1000, timeMax: 1000 };
  const solo = new E.Engine().bestMove(b, C.WHITE, OPT);
  // 这个局面白棋只有 A9 / B9 两手能活
  assert.ok(['A9', 'B9'].includes(C.pToLabel(solo.move)),
    '单线程就走错了，基准不成立: ' + C.pToLabel(solo.move));
  const sab = new SharedArrayBuffer(E.TT.bytes);
  const par = new E.Engine({ ttBuffer: sab }).bestMove(b, C.WHITE, OPT);
  assert.ok(['A9', 'B9'].includes(C.pToLabel(par.move)),
    '用共享表之后走出了送棋的一手: ' + C.pToLabel(par.move));
});

ok('副线程的 startDepth 偏移不会让它给出非法着法', () => {
  C.setSize(15);
  const b = new C.Board();
  ['H8', 'I9', 'I8', 'J8', 'G9'].forEach((s, i) =>
    b.put(C.labelToP(s), i % 2 === 0 ? C.BLACK : C.WHITE));
  for (const sd of [2, 4, 8, 16]) {
    const r = new E.Engine().bestMove(b, C.WHITE, {
      level: 'hard', useBook: false, timeMin: 200, timeMax: 400, startDepth: sd
    });
    assert.ok(r.move >= 0 && b.cells[r.move] === C.EMPTY,
      `startDepth=${sd} 返回了非法着法 ${r.move}`);
  }
});

// ---------- 真·多线程 ----------
(async () => {
  await okAsync('4 条真线程并发读写同一张共享表，结果仍然自洽', async () => {
    const { Worker } = require('worker_threads');
    const sab = new SharedArrayBuffer(E.TT.bytes);
    const enginePath = path.join(__dirname, '../js/engine.js').replace(/\\/g, '/');
    const corePath = path.join(__dirname, '../js/core.js').replace(/\\/g, '/');
    const src = `
      const { parentPort, workerData } = require('worker_threads');
      const C = require(${JSON.stringify(corePath)});
      const E = require(${JSON.stringify(enginePath)});
      C.setSize(12);
      const g = workerData.moves;
      const b = new C.Board();
      g.forEach((s, i) => b.put(C.labelToP(s), i % 2 === 0 ? C.BLACK : C.WHITE));
      const eng = new E.Engine({ ttBuffer: workerData.sab });
      const r = eng.bestMove(b, C.WHITE, {
        level: 'master', useBook: false, timeMin: 1200, timeMax: 1200,
        startDepth: 2 + 2 * workerData.smp
      });
      parentPort.postMessage({ smp: workerData.smp, move: C.pToLabel(r.move), nodes: r.nodes });
    `;
    const moves = ('F8 F6 E7 D6 E6 E5 G7 C7 B8 F4 G3 F5 F3 D5 G5 C5 B5 D3 D4 G6 E4 E9 H7 F7 ' +
      'D8 E8 H5 D9 C10 C8 C6 B7 E10 C9 F9 G8 H6 H4 I5 J4 I6 G4 I4').split(' ');
    const results = await Promise.all([0, 1, 2, 3].map(smp => new Promise((res, rej) => {
      const w = new Worker(src, { eval: true, workerData: { sab, smp, moves } });
      w.on('message', m => { res(m); w.terminate(); });
      w.on('error', rej);
    })));
    const main = results.find(r => r.smp === 0);
    assert.ok(main, '主线程没有返回结果');
    // 只有主线程（smp=0）的结果算数，它必须仍然是那两手活路之一
    assert.ok(['A9', 'B9'].includes(main.move),
      `4 线程共享表之后主线程走出了 ${main.move}（应为 A9/B9）—— 共享表污染了结论`);
    const total = results.reduce((s, r) => s + r.nodes, 0);
    assert.ok(total > 0, '所有线程都没搜出节点');
    console.log(`       （4 线程共搜 ${total.toLocaleString()} 节点，主线程走 ${main.move}）`);
  });

  console.log(`\n${pass} 项通过${fail ? '，' + fail + ' 项失败' : ''}`);
  process.exit(fail ? 1 : 0);
})();
