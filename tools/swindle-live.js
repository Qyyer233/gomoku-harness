/*
 * swindle-live.js — 拿真实的必输局面验证绝境搏命
 *
 * 两个必须回答的问题：
 *   1. 它到底会不会换手？换出来的是不是更难被走对？
 *   2. **会不会超时？** 这是硬红线 —— 实战 15 秒读秒，超一次就可能输一局。
 *
 * 用法: node tools/swindle-live.js [每手预算ms] [线程]
 */
const { Rapfi, labelToXY } = require('./rapfi.js');
const { swindle } = require('./swindle.js');
const C = require('../js/core.js');

const MS = parseInt(process.argv[2] || '6000', 10);
const THREADS = parseInt(process.argv[3] || '16', 10);

// 实战输掉那局，白方从第 6 手起一路被杀
const GAME = 'G7 H8 H6 F8 I6 G6 H5 J7 H4 H7 I8 I5 F4 F5 E4 G4 E3 G5'.split(' ');

(async () => {
  C.setSize(12);
  const lbl = (x, y) => C.pToLabel(C.xyToP(x, y));
  const eng = new Rapfi({ threads: THREADS });
  await eng.start();
  await eng.newGame(12);
  console.log('12 路 · 每手预算 ' + MS + 'ms · ' + THREADS + ' 线程\n');

  let swapped = 0, over = 0, worst = 0;
  for (let ply = 5; ply < GAME.length; ply += 2) {     // 白方回合
    const moves = GAME.slice(0, ply).map(labelToXY);
    const t0 = Date.now();
    const first = await eng.think(moves, MS);
    let line = '白第 ' + ((ply + 1) / 2) + ' 手：引擎给 ' + lbl(first.x, first.y).padEnd(4) +
      (first.mate ? '被杀 ' + (-first.mate) + ' 步' : '评分 ' + first.eval).padEnd(12) +
      '用了 ' + String(first.ms).padStart(5) + 'ms';

    if (first.mate < 0) {
      const sw = await swindle(eng, moves, first, { deadline: t0 + MS, width: 5 });
      if (!sw) line += '   搏命：时间不够，没试';
      else if (sw.x === first.x && sw.y === first.y)
        line += '   搏命：试了 ' + sw.tried + ' 手，原手最顽强';
      else {
        swapped++;
        line += '   **换成 ' + lbl(sw.x, sw.y) + '** · ' + sw.picked.reason + '（试了 ' + sw.tried + ' 手）';
      }
    }
    const total = Date.now() - t0;
    worst = Math.max(worst, total);
    if (total > MS) { over++; line += '   ⚠ 超时 ' + (total - MS) + 'ms'; }
    console.log(line + '   [总 ' + total + 'ms]');
  }
  eng.stop();
  console.log('\n换手 ' + swapped + ' 次 · 超时 ' + over + ' 次 · 最长一手 ' + worst + 'ms（上限 ' + MS + 'ms）');
  process.exit(over ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
