/*
 * vs-js.js — Rapfi 内核 对 自研 JS 引擎，同样的时限、同样的开局库
 *
 * 有过一种感觉：「还不如我们的自研引擎」。这能测，不该靠感觉下结论，
 * 也不该靠「Rapfi 是世界冠军」这句话。
 *
 * 设置成**和 app 里完全一样**：
 *   - 两边同一个思考上限（默认 6000ms，就是界面 selThink 的默认值）
 *   - 两边查同一个开局库（差别只在搜索核，不在知识）
 *   - Rapfi 用界面默认的「均衡」用时风格（matchSpread 21）
 *   - JS 引擎用大师档，实例跨手复用（app 就是这么用的）
 *
 * 用法：node tools/vs-js.js --games 40 --size 12 --ms 6000 --conc 4
 */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../js/core.js');
const E = require('../js/engine.js');
const B = require('../js/book.js');
const { Rapfi } = require('./rapfi.js');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i < 0 ? d : (isNaN(+process.argv[i + 1]) ? process.argv[i + 1] : +process.argv[i + 1]);
};
const SIZE  = arg('size', 12);
const GAMES = arg('games', 40);
const MS    = arg('ms', 6000);
// Rapfi 单独的预算。默认跟 MS 一样（和 app 里一致）；给了 --rms 就用它，
// 这是为了做「同用时」对比 —— 自研引擎的自适应用时会主动提前收手，
// 6 秒上限下平均只用 1.7 秒，而 Rapfi 用满 5.1 秒。那样比出来的差距里
// 混着时间差，说明不了搜索核本身的强弱。
const RAPFI_MS = arg('rms', MS);
const CONC  = arg('conc', 4);
const SPREAD = arg('spread', 21);
const NOBOOK = process.argv.includes('--nobook');
const MAXPLY = SIZE * SIZE;

C.setSize(SIZE);
const BOOK_JSON = path.join(ROOT, 'data', SIZE === 15 ? 'book.json' : `book${SIZE}.json`);
const book = NOBOOK ? null : B.Book.load(fs.readFileSync(BOOK_JSON, 'utf8'));

function stats(win, loss, draw) {
  const n = win + loss + draw;
  if (!n) return { score: 0, se: 0 };
  const w = win / n, d = draw / n;
  const score = w + d / 2;
  return { score, se: Math.sqrt(Math.max(w + d / 4 - score * score, 0) / n) };
}

/** 随机开局（中心附近两手），成对使用 */
function openings(n, seed) {
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const c = (SIZE - 1) >> 1, out = [];
  for (let i = 0; i < n; i++) {
    const mv = [], used = new Set();
    for (let k = 0; k < 2; k++) {
      let x, y, t = 0;
      do { x = c + ((rnd() * 5) | 0) - 2; y = c + ((rnd() * 5) | 0) - 2; }
      while (used.has(y * SIZE + x) && ++t < 40);
      used.add(y * SIZE + x);
      mv.push(C.xyToP(x, y));
    }
    out.push(mv);
  }
  return out;
}

/** 返回 1 = Rapfi 赢, 0 = 和, -1 = JS 引擎赢 */
async function playGame(rapfi, js, opening, rapfiBlack) {
  const b = new C.Board();
  const moves = [];
  for (const p of opening) {
    if (b.cells[p] !== C.EMPTY) break;
    b.put(p, moves.length % 2 === 0 ? C.BLACK : C.WHITE);
    moves.push(p);
    if (b.lastMoveWins()) return { r: 0, rMs: 0, jMs: 0, rN: 0, jN: 0, rEMs: 0 };
  }
  await rapfi.newGame(SIZE);
  await rapfi.think([], 50); rapfi.restart();   // 预热权重（见 rapfi.js）
  js.reset();

  let rMs = 0, jMs = 0, rN = 0, jN = 0, rEMs = 0;
  while (moves.length < MAXPLY) {
    const role = moves.length % 2 === 0 ? C.BLACK : C.WHITE;
    const isRapfi = (role === C.BLACK) === rapfiBlack;
    let p = -1;

    // 两边都先查库：差别只应该在搜索核
    const hit = book && book.lookup(b, role, 0);
    if (hit && b.cells[hit.move] === C.EMPTY) {
      p = hit.move;
    } else if (isRapfi) {
      let r;
      try { r = await rapfi.think(moves.map(q => [C.pToX(q), C.pToY(q)]), RAPFI_MS); }
      catch (e) { return { r: -1, rMs, jMs, rN, jN, rEMs }; }
      p = C.xyToP(r.x, r.y); rMs += r.ms; rEMs += r.engineMs || 0; rN++;
    } else {
      const t0 = Date.now();
      const r = js.bestMove(b, role, { level: 'master', useBook: false, timeMax: MS });
      p = r.move; jMs += Date.now() - t0; jN++;
    }
    if (p < 0 || b.cells[p] !== C.EMPTY) return { r: isRapfi ? -1 : 1, rMs, jMs, rN, jN, rEMs };
    b.put(p, role);
    moves.push(p);
    if (b.lastMoveWins()) return { r: isRapfi ? 1 : -1, rMs, jMs, rN, jN, rEMs };
  }
  return { r: 0, rMs, jMs, rN, jN, rEMs };
}

async function main() {
  console.log(`${SIZE} 路 · 每手上限 Rapfi ${RAPFI_MS}ms / JS ${MS}ms · ${GAMES} 局 · 并发 ${CONC}`);
  console.log(`A = Rapfi 内核（用时风格 ${SPREAD}）   B = 自研 JS 引擎（大师档）`);
  console.log(`开局库：${book ? '两边都查（' + book.verdictCount() + ' 条裁定）' : '两边都不查'}\n`);

  const opens = openings(Math.ceil(GAMES / 2), 424242);
  const jobs = [];
  for (let i = 0; i < GAMES; i++) jobs.push({ opening: opens[i >> 1], rapfiBlack: i % 2 === 0 });

  let win = 0, loss = 0, draw = 0, done = 0, RMS = 0, JMS = 0, RN = 0, JN = 0, REMS = 0;

  async function worker() {
    const r = new Rapfi({ threads: Math.max(1, Math.floor(24 / CONC)), pondering: false, matchSpread: SPREAD });
    await r.start();
    const j = new E.Engine();
    if (book) j.setBook(book);
    for (;;) {
      const job = jobs.shift();
      if (!job) break;
      const g = await playGame(r, j, job.opening, job.rapfiBlack);
      if (g.r > 0) win++; else if (g.r < 0) loss++; else draw++;
      RMS += g.rMs; JMS += g.jMs; RN += g.rN; JN += g.jN; REMS += g.rEMs;
      done++;
      const { score, se } = stats(win, loss, draw);
      const elo = score <= 0 ? -800 : score >= 1 ? 800 : -400 * Math.log10(1 / score - 1);
      process.stdout.write(
        `  ${String(done).padStart(3)}/${GAMES}  ${win}-${loss}-${draw}  ` +
        `Rapfi 得分率 ${(score * 100).toFixed(1)}%  ±${(se * 196).toFixed(1)}%  Elo ${elo.toFixed(0)}  ` +
        `平均每手 Rapfi ${RN ? Math.round(RMS / RN) : 0}ms / JS ${JN ? Math.round(JMS / JN) : 0}ms\n`);
    }
    r.stop();
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  const { score, se } = stats(win, loss, draw);
  const lo = score - 1.96 * se, hi = score + 1.96 * se;
  const elo = score <= 0 ? -800 : score >= 1 ? 800 : -400 * Math.log10(1 / score - 1);
  console.log('\n================ 结论 ================');
  console.log(`Rapfi ${win} 胜 ${loss} 负 ${draw} 和`);
  console.log(`得分率 ${(score * 100).toFixed(1)}%  95% 区间 [${(lo * 100).toFixed(1)}%, ${(hi * 100).toFixed(1)}%]  Elo ${elo.toFixed(0)}`);
  console.log(`平均每手：Rapfi 墙钟 ${RN ? Math.round(RMS / RN) : 0}ms · 引擎自报 ${RN ? Math.round(REMS / RN) : 0}ms（${RN} 手） / JS ${JN ? Math.round(JMS / JN) : 0}ms（${JN} 手）`);
  if (lo > 0.5)      console.log('判定：Rapfi 内核确实更强 ✓');
  else if (hi < 0.5) console.log('判定：自研引擎更强 —— 那就该换回去 ✗');
  else               console.log('判定：分不出高下，局数还不够');
}

main().catch(e => { console.error(e); process.exit(1); });
