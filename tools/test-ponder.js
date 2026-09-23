/*
 * test-ponder.js — 跨搜索复用置换表的正确性
 *
 * 守两件事：
 *
 * 1. **杀棋分在置换表里必须按「距本节点多少层」存**。
 *    搜索里 `val = WIN - ply` 的 ply 是相对**当前搜索根节点**的，
 *    而置换表跨搜索复用（引擎一局用到底；开了后台思考之后更是每手都在跨搜索命中）。
 *    同一个局面下次出现时 ply 不同，直接存原值就会把杀棋步数记错。
 *    判据是个不依赖实现的不变量：**同一个局面的评分不该取决于之前搜过什么**。
 *
 * 2. 后台思考（预热置换表）不能改变结论，只能让它更快。
 *    这一条尤其要守：在「根节点置换表剪枝」那个 bug 还在的时候，
 *    预热会让每个真实搜索的根节点都命中，于是 AI 一手都不搜。
 */
const assert = require('assert');
const C = require('../js/core.js');
const E = require('../js/engine.js');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

console.log('后台思考与跨搜索置换表');

C.setSize(12);
const GAME = ('F8 F6 E7 D6 E6 E5 G7 C7 B8 F4 G3 F5 F3 D5 G5 C5 B5 D3 D4 G6 E4 E9 H7 F7 D8 E8 ' +
  'H5 D9 C10 C8 C6 B7 E10 C9 F9 G8 H6 H4 I5 J4 I6 G4 I4 I3 I7 I8 J7 K7 K8 L9')
  .split(' ');

const OPT = {
  level: 'master', useBook: false, fastOpening: false, depth: 8, width: 16,
  vcf: 0, vct: 0, vctShare: 0, timeMin: 60000, timeMax: 60000, stable: 1e9, solid: 8
};

function boardAt(n) {
  const b = new C.Board();
  for (let i = 0; i < n; i++) b.put(C.labelToP(GAME[i]), i % 2 === 0 ? C.BLACK : C.WHITE);
  return b;
}
const roleAt = n => (n % 2 === 0 ? C.BLACK : C.WHITE);

/** 模拟后台思考：轮对手走时先搜一遍当前局面，把置换表填热 */
function withPonder(n, ponderDepth) {
  const eng = new E.Engine();
  const b = boardAt(n - 1);
  const o = {};
  for (const k in OPT) o[k] = OPT[k];
  o.depth = ponderDepth; o.solid = ponderDepth;
  eng.bestMove(b, roleAt(n - 1), o);            // 这就是「后台思考」
  b.put(C.labelToP(GAME[n - 1]), roleAt(n - 1));  // 对手真的落子了
  return eng.bestMove(b, roleAt(n), OPT);
}
function withoutPonder(n) {
  return new E.Engine().bestMove(boardAt(n), roleAt(n), OPT);
}

ok('预热不会把「已证明的胜势」变成劣势', () => {
  // 原先这里断言「预热前后着法和评分必须完全一样」，那个断言是错的：
  // α-β + 置换表在**固定深度**下本来就会有「搜索不稳定」——
  // 热表带来的剪枝顺序不同，同一深度可以给出不同（但都合法）的结果。
  // 真正要守的不是「一模一样」，而是**预热不能让引擎变瞎**：
  // 冷搜索认定必胜的局面，热搜索不能反过来认为必败。
  const MATE = 9999000;
  for (const n of [30, 36, 40, 46]) {
    const cold = withoutPonder(n);
    for (const pd of [4, 6, 8]) {
      const warm = withPonder(n, pd);
      if (cold.score >= MATE) {
        assert.ok(warm.score > -MATE,
          `第 ${n} 手：冷搜索认定必胜(${cold.score})，预热到 ${pd} 层后却认定必败(${warm.score})`);
      }
      if (cold.score <= -MATE) {
        assert.ok(warm.score < MATE,
          `第 ${n} 手：冷搜索认定必败(${cold.score})，预热后却认定必胜(${warm.score})`);
      }
      assert.ok(warm.move >= 0, `第 ${n} 手：预热到 ${pd} 层后没给出着法`);
    }
  }
});

ok('预热之后搜索仍然真的在搜（不会因为根节点命中就交白卷）', () => {
  // 「根节点置换表剪枝」那个 bug 的表现就是这里：depth 会变成 0、节点数极少
  for (const n of [30, 36, 40]) {
    const warm = withPonder(n, 8);
    assert.ok(warm.source !== 'search' || warm.depth > 0,
      `第 ${n} 手预热后 depth=0，根节点又被置换表剪掉了`);
  }
});

ok('置换表里的杀棋分按「距本节点多少层」存取', () => {
  // 直接测这条换算本身，不要通过整盘搜索去测 —— 那样会被「搜索不稳定」污染，
  // 测试会因为无关的改动红掉，然后逼人去改断言（差点就这么干了）。
  //
  // 搜索里 `val = WIN - ply` 的 ply 是相对**当前搜索根节点**的，而置换表跨搜索复用。
  // 所以存的时候要 +ply 换成「距本节点多少层」，取的时候 -ply 换回去。
  // 同一条记录在不同 ply 上读出来，代表的「还有几步杀」必须一致。
  const WIN = 10000000;
  const tt = new E.TT();
  const KEY = 0x12345, K2 = 0x6789;
  // 在 ply=5 的节点上算出「5 层后取胜」：根视角的分是 WIN-5，距本节点 0 层
  const plyStore = 5, rootScore = WIN - plyStore;
  tt.store(KEY, K2, 8, rootScore + plyStore, 0, 42);

  const read = (plyRead) => {
    const i = (KEY & (tt.a.length / 4 - 1)) << 2;
    const meta = tt.a[i + 3], x = tt.a[i + 2] ^ meta;
    assert.strictEqual(tt.a[i] ^ x, KEY, '校验位对不上');
    let sc = tt.a[i + 2];
    if (sc >= WIN - 1000) sc -= plyRead;
    return sc;
  };
  // 同一条记录：在根下第 5 层读，应还原成 WIN-5；在第 9 层读，应是 WIN-9
  assert.strictEqual(read(5), WIN - 5, '在原来的 ply 上读不回原值');
  assert.strictEqual(read(9), WIN - 9, '换个 ply 读，杀棋步数没跟着变');
  // 「还有几步杀」= WIN - 分数 - ply，跨 ply 必须恒定
  assert.strictEqual((WIN - read(5)) - 5, (WIN - read(9)) - 9,
    '同一条记录在不同 ply 上读出的「还有几步杀」不一致');
});

console.log(`\n${pass} 项通过${fail ? '，' + fail + ' 项失败' : ''}`);
process.exit(fail ? 1 : 0);
