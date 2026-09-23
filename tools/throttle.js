/*
 * throttle.js — 检测这台机器降不降频
 *
 * 为什么要有它：本项目曾经把「吞吐随深度下降」当成引擎性能 bug 追了半天，
 * 挨个排除了 GC（mu=0.998）、V8 反优化（全程 TurboFan）、置换表膨胀（清表反而更慢），
 * 最后发现是笔记本在热/功耗限制下降频 —— 这个纯 JS 忙循环（零行五子棋代码）
 * 持续满载 8 秒后，吞吐就掉到初始的 30% 左右并一直维持。
 *
 * 换机器、或者对某个耗时数据起疑时，先跑这个。
 * 若吞吐明显下滑，那么所有「按时间」的测量（耗时、nodes/s、--atime 限时对局）
 * 都不可信，只能相信**节点数 / 固定深度 / 行为指纹**这类确定性指标。
 *
 * 用法: node throttle.js [秒数]
 */
const SECONDS = parseInt(process.argv[2] || '30', 10);

// xorshift32：纯整数运算，不分配内存，所以不会把 GC 混进来
let x = 1 >>> 0;
function work(n) {
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
  }
  return x;
}
work(1e6);                 // 预热，让 V8 先把它编译成优化代码

const CHUNK = 1e6;
const rates = [];
console.log(`纯 JS 忙循环 ${SECONDS} 秒（不涉及五子棋代码）`);
console.log('秒    迭代/毫秒     相对第 1 秒');
for (let s = 0; s < SECONDS; s++) {
  const t0 = process.hrtime.bigint();
  let iters = 0;
  while (Number(process.hrtime.bigint() - t0) / 1e6 < 1000) { work(CHUNK); iters += CHUNK; }
  const rate = iters / (Number(process.hrtime.bigint() - t0) / 1e6);
  rates.push(rate);
  console.log(`${String(s + 1).padStart(3)}  ${rate.toFixed(0).padStart(11)}  ${(rate / rates[0] * 100).toFixed(0).padStart(11)}%`);
}

const last = rates.slice(-5).reduce((a, b) => a + b, 0) / 5;
const drop = last / rates[0];
console.log('');
if (drop < 0.8) {
  console.log(`★ 这台机器会降频：稳定后只有初始的 ${(drop * 100).toFixed(0)}%（${(1 / drop).toFixed(1)} 倍差距）。`);
  console.log('  所有按时间的测量都不可信。要量时间就：干净进程起、单次爆发 3 秒内、重复取最小值。');
} else {
  console.log(`频率稳定（稳定后为初始的 ${(drop * 100).toFixed(0)}%），耗时类测量可用。`);
}
