/*
 * arena.js — 两套配置对打，量化强度与速度
 *
 * 用法:
 *   node arena.js --a hard --b normal --games 20
 *   node arena.js --a hard --b hard --abook 1 --bbook 0 --games 20   # 有库 vs 无库
 *
 *   --a/--b        双方难度
 *   --abook/--bbook 是否使用开局库 (1/0)
 *   --games        总局数（自动交换先后手）
 *   --open         每局随机铺开的开局手数（保证棋局不重复）
 */
const path = require('path');
const fs = require('fs');
const C = require('../js/core.js');
const E = require('../js/engine.js');
const B = require('../js/book.js');
const SPRT = require('./sprt.js');

function arg(n, d) {
  const i = process.argv.indexOf('--' + n);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
}
const has = n => process.argv.indexOf('--' + n) > 0;
C.setSize(parseInt(arg('size', 15), 10));
const LA = arg('a', 'hard'), LB = arg('b', 'normal');
const GAMES = parseInt(arg('games', 20), 10);
const OPEN = parseInt(arg('open', 4), 10);
const A_BOOK = arg('abook', '1') === '1';
const B_BOOK = arg('bbook', '1') === '1';
// 算杀开关：不给就用难度预设，给了就覆盖（用来量化 VCF/VCT 的贡献）
const A_VCT = arg('avct', null), B_VCT = arg('bvct', null);
// 逐项覆盖，方便和「旧配置」做对照
const OVR = side => {
  const o = {};
  const d = arg(side + 'depth', null); if (d !== null) o.depth = parseInt(d, 10);
  const t = arg(side + 'time', null);  if (t !== null) o.timeMs = parseInt(t, 10);
  const w = arg(side + 'width', null); if (w !== null) o.width = parseInt(w, 10);
  // 收手阈值：自适应用时的两个刹车，量化「多搜几层值不值」
  const s = arg(side + 'solid', null);  if (s !== null) o.solid = parseInt(s, 10);
  const k = arg(side + 'stable', null); if (k !== null) o.stable = parseInt(k, 10);
  if (arg(side + 'basic', null) === '1') o.basicOrder = true;
  return o;
};
const A_OVR = OVR('a'), B_OVR = OVR('b');

let book = null;
const bookPath = path.join(__dirname, '../data/book.json');
if (fs.existsSync(bookPath)) {
  book = B.Book.load(fs.readFileSync(bookPath, 'utf8'));
  console.log(`开局库: ${book.meta.positions} 局面 / ${book.meta.games} 局棋谱`);
} else {
  console.log('开局库不存在，双方都用纯搜索');
}

let seed = parseInt(arg('seed', 20240917), 10) >>> 0;
function rnd() {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 4294967296;
}

const engA = new E.Engine(); if (book) engA.setBook(book);
const engB = new E.Engine(); if (book) engB.setBook(book);

/** 随机但不离谱的开局手 */
function openMove(b, role) {
  const opp = 3 - role;
  const five = b.winPoints(role, []); if (five.length) return five[0];
  const blk = b.winPoints(opp, []); if (blk.length) return blk[0];
  const cand = b.emptyNear([])
    .map(p => [p, E.threatScore(b, p, role) + E.threatScore(b, p, opp) * 0.85])
    .sort((x, y) => y[1] - x[1]).slice(0, 8);
  if (!cand.length) return C.center();      // 天元要按当前边长算，12 路不是 (7,7)
  return cand[Math.floor(rnd() * cand.length) % cand.length][0];
}

const stat = { aWin: 0, bWin: 0, draw: 0, aMs: 0, aMoves: 0, bMs: 0, bMoves: 0, aMax: 0, bMax: 0, aBook: 0, bBook: 0 };

// SPRT：不预先定局数，边打边算，撞到边界就停（见 tools/sprt.js 里的来龙去脉）。
// --games 在这个模式下退化成「最多打这么多局」的保险丝。
const USE_SPRT = has('sprt');
const sprt = USE_SPRT ? new SPRT.Sprt({
  elo0: parseFloat(arg('elo0', 0)),
  elo1: parseFloat(arg('elo1', 15)),
  alpha: parseFloat(arg('alpha', 0.05)),
  beta: parseFloat(arg('beta', 0.05))
}) : null;
if (sprt) {
  console.log(`SPRT: H0 = ${sprt.elo0} Elo, H1 = ${sprt.elo1} Elo, ` +
              `alpha=${sprt.alpha} beta=${sprt.beta}，最多 ${GAMES} 局`);
}

for (let g = 0; g < GAMES; g++) {
  const aIsBlack = g % 2 === 0;                 // 交换先后手，消除先手优势
  const b = new C.Board();
  engA.reset(); engB.reset();
  b.put(C.center(), C.BLACK);                   // 天元随边长走，不能写死 (7,7)
  let winner = 0;

  for (let ply = 1; ply < 225; ply++) {
    const role = ply % 2 === 0 ? C.BLACK : C.WHITE;
    const isA = (role === C.BLACK) === aIsBlack;
    let mv;
    if (ply < OPEN) {
      mv = openMove(b, role);
    } else {
      const t = Date.now();
      const o = {
        level: isA ? LA : LB,
        useBook: isA ? A_BOOK : B_BOOK,
        bookRandom: 1
      };
      const vctOverride = isA ? A_VCT : B_VCT;
      if (vctOverride !== null) o.vct = parseInt(vctOverride, 10);
      Object.assign(o, isA ? A_OVR : B_OVR);
      const r = (isA ? engA : engB).bestMove(b, role, o);
      const dt = Date.now() - t;
      mv = r.move;
      if (isA) { stat.aMs += dt; stat.aMoves++; stat.aMax = Math.max(stat.aMax, dt); if (r.source === 'book') stat.aBook++; }
      else { stat.bMs += dt; stat.bMoves++; stat.bMax = Math.max(stat.bMax, dt); if (r.source === 'book') stat.bBook++; }
    }
    if (b.cells[mv] !== C.EMPTY) break;
    b.put(mv, role);
    if (b.lastMoveWins()) { winner = role; break; }
  }

  let res = 0;
  if (winner === 0) stat.draw++;
  else if ((winner === C.BLACK) === aIsBlack) { stat.aWin++; res = 1; }
  else { stat.bWin++; res = -1; }

  if (sprt) {
    sprt.add(res);
    // 每局一整行：长任务的进度不能用 \r 覆盖，管道里会一个字都看不到
    console.log(`  ${String(g + 1).padStart(4)}/${GAMES}  ${sprt.line()}`);
    if (sprt.verdict()) { console.log(`\n提前终止：已达统计结论`); break; }
  } else {
    process.stdout.write(`\r${g + 1}/${GAMES}  A(${LA}${A_BOOK ? '+库' : ''}) ${stat.aWin} : ` +
      `${stat.bWin} B(${LB}${B_BOOK ? '+库' : ''})  和 ${stat.draw}`);
  }
}

const played = stat.aWin + stat.bWin + stat.draw;
const pct = (stat.aWin + stat.draw * 0.5) / Math.max(1, played) * 100;
console.log(`\n\nA = ${LA}${A_BOOK ? ' +开局库' : ''}   B = ${LB}${B_BOOK ? ' +开局库' : ''}`);
console.log(`结果: A ${stat.aWin} 胜 / B ${stat.bWin} 胜 / 和 ${stat.draw}` +
  `（共 ${played} 局）  A 得分率 ${pct.toFixed(1)}%`);
if (sprt) {
  console.log(`SPRT: ${sprt.line()}`);
  console.log(sprt.conclusion());
  if (!sprt.verdict()) {
    console.log(`  （打满了 ${GAMES} 局仍无结论 —— 这正说明「固定局数读胜率」不可靠：` +
                `此时任何百分比都不是结论，要么加大 --games，要么先用 bench.js 的指纹判断）`);
  }
}
console.log(`速度: A 平均 ${(stat.aMs / Math.max(1, stat.aMoves)).toFixed(1)}ms (最慢 ${stat.aMax}ms)，` +
  `B 平均 ${(stat.bMs / Math.max(1, stat.bMoves)).toFixed(1)}ms (最慢 ${stat.bMax}ms)`);
console.log(`查库: A ${stat.aBook}/${stat.aMoves} 手命中 (${(stat.aBook / Math.max(1, stat.aMoves) * 100).toFixed(1)}%)，` +
  `B ${stat.bBook}/${stat.bMoves} 手命中 (${(stat.bBook / Math.max(1, stat.bMoves) * 100).toFixed(1)}%)`);
