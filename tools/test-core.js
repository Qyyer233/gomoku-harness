// 核心模块自检：棋形识别 / 增量评分 / 对称规范化
const C = require('../js/core.js');
const { Board, labelToP, pToLabel, SHAPE_NAME } = C;

let fail = 0;
function eq(actual, expect, msg) {
  const ok = String(actual) === String(expect);
  if (!ok) fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + msg + '  => ' + actual + (ok ? '' : ' (期望 ' + expect + ')'));
}

function setup(blacks, whites) {
  const b = new Board();
  (blacks || []).forEach(s => b.put(labelToP(s), C.BLACK));
  (whites || []).forEach(s => b.put(labelToP(s), C.WHITE));
  return b;
}
const shape = (b, pt, role) => {
  let best = 0;
  for (let d = 0; d < 4; d++) best = Math.max(best, b.shapeAt(labelToP(pt), d, role));
  return SHAPE_NAME[best];
};

console.log('— 棋形识别 —');
let b = setup(['H8', 'I8', 'J8']);
eq(shape(b, 'K8', C.BLACK), '活四', '_XXX_ 补右端成活四');
eq(shape(b, 'G8', C.BLACK), '活四', '_XXX_ 补左端成活四');
eq(shape(b, 'H9', C.BLACK), '活二', 'H9 与 H8 竖向成活二');

b = setup(['H8', 'I8'], []);
eq(shape(b, 'J8', C.BLACK), '活三', '两子补一子成活三');

b = setup(['H8', 'I8', 'J8'], ['G8']);
eq(shape(b, 'K8', C.BLACK), '冲四', '一端被堵只能冲四');

b = setup(['H8', 'I8', 'J8', 'K8'], []);
eq(shape(b, 'L8', C.BLACK), '五连', '四连补五');

b = setup(['H8', 'J8'], []);
eq(shape(b, 'I8', C.BLACK), '活三', '跳三 X_X 中间补成活三');

b = setup(['H8', 'I8', 'K8'], []);
eq(shape(b, 'J8', C.BLACK), '活四', '跳四补中成活四');

b = setup(['H12', 'I11', 'J10'], []);
eq(shape(b, 'K9', C.BLACK), '活四', '斜向活四');

b = setup(['A8', 'B8', 'C8'], []);
eq(shape(b, 'D8', C.BLACK), '冲四', '贴边墙当作阻挡');

console.log('— 成五判定 —');
b = setup(['H8', 'I8', 'J8', 'K8', 'L8'], []);
eq(b.lastMoveWins(), 'true', '横五连获胜');
b = setup(['H8', 'I9', 'J10', 'K11', 'L12'], []);
eq(b.lastMoveWins(), 'true', '斜五连获胜');
b = setup(['H8', 'I8', 'J8', 'K8'], []);
eq(b.lastMoveWins(), 'false', '四连未胜');

console.log('— 增量评分对称性 —');
b = setup(['H8', 'I9', 'J8'], ['G7', 'K11']);
const snapshot = { b: b.total[1], w: b.total[2], h: b.hash };
b.put(labelToP('F5'), C.BLACK); b.undo();
eq(b.total[1] === snapshot.b && b.total[2] === snapshot.w && b.hash === snapshot.h, 'true',
   '落子后悔棋可完全还原');

// 与全量重算比对
function bruteTotal(board, role) {
  let s = 0;
  for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) {
    const p = C.xyToP(x, y);
    if (board.cells[p] !== role) continue;
    for (let d = 0; d < 4; d++) s += C.SHAPE_SCORE[board.shapeAt(p, d, role)];
  }
  return s;
}
let rb = new Board();
let seed = 12345;
const rand = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
for (let i = 0; i < 40; i++) {
  const empties = rb.emptyNear([]);
  const list = empties.length ? empties : [C.xyToP(7, 7)];
  rb.put(list[rand(list.length)], i % 2 ? C.WHITE : C.BLACK);
}
eq(rb.total[1], bruteTotal(rb, C.BLACK), '增量黑分 == 全量重算');
eq(rb.total[2], bruteTotal(rb, C.WHITE), '增量白分 == 全量重算');

console.log('— 对称规范化 —');
const b1 = setup(['H8', 'I9'], ['G7']);
const b2 = setup(['G7'], ['H8', 'I9']);   // 黑白互换，键必须不同
const b3 = new Board();
[['H8', C.BLACK], ['G9', C.BLACK], ['I7', C.WHITE]].forEach(([s, r]) => b3.put(labelToP(s), r));
eq(C.canonicalKey(b1, 1).key === C.canonicalKey(b3, 1).key, 'true', '镜像局面规范键相同');
eq(C.canonicalKey(b1, 1).key === C.canonicalKey(b2, 1).key, 'false', '换色局面规范键不同');
// 变换往返
let tOk = true;
for (let t = 0; t < 8; t++) for (let x = 0; x < 15; x += 3) for (let y = 0; y < 15; y += 4) {
  const f = C.symFwd(t, x, y), back = C.symInv(t, f[0], f[1]);
  if (back[0] !== x || back[1] !== y) tOk = false;
}
eq(tOk, 'true', '8 种变换与其逆互为往返');

// 规范键还原的着法确实落在等价位置
const kb = setup(['H8', 'I9', 'K11'], ['G7', 'J8']);
const ck = C.canonicalKey(kb, 1);
let mapOk = true;
for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) {
  const cur = C.symInv(ck.transform, x, y);
  if (ck.key[y * 15 + x] !== String(kb.cells[C.xyToP(cur[0], cur[1])])) mapOk = false;
}
eq(mapOk, 'true', '规范键与 symInv 映射一致');

console.log('— 对称等价着法（随机挑一个，棋力零损失）—');
const symSet = (b, pt) => C.symmetricMoves(b, labelToP(pt)).map(pToLabel).sort().join(' ');
C.setSize(12);
eq(symSet(new Board(), 'F7'), 'F6 F7 G6 G7', '12 路空盘：中间 4 点互相等价');
C.setSize(15);
const tengen = setup(['H8']);
eq(symSet(tengen, 'G8'), 'G8 H7 H9 I8', '15 路天元之后：上下左右 4 点等价');
eq(symSet(tengen, 'G7'), 'G7 G9 I7 I9', '15 路天元之后：4 个斜角等价（和上下左右是两组）');
// 只沿一条斜线对称：只有沿这条线的镜像是等价的
eq(symSet(setup(['H8'], ['I9']), 'G8'), 'G8 H7', '只有一条对称轴时只剩一对');
eq(symSet(setup(['H8', 'I8'], ['J10']), 'G8'), 'G8', '局面不对称就只有自己');
// H8-G8 横连：只关于第 8 行上下对称（左右不对称，因为两子不以天元为中心）
eq(symSet(setup(['H8', 'G8']), 'H9'), 'H7 H9', '只有上下对称时，H9 只和 H7 等价');
// 颜色也算：同样的形状，黑白不同就不对称
eq(symSet(setup(['H8'], ['H9', 'H7']), 'G8'), 'G8 I8', '白子上下各一，只剩左右对称');

console.log(fail === 0 ? '\n全部通过 ✔' : '\n失败 ' + fail + ' 项 �’');
process.exit(fail ? 1 : 0);
