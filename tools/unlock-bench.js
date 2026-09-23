/*
 * unlock-bench.js — 「我们这台设备上的 Rapfi」对「比赛规格的 Rapfi」强多少？
 *
 * 比赛规格（查自 https://gomocup.org/detail-information/）：
 *   - CPU 亲和性钉死在 **1 个核**上，多线程开了也没用；
 *   - 内存上限每届公布，**下限 70MB**；
 *   - 比赛期间该 AI 的所有文件不得超过 **20MB**（所以它带不了大棋谱库）；
 *   - 时间不严于 30 秒/手、3 分钟/局 —— 这一项我们**没有优势**，
 *     6 秒/手 × 三十手也是 3 分钟，持平。
 *
 * 所以「解封」的真正来源只有两项：核数和内存。这里把它量成 Elo。
 * 棋谱库那一项不在这个对比里 —— 两边都不查库，只比引擎本身。
 *
 * 用法：node tools/unlock-bench.js --games 30 --ms 6000
 */
'use strict';
const C = require('../js/core.js');
const { Rapfi } = require('./rapfi.js');

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i < 0 ? d : (isNaN(+process.argv[i + 1]) ? process.argv[i + 1] : +process.argv[i + 1]);
};
const SIZE = arg('size', 12);
const GAMES = arg('games', 30);
const MS = arg('ms', 6000);
const THREADS = arg('threads', 24);
const MEM = arg('mem', 1024);          // 我们这边给多少 MB
const TMEM = arg('tmem', 70);          // 比赛规格给多少 MB
// 用时风格。21 = 界面的「均衡」档（着法稳定就收手），0 = 每手烧满预算。
// **量算力差距时必须设 0**：开着自适应的话，强的一方只是「更早想明白」，
// 然后和弱的一方想出同一手、双双收手 —— 实测 24 核对 1 核打成 15:15，
// 而两边平均只用了 331ms / 683ms，6 秒的预算根本没动。
const PACE = arg('pace', 21);
const MAXPLY = SIZE * SIZE;

C.setSize(SIZE);

function stats(win, loss, draw) {
  const n = win + loss + draw;
  if (!n) return { score: 0, se: 0 };
  const w = win / n, d = draw / n, score = w + d / 2;
  return { score, se: Math.sqrt(Math.max(w + d / 4 - score * score, 0) / n) };
}
const elo = s => s <= 0 ? -800 : s >= 1 ? 800 : -400 * Math.log10(1 / s - 1);

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
      used.add(y * SIZE + x); mv.push(C.xyToP(x, y));
    }
    out.push(mv);
  }
  return out;
}

(async () => {
  console.log(`${SIZE} 路 · 每手上限 ${MS}ms · ${GAMES} 局 · 两边都不查棋谱库`);
  console.log(`用时风格 ${PACE}` + (PACE === 0 ? "（关掉自适应，两边都烧满预算）" : "（均衡档，着法稳定就收手）"));
  console.log(`A = 我们这台设备：${THREADS} 线程 / ${MEM}MB`);
  console.log(`B = 比赛规格：    1 线程 / ${TMEM}MB\n`);

  const A = new Rapfi({ threads: THREADS, pondering: false, matchSpread: PACE, maxMemory: MEM * 1048576 });
  const B = new Rapfi({ threads: 1, pondering: false, matchSpread: PACE, maxMemory: TMEM * 1048576 });
  await A.start(); await B.start();

  let win = 0, loss = 0, draw = 0, aMs = 0, aN = 0, bMs = 0, bN = 0;
  const opens = openings(Math.ceil(GAMES / 2), 20260921);

  for (let g = 0; g < GAMES; g++) {
    await A.newGame(SIZE); await B.newGame(SIZE);
    await A.think([], 50); A.restart();
    await B.think([], 50); B.restart();
    const b = new C.Board(), moves = [];
    for (const p of opens[g >> 1]) {
      if (b.cells[p] !== C.EMPTY) continue;
      b.put(p, moves.length % 2 === 0 ? C.BLACK : C.WHITE); moves.push(p);
    }
    const aBlack = g % 2 === 0;
    let res = 0;
    while (moves.length < MAXPLY) {
      const role = moves.length % 2 === 0 ? C.BLACK : C.WHITE;
      const isA = (role === C.BLACK) === aBlack;
      const eng = isA ? A : B;
      let r;
      try { r = await eng.think(moves.map(q => [C.pToX(q), C.pToY(q)]), MS); }
      catch (e) { res = isA ? -1 : 1; break; }
      if (isA) { aMs += r.ms; aN++; } else { bMs += r.ms; bN++; }
      const p = C.xyToP(r.x, r.y);
      if (p < 0 || b.cells[p] !== C.EMPTY) { res = isA ? -1 : 1; break; }
      b.put(p, role); moves.push(p);
      if (b.lastMoveWins()) { res = isA ? 1 : -1; break; }
    }
    if (res > 0) win++; else if (res < 0) loss++; else draw++;
    const { score, se } = stats(win, loss, draw);
    console.log(`  ${String(g + 1).padStart(3)}/${GAMES}  ${win}-${loss}-${draw}  ` +
      `解封版得分率 ${(score * 100).toFixed(1)}%  ±${(se * 196).toFixed(1)}%  Elo ${elo(score).toFixed(0)}  ` +
      `每手 A ${aN ? Math.round(aMs / aN) : 0}ms / B ${bN ? Math.round(bMs / bN) : 0}ms`);
  }
  A.stop(); B.stop();

  const { score, se } = stats(win, loss, draw);
  const lo = score - 1.96 * se, hi = score + 1.96 * se;
  console.log('\n================ 结论 ================');
  console.log(`解封版 ${win} 胜 ${loss} 负 ${draw} 和`);
  console.log(`得分率 ${(score * 100).toFixed(1)}%  95% 区间 [${(lo * 100).toFixed(1)}%, ${(hi * 100).toFixed(1)}%]  Elo ${elo(score).toFixed(0)}`);
  if (lo > 0.5) console.log('判定：解封确实更强 ✓');
  else if (hi < 0.5) console.log('判定：比赛规格反而更强 ✗（那说明多核有害，得查）');
  else console.log('判定：分不出高下 —— 解封带来的优势没有想象中大');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
