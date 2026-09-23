/*
 * test-block.js — 各种活三/冲四形状的封堵检验
 *
 * 单纯的「四连要挡」谁都会，真正容易漏的是跳三、断三这些形状。
 * 这里把常见形状逐个摆出来，要求引擎必须走到有效的化解点上。
 * 判据不是硬编码某一个点，而是：**走完这一手后，对手不能再做出活四**。
 * 这样既严格，又不会因为存在多个正确解而误判。
 */
const C = require('../js/core.js');
const E = require('../js/engine.js');
const { labelToP, pToLabel } = C;

let fail = 0;
function build(black, white) {
  const b = new C.Board();
  const n = Math.max(black.length, white.length);
  for (let i = 0; i < n; i++) {
    if (i < black.length) b.put(labelToP(black[i]), C.BLACK);
    if (i < white.length) b.put(labelToP(white[i]), C.WHITE);
  }
  return b;
}
/** 对手（role）还能不能一步做出活四 */
function canMakeOpenFour(b, role) {
  for (const p of b.emptyNear([])) if (b.isOpenFourPoint(p, role)) return true;
  return false;
}

// 黑方摆出各种三，白方必须化解。远处给白子补手数，保证轮次合法。
const filler = ['A1', 'A3', 'A5', 'A7', 'A9', 'A11'];
const cases = [
  ['连活三  _XXX_',      ['H8', 'I8', 'J8']],
  ['跳活三  _XX_X_',     ['H8', 'I8', 'K8']],
  ['跳活三  _X_XX_',     ['H8', 'J8', 'K8']],
  ['中跳三  _X_X_X_',    ['H8', 'J8', 'L8']],
  ['斜连活三',           ['H8', 'I9', 'J10']],
  ['斜跳活三',           ['H8', 'I9', 'K11']],
  ['反斜活三',           ['H10', 'I9', 'J8']],
  ['竖连活三',           ['H8', 'H9', 'H10']],
  ['竖跳活三',           ['H8', 'H9', 'H11']]
];

for (const level of ['normal', 'hard', 'master']) {
  console.log(`— 难度 ${level} —`);
  for (const [name, blacks] of cases) {
    const b = build(blacks, filler.slice(0, blacks.length));
    if (!canMakeOpenFour(b, C.BLACK)) {
      console.log(`  skip ${name}（这个摆法其实做不出活四，跳过）`);
      continue;
    }
    const eng = new E.Engine();
    const r = eng.bestMove(b, C.WHITE, { level, useBook: false });
    b.put(r.move, C.WHITE);
    const stillOpen = canMakeOpenFour(b, C.BLACK);
    // 白方自己做出冲四/成五也算有效化解（逼黑先应）
    const counter = b.isFourPoint(r.move, C.WHITE);
    const ok = !stillOpen || counter;
    if (!ok) fail++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(18)} 走 ${pToLabel(r.move)}` +
      `  ${counter ? '(冲四抢先手)' : ''}${stillOpen && !counter ? '  <- 黑仍能做活四' : ''}  ${r.timeMs}ms`);
  }
}

console.log(fail === 0 ? '\n全部通过' : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
