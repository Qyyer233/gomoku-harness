/*
 * test-size.js — 12 路棋盘检验
 *
 * 棋盘边长是可变的（Core.setSize），实现方式是「把墙往里挪」：
 * 内部数组、方向位移、Zobrist 表、6561 项棋形表全都不变，
 * 只是可落子区域缩小。所以这里重点验证边界没漏：
 * 贴边的棋形算得对、不会走到棋盘外、坐标越界会被拒绝。
 */
const C = require('../js/core.js');
const E = require('../js/engine.js');
C.setSize(12);
let fail = 0;
const ok = m => console.log('  ok   ' + m);
const bad = m => { fail++; console.log('  FAIL ' + m); };

function build(black, white) {
  const b = new C.Board();
  const n = Math.max(black.length, white.length);
  for (let i = 0; i < n; i++) {
    if (i < black.length) b.put(C.labelToP(black[i]), C.BLACK);
    if (i < white.length) b.put(C.labelToP(white[i]), C.WHITE);
  }
  return b;
}
// 12 路上的战术
let b = build(['F6','G6','H6','I6'], ['F7','G7','H7']);
let r = new E.Engine().bestMove(b, C.BLACK, { level:'hard', useBook:false });
if (!['E6','J6'].includes(C.pToLabel(r.move))) bad(`四连未成五: ${C.pToLabel(r.move)}`);
else ok(`12 路四连成五 ${C.pToLabel(r.move)}`);

b = build(['A1','C3','E5'], ['F6','G6','H6','I6']);
r = new E.Engine().bestMove(b, C.BLACK, { level:'hard', useBook:false });
if (!['E6','J6'].includes(C.pToLabel(r.move))) bad(`未封堵四连: ${C.pToLabel(r.move)}`);
else ok(`12 路封堵四连 ${C.pToLabel(r.move)}`);

// 坐标校验：12 路上 M 列不存在
if (C.labelToP('M5') !== -1) bad('12 路上 M 列应当非法');
else ok('越界坐标 M5 被正确拒绝');
if (C.labelToP('L12') < 0) bad('L12 在 12 路上应当合法');
else ok('边角坐标 L12 合法');

// 贴边：L 列是最后一列，L 右边是墙
b = build(['I6','J6','K6'], ['A1','A3','A5']);
r = new E.Engine().bestMove(b, C.BLACK, { level:'hard', useBook:false });
ok(`12 路贴边三连 -> ${C.pToLabel(r.move)}（棋盘只到 L 列）`);
if (C.pToX(r.move) >= 12) bad('走到了棋盘外');

// 整局能下完不出错
const g = new C.Board();
const e1 = new E.Engine(), e2 = new E.Engine();
let winner = 0, ply = 0;
g.put(C.center(), C.BLACK);
for (ply = 1; ply < 144; ply++) {
  const role = ply % 2 === 0 ? C.BLACK : C.WHITE;
  const mv = (role === C.BLACK ? e1 : e2).bestMove(g, role, { level:'normal', useBook:false }).move;
  if (g.cells[mv] !== C.EMPTY) { bad('走到了非空点'); break; }
  if (C.pToX(mv) < 0 || C.pToX(mv) >= 12 || C.pToY(mv) < 0 || C.pToY(mv) >= 12) { bad('走到棋盘外'); break; }
  g.put(mv, role);
  if (g.lastMoveWins()) { winner = role; break; }
}
if (winner) ok(`12 路整局完成，${winner===1?'黑':'白'}胜，共 ${g.history.length} 手`);
else ok(`12 路整局完成（${g.history.length} 手未分胜负）`);

console.log(fail === 0 ? '\n12 路全部通过' : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
