/*
 * balanced-openings.js — 造一批「平衡开局」，供所有比胜负的测试用
 *
 * 为什么必须有这个：随机撒两颗子当开局，结果往往由开局本身决定，不由棋力决定。
 * 实测踩过 —— `unlock-bench.js` 拿 15 个随机开局、每个正反各打一遍，
 * 24 核对 1 核连着两次都是**精确的 15 胜 15 负 0 和**：
 * 先手方每局都赢，两个引擎谁强谁弱完全没体现出来。
 *
 * 做法：撒一批候选开局 -> 让 Rapfi 给每个打分 -> 只留评分接近 0 的那些。
 * 评分是从「轮到走的那一方」的视角给的，所以 |eval| 小 = 双方机会接近。
 *
 * 用法：
 *   node tools/balanced-openings.js --size 12 --plies 4 --keep 24 --ms 2000
 *   -> 写进 data/openings12-balanced.json，其它工具直接读
 */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../js/core.js');
const { Rapfi } = require('./rapfi.js');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i < 0 ? d : (isNaN(+process.argv[i + 1]) ? process.argv[i + 1] : +process.argv[i + 1]);
};
const SIZE = arg('size', 12);
const PLIES = arg('plies', 4);          // 开局有几手
const KEEP = arg('keep', 24);           // 最终保留几个
const MS = arg('ms', 2000);             // 每个候选给多少时间打分
const POOL = arg('pool', 120);          // 候选池多大
const THREADS = arg('threads', 12);
const OUT = path.join(ROOT, 'data', `openings${SIZE}-balanced.json`);

C.setSize(SIZE);

/** 撒候选：中心附近随机落 PLIES 手，双方交替 */
function candidates(n, seed) {
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const c = (SIZE - 1) >> 1, out = [], seen = new Set();
  const R = Math.min(3, (SIZE - 1) >> 1);
  let guard = 0;
  while (out.length < n && guard++ < n * 40) {
    const mv = [], used = new Set();
    let ok = true;
    for (let k = 0; k < PLIES; k++) {
      let x, y, t = 0;
      do {
        x = c + ((rnd() * (2 * R + 1)) | 0) - R;
        y = c + ((rnd() * (2 * R + 1)) | 0) - R;
      } while (used.has(y * SIZE + x) && ++t < 60);
      if (used.has(y * SIZE + x)) { ok = false; break; }
      used.add(y * SIZE + x);
      mv.push([x, y]);
    }
    if (!ok) continue;
    // 同一个开局的 8 种对称算同一个，用规范化 key 去重
    const b = new C.Board();
    mv.forEach((m, i) => b.put(C.xyToP(m[0], m[1]), i % 2 === 0 ? C.BLACK : C.WHITE));
    const key = C.canonicalKey(b, PLIES % 2 === 0 ? C.BLACK : C.WHITE).key;
    const ks = String(key);
    if (seen.has(ks)) continue;
    seen.add(ks);
    out.push(mv);
  }
  return out;
}

(async () => {
  const pool = candidates(POOL, 20260921);
  console.log(`${SIZE} 路 · ${PLIES} 手开局 · 候选 ${pool.length} 个（去过对称重复）· 每个打分 ${MS}ms`);
  console.log('只保留评分接近 0 的 —— 那才是双方机会接近、胜负由棋力决定的开局\n');

  const r = new Rapfi({ threads: THREADS, pondering: false, matchSpread: 0 });
  await r.start(); await r.newGame(SIZE);
  await r.think([], 50); r.restart();

  const scored = [];
  for (let i = 0; i < pool.length; i++) {
    // 签名是 analyse(moves, budgetMs, multiPV)。这里曾经写反成 (pool[i], 1, MS)，
    // 于是每个开局只打了 50ms 的分、还要了 MS 条 PV —— 旧的 openings12-balanced.json
    // 就是这么造出来的，它的「平衡」只有 50ms 的精度。
    const a = await r.analyse(pool[i], MS, 1);
    // 有杀棋的开局直接废掉：那不是「不平衡」，是已经结束了
    const mate = a.cands && a.cands[0] ? a.cands[0].mate : 0;
    const ev = a.cands && a.cands[0] ? a.cands[0].eval : null;
    if (mate || ev == null) {
      if ((i + 1) % 20 === 0) process.stdout.write(`  打分 ${i + 1}/${pool.length}\n`);
      continue;
    }
    scored.push({ moves: pool[i], eval: ev });
    if ((i + 1) % 20 === 0) process.stdout.write(`  打分 ${i + 1}/${pool.length}\n`);
  }
  r.stop();

  scored.sort((a, b) => Math.abs(a.eval) - Math.abs(b.eval));
  const keep = scored.slice(0, KEEP);
  const labels = m => m.map(q => C.pToLabel(C.xyToP(q[0], q[1]))).join(' ');

  console.log(`\n可用候选 ${scored.length} 个，保留最平衡的 ${keep.length} 个：`);
  for (const k of keep.slice(0, 10)) console.log(`  ${labels(k.moves).padEnd(20)} 评分 ${k.eval}`);
  if (keep.length > 10) console.log(`  …还有 ${keep.length - 10} 个`);
  const worst = keep.length ? Math.abs(keep[keep.length - 1].eval) : 0;
  console.log(`\n保留部分的最大 |评分| = ${worst}（越小越平衡）`);
  if (scored.length) {
    const all = scored.map(x => Math.abs(x.eval)).sort((a, b) => a - b);
    console.log(`对照：全部候选的中位 |评分| = ${all[Math.floor(all.length / 2)]}`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    size: SIZE, plies: PLIES, madeAt: new Date().toISOString(),
    ms: MS, note: '评分接近 0 的开局，供比胜负的测试用（见文件头）',
    openings: keep.map(k => ({ moves: k.moves, eval: k.eval, labels: labels(k.moves) }))
  }, null, 1));
  console.log(`\n已写入 ${path.relative(ROOT, OUT)}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
