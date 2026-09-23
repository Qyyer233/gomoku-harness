/*
 * prep-bench.js — 预测式超前思考值不值？
 *
 * 判据：
 *   1. **命中率** —— 对手真走的那一手，在不在我们预备好的几条里；
 *   2. **净收益** —— 同样的开局，开预备和不开预备，平均每手各花多久。
 *
 * 两条规矩，都是踩过坑才定下来的：
 *
 *   - **基线必须跑同一批开局、同一套流程**，只把宽度设成 0。
 *     第一版拿另一批局面、另一段循环当基线，比出来的 66% 是假的。
 *
 *   - **诊断要在对手落子之后再读**。`start()` 是发起就返回的，
 *     刚排上队时候选还没算出来；在那一刻读 lastCands 只会读到空，
 *     于是报出「预测命中 0%」却同时有 25% 缓存命中这种自相矛盾的结果。
 *
 * 对手由另一个独立的 Rapfi 进程扮演，它不知道我们预备了什么。
 * 人类高手的着法分布比引擎发散，所以这个命中率应当看作上限。
 *
 * 用法：node tools/prep-bench.js --games 6 --width 3 --prepms 3000 --oppms 12000
 */
'use strict';
const C = require('../js/core.js');
const { Rapfi } = require('./rapfi.js');
const { Prepare } = require('./prepare.js');

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i < 0 ? d : (isNaN(+process.argv[i + 1]) ? process.argv[i + 1] : +process.argv[i + 1]);
};
const GAMES = arg('games', 6);
const SIZE = arg('size', 12);
const WIDTH = arg('width', 3);
const CAP = arg('ms', 6000);
const PREP_MS = arg('prepms', 3000);
// 预测这一步（multiPV）给多少时间。默认和实战（prepare.js）一致。
// ⚠ 2026-09-23 之前 prepare.js 把 analyse 的参数传反了，这个值实际进的是 multiPV、
// 预测永远只有 50ms —— 所以更早记下的命中率（57% / 79% / 70.8%）都是在那个 bug 下量的。
const ANALYSE_MS = arg('anams', 300);
const OPP_MS = arg('oppms', 12000);   // 对手思考多久 = 我们预备的窗口
const MAXPLY = arg('maxply', 26);
// 预备引擎的个数和线程数。并行是这套东西能不能成立的关键：
// 串行时 12 秒窗口只备完 2.4 条，命中率卡在 70.8%。
const PREP_N = arg('prepn', 2);
const PREP_T = arg('prept', 8);
const MAIN_T = arg('maint', 8);

C.setSize(SIZE);

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
      used.add(y * SIZE + x); mv.push([x, y]);
    }
    out.push(mv);
  }
  return out;
}

/** 跑一批棋。width = 0 就是「完全不预备」的基线。 */
async function play(me, opp, preps, opens, width, label) {
  const R = { hit: 0, miss: 0, ms: 0, n: 0, rank: new Array(10).fill(0), done: 0, turns: 0 };
  for (let g = 0; g < opens.length; g++) {
    await me.newGame(SIZE); await opp.newGame(SIZE);
    for (const p of preps) await p.newGame(SIZE);
    await me.think([], 50); me.restart();
    await opp.think([], 50); opp.restart();
    const prep = new Prepare(preps.length ? preps : me, { width, perMoveMs: PREP_MS, analyseMs: ANALYSE_MS });
    const moves = opens[g].map(m => m.slice());
    const used = new Set(moves.map(m => m[0] + ',' + m[1]));

    for (let ply = moves.length; ply < MAXPLY; ply++) {
      if (ply % 2 === 0) {                       // 我方
        const t0 = Date.now();
        const ready = width > 0 ? prep.get(moves) : null;
        let mv;
        if (ready) {
          R.hit++;
          prep.stop();
          mv = [ready.x, ready.y];
        } else {
          R.miss++;
          if (width > 0) prep.stop();
          const r = await me.think(moves, CAP);
          mv = [r.x, r.y];
        }
        R.ms += Date.now() - t0; R.n++;
        moves.push(mv);
        if (width > 0) prep.start(moves.map(m => m.slice()));
      } else {                                   // 对手
        // **对手的思考窗口必须是真的。** 直接 opp.think(12000) 是不行的：
        // 它开着自适应用时，几百毫秒就收手了 —— 窗口根本没有 12 秒，
        // 实测每轮只备完 0.9 条，于是把「预备来不及」误读成「预备没用」。
        //
        // 真实对局里对手是人，那十几二十秒是实打实的，
        // 而且这段时间本机 CPU 全是空的。所以让它快速出手，再补足等待时间。
        const tOpp = Date.now();
        const r = await opp.think(moves, Math.min(2000, OPP_MS));
        const left = OPP_MS - (Date.now() - tOpp);
        if (left > 0) await new Promise(res => setTimeout(res, left));
        // **读诊断要在这之后**：对手想了 OPP_MS，预备也就跑了这么久
        if (width > 0) {
          const cands = prep.lastCands;
          const i = cands.findIndex(c => c[0] === r.x && c[1] === r.y);
          R.rank[i < 0 ? 0 : Math.min(9, i + 1)]++;
          R.done += prep.doneThisTurn; R.turns++;
        }
        moves.push([r.x, r.y]);
      }
      const last = moves[moves.length - 1], k = last[0] + ',' + last[1];
      if (used.has(k)) break;                    // 出了重子就中止
      used.add(k);
    }
    await prep.cancel();
    process.stdout.write(`  ${label} 第 ${g + 1}/${opens.length} 局` +
      (width > 0 ? `   累计命中 ${R.hit}/${R.hit + R.miss}` : '') +
      `   平均 ${Math.round(R.ms / R.n)}ms/手\n`);
  }
  return R;
}

(async () => {
  console.log(`主引擎 ${MAIN_T} 线程 · 预备 ${PREP_N} 个引擎各 ${PREP_T} 线程`);
  console.log(`${SIZE} 路 · 宽度 ${WIDTH} × 每条 ${PREP_MS}ms · 预测 ${ANALYSE_MS}ms · ` +
              `本方上限 ${CAP}ms · 对手思考 ${OPP_MS}ms · ${GAMES} 局`);
  console.log('基线跑同一批开局、同一套流程，只把宽度设成 0\n');

  const me = new Rapfi({ threads: MAIN_T, pondering: false, matchSpread: 21 });
  const preps = [];
  for (let i = 0; i < PREP_N; i++) preps.push(new Rapfi({ threads: PREP_T, pondering: false, matchSpread: 0 }));
  const opp = new Rapfi({ threads: 12, pondering: false, matchSpread: 21 });
  await me.start(); await opp.start();
  for (const p of preps) { await p.start(); await p.newGame(SIZE); }
  const opens = openings(GAMES, 20260920);

  const on = await play(me, opp, preps, opens, WIDTH, '开预备');
  console.log('');
  const off = await play(me, opp, preps, opens, 0, '不预备');
  me.stop(); opp.stop(); for (const p of preps) p.stop();

  const n = on.hit + on.miss;
  console.log('\n================ 诊断 ================');
  console.log(`  每轮平均备完 ${(on.done / (on.turns || 1)).toFixed(1)} 条（宽度设的是 ${WIDTH}）`);
  console.log('  对手真走的那一手，排在我们预测的第几位：');
  const tot = on.rank.reduce((a, b) => a + b, 0) || 1;
  console.log(`    压根没预测到   ${String(on.rank[0]).padStart(3)}   ${(on.rank[0] / tot * 100).toFixed(0)}%`);
  for (let i = 1; i < 10; i++) {
    if (!on.rank[i]) continue;
    console.log(`    第 ${i} 位         ${String(on.rank[i]).padStart(3)}   ${(on.rank[i] / tot * 100).toFixed(0)}%` +
                (i > WIDTH ? '   ← 预测到了但宽度不够' : ''));
  }
  const inList = tot - on.rank[0];
  console.log(`  预测命中（不论来不来得及备）：${inList}/${tot} = ${(inList / tot * 100).toFixed(0)}%`);

  const aOn = Math.round(on.ms / on.n), aOff = Math.round(off.ms / off.n);
  console.log('\n================ 结论 ================');
  console.log(`缓存命中率 ${(on.hit / n * 100).toFixed(1)}%   （命中 ${on.hit} / 未命中 ${on.miss}）`);
  console.log(`开预备   平均 ${aOn}ms/手（${on.n} 手）`);
  console.log(`不预备   平均 ${aOff}ms/手（${off.n} 手）`);
  const gain = aOff - aOn;
  console.log(`\n每手省 ${gain}ms（${(gain / aOff * 100).toFixed(0)}%）  ` + (gain > 0 ? '✓ 值' : '✗ 不值'));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
