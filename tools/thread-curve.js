/*
 * thread-curve.js — 线程收益的拐点在哪？
 *
 * 为什么要这个数：24 核在这台机器上明显溢出（24 线程和 12 线程深度完全一样，
 * 24 线程对 1 线程在均衡档下 30 局打平）。既然正式思考吃不下这么多算力，
 * 就该把富余的核拿去做「预备」——预测对手应手、把我们的答复提前算好。
 *
 * 但预备本身也是搜索，**也有同样的边际衰减**。所以问题变成：
 * 一个搜索进程给几个线程最划算？知道拐点才知道该切成几个进程。
 *
 * 判据用固定时间下的**搜索层数**，不用胜率：层数是直接读数，
 * 不需要几百局就能看出差别。关掉自适应用时（matchSpread 0），
 * 否则强的一方只是「更早收手」，差别全被吃掉。
 * 交替重复测，因为这台机器会降频。
 *
 * 用法：node tools/thread-curve.js --rounds 2 --ms 6000
 */
'use strict';
const C = require('../js/core.js');
const { Rapfi } = require('./rapfi.js');

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i < 0 ? d : (isNaN(+process.argv[i + 1]) ? process.argv[i + 1] : +process.argv[i + 1]);
};
const SIZE = arg('size', 12);
const MS = arg('ms', 6000);
const ROUNDS = arg('rounds', 2);
const LIST = String(arg('threads', '1,2,4,8,12,24')).split(',').map(Number);

C.setSize(SIZE);

// 中局、无速杀。有速杀的局面引擎证完就停，测不出算力差别。
const LINES = [
  'G6 G7 F7 F8 H6',
  'F5 F6 E7 E6 G6 H7',
  'F6 G7 E8 E6 F8 D8',
  'G6 F7 F5 G8 E6 H7 F6'
];
const toXY = s => s.split(' ').map(L => { const p = C.labelToP(L); return [C.pToX(p), C.pToY(p)]; });

async function run(threads) {
  const r = new Rapfi({ threads, pondering: false, matchSpread: 0, maxMemory: 1024 * 1048576 });
  await r.start(); await r.newGame(SIZE);
  await r.think([], 50); r.restart();
  let depth = 0, nodes = 0, n = 0;
  for (const line of LINES) {
    await r.newGame(SIZE);                 // 每个局面都从干净的置换表开始，只比算力
    const d = await r.think(toXY(line), MS);
    depth += d.depth; nodes += d.nodes; n++;
  }
  r.stop();
  await new Promise(s => setTimeout(s, 700));
  return { depth: depth / n, nodes: nodes / n };
}

(async () => {
  console.log(`${SIZE} 路 · 每手 ${MS}ms（烧满，不自适应）· ${LINES.length} 个中局局面 · 交替 ${ROUNDS} 轮\n`);
  const acc = new Map(LIST.map(t => [t, []]));
  for (let i = 0; i < ROUNDS; i++) {
    // 每轮把顺序倒过来，抵消降频漂移
    const order = i % 2 === 0 ? LIST : [...LIST].reverse();
    for (const t of order) acc.get(t).push(await run(t));
    console.log(`  第 ${i + 1} 轮跑完`);
  }

  console.log('\n线程   平均层数   平均节点   相对 1 线程');
  const avg = t => {
    const a = acc.get(t);
    return {
      depth: a.reduce((s, x) => s + x.depth, 0) / a.length,
      nodes: a.reduce((s, x) => s + x.nodes, 0) / a.length
    };
  };
  const base = avg(LIST[0]);
  for (const t of LIST) {
    const v = avg(t);
    const bar = '#'.repeat(Math.max(0, Math.round((v.depth - base.depth) * 4)));
    console.log(`${String(t).padStart(4)}   ${v.depth.toFixed(1).padStart(8)}   ` +
      `${(v.nodes / 1e6).toFixed(1).padStart(7)}M   ` +
      `${(v.depth - base.depth >= 0 ? '+' : '')}${(v.depth - base.depth).toFixed(1)} 层  ${bar}`);
  }
  // 拐点：再翻倍线程换来的层数已经不到 0.5 层
  let knee = LIST[0];
  for (let i = 1; i < LIST.length; i++) {
    if (avg(LIST[i]).depth - avg(LIST[i - 1]).depth >= 0.5) knee = LIST[i];
  }
  console.log(`\n拐点 ≈ ${knee} 线程（再往上每翻倍换来的层数不足 0.5）`);
  console.log(`-> 24 核可以切成 ${Math.max(1, Math.floor(24 / knee))} 个 ${knee} 线程的进程：` +
              `1 个跑正式出手，其余全部拿去并行预备`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
