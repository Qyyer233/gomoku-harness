/*
 * prep-legal.js — 预备缓存里会不会出现「已经有子」的着法？
 *
 * 实战抓到两次，两次都是「超前思考命中」，而且都让 AI 整手消失：
 *
 *   logs 03-11-08 第 17 手   AI 说 F3   棋盘上是 G3
 *   logs 03-17-43 第 24 手   AI 说 C10  棋盘上是 B10    ← 这局输了
 *
 * 界面拿到非法着法会静默放弃（已修），但根子在「缓存里为什么会有非法着法」。
 * 这里把预备反复跑起来，**每一条结果都验一遍合法性**，把它抓出来。
 *
 * 用法：node tools/prep-legal.js --turns 40 --prepn 2 --prept 8
 */
'use strict';
const C = require('../js/core.js');
const { Rapfi } = require('./rapfi.js');
const { Prepare, key } = require('./prepare.js');

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i < 0 ? d : (isNaN(+process.argv[i + 1]) ? process.argv[i + 1] : +process.argv[i + 1]);
};
const SIZE = arg('size', 12);
const TURNS = arg('turns', 40);
const PREPN = arg('prepn', 2);
const PREPT = arg('prept', 8);
const PREP_MS = arg('prepms', 2000);
const WINDOW = arg('window', 6000);

C.setSize(SIZE);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lbl = xy => C.pToLabel(C.xyToP(xy[0], xy[1]));

(async () => {
  console.log(`${SIZE} 路 · ${PREPN} 个预备引擎各 ${PREPT} 线程 · 每条 ${PREP_MS}ms · 窗口 ${WINDOW}ms`);
  console.log(`跑 ${TURNS} 个回合，每条预备结果都验合法性\n`);

  const main = new Rapfi({ threads: 8, pondering: false, matchSpread: 21 });
  const preps = [];
  for (let i = 0; i < PREPN; i++) preps.push(new Rapfi({ threads: PREPT, pondering: false, matchSpread: 0 }));
  await main.start(); await main.newGame(SIZE);
  for (const p of preps) { await p.start(); await p.newGame(SIZE); }
  await main.think([], 50); main.restart();
  for (const p of preps) { await p.think([], 50); p.restart(); }

  const prep = new Prepare(preps, { width: 3, perMoveMs: PREP_MS });

  let bad = 0, checked = 0, games = 0;
  let moves = [[5, 5], [6, 6]];
  const used = new Set(moves.map(m => m[0] + ',' + m[1]));

  for (let t = 0; t < TURNS; t++) {
    // 我方出手
    const r = await main.think(moves, 3000);
    const mk = r.x + ',' + r.y;
    if (used.has(mk)) { console.log(`  ✗ 主引擎自己给了已有子的点 ${lbl([r.x, r.y])}`); break; }
    moves.push([r.x, r.y]); used.add(mk);

    // 发起预备，等一个窗口
    prep.start(moves.map(m => m.slice()));
    await sleep(WINDOW);

    // **把这一轮备出来的每一条都验一遍**
    for (const [k, v] of prep.cache) {
      const line = k.split(' ').filter(Boolean).map(s => s.split(',').map(Number));
      if (line.length !== moves.length + 1) continue;      // 只验这一轮的
      const occupied = line.some(m => m[0] === v.x && m[1] === v.y);
      checked++;
      if (occupied) {
        bad++;
        console.log(`  ✗✗ 第 ${t + 1} 回合：缓存里 ${line.map(lbl).join(' ')} -> ${lbl([v.x, v.y])}，` +
                    `而这个点在该局面里已经有子了！（${v.depth} 层，${v.ms}ms，${v.prepared ? '预备' : '?'}）`);
      }
    }

    // 对手随便走一手（可能命中预备，也可能不命中）
    prep.stop();
    const opp = await main.think(moves, 800);
    const ok2 = opp.x + ',' + opp.y;
    if (used.has(ok2)) break;
    moves.push([opp.x, opp.y]); used.add(ok2);

    if (moves.length > 30) {                                 // 开新的一局
      games++;
      await main.newGame(SIZE); for (const p of preps) await p.newGame(SIZE);
      prep.clear();
      moves = [[5, 5], [6, 6]]; used.clear();
      used.add('5,5'); used.add('6,6');
    }
    if ((t + 1) % 10 === 0) console.log(`  跑了 ${t + 1} 回合，验了 ${checked} 条，异常 ${bad} 条`);
  }

  await prep.cancel();
  main.stop(); for (const p of preps) p.stop();
  console.log(`\n共验 ${checked} 条预备结果，${bad} 条是非法着法` +
              (bad ? '   ✗ 复现了' : '   ✓ 没复现'));
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
