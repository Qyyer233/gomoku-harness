/*
 * book-ab.js — A/B：开局库的 maxPly 闸门该不该放开
 *
 * 背景：`Book.maxPly`（默认 8）限制库只管前 8 手。这个数字不是拍脑袋定的 ——
 * 当年实测放开会让胜率从 62.5% 掉到 40.0%，原因：
 * **棋谱由自对弈产生，一旦现场搜索比造谱的引擎更强，深层的库着法就会反过来拖后腿。**
 *
 * 但那个前提现在变了：15 路棋谱库里 24,190/28,090 局来自 Gomocup 世界赛
 * （Rapfi / Yixin / JAX 打的），不再是我们自己的弱引擎。所以要重测。
 *
 * 判据：双方都是「查库 + Rapfi 兜底」，**只有 maxPly 不同**。
 *   - A 明显 > 50%：放开有收益，而且还省时间（查库是 0ms）
 *   - 约等于 50%：深层库着法和 Rapfi 现场算的一样好 —— 那就该放开，白省时间
 *   - A 明显 < 50%：深层库着法更差，闸门保持原样
 *
 * 注意这里**不把省下的时间还给 A**。实战里省下的时间本来就用不上，
 * 而且「同样时限下谁更强」才是干净的比较。
 *
 * 用法：
 *   node tools/book-ab.js --size 15 --games 200 --ms 1500 --plyA 26 --plyB 8
 */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../js/core.js');
const B = require('../js/book.js');
const { Rapfi } = require('./rapfi.js');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i < 0 ? d : (isNaN(+process.argv[i + 1]) ? process.argv[i + 1] : +process.argv[i + 1]);
};
const SIZE  = arg('size', 15);
const GAMES = arg('games', 200);
const MS    = arg('ms', 1500);
const CONC  = arg('conc', 5);
const PLY_A = arg('plyA', 26);        // 实验组：放开
const PLY_B = arg('plyB', 8);         // 对照组：现状
const SPREAD = arg('spread', 21);
// 深层条目最大的嫌疑是**样本太薄**：minGames=2 意味着第 15 手的局面出现两次
// 就算数，那个胜率纯粹是噪声。所以把门槛也做成可调，好分辨是「深度」的问题
// 还是「样本」的问题。
const MING_A = arg('minGamesA', 2);
const MING_B = arg('minGamesB', 2);
const MAXPLY = SIZE * SIZE;

C.setSize(SIZE);
const BOOK_JSON = path.join(ROOT, 'data', SIZE === 15 ? 'book.json' : `book${SIZE}.json`);
const raw = JSON.parse(fs.readFileSync(BOOK_JSON, 'utf8'));

function bookWith(maxPly, minGames) {
  const b = B.Book.load(raw);
  b.maxPly = maxPly;
  b.minGames = minGames;
  return b;
}

/** 得分率与标准误。带和棋的胜负不是二项分布，见 rapfi-verify.js 里的说明。 */
function stats(win, loss, draw) {
  const n = win + loss + draw;
  if (!n) return { score: 0, se: 0 };
  const w = win / n, d = draw / n;
  const score = w + d / 2;
  return { score, se: Math.sqrt(Math.max(w + d / 4 - score * score, 0) / n) };
}

/**
 * 起始局面直接取自真实棋谱。
 *
 * **不能用随机开局。** 第一版就是在中心附近随机摆两手，结果两边的查库率都是
 * 0% —— 随机局面根本不在库里，这个 A/B 等于什么都没测。
 * 而 Gomocup 每局开头是赛会**指定**的平衡开局（`#o<K>` 标出来了），
 * 那既是库里真实存在的局面，又是赛会精心挑的「双方机会均等」的起点，
 * 正好拿来当测试起点。
 */
function openingsFromRecords(n, seed) {
  const R = require('./records.js');
  const dir = path.join(ROOT, 'data', SIZE === 15 ? 'records' : `records${SIZE}`);
  const games = R.loadDir(dir).reduce((a, f) => a.concat(f.games), [])
    .filter(g => (g.openLen || 0) >= 3 && g.moves.length > (g.openLen || 0) + 10);
  if (!games.length) throw new Error('没有带 #o 标记的棋谱 —— 先跑 npm run gomocup:import');

  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const seen = new Set(), out = [];
  // **有放回地抽，不去重。** Gomocup 每届只用 12 条指定开局，去重的话
  // 三届加起来也就 30 来个起点，凑不够局数。重复用同一个开局没问题：
  // 每个开局黑白各下一次，而且限时搜索本身不是确定性的，棋路会分叉。
  for (let i = 0; i < n; i++) {
    const g = games[(rnd() * games.length) | 0];
    const mv = g.moves.slice(0, g.openLen);     // 只取赛会指定的那一段
    out.push(mv);
    seen.add(mv.join('|'));
  }
  console.log(`起始局面取自 ${games.length} 局真实对局的赛会指定开局` +
              `（${seen.size} 个不同的起点，有放回抽样 ${out.length} 次）`);
  return out;
}

/**
 * 下一局。sideA 执什么颜色由 aBlack 决定。
 * 返回 {r: 1/0/-1（A 视角）, bookA, bookB, movesA, movesB}
 */
async function playGame(engA, engB, bookA, bookB, opening, aBlack) {
  const board = new C.Board();
  const moves = [];
  for (const p of opening) {
    if (board.cells[p] !== C.EMPTY) break;
    board.put(p, moves.length % 2 === 0 ? C.BLACK : C.WHITE);
    moves.push(p);
    if (board.lastMoveWins()) return { r: 0, bookA: 0, bookB: 0, movesA: 0, movesB: 0 };
  }

  await engA.newGame(SIZE);
  await engB.newGame(SIZE);

  let bookAHits = 0, bookBHits = 0, movesA = 0, movesB = 0;

  while (moves.length < MAXPLY) {
    const role = moves.length % 2 === 0 ? C.BLACK : C.WHITE;
    const isA = (role === C.BLACK) === aBlack;
    const eng = isA ? engA : engB;
    const book = isA ? bookA : bookB;
    if (isA) movesA++; else movesB++;

    let p = -1;
    const hit = book.lookup(board, role, 0);
    if (hit && board.cells[hit.move] === C.EMPTY) {
      p = hit.move;
      if (isA) bookAHits++; else bookBHits++;
    } else {
      let r;
      try {
        r = await eng.think(moves.map(q => [C.pToX(q), C.pToY(q)]), MS);
      } catch (e) {
        return { r: isA ? -1 : 1, bookA: bookAHits, bookB: bookBHits, movesA, movesB };
      }
      p = C.xyToP(r.x, r.y);
    }
    if (p < 0 || board.cells[p] !== C.EMPTY)
      return { r: isA ? -1 : 1, bookA: bookAHits, bookB: bookBHits, movesA, movesB };

    board.put(p, role);
    moves.push(p);
    if (board.lastMoveWins())
      return { r: isA ? 1 : -1, bookA: bookAHits, bookB: bookBHits, movesA, movesB };
  }
  return { r: 0, bookA: bookAHits, bookB: bookBHits, movesA, movesB };
}

async function main() {
  console.log(`${SIZE} 路 · 每手上限 ${MS}ms · ${GAMES} 局 · 并发 ${CONC}`);
  console.log(`A = 库管到第 ${PLY_A} 手 / 样本门槛 ${MING_A}   ` +
              `B = 库管到第 ${PLY_B} 手 / 样本门槛 ${MING_B}`);
  console.log(`棋谱库：${raw.games} 局棋谱 / ${Object.keys(raw.entries).length} 个局面 / ` +
              `${Object.keys(raw.verdicts || {}).length} 条裁定\n`);

  const opens = openingsFromRecords(Math.ceil(GAMES / 2), 20260919);
  const jobs = [];
  for (let i = 0; i < GAMES; i++) jobs.push({ opening: opens[i >> 1], aBlack: i % 2 === 0 });

  let win = 0, loss = 0, draw = 0, done = 0;
  let hitA = 0, hitB = 0, mvA = 0, mvB = 0;

  async function worker() {
    const a = new Rapfi({ threads: 1, pondering: false, matchSpread: SPREAD });
    const b = new Rapfi({ threads: 1, pondering: false, matchSpread: SPREAD });
    await a.start(); await b.start();
    const bookA = bookWith(PLY_A, MING_A), bookB = bookWith(PLY_B, MING_B);
    for (;;) {
      const job = jobs.shift();
      if (!job) break;
      const g = await playGame(a, b, bookA, bookB, job.opening, job.aBlack);
      if (g.r > 0) win++; else if (g.r < 0) loss++; else draw++;
      hitA += g.bookA; hitB += g.bookB; mvA += g.movesA; mvB += g.movesB;
      done++;
      const { score, se } = stats(win, loss, draw);
      const elo = score <= 0 ? -800 : score >= 1 ? 800 : -400 * Math.log10(1 / score - 1);
      process.stdout.write(
        `  ${String(done).padStart(3)}/${GAMES}  ${win}-${loss}-${draw}  ` +
        `得分率 ${(score * 100).toFixed(1)}%  ±${(se * 196).toFixed(1)}%  Elo ${elo.toFixed(0)}  ` +
        `查库率 A ${(hitA / Math.max(mvA, 1) * 100).toFixed(0)}% / B ${(hitB / Math.max(mvB, 1) * 100).toFixed(0)}%\n`);
    }
    a.stop(); b.stop();
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  const { score, se } = stats(win, loss, draw);
  const lo = score - 1.96 * se, hi = score + 1.96 * se;
  const elo = score <= 0 ? -800 : score >= 1 ? 800 : -400 * Math.log10(1 / score - 1);
  console.log('\n================ 结论 ================');
  console.log(`A（库到第 ${PLY_A} 手）查库率 ${(hitA / Math.max(mvA, 1) * 100).toFixed(1)}%，` +
              `B（库到第 ${PLY_B} 手）${(hitB / Math.max(mvB, 1) * 100).toFixed(1)}%`);
  console.log(`得分率 ${(score * 100).toFixed(1)}%  95% 区间 [${(lo * 100).toFixed(1)}%, ` +
              `${(hi * 100).toFixed(1)}%]  Elo ${elo.toFixed(0)}`);
  if (lo > 0.5)      console.log(`判定：放开到第 ${PLY_A} 手更强，而且更省时间 ✓✓`);
  else if (hi < 0.5) console.log(`判定：放开更弱，闸门保持 ${PLY_B} ✗`);
  else               console.log(`判定：没有显著差异 —— 既然棋力不亏、查库还是 0ms，` +
                                 `那就该放开（省下的时间是白赚的）✓`);
}

main().catch(e => { console.error(e); process.exit(1); });
