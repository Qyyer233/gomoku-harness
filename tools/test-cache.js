/*
 * test-cache.js — 棋形编码缓存的一致性
 *
 * `Board.code` 缓存了每个点、每个方向、每一方的 8 格窗口编码，靠 put/undo 增量维护。
 * 它把每节点的 codeAt 调用从 329 次降到 137 次（实测整体快 2.1~2.3 倍）。
 *
 * 缓存类优化最容易出的错不是算错，而是**某条路径改了棋盘却没刷新缓存** ——
 * 那种错不会抛异常，只会让引擎安静地下错棋。所以这里不测「某个点对不对」，
 * 而是暴力比对：随机落子/悔棋几千步，全盘所有点 × 4 方向 × 双方，
 * 缓存值必须和实算逐一相等。
 *
 * 新增任何直接写 `cells` 的代码路径，都要保证它之后缓存仍然自洽 —— 这个测试会抓。
 */
const assert = require('assert');
const C = require('../js/core.js');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

console.log('棋形编码缓存');

/** 全盘逐点比对缓存与实算 */
function verify(b, tag) {
  for (let y = 0; y < C.SIZE; y++) {
    for (let x = 0; x < C.SIZE; x++) {
      const p = C.xyToP(x, y);
      for (let d = 0; d < 4; d++) {
        for (const role of [C.BLACK, C.WHITE]) {
          const cached = b.codeAt(p, d, role);
          const raw = b._rawCode(p, d, role);
          assert.strictEqual(cached, raw,
            `${tag}: ${C.pToLabel(p)} 方向${d} ${role === C.BLACK ? '黑' : '白'} ` +
            `缓存=${cached} 实算=${raw}`);
        }
      }
    }
  }
}

for (const size of [12, 15]) {
  ok(`${size} 路：空盘缓存正确（墙的位置也要算对）`, () => {
    C.setSize(size);
    verify(new C.Board(), `${size}路空盘`);
  });

  ok(`${size} 路：3000 步随机落子/悔棋后缓存始终自洽`, () => {
    C.setSize(size);
    const b = new C.Board();
    let seed = 987654321;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const hist = [];
    for (let step = 0; step < 3000; step++) {
      if (hist.length && rnd() < 0.35) { b.undo(); hist.pop(); }
      else {
        const p = C.xyToP((rnd() * C.SIZE) | 0, (rnd() * C.SIZE) | 0);
        if (b.cells[p] !== C.EMPTY) continue;
        b.put(p, hist.length % 2 === 0 ? C.BLACK : C.WHITE);
        hist.push(p);
      }
      if (step % 300 === 0) verify(b, `${size}路 第${step}步（盘上${hist.length}子）`);
    }
    verify(b, `${size}路 收尾`);
  });

  ok(`${size} 路：全部悔完之后回到空盘状态`, () => {
    C.setSize(size);
    const b = new C.Board();
    const fresh = new C.Board();
    const pts = ['F8', 'G8', 'H8', 'F7', 'G7', 'E9', 'J4']
      .map(C.labelToP).filter(p => p >= 0);
    pts.forEach((p, i) => b.put(p, i % 2 === 0 ? C.BLACK : C.WHITE));
    while (b.history.length) b.undo();
    verify(b, `${size}路 悔完`);
    // 不只是自洽，还要和全新棋盘逐字节相同 —— 否则 undo 漏掉了什么
    assert.deepStrictEqual(Array.from(b.code), Array.from(fresh.code),
      '全部悔棋后缓存和新棋盘不一致，undo 漏掉了某些点');
  });

  ok(`${size} 路：clone 出来的棋盘缓存完整`, () => {
    C.setSize(size);
    const b = new C.Board();
    ['F8', 'G8', 'H8', 'F7'].map(C.labelToP)
      .forEach((p, i) => b.put(p, i % 2 === 0 ? C.BLACK : C.WHITE));
    const c = b.clone();
    verify(c, `${size}路 clone`);
    // clone 之后继续落子，两边各走各的也不能互相污染
    c.put(C.labelToP('J4'), C.WHITE);
    verify(c, `${size}路 clone 落子后`);
    verify(b, `${size}路 原盘（不该被 clone 影响）`);
  });
}

console.log(`\n${pass} 项通过${fail ? '，' + fail + ' 项失败' : ''}`);
process.exit(fail ? 1 : 0);
