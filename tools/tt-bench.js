/*
 * tt-bench.js — 两个只能靠实测回答的问题
 *
 *   A. **置换表跨手复用，到底省了多少？**
 *      我们是「一局棋一个常驻进程」，而 BOARD 命令不清置换表 ——
 *      所以前面几手算过的东西，后面还能用。这一条一直被当成理所当然，
 *      但从没量过。对照组：每一手都 START 一次（START 会清表），其余完全相同。
 *
 *   B. **Rapfi 自己会不会在我们没发命令时后台思考？**
 *      协议里有 INFO PONDERING 1，我们也发了。但发了不等于它真在算 ——
 *      直接采 CPU：出手之后什么都不做，看它还烧不烧。
 *
 * 用法：node tools/tt-bench.js --plies 16
 */
'use strict';
const { execFileSync } = require('child_process');
const C = require('../js/core.js');
const { Rapfi } = require('./rapfi.js');

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i < 0 ? d : (isNaN(+process.argv[i + 1]) ? process.argv[i + 1] : +process.argv[i + 1]);
};
const SIZE = arg('size', 12);
const PLIES = arg('plies', 16);
const CAP = arg('ms', 6000);
const ROUNDS = arg('rounds', 2);

C.setSize(SIZE);

const cpuOf = pid => {
  try {
    return parseFloat(execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-Process -Id ${pid}).CPU`], { encoding: 'utf8' }).trim()) || 0;
  } catch (e) { return 0; }
};

// 一条真实对局线路（取自实战日志），双方都由同一个引擎推进
const LINE = 'G6 G7 F7 F8 H5 E8 H6 F6 H4 H7 F4 H8 I4 J3 E5 D4 K2 J5 I6 H3'
  .split(' ').map(L => { const p = C.labelToP(L); return [C.pToX(p), C.pToY(p)]; });

/** freshEveryMove = true 时每手都 START（清空置换表） */
async function run(freshEveryMove) {
  const r = new Rapfi({ threads: 24, pondering: true, matchSpread: 21 });
  await r.start();
  await r.newGame(SIZE);
  await r.think([], 50); r.restart();
  const out = [];
  for (let n = 4; n <= Math.min(PLIES, LINE.length - 1); n += 2) {
    if (freshEveryMove) { await r.newGame(SIZE); }
    const t0 = Date.now();
    const d = await r.think(LINE.slice(0, n), CAP);
    out.push({ ply: n + 1, ms: Date.now() - t0, depth: d.depth, nodes: d.nodes });
  }
  r.stop();
  await new Promise(s => setTimeout(s, 600));
  return out;
}

async function ponderCheck() {
  const r = new Rapfi({ threads: 24, pondering: true, matchSpread: 21 });
  await r.start(); await r.newGame(SIZE);
  await r.think([], 50); r.restart();
  const pid = r.proc.pid;
  // 正常走一手，然后什么都不做，看它自己烧不烧 CPU
  await r.think(LINE.slice(0, 6), CAP);
  const trace = []; let prev = cpuOf(pid);
  for (let i = 0; i < 6; i++) {
    await new Promise(s => setTimeout(s, 1000));
    const now = cpuOf(pid); trace.push(Math.round((now - prev) * 10) / 10); prev = now;
  }
  r.stop();
  await new Promise(s => setTimeout(s, 600));
  return trace;
}

(async () => {
  console.log('B. Rapfi 自己会不会后台思考？（出手后什么都不发，逐秒采 CPU）');
  const t = await ponderCheck();
  console.log('   ' + t.map((v, i) => `第${i + 1}秒 ${v}`).join('  ') + '  核秒');
  console.log('   ' + (t.reduce((a, b) => a + b, 0) > 2
    ? '-> 它自己在算（INFO PONDERING 1 生效）'
    : '-> 它没在算：出手之后就完全空闲，协议里的 PONDERING 对它没有作用') + '\n');

  console.log(`A. 置换表跨手复用省了多少？（${SIZE} 路，第 5~${PLIES + 1} 手，上限 ${CAP}ms，交替 ${ROUNDS} 轮）`);
  const keep = [], fresh = [];
  for (let i = 0; i < ROUNDS; i++) {
    if (i % 2 === 0) { keep.push(await run(false)); fresh.push(await run(true)); }
    else { fresh.push(await run(true)); keep.push(await run(false)); }
    process.stdout.write(`   第 ${i + 1} 轮跑完\n`);
  }
  const flat = a => a.flat();
  const avg = a => Math.round(flat(a).reduce((s, x) => s + x.ms, 0) / flat(a).length);
  const dep = a => +(flat(a).reduce((s, x) => s + x.depth, 0) / flat(a).length).toFixed(1);

  console.log('\n   手   保留置换表          每手清空置换表');
  const K = flat(keep), F = flat(fresh), per = K.length / ROUNDS;
  for (let i = 0; i < per; i++) {
    let km = 0, kd = 0, fm = 0, fd = 0;
    for (let r2 = 0; r2 < ROUNDS; r2++) {
      km += K[r2 * per + i].ms; kd += K[r2 * per + i].depth;
      fm += F[r2 * per + i].ms; fd += F[r2 * per + i].depth;
    }
    console.log(`  ${String(K[i].ply).padStart(3)}   ${String(Math.round(km / ROUNDS) + 'ms').padStart(7)} / ${(kd / ROUNDS).toFixed(0)} 层` +
                `        ${String(Math.round(fm / ROUNDS) + 'ms').padStart(7)} / ${(fd / ROUNDS).toFixed(0)} 层`);
  }
  console.log(`\n   保留置换表   平均 ${avg(keep)}ms   ${dep(keep)} 层`);
  console.log(`   每手清空     平均 ${avg(fresh)}ms   ${dep(fresh)} 层`);
  const g = avg(fresh) - avg(keep);
  console.log(`\n   置换表省下 ${g}ms/手（${(g / avg(fresh) * 100).toFixed(0)}%），层数 ${(dep(keep) - dep(fresh) >= 0 ? '+' : '')}${(dep(keep) - dep(fresh)).toFixed(1)}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
