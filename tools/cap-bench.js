/*
 * cap-bench.js — 两个「比赛限制、我们不受限」的旋钮到底值多少
 *
 *   A. **内存上限**。rapfi.js 默认给 MAX_MEMORY = 1GB，那是比赛规格；
 *      本机有 31.6GB。置换表的大小受这个值限制，24 线程每秒几百万节点，
 *      1GB 的表几秒就填满并开始互相覆盖 —— 实测置换表跨手只省 19%，
 *      而且在难局面上完全没帮上忙，很可能就是被这个憋的。
 *
 *   B. **线程数**。24 线程比 12 线程强多少？
 *      如果差别很小，那把一半算力挪去做「预备」（预测对手应手）更划算 ——
 *      预备现在是一条一条串行算的，并行起来能备完更多条，命中率能往上顶。
 *
 * 判据用固定时间下的**搜索层数**，不用胜率：层数是直接读数，不需要几百局。
 * 交替重复测，因为这台机器会降频。
 *
 * 用法：node tools/cap-bench.js --rounds 3
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
const ROUNDS = arg('rounds', 3);

C.setSize(SIZE);

// 几个中局局面，都没有速杀（有速杀的局面引擎证完就停，测不出算力差别）
const LINES = [
  'G6 G7 F7 F8 H6',
  'F5 F6 E7 E6 G6 H7',
  'F6 G7 E8 E6 F8 D8',
  'G6 F7 F5 G8 E6 H7 F6'
];
const toXY = s => s.split(' ').map(L => { const p = C.labelToP(L); return [C.pToX(p), C.pToY(p)]; });

async function run(threads, memMB) {
  const r = new Rapfi({
    threads, pondering: false, matchSpread: 0,      // 关掉自适应，让它把时间用满
    maxMemory: memMB * 1024 * 1024
  });
  await r.start(); await r.newGame(SIZE);
  await r.think([], 50); r.restart();
  let depth = 0, nodes = 0, ms = 0, n = 0;
  for (const line of LINES) {
    await r.newGame(SIZE);                          // 每个局面都从干净的表开始，只比算力
    const d = await r.think(toXY(line), MS);
    depth += d.depth; nodes += d.nodes; ms += d.ms; n++;
  }
  r.stop();
  await new Promise(s => setTimeout(s, 800));
  return { depth: +(depth / n).toFixed(1), nodes: Math.round(nodes / n), ms: Math.round(ms / n) };
}

const fmt = x => `${String(x.depth).padStart(5)} 层   ${String((x.nodes / 1e6).toFixed(1) + 'M').padStart(7)} 节点   ${String(x.ms + 'ms').padStart(7)}`;

(async () => {
  console.log(`${SIZE} 路 · 每手 ${MS}ms · ${LINES.length} 个中局局面 · 交替 ${ROUNDS} 轮\n`);

  console.log('A. 内存上限（都用 24 线程）');
  const a1 = [], a2 = [];
  for (let i = 0; i < ROUNDS; i++) {
    if (i % 2 === 0) { a1.push(await run(24, 1024)); a2.push(await run(24, 8192)); }
    else { a2.push(await run(24, 8192)); a1.push(await run(24, 1024)); }
    console.log(`   第 ${i + 1} 轮   1GB ${fmt(a1[a1.length - 1])}      8GB ${fmt(a2[a2.length - 1])}`);
  }
  const avg = arr => ({
    depth: +(arr.reduce((s, x) => s + x.depth, 0) / arr.length).toFixed(1),
    nodes: Math.round(arr.reduce((s, x) => s + x.nodes, 0) / arr.length),
    ms: Math.round(arr.reduce((s, x) => s + x.ms, 0) / arr.length)
  });
  console.log(`   1GB（现状）  ${fmt(avg(a1))}`);
  console.log(`   8GB          ${fmt(avg(a2))}`);
  console.log(`   -> 层数 ${(avg(a2).depth - avg(a1).depth >= 0 ? '+' : '')}${(avg(a2).depth - avg(a1).depth).toFixed(1)}\n`);

  console.log('B. 线程数（都给 8GB）');
  const b1 = [], b2 = [];
  for (let i = 0; i < ROUNDS; i++) {
    if (i % 2 === 0) { b1.push(await run(12, 8192)); b2.push(await run(24, 8192)); }
    else { b2.push(await run(24, 8192)); b1.push(await run(12, 8192)); }
    console.log(`   第 ${i + 1} 轮   12线程 ${fmt(b1[b1.length - 1])}      24线程 ${fmt(b2[b2.length - 1])}`);
  }
  console.log(`   12 线程   ${fmt(avg(b1))}`);
  console.log(`   24 线程   ${fmt(avg(b2))}`);
  const d = avg(b2).depth - avg(b1).depth;
  console.log(`   -> 层数 ${(d >= 0 ? '+' : '')}${d.toFixed(1)}   ` +
    (Math.abs(d) < 0.6 ? '（差别很小 -> 把一半算力挪去做预备更划算）' : '（24 线程明显更强 -> 别拆）'));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
