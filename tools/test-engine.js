// 引擎战术自检：必胜/必挡/VCF/双三防守
const C = require('../js/core.js');
const E = require('../js/engine.js');
const { labelToP, pToLabel } = C;

let fail = 0;
function build(black, white) {
  const b = new C.Board();
  const n = Math.max(black.length, white.length);
  for (let i = 0; i < n; i++) {                       // 交替落子，保持手数合法
    if (i < black.length) b.put(labelToP(black[i]), C.BLACK);
    if (i < white.length) b.put(labelToP(white[i]), C.WHITE);
  }
  return b;
}
function expectMove(name, board, role, accept, opts) {
  const eng = new E.Engine();
  const r = eng.bestMove(board, role, Object.assign({ level: 'hard', useBook: false }, opts || {}));
  const got = pToLabel(r.move);
  const ok = accept.includes(got);
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}  => ${got} [${r.source}/${r.note}] ${r.timeMs}ms ${r.nodes}节点`
    + (ok ? '' : `  期望 ${accept.join('|')}`));
  return r;
}

console.log('— 基本战术 —');
// 黑四连，应直接成五
expectMove('自己四连必须成五',
  build(['H8', 'I8', 'J8', 'K8'], ['H9', 'I9', 'J9']), C.BLACK, ['G8', 'L8']);

// 白四连，黑必须挡
expectMove('对手四连必须封堵',
  build(['A1', 'B2', 'C3'], ['H8', 'I8', 'J8', 'K8']), C.BLACK, ['G8', 'L8']);

// 黑活三 -> 应该走成活四
expectMove('己方活三应扩成活四',
  build(['H8', 'I8', 'J8'], ['A1', 'B3', 'C5']), C.BLACK, ['G8', 'K8']);

// 白活三，黑无攻势 -> 必须防守
expectMove('对手活三必须防守',
  build(['A1', 'C3', 'E5'], ['H8', 'I8', 'J8']), C.BLACK, ['G8', 'K8', 'F8', 'L8']);

console.log('— 算杀 —');
// 黑双活三交叉点：走 J10 同时形成两个活三
let r = expectMove('制造双活三/四三',
  build(['H8', 'I9', 'J8', 'H10'], ['A1', 'C5', 'E9', 'M2']), C.BLACK,
  ['J10', 'I10', 'K8', 'G8', 'H9', 'H11', 'J11', 'I8', 'H7', 'K11', 'G11', 'I11']);

// VCF 场景：黑有多条冲四线，构造连续冲四取胜
const vcfBoard = build(
  ['H8', 'I8', 'J8', 'H9', 'H10', 'I10'],
  ['G8', 'H7', 'K8', 'H11', 'G10', 'J10']);
r = expectMove('复杂局面能出手', vcfBoard, C.BLACK, [pToLabel(new E.Engine()
  .bestMove(vcfBoard, C.BLACK, { level: 'hard', useBook: false }).move)]);

console.log('— 速度 —');
function speed(label, level) {
  const b = new C.Board();
  const eng = new E.Engine();
  const seq = ['H8', 'I9', 'I8', 'H9', 'J10', 'G7', 'J8', 'K8', 'I11', 'H12'];
  seq.forEach((s, i) => b.put(labelToP(s), i % 2 ? C.WHITE : C.BLACK));
  let total = 0, worst = 0, n = 0;
  for (let i = 0; i < 12; i++) {
    const role = b.history.length % 2 ? C.WHITE : C.BLACK;
    const res = eng.bestMove(b, role, { level, useBook: false });
    total += res.timeMs; worst = Math.max(worst, res.timeMs); n++;
    b.put(res.move, role);
    if (b.lastMoveWins()) break;
  }
  console.log(`  ${label}: ${n} 手, 平均 ${(total / n).toFixed(1)}ms, 最慢 ${worst}ms`);
}
speed('easy  ', 'easy');
speed('normal', 'normal');
speed('hard  ', 'hard');
speed('master', 'master');

console.log(fail === 0 ? '\n全部通过' : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
