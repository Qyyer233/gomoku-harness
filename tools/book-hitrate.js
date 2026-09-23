/*
 * book-hitrate.js — 棋谱库在「真实对局」里到底能带我们走多远
 *
 * 之前判断覆盖率用的是「拿一条旧棋谱对着查」，那个测法是错的：
 * 旧棋谱里我们自己那几手不是库里的着法，所以从第一手起就不是我们会遇到的局面，
 * 测出来的脱谱手数毫无意义。
 *
 * 正确的问法是：**对手爱走什么走什么的时候，我们有多少手是 0ms 直出的。**
 * 所以这里真下棋：
 *   我们这边   查库，命中就走（0ms），不命中就交给 Rapfi
 *   对手那边   Rapfi 的前 K 个候选里**随机挑一个**
 *
 * 对手为什么要随机：真人不会永远走引擎的第一选择。如果对手也只走最优着法，
 * 那测出来的命中率会被高估得离谱 —— 因为库正是照着最优线造的。
 * 随机挑前 K 个才逼近「真人会偏离」的实际情况，K 越大越保守。
 *
 * 用法：
 *   node tools/book-hitrate.js --games 40 --size 12 --topk 8
 *   node tools/book-hitrate.js --games 40 --topk 3    # 对手比较「像引擎」的情形
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
const GAMES = arg('games', 40);
const SIZE  = arg('size', 12);
const TOPK  = arg('topk', 8);
const OPP_MS = arg('oppms', 400);      // 对手每手想多久（只需要「像样」，不需要很强）
const OUR_MS = arg('ourms', 1000);     // 我们脱谱之后每手想多久
const CONC  = arg('conc', 4);
const PLIES = arg('plies', 30);        // 只统计前多少手 —— 开局库本来就管不到残局

C.setSize(SIZE);

const BOOK_JSON = path.join(ROOT, 'data', SIZE === 15 ? 'book.json' : `book${SIZE}.json`);
const book = B.Book.load(fs.readFileSync(BOOK_JSON, 'utf8'));

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/** 下一局。ourColor 是我们执的颜色。返回这一局的统计。 */
async function playOne(ourEng, oppEng, ourColor, rnd) {
  const b = new C.Board();
  await ourEng.newGame(SIZE);
  await oppEng.newGame(SIZE);

  const moves = [];
  let ourMoves = 0, bookHits = 0, leftBookAt = -1, verdictHits = 0, statsHits = 0;

  for (let ply = 0; ply < PLIES; ply++) {
    const role = ply % 2 === 0 ? C.BLACK : C.WHITE;
    const xy = moves.map(p => [C.pToX(p), C.pToY(p)]);
    let p = -1;

    if (role === ourColor) {
      ourMoves++;
      const hit = book.lookup(b, role, 0);
      if (hit && b.cells[hit.move] === C.EMPTY) {
        p = hit.move;
        bookHits++;
        if (hit.kind === 'verdict') verdictHits++; else statsHits++;
      } else {
        if (leftBookAt < 0) leftBookAt = ply;          // 第一次脱谱的手数
        const r = await ourEng.think(xy, OUR_MS);
        p = C.xyToP(r.x, r.y);
      }
    } else {
      // 对手：前 TOPK 个候选里随机挑，模拟真人不总走第一选择
      const r = await oppEng.analyse(xy, OPP_MS, TOPK);
      const pool = r.cands.filter(c => c.xy);
      const pick = pool[Math.floor(rnd() * pool.length)] || pool[0];
      p = C.xyToP(pick.xy[0], pick.xy[1]);
    }

    if (p < 0 || b.cells[p] !== C.EMPTY) break;
    b.put(p, role);
    moves.push(p);
    if (b.lastMoveWins()) break;
  }

  return { ourMoves, bookHits, verdictHits, statsHits,
           leftBookAt: leftBookAt < 0 ? PLIES : leftBookAt, plies: moves.length };
}

async function main() {
  console.log(`${SIZE} 路 · ${GAMES} 局 · 只统计前 ${PLIES} 手 · ` +
              `对手在前 ${TOPK} 个候选里随机选`);
  console.log(`棋谱库：统计局面 ${book.size()} 个 · 引擎裁定 ${book.verdictCount()} 条\n`);

  const jobs = [];
  for (let i = 0; i < GAMES; i++)
    jobs.push({ i, ourColor: i % 2 === 0 ? C.BLACK : C.WHITE, seed: 1000 + i });

  const agg = { black: [], white: [] };
  let done = 0;

  async function worker() {
    const ours = new Rapfi({ threads: 1, pondering: false });
    const opp  = new Rapfi({ threads: 1, pondering: false, showDetail: true });
    await ours.start(); await opp.start();
    for (;;) {
      const job = jobs.shift();
      if (!job) break;
      const r = await playOne(ours, opp, job.ourColor, mulberry(job.seed));
      (job.ourColor === C.BLACK ? agg.black : agg.white).push(r);
      done++;
      process.stdout.write(`  ${String(done).padStart(3)}/${GAMES}  ` +
        `执${job.ourColor === C.BLACK ? '黑' : '白'}  ` +
        `我方 ${r.ourMoves} 手中 ${r.bookHits} 手查库直出  ` +
        `第 ${r.leftBookAt + 1} 手起脱谱\n`);
    }
    ours.stop(); opp.stop();
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  const show = (name, list) => {
    if (!list.length) return;
    const our = list.reduce((s, r) => s + r.ourMoves, 0);
    const hit = list.reduce((s, r) => s + r.bookHits, 0);
    const ver = list.reduce((s, r) => s + r.verdictHits, 0);
    const sta = list.reduce((s, r) => s + r.statsHits, 0);
    const left = list.map(r => r.leftBookAt + 1).sort((a, b) => a - b);
    const mid = left[left.length >> 1];
    console.log(`  ${name}  ${list.length} 局：我方共 ${our} 手，` +
      `${hit} 手查库直出（${(hit / our * 100).toFixed(0)}%，裁定 ${ver} / 统计 ${sta}）`);
    console.log(`        脱谱手数 中位数 ${mid}，最早 ${left[0]}，最晚 ${left[left.length - 1]}`);
  };
  console.log('\n================ 结论 ================');
  show('执黑', agg.black);
  show('执白', agg.white);
  const all = agg.black.concat(agg.white);
  const our = all.reduce((s, r) => s + r.ourMoves, 0);
  const hit = all.reduce((s, r) => s + r.bookHits, 0);
  console.log(`  合计：${(hit / our * 100).toFixed(1)}% 的着法是 0ms 直出的`);
}

main().catch(e => { console.error(e); process.exit(1); });
