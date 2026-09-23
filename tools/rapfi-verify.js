/*
 * rapfi-verify.js — 验证「给 12 路补上 NNUE」这件事真的有效
 *
 * 背景：Rapfi 官方自由规则权重在文件头里声明只适用 13~22 路，12 路会整个
 * 关掉 NNUE。tools/rapfi-weight.js 把尺寸清单里的 12 位点亮了（权重体一字
 * 未动），于是 12 路也能加载。
 *
 * 但「能加载」不等于「下得好」—— 官方把下限划在 13 路可能是有原因的，
 * 网络在没训练过的尺寸上完全可能输出垃圾。所以必须实测，不能想当然。
 *
 * 判据：**补丁版（有 NNUE）对未打补丁版（传统估值）在 12 路上对轰**。
 *   - 明显 > 50%：NNUE 在 12 路上是有效的，补丁值得用
 *   - 约等于 50%：网络在 12 路上没起作用，补丁没意义（但也无害）
 *   - 明显 < 50%：网络在 12 路上输出是坏的，必须把补丁撤掉
 *
 * 用法：node tools/rapfi-verify.js [--games 60] [--ms 1000] [--size 12] [--conc 4]
 */
'use strict';
const { Rapfi } = require('./rapfi.js');

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i < 0 ? d : (isNaN(+process.argv[i + 1]) ? process.argv[i + 1] : +process.argv[i + 1]);
};
const GAMES = arg('games', 60);
const MS    = arg('ms', 1000);
const SIZE  = arg('size', 12);
const CONC  = arg('conc', 4);
// 对照组用哪份配置。默认 config-noeval.toml：它只留连珠权重，自由规则下必然
// 匹配失败，于是**任何尺寸**上 NNUE 都被明确禁用 —— 这样 12 路和 13 路的
// 差距才有同一个基准可比（这正是判断「12 路是不是因为超出训练尺寸而打折」的关键）。
const CTRL  = String(arg('ctrl', 'config-noeval.toml'));
// 两边各自的 matchSpread（Rapfi 自适应用时的旋钮，0 = 每手烧满预算）。
// 用来回答「省下来的时间是不是拿棋力换的」。
const SPREAD_A = arg('spreadA', 21);
const SPREAD_B = arg('spreadB', 21);
const SAME  = process.argv.includes('--same');   // 两边用同一份配置，只比 matchSpread
const MAXPLY = SIZE * SIZE;

/**
 * 得分率和它的标准误。
 *
 * **不能用二项近似 `sqrt(p(1-p)/n)`** —— 那个式子假设每局的结果非胜即负，
 * 而这里每局的得分 X 取值是 {1, 0.5, 0}。和棋对方差的贡献是零，
 * 二项近似会把方差高估，区间白白变宽。用真正的三项分布方差：
 *   Var(X) = E[X²] − E[X]² = (w + d/4) − (w + d/2)²
 * 这是引擎测试里的标准做法（和棋越多，两者差得越远）。
 */
function stats(win, loss, draw) {
  const n = win + loss + draw;
  if (!n) return { score: 0, se: 0 };
  const w = win / n, d = draw / n;
  const score = w + d / 2;
  const varX = Math.max(w + d / 4 - score * score, 0);
  return { score, se: Math.sqrt(varX / n) };
}

/* ---------- 独立的胜负判定（不依赖 js/core.js，免得被它的全局尺寸牵着走） ---------- */
function wins(grid, x, y, who) {
  const at = (a, b) => (a < 0 || b < 0 || a >= SIZE || b >= SIZE) ? -1 : grid[b * SIZE + a];
  const D = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dx, dy] of D) {
    let n = 1;
    for (let k = 1; at(x + dx * k, y + dy * k) === who; k++) n++;
    for (let k = 1; at(x - dx * k, y - dy * k) === who; k++) n++;
    if (n >= 5) return true;   // 无禁手，长连也算赢
  }
  return false;
}

/** 生成互不相同的开局（中心附近若干手），保证两局一对用同一个开局、只交换先后手 */
function openings(n, seed) {
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const c = (SIZE - 1) >> 1;
  const seen = new Set(), out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 200) {
    const mv = [], used = new Set();
    const plies = 2 + ((rnd() * 2) | 0) * 2;       // 2 或 4 手
    let ok = true;
    for (let i = 0; i < plies; i++) {
      let x, y, tries = 0;
      do {
        x = c + ((rnd() * 5) | 0) - 2;
        y = c + ((rnd() * 5) | 0) - 2;
      } while (used.has(y * SIZE + x) && ++tries < 50);
      if (used.has(y * SIZE + x)) { ok = false; break; }
      used.add(y * SIZE + x);
      mv.push([x, y]);
    }
    if (!ok) continue;
    const key = mv.map(m => m.join()).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mv);
  }
  return out;
}

/**
 * 下一局。engA 先手还是 engB 先手由 aFirst 决定。
 * 返回 1=A 赢, 0=和, -1=B 赢
 */
async function playGame(engA, engB, opening) {
  const grid = new Int8Array(SIZE * SIZE).fill(0);
  const moves = [];
  let over = 0;

  for (const [x, y] of opening) {
    const who = moves.length % 2 === 0 ? 1 : 2;
    grid[y * SIZE + x] = who;
    moves.push([x, y]);
    if (wins(grid, x, y, who)) { over = who; break; }
  }
  if (over) return over === 1 ? 1 : -1;          // 开局就分胜负，极少见

  await engA.newGame(SIZE);
  await engB.newGame(SIZE);

  while (moves.length < MAXPLY) {
    const turn = moves.length % 2;               // 0 = 先手方
    const eng = turn === 0 ? engA : engB;
    let r;
    try {
      r = await eng.think(moves.map(m => m.slice()), MS);
    } catch (e) {
      return turn === 0 ? -1 : 1;                // 崩了就判负
    }
    const { x, y } = r;
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || grid[y * SIZE + x] !== 0)
      return turn === 0 ? -1 : 1;                // 走了非法点，判负
    const who = turn === 0 ? 1 : 2;
    grid[y * SIZE + x] = who;
    moves.push([x, y]);
    if (wins(grid, x, y, who)) return turn === 0 ? 1 : -1;
  }
  return 0;
}

async function main() {
  console.log(`${SIZE} 路  每手 ${MS}ms  ${GAMES} 局  并发 ${CONC}`);
  console.log(SAME
    ? `A = matchSpread ${SPREAD_A}   B = matchSpread ${SPREAD_B}（同一份配置，只比用时策略）\n`
    : `A = 启用 NNUE   B = 关掉 NNUE（${CTRL}，走传统估值）\n`);

  const opens = openings(Math.ceil(GAMES / 2), 12345);
  const jobs = [];
  for (let i = 0; i < GAMES; i++) jobs.push({ i, opening: opens[i >> 1], aFirst: i % 2 === 0 });

  let win = 0, loss = 0, draw = 0, done = 0;
  let nnueSeen = null, weightSeen = null, ctrlNnue = null;

  async function worker() {
    const a = new Rapfi({ threads: 1, pondering: false, matchSpread: SPREAD_A });
    const b = new Rapfi({ threads: 1, pondering: false, matchSpread: SPREAD_B,
                          config: SAME ? null : CTRL });
    await a.start(); await b.start();
    for (;;) {
      const job = jobs.shift();
      if (!job) break;
      const r = job.aFirst ? await playGame(a, b, job.opening)
                           : -(await playGame(b, a, job.opening));
      if (a.nnueActive != null) { nnueSeen = a.nnueActive; weightSeen = a.weightFile; }
      if (b.nnueActive != null) ctrlNnue = b.nnueActive;
      if (r > 0) win++; else if (r < 0) loss++; else draw++;
      done++;
      const { score, se } = stats(win, loss, draw);
      const elo = score <= 0 ? -800 : score >= 1 ? 800 : -400 * Math.log10(1 / score - 1);
      process.stdout.write(
        `  ${String(done).padStart(3)}/${GAMES}  ${win}-${loss}-${draw} (胜-负-和)  ` +
        `得分率 ${(score * 100).toFixed(1)}%  ±${(se * 196).toFixed(1)}%  Elo ${elo.toFixed(0)}\n`);
    }
    a.stop(); b.stop();
  }

  await Promise.all(Array.from({ length: CONC }, worker));

  const { score, se } = stats(win, loss, draw);
  console.log('\n================ 结论 ================');
  if (!SAME) {
    console.log(`${SIZE} 路 · 实验组 NNUE：${nnueSeen === true ? '启用（' + weightSeen + '）' : nnueSeen === false ? '未启用（实验组设错了！）' : '未知'}`);
    console.log(`${SIZE} 路 · 对照组 NNUE：${ctrlNnue === true ? '启用（对照组设错了！）' : ctrlNnue === false ? '已禁用（正确）' : '未知'}`);
  }
  const lo = score - se * 1.96, hi = score + se * 1.96;
  const elo = score <= 0 ? -800 : score >= 1 ? 800 : -400 * Math.log10(1 / score - 1);
  console.log(`得分率 ${(score * 100).toFixed(1)}%  95% 区间 [${(lo * 100).toFixed(1)}%, ${(hi * 100).toFixed(1)}%]  Elo ${elo.toFixed(0)}`);
  if (SAME) {
    // 这里要的不是「A 更强」，而是「A 不比 B 弱」—— 省时间不能拿棋力换
    if (lo > 0.5)       console.log(`判定：matchSpread ${SPREAD_A} 反而更强 ✓`);
    else if (hi < 0.5)  console.log(`判定：matchSpread ${SPREAD_A} 明显更弱，省下的时间是拿棋力换的 ✗`);
    else                console.log(`判定：两者没有显著差异 —— 那就该选快的那个 ✓`);
  }
  else if (lo > 0.5)     console.log(`判定：NNUE 在 ${SIZE} 路上确实有效 ✓`);
  else if (hi < 0.5)     console.log(`判定：开着 NNUE 反而更弱，必须查 ✗`);
  else                   console.log('判定：区间跨过 50%，局数还不够');
}

main().catch(e => { console.error(e); process.exit(1); });
