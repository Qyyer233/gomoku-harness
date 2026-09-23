/*
 * test-swindle.js — 绝境搏命的打分规则
 *
 * 打分是这个功能的全部要害：方向选错的话，它会把一手能撑 46 步的棋换成
 * 10 步就完的，等于主动缩短对手犯错的窗口 —— 比不做还糟。
 * 所以 scoreCandidate 写成纯函数，在这里逐条钉死。
 *
 * 用的数字来自真实探测（12 路 G7 H8 H6 F8 I6 G6 H5 J7 H4 之后）：
 *   白走 H6  -> 对手 6 个应手里 1 个能赢、3 个反而自己被杀
 *   白走 H10 -> 2 个能赢
 *   白走 H11 -> 6 个全能赢
 */
const { scoreCandidate } = require('./swindle.js');

let pass = 0, fail = 0;
const ok = m => { pass++; console.log('  ✓ ' + m); };
const bad = m => { fail++; console.log('  ✗ ' + m); };
const check = (c, m) => c ? ok(m) : bad(m);

const KEEP = 0.6;
const base = { mate: -36 };                       // 根搜索：被杀 36 步
const rep = (...mates) => ({ replies: mates.map(m => ({ mate: m })) });

console.log('绝境搏命 · 打分规则');

// ---------- 1. 对手的赢法越少越好（主指标） ----------
{
  const narrow = scoreCandidate(rep(35, 0, 0, -18, -18, -16), base, KEEP);   // 真实的 H6
  const wide = scoreCandidate(rep(15, 15, 15, 15, 17, 17), base, KEEP);      // 真实的 H11
  check(narrow.rank > wide.rank, '对手只有 1 条赢法的候选，胜过 6 条全赢的');
  check(narrow.winning === 1 && wide.winning === 6, '赢法数量统计正确（1 vs 6）');
}

// ---------- 2. 对手一走就输的陷阱要加分 ----------
{
  const withTraps = scoreCandidate(rep(35, 0, 0, -18, -18, -16), base, KEEP);
  const noTraps = scoreCandidate(rep(35, 0, 0, 0, 0, 0), base, KEEP);
  check(withTraps.rank > noTraps.rank, '同样只有 1 条赢法时，带陷阱的更好');
  check(withTraps.traps === 3, '陷阱数量统计正确（3 个应手会让对手自己被杀）');
}

// ---------- 3. ⚠ 不许拿抵抗步数换「窄」 ----------
// 步数 = 对手必须连续走对的手数 = 犯错机会数。
// 这条守不住，这个功能就是负收益 —— 把 -M36 换成 -M10 等于帮对手收官。
{
  const tooFast = scoreCandidate(rep(10, 0, 0, 0, 0, 0), base, KEEP);
  check(tooFast.rank < 0, '只剩 10 步（不到 36 的六成）直接淘汰，哪怕它更窄');
  check(/撑不了/.test(tooFast.reason), '淘汰理由写清楚：' + tooFast.reason);
  const justEnough = scoreCandidate(rep(22, 0, 0, 0, 0, 0), base, KEEP);
  check(justEnough.rank >= 0, '刚好保住六成（22 >= 36×0.6）的候选保留');
}

// ---------- 4. 对手证不出杀 -> 撑的步数是未知，不能拿去淘汰 ----------
// 写反的话，最有价值的那一类候选会被全部筛掉，功能静默失效。
{
  const r = scoreCandidate(rep(0, 0, 0, 0, 0, 0), base, KEEP);
  check(r.rank >= 0, '对手一个杀都证不出的候选不会被步数闸淘汰');
  check(r.survive === Infinity, '证不出杀时撑的步数记为未知');
  check(r.winning === 0 && r.rank >= 1, '对手 0 条赢法 -> 拿到满分档');
}

// ---------- 5. 边界 ----------
{
  check(scoreCandidate({ replies: [] }, base, KEEP).rank < 0, '对手那边没算出候选 -> 淘汰');
  const noBase = scoreCandidate(rep(5, 5, 5), { mate: 0 }, KEEP);
  check(noBase.rank >= 0, '根搜索没报 mate 时不做步数淘汰');
  const allTraps = scoreCandidate(rep(-10, -10, -10), base, KEEP);
  check(allTraps.rank > 1, '对手怎么走都输 -> 分数最高（其实是我们反赢了）');
}

console.log('\n' + pass + ' 条通过' + (fail ? '，' + fail + ' 条失败' : ''));
process.exit(fail ? 1 : 0);
