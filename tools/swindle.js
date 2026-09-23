/*
 * swindle.js — 绝境搏命：已经算出必输之后，把剩下的预算花在「让对手走错」上
 *
 * 为什么需要
 * ----------
 * 引擎一旦证明这个局面必输，就立刻收手 —— 实战日志里那局，第 8 手之后
 * 每一手只想了 50~250 毫秒，6 秒预算一点没用。它在按「最长抵抗」选棋，
 * 这个目标**对着另一个引擎是对的**：对手不会出错，那么能拖多久就是全部。
 *
 * 可我们的对手是人。「必输」只在对手也是引擎、不会出错时才成立，
 * 而真实的人类选手不可能不出错。所以真正该最大化的是**对手走错的机会**。
 * 而那几秒和 24 个核就闲在那儿。
 *
 * 量什么：对手有几条路能赢
 * ------------------------
 * 对每个候选防守，站到对手一侧做一次多着法分析，数他的前 K 个应手里
 * **有几个是已证明的必胜**。实测这个指标区分度很大（12 路一个真实必输局面）：
 *
 *     白走 H6   -> 对手 6 个应手里只有 1 个能赢，还有 3 个反而自己被杀
 *     白走 H10  -> 2 个能赢
 *     白走 H11  -> 6 个全能赢
 *
 * 一条路和六条路，对人来说完全是两回事。
 *
 * ⚠ 走过的弯路：第一版数的是「对手还能不能证出杀」。那个指标没用 ——
 * 它和「杀的步数」高度重合，而步数正是根搜索已经在最大化的东西，
 * 于是每次都选回引擎原来那一手，功能等于没做（实测 7 个局面换手 0 次）。
 * 而且逐个候选再搜时置换表是热的，引擎直接把根搜索的结论读回来，
 * 根本不是一次独立检验。
 *
 * 不做什么
 * --------
 * 不会为了「窄」去走一手明显更快输的棋。步数就是对手必须连续走对的手数，
 * 也就是犯错机会数 —— 拿 -M46 换 -M10 是在主动关掉自己的生路。所以有 keepRatio 闸。
 */
'use strict';

/**
 * 给一个候选打分。**纯函数，单独测。**
 *
 * @param c.replies  对手那一侧的前 K 个应手（每个带 mate：>0 他赢，<0 他反而被杀）
 * @param base.mate  根搜索给出的 mate（负数 = 我们被杀的步数）
 * @param keepRatio  至少要保住根搜索那手多少比例的抵抗步数
 * @return { rank, survive, winning, traps, reason }；不合格的 rank = -1
 */
function scoreCandidate(c, base, keepRatio) {
  const reps = (c.replies || []).filter(r => r);
  const total = reps.length;
  if (!total) return { rank: -1, survive: 0, winning: 0, traps: 0, reason: '对手那边没算出候选' };

  const winning = reps.filter(r => (r.mate || 0) > 0).length;
  const traps = reps.filter(r => (r.mate || 0) < 0).length;   // 对手走了反而自己被杀
  // 我们还能撑多久 = 对手最快的那条杀路；他证不出杀就是未知数
  const mates = reps.filter(r => (r.mate || 0) > 0).map(r => r.mate);
  const survive = mates.length ? Math.min.apply(null, mates) : Infinity;

  // **别把抵抗步数换掉。** 步数 = 对手要连续走对的手数 = 犯错机会数。
  const baseSurvive = Math.abs(base.mate || 0);
  if (baseSurvive > 0 && survive !== Infinity && survive < baseSurvive * keepRatio) {
    return {
      rank: -1, survive, winning, traps,
      reason: '撑不了那么久（' + survive + ' vs ' + baseSurvive + '）'
    };
  }

  // 主指标：对手的赢法越少越好。副指标：他一走就输的陷阱越多越好。
  const narrow = (total - winning) / total;
  const trap = traps / total;
  return {
    rank: narrow + trap * 0.5,
    survive, winning, traps,
    reason: '对手 ' + total + ' 个应手里 ' + winning + ' 个能赢' +
            (traps ? '、' + traps + ' 个反而自己被杀' : '') +
            (survive === Infinity ? '（他证不出杀）' : '（最快 ' + survive + ' 步）')
  };
}

/**
 * 在必输局面里挑一手最难被走对的防守。
 *
 * @param eng       Rapfi 实例（会被独占，调用方自己串行化）
 * @param moves     整局着法 [[x,y],…]，轮到我们走
 * @param base      根搜索的结果（必须 mate < 0）
 * @param opts.deadline  绝对时间戳，**一步都不许越过**
 * @param opts.width     最多试几个候选（默认 4）
 * @param opts.replies   对手那边取前几个应手（默认 6）
 * @param opts.keepRatio 至少保住多少比例的抵抗步数（默认 0.6）
 * @param opts.onLog     日志回调
 * @return { x, y, tried, picked, lines } 或 null
 */
async function swindle(eng, moves, base, opts) {
  opts = opts || {};
  const deadline = opts.deadline || 0;
  const width = Math.max(2, Math.min(8, opts.width || 4));
  const K = Math.max(3, Math.min(10, opts.replies || 6));
  const keepRatio = opts.keepRatio == null ? 0.6 : opts.keepRatio;
  const log = opts.onLog || (() => {});
  // **余量要厚。** _think 自带硬停定时器，analyse 没有 —— 它只发 TIMEOUT_TURN，
  // 然后等引擎自己回话。16 条线程停下来、汇总、打印 PV 实测要几百毫秒，
  // 这段全落在预算外面。实测 6000ms 预算下最长一手贴到 5805ms，太薄了。
  // 超时在读秒制对局里是会直接输棋的（15 秒读秒），宁可少试一个候选。
  const MARGIN = 500;
  const left = () => deadline - Date.now() - MARGIN;

  if (!base || !(base.mate < 0)) return null;     // 没被证明必输就不折腾
  if (left() < 1400) { log('剩 ' + Math.max(0, left()) + 'ms，不够搏命'); return null; }

  // 先拿一批候选。这一步只要排序不要精度，封顶 800ms。
  const pickMs = Math.max(300, Math.min(800, Math.floor(left() * 0.25)));
  let cands;
  try {
    cands = ((await eng.analyse(moves, pickMs, width)).cands || []).filter(c => c.xy);
  } catch (e) {
    log('取候选失败：' + e.message);
    return null;
  }
  if (cands.length < 2) { log('只有 ' + cands.length + ' 个候选，没得挑'); return null; }

  // 根搜索那一手必须在列表里 —— 它是保底
  const baseKey = base.x + ',' + base.y;
  if (!cands.some(c => c.xy[0] + ',' + c.xy[1] === baseKey))
    cands.unshift({ xy: [base.x, base.y], mate: base.mate, eval: base.eval });

  const lines = [];
  let best = null;
  for (const c of cands) {
    const remain = left();
    if (remain < 700) { log('时间到，只试了 ' + lines.length + '/' + cands.length + ' 个候选'); break; }
    // 剩下的候选平分剩余时间，单个封顶 1.2 秒；再扣一档收尾开销
    const share = Math.floor(remain / Math.max(1, cands.length - lines.length));
    const per = Math.max(350, Math.min(1200, share) - 250);
    let r;
    try {
      r = await eng.analyse(moves.concat([c.xy]), per, K);   // 站在对手那一侧
    } catch (e) {
      log('候选 ' + c.xy + ' 试算失败：' + e.message);
      continue;
    }
    const s = scoreCandidate({ replies: r.cands || [] }, base, keepRatio);
    const row = {
      xy: c.xy, rank: s.rank, survive: s.survive, winning: s.winning,
      traps: s.traps, reason: s.reason,
      isBase: c.xy[0] + ',' + c.xy[1] === baseKey
    };
    lines.push(row);
    // 同分时保底那一手优先 —— 没有确凿理由就不推翻引擎。
    // 保底那手不一定排在第一个试，所以同分时要显式偏向它，光靠「先到先得」不够。
    if (s.rank >= 0 && (!best || s.rank > best.rank + 1e-9 ||
        (row.isBase && s.rank > best.rank - 1e-9))) best = row;
  }

  if (!best) return null;
  return { x: best.xy[0], y: best.xy[1], tried: lines.length, picked: best, lines };
}

module.exports = { swindle, scoreCandidate };
