/*
 * test-defense.js — 防守深度检验
 *
 * 人类打败中等引擎的典型套路不是一步杀，而是**提前两三手布双威胁**：
 * 先摆两个互不相干的活二，等它们交汇成双活三时已经拦不住了。
 * 引擎要拆掉它，必须在对手「还没成形」的时候就看出来。
 *
 * 这里让一个「贪心进攻者」扮演人类：它不防守，只管每一手把自己的威胁做到最大。
 * 引擎如果真有大师水平，应该稳稳守住并反杀。守不住就是防守深度不够。
 *
 * 用法: node test-defense.js [--games 20] [--level master]
 */
const fs = require('fs');
const path = require('path');
const C = require('../js/core.js');
const E = require('../js/engine.js');
const B = require('../js/book.js');

function arg(n, d) {
  const i = process.argv.indexOf('--' + n);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
}
const GAMES = parseInt(arg('games', 20), 10);
const LEVEL = arg('level', 'master');

let book = null;
const bp = path.join(__dirname, '../data/book.json');
if (fs.existsSync(bp)) book = B.Book.load(fs.readFileSync(bp, 'utf8'));

let seed = parseInt(arg('seed', 6161), 10) >>> 0;
const rnd = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 4294967296;
};

/**
 * 贪心进攻者：模仿「只顾进攻的人类」。
 * 能成五就成五，对手要成五才挡，其余一律走自己威胁最大的点，
 * 并且偏好能同时长两条线的点（这正是人类做双威胁的直觉）。
 */
function attacker(b, role) {
  const opp = 3 - role;
  const five = b.winPoints(role, []);
  if (five.length) return five[0];
  const block = b.winPoints(opp, []);
  if (block.length) return block[0];

  const empties = b.emptyNear([]);
  if (!empties.length) return C.xyToP(7, 7);
  let best = -1, bestScore = -1;
  for (const p of empties) {
    let s = E.threatScore(b, p, role);
    // 同时在多个方向成形的点加权 —— 人类眼里的"好点"
    let dirs = 0;
    for (let d = 0; d < 4; d++) if (b.shapeAt(p, d, role) >= C.S_OPEN_TWO) dirs++;
    s += dirs * dirs * 400;
    s += rnd() * 200;                       // 一点随机，避免每局一模一样
    if (s > bestScore) { bestScore = s; best = p; }
  }
  return best;
}

let engWin = 0, attWin = 0, draw = 0;
const losses = [];

for (let g = 0; g < GAMES; g++) {
  const attIsBlack = g % 2 === 0;           // 攻方轮流执黑执白
  const b = new C.Board();
  const eng = new E.Engine();
  if (book) eng.setBook(book);
  b.put(C.xyToP(7, 7), C.BLACK);
  let winner = 0;

  for (let ply = 1; ply < 225; ply++) {
    const role = ply % 2 === 0 ? C.BLACK : C.WHITE;
    const isAtt = (role === C.BLACK) === attIsBlack;
    const mv = isAtt ? attacker(b, role)
                     : eng.bestMove(b, role, { level: LEVEL, useBook: true, bookRandom: 1 }).move;
    if (b.cells[mv] !== C.EMPTY) break;
    b.put(mv, role);
    if (b.lastMoveWins()) { winner = role; break; }
  }

  if (winner === 0) draw++;
  else if ((winner === C.BLACK) === attIsBlack) {
    attWin++;
    if (losses.length < 3) losses.push({
      attSide: attIsBlack ? '黑' : '白',
      moves: b.history.map(C.pToLabel).join(' ')
    });
  } else engWin++;

  process.stdout.write(`\r${g + 1}/${GAMES}  引擎 ${engWin} : ${attWin} 贪心进攻者  和 ${draw}`);
}

console.log('\n');
const rate = (engWin + draw * 0.5) / GAMES * 100;
console.log(`难度 ${LEVEL} vs 贪心进攻者：引擎 ${engWin} 胜 / 对手 ${attWin} 胜 / 和 ${draw}`);
console.log(`引擎得分率 ${rate.toFixed(1)}%   （大师水平应当接近 100%）`);
if (losses.length) {
  console.log('\n输掉的对局（攻方执' + losses.map(l => l.attSide).join('/') + '）:');
  for (const l of losses) console.log('  ' + l.moves);
}
process.exit(rate >= 90 ? 0 : 1);
