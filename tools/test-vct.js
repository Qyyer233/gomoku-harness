/*
 * test-vct.js — 算杀正确性检验
 *
 * 算杀最危险的错误不是「漏掉杀棋」，而是「误报必胜」：
 * 引擎以为在走杀棋，实际对手能化解，于是白丢先手甚至送棋。
 * 所以主检验不是拿我手搓的局面去对答案（很容易搓错），
 * 而是：**随机造大量中局，凡是 VCT 宣称必胜的，就让对手用满强度引擎顽抗，
 * 真正把棋下完，看这个"必胜"兑不兑现。**
 */
const C = require('../js/core.js');
const E = require('../js/engine.js');
const { labelToP, pToLabel } = C;

let fail = 0;
const ok = m => console.log('  ok   ' + m);
const bad = m => { fail++; console.log('  FAIL ' + m); };

function build(black, white) {
  const b = new C.Board();
  const n = Math.max(black.length, white.length);
  for (let i = 0; i < n; i++) {
    if (i < black.length) b.put(labelToP(black[i]), C.BLACK);
    if (i < white.length) b.put(labelToP(white[i]), C.WHITE);
  }
  return b;
}

/** 攻方按引擎走，守方满强度顽抗，看攻方能否真的连成五 */
function playOut(board, atk, maxPly = 34) {
  const b = board.clone();
  const atkEng = new E.Engine(), defEng = new E.Engine();
  for (let ply = 0; ply < maxPly; ply++) {
    const role = ply % 2 === 0 ? atk : 3 - atk;
    const eng = role === atk ? atkEng : defEng;
    const r = eng.bestMove(b, role, { level: 'hard', timeMs: 80, useBook: false });
    if (b.cells[r.move] !== C.EMPTY) return { winner: 0, reason: '非法着法' };
    b.put(r.move, role);
    if (b.lastMoveWins()) return { winner: role, plies: ply + 1 };
  }
  return { winner: 0, reason: `${maxPly} 手内未分胜负` };
}

console.log('— 能找到明摆着的杀棋 —');
let b = build(['H8', 'I9', 'J8', 'H10'], ['A1', 'C5', 'E9', 'M2']);
let eng = new E.Engine();
let mv = eng.runVct(b, C.BLACK, 10, 100000, 2000);
if (mv < 0) bad('双活三局面 VCT 未找到杀棋');
else {
  const res = playOut(b, C.BLACK);
  if (res.winner === C.BLACK) ok(`双活三找到 ${pToLabel(mv)}，实战 ${res.plies} 手兑现`);
  else bad(`宣称 ${pToLabel(mv)} 必胜，实战未兑现（${res.reason || '对手守住'}）`);
}

console.log('— 不能误报 —');
b = build(['H8', 'I9'], ['G7', 'K11']);
mv = new E.Engine().runVct(b, C.BLACK, 12, 200000, 2000);
if (mv >= 0) bad(`两子空旷局面误报必胜 ${pToLabel(mv)}`);
else ok('两子局面正确地报告「无杀」');

b = build(['H8', 'I8', 'J8'], ['G8', 'K8', 'C3', 'C5', 'E3']);
mv = new E.Engine().runVct(b, C.BLACK, 10, 100000, 2000);
if (mv < 0) ok('两端被堵死的三正确地报告「无杀」');
else {
  const res = playOut(b, C.BLACK);
  if (res.winner === C.BLACK) ok(`另有杀棋 ${pToLabel(mv)}，实战兑现`);
  else bad(`被堵死的三误报必胜 ${pToLabel(mv)}`);
}

console.log('— 随机中局批量兑现检验（主检验）—');
let seed = 987654321;
const rand = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
let claimed = 0, honored = 0, scanned = 0;
const t0 = Date.now();
for (let g = 0; g < 120; g++) {
  const rb = new C.Board();
  rb.put(C.xyToP(7, 7), C.BLACK);
  const stones = 7 + rand(12);
  for (let i = 1; i < stones; i++) {
    const empties = rb.emptyNear([]);
    if (!empties.length) break;
    rb.put(empties[rand(empties.length)], i % 2 ? C.WHITE : C.BLACK);
    if (rb.lastMoveWins()) { rb.undo(); break; }
  }
  const role = rb.history.length % 2 === 0 ? C.BLACK : C.WHITE;
  // 已经有人能直接成五的局面不算，那不需要算杀
  if (rb.winPoints(role, []).length || rb.winPoints(3 - role, []).length) continue;
  scanned++;
  const k = new E.Engine().runVct(rb, role, 10, 40000, 400);
  if (k < 0) continue;
  claimed++;
  const res = playOut(rb, role);
  if (res.winner === role) honored++;
  else {
    console.log(`      未兑现: ${rb.history.map(pToLabel).join(' ')}`);
    console.log(`               ${role === 1 ? '黑' : '白'} 走 ${pToLabel(k)} — ${res.reason || '对手守住'}`);
  }
}
console.log(`      扫描 ${scanned} 个局面，宣称必胜 ${claimed} 次，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
if (claimed === 0) bad('一个杀棋都没找到，VCT 可能没在工作');
else if (honored === claimed) ok(`宣称的 ${claimed} 次必胜全部实战兑现`);
else bad(`宣称 ${claimed} 次，只兑现 ${honored} 次（误报 ${claimed - honored} 次）`);

console.log('— 速度 —');
b = build(['H8', 'I8', 'J8', 'H9', 'H10'], ['G8', 'H7', 'A1', 'C3', 'E5']);
for (const [label, d, budget] of [['深度 6 ', 6, 20000], ['深度 10', 10, 100000]]) {
  const e3 = new E.Engine();
  const t = Date.now();
  const r = e3.runVct(b, C.BLACK, d, budget, 8000);
  console.log(`  VCT ${label}: ${Date.now() - t}ms, ${e3.vctNodes} 节点 -> ${r >= 0 ? pToLabel(r) : '无杀'}`);
}

console.log(fail === 0 ? '\n全部通过' : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
