/*
 * gen-openings.js — 穷举开局并深算，把开局库补成「查表即最优」
 *
 * 自对弈产出的棋谱都从天元附近开始，对手一旦开在边角，库直接查不到。
 * 但开局是**可以穷举**的：棋盘有 8 种对称，第 1 手落在哪里，
 * 归并之后只剩几十种（15 路 36 种，12 路 21 种）。
 *
 * 逐层展开的规则不对称，这正是「必胜谱为什么那么大」的根源：
 *   - 轮到 AI  → 只有 1 条分支（引擎算出来的那一手）
 *   - 轮到对手 → 必须展开**全部**合理应手，一条都不能漏
 * 所以层数每加 2，局面数要乘以对手的分支数（几十倍）。
 *
 * 用法:
 *   node gen-openings.js --count --ply 6            # 只数局面，不深算（先看代价）
 *   node gen-openings.js --size 12 --ply 4 --ms 2000
 *
 *   --size   棋盘边长（默认 15）
 *   --ply    补到第几手（默认 2）
 *   --ms     每个局面的深算毫秒数（默认 2000）
 *   --near   展开对手着法时只考虑离已有子多近的点（默认 2，和引擎的候选半径一致）
 *   --count  只统计各层的局面数，不做深算
 *   --book   要合并进的开局库（默认 ../data/book.json）
 *   --budget 最多分析多少个局面，超了就停（默认无限）
 *   --trust  已有条目至少多少局支撑才复用（默认 20，低于此值重新深算）
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
const has = n => process.argv.indexOf('--' + n) > 0;

const SIZE = parseInt(arg('size', 15), 10);
C.setSize(SIZE);
const MAX_PLY = parseInt(arg('ply', 2), 10);
const MS = parseInt(arg('ms', 2000), 10);
const NEAR = parseInt(arg('near', 2), 10);
const COUNT_ONLY = has('count');
const BUDGET = parseInt(arg('budget', 0), 10) || Infinity;
const BOOK_PATH = path.resolve(arg('book', path.join(__dirname, '../data/book.json')));
// 已有条目要有这么多局支撑才直接复用，否则重新深算
const TRUST_GAMES = parseInt(arg('trust', 20), 10);

const keyOf = (b, role) => B.hashKey(C.canonicalKey(b, role).key);

/** 对手的合理应手：已有子附近的空点（空盘时是全盘） */
function opponentMoves(b, moves) {
  const out = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const p = C.xyToP(x, y);
      if (b.cells[p] !== C.EMPTY) continue;
      if (moves.length) {
        let near = false;
        for (const q of moves) {
          if (Math.abs(C.pToX(q) - x) <= NEAR && Math.abs(C.pToY(q) - y) <= NEAR) { near = true; break; }
        }
        if (!near) continue;
      }
      out.push(p);
    }
  }
  return out;
}

// ---------- 载入 / 新建开局库 ----------
let book = { version: 1, size: SIZE, generated: '', games: 0, maxPly: 26, entries: {} };
if (!COUNT_ONLY && fs.existsSync(BOOK_PATH)) {
  const old = JSON.parse(fs.readFileSync(BOOK_PATH, 'utf8'));
  if ((old.size || 15) === SIZE) book = old;
  else console.log(`已有的库是 ${old.size || 15} 路，尺寸不符，另建一个 ${SIZE} 路的库`);
}
book.size = SIZE;

const eng = new E.Engine();
let analysed = 0, reused = 0, stopped = false;
const t0 = Date.now();

/**
 * 求某个局面下 AI 的着法。库里已经有就直接用（保证同一局面只算一次），
 * 否则深算并写进库。
 * @return padded 落点
 */
function aiMoveFor(b, moves, aiColor) {
  const ck = C.canonicalKey(b, aiColor);
  const h = B.hashKey(ck.key);
  const ent = book.entries[h];
  // 只复用「样本厚」的条目（比如天元有 3519 局支撑）。
  // 自对弈里只有两三局支撑的着法，还不如现在花 2 秒深算一遍 ——
  // 那种条目正是之前让开局库拖后腿的东西。
  if (ent && ent[0] === moves.length && ent[2] >= TRUST_GAMES) {
    reused++;
    const cx = ent[1] % 15, cy = (ent[1] / 15) | 0;
    const real = C.symInv(ck.transform, cx, cy);
    const p = C.xyToP(real[0], real[1]);
    if (b.cells[p] === C.EMPTY) return p;        // 命中且合法
  }
  if (analysed >= BUDGET) { stopped = true; return -1; }

  eng.reset();
  // fastOpening:false —— 离线造库就是要在开局局面上深算，
  // 不能被 OPENING_FAST 那道「开局提速」上限压住
  const r = eng.bestMove(b, aiColor, {
    level: 'master', useBook: false, timeMin: MS, timeMax: MS, fastOpening: false
  });
  const cm = C.symFwd(ck.transform, C.pToX(r.move), C.pToY(r.move));
  // 条目格式 [棋子数, 着法, 局数, 胜局, 和局, 总手数]。
  // 这些是算出来的不是统计出来的，给一组中性计数：过得了 minGames 门槛即可，
  // 不去污染真实棋谱的胜率。
  book.entries[h] = [moves.length, cm[1] * 15 + cm[0], 4, 2, 0, 240];
  analysed++;
  if (analysed % 20 === 0) {
    const el = (Date.now() - t0) / 1000;
    process.stdout.write(`\r  深算 ${analysed} 个  复用 ${reused} 个  ${el.toFixed(0)}s`);
  }
  return r.move;
}

/** 逐层展开。返回每层的不等价局面数。 */
function walk(aiColor) {
  let level = [[]];                       // 当前层的着法序列
  const counts = [];
  for (let ply = 0; ply < MAX_PLY && level.length; ply++) {
    const role = ply % 2 === 0 ? C.BLACK : C.WHITE;
    const next = [];
    const seen = new Set();

    for (const moves of level) {
      const b = new C.Board();
      moves.forEach((p, i) => b.put(p, i % 2 === 0 ? C.BLACK : C.WHITE));

      if (role === aiColor) {
        // AI 这一层只有一条分支。
        // 只统计时用「静态评分最高的点」当替身：分支数一样是 1，
        // 但必须是个合法着法，否则后面几层建不出局面（早先这里放了 -1，
        // 结果执黑分支直接数出 0）。
        if (COUNT_ONLY) {
          let best = -1, bs = -1;
          for (const p of b.emptyNear([])) {
            const s = E.threatScore(b, p, aiColor) + E.threatScore(b, p, 3 - aiColor) * 0.85;
            if (s > bs) { bs = s; best = p; }
          }
          if (best < 0) best = C.center();
          next.push(moves.concat([best]));
          continue;
        }
        const mv = aiMoveFor(b, moves, aiColor);
        if (mv < 0) return counts;         // 预算用完
        next.push(moves.concat([mv]));
      } else {
        // 对手这一层要全部展开
        for (const p of opponentMoves(b, moves)) {
          b.put(p, role);
          const k = keyOf(b, 3 - role);
          b.undo();
          if (seen.has(k)) continue;       // 对称等价只留一个
          seen.add(k);
          next.push(moves.concat([p]));
        }
      }
    }
    counts.push({ ply: ply + 1, role: role === C.BLACK ? '黑' : '白',
                  who: role === aiColor ? 'AI' : '对手', n: next.length });
    level = next;
    if (COUNT_ONLY && next.length > 400000) {
      counts.push({ ply: ply + 2, role: '-', who: '-', n: NaN });
      break;                               // 再数下去没意义
    }
  }
  return counts;
}

// ---------- 主流程 ----------
console.log(`${SIZE} 路，展开到第 ${MAX_PLY} 手，对手候选半径 ${NEAR}` +
            (COUNT_ONLY ? '（只统计，不深算）' : `，每个局面深算 ${MS}ms`));

for (const aiColor of [C.BLACK, C.WHITE]) {
  console.log(`\nAI 执${aiColor === C.BLACK ? '黑' : '白'}：`);
  const counts = walk(aiColor);
  for (const c of counts) {
    console.log(`  第 ${String(c.ply).padStart(2)} 手(${c.who})后  不等价局面 ` +
                (isNaN(c.n) ? '数不过来了' : c.n.toLocaleString()));
  }
  if (stopped) { console.log('  （已达分析预算上限，提前停止）'); break; }
}

if (!COUNT_ONLY) {
  book.generated = new Date().toISOString();
  book.positions = Object.keys(book.entries).length;
  fs.writeFileSync(BOOK_PATH, JSON.stringify(book));
  fs.writeFileSync(BOOK_PATH.replace(/\.json$/, '.js'),
    '(function(g){g.GOMOKU_BOOKS=g.GOMOKU_BOOKS||{};g.GOMOKU_BOOKS[' + SIZE + ']=' +
    JSON.stringify(book) + ';})(typeof self!=="undefined"?self:this);\n');
  console.log(`\n\n深算 ${analysed} 个局面，复用 ${reused} 个`);
  console.log(`开局库现有 ${book.positions} 个局面 -> ${BOOK_PATH}`);
  console.log(`用时 ${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分钟`);
}
