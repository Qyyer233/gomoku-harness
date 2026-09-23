/*
 * bench.js — 固定局面、固定深度的基准测试
 *
 * 借鉴 Rapfi 的 command/benchmark.cpp（Gomocup 2024 冠军引擎）。
 * 解决的是这个项目反复吃亏的问题：**改完引擎没有可靠指标**。
 * 胜率噪声太大（同一个改动两个种子读出 58.8% 和 46.3%），
 * 漏着率又饱和在 0，两个都没有分辨力。
 *
 * 这里不打比赛，只做两件确定性的事：
 *
 *   1. 落子/悔棋吞吐 —— core.js 的增量评分改动会直接反映在这里
 *   2. 固定深度搜索 —— 报总节点数、nodes/s，以及一个**行为指纹**
 *
 * 行为指纹是关键：把每个局面的「节点数 + 根节点分数 + 选中的着法」哈希成一个数。
 *   指纹没变 = 决策完全没动，这次改动是纯提速 -> 看 nodes/s 就够了，不用打比赛
 *   指纹变了 = 决策变了 -> 必须做强度测试（arena --sprt）
 * 没有它，「我只是重构了一下」和「我悄悄改变了棋力」根本分不清。
 *
 * 为什么必须固定深度而不是固定时间：固定时间下节点数随机器负载漂移，
 * 两次跑同一份代码都对不上，指纹就失去意义了。
 *
 * 用法:
 *   node bench.js                 # 默认深度 8
 *   node bench.js --depth 10
 *   node bench.js --nomove        # 跳过落子吞吐，只跑搜索
 */
const C = require('../js/core.js');
const E = require('../js/engine.js');

function arg(n, d) {
  const i = process.argv.indexOf('--' + n);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
}
const has = n => process.argv.indexOf('--' + n) > 0;
const DEPTH = parseInt(arg('depth', 8), 10);
const MOVE_TESTS = 300000;

/**
 * 基准局面。**改动这张表会让指纹失去可比性**，等于换了一把尺子 ——
 * 要加局面就重新记录一份基线，别和旧数字比。
 *
 * 选局面的原则：覆盖不同阶段和不同性质，而不是挑「有意思」的。
 * 其中 12 路那两条来自用户的实战棋谱（第 43 手是个只有两手能活的生死局面，
 * 正是根节点置换表那个 bug 暴露出来的地方）。
 */
const BENCH = [
  // --- 15 路 ---
  { size: 15, name: '开局·斜指', moves: 'H8 I9 J10' },
  { size: 15, name: '开局·直指', moves: 'H8 H9 H7 I8' },
  { size: 15, name: '中局·对攻', moves: 'H8 I9 I8 J8 G9 F10 H10 H9 G8 J9 I7' },
  { size: 15, name: '中局·防守', moves: 'H8 H9 I9 G7 J10 F6 I8 J7 H7 G8 I6 I7 J6' },
  { size: 15, name: '交叉威胁', moves: 'H8 G8 I9 F6 J8 K7 I7 J6 G10 H11' },
  // --- 12 路（来自实战）---
  { size: 12, name: '实战·开局偏位', moves: 'F8 F6 E7 D6 E6' },
  { size: 12, name: '实战·中盘缠斗', moves: 'F8 F6 E7 D6 E6 E5 G7 C7 B8 F4 G3 F5 F3 D5 G5 C5 B5 D3 D4 G6 E4' },
  // 第 43 手：黑棋 I 列活三，白棋只有 A9/B9 两手能活（唯一解是反冲四）
  { size: 12, name: '实战·唯一解防守', moves: 'F8 F6 E7 D6 E6 E5 G7 C7 B8 F4 G3 F5 F3 D5 G5 C5 B5 D3 D4 G6 E4 E9 H7 F7 D8 E8 H5 D9 C10 C8 C6 B7 E10 C9 F9 G8 H6 H4 I5 J4 I6 G4 I4' },
  { size: 12, name: '实战·残局算杀', moves: 'F8 F6 E7 D6 E6 E5 G7 C7 B8 F4 G3 F5 F3 D5 G5 C5 B5 D3 D4 G6 E4 E9 H7 F7 D8 E8 H5 D9 C10 C8 C6 B7 E10 C9 F9 G8 H6 H4 I5 J4 I6 G4 I4 I3 I7 I8 J7 K7 K8 L9' }
];

function build(entry) {
  C.setSize(entry.size);
  const b = new C.Board();
  const list = entry.moves.trim().split(/\s+/);
  list.forEach((s, i) => {
    const p = C.labelToP(s);
    if (p < 0) throw new Error(`${entry.name}: 坐标 ${s} 不在 ${entry.size} 路棋盘上`);
    b.put(p, i % 2 === 0 ? C.BLACK : C.WHITE);
  });
  return { board: b, role: list.length % 2 === 0 ? C.BLACK : C.WHITE };
}

// 32 位滚动哈希（FNV-1a 变体）。只要求稳定和好打印，不要求密码学强度。
let hash = 0x811c9dc5 >>> 0;
function mix(v) {
  v = v | 0;
  for (let i = 0; i < 4; i++) {
    hash = (hash ^ ((v >>> (i * 8)) & 0xff)) >>> 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
}

// ---------- 1. 落子/悔棋吞吐 ----------
if (!has('nomove')) {
  console.log('========== 落子吞吐 ==========');
  let moveCount = 0;
  const t0 = Date.now();
  for (const entry of BENCH) {
    C.setSize(entry.size);
    const list = entry.moves.trim().split(/\s+/).map(C.labelToP);
    const b = new C.Board();
    const reps = Math.max(1, Math.round(MOVE_TESTS / BENCH.length / list.length));
    for (let r = 0; r < reps; r++) {
      for (let i = 0; i < list.length; i++) b.put(list[i], i % 2 === 0 ? C.BLACK : C.WHITE);
      for (let i = 0; i < list.length; i++) b.undo();
      moveCount += list.length;
    }
  }
  const ms = Math.max(1, Date.now() - t0);
  console.log(`落子+悔棋 ${moveCount.toLocaleString()} 次  ${ms}ms  ` +
              `${Math.round(moveCount * 1000 / ms).toLocaleString()} 次/秒\n`);
}

// ---------- 2. 固定深度搜索 ----------
console.log(`========== 搜索基准（固定深度 ${DEPTH}）==========`);
let totalNodes = 0, totalMs = 0;

for (const entry of BENCH) {
  const { board, role } = build(entry);
  const eng = new E.Engine();
  eng.reset();                       // 每个局面都从干净的置换表开始，保证可复现
  const t0 = Date.now();
  // 搜索参数全部写死，不走 LEVELS。
  // 基准尺子量的是「搜索代码有没有变」，不该因为有人调了 LEVELS.master.width 就失效
  //（那种调参属于强度改动，用 arena 量，不是这里）。
  // 固定深度跑满：两道「提前收手」的闸门都关掉，否则节点数随时间漂移，指纹就没意义了。
  const r = eng.bestMove(board, role, {
    level: 'master', useBook: false, fastOpening: false,
    depth: DEPTH, width: 16,
    vcf: 20, vct: 16,
    // VCT 必须给**节点**预算而不是时间预算：时间预算下节点数随机器负载漂移。
    // 20 万太大（单个局面能跑 15 秒），压到 2 万，既有覆盖又有界。
    vctNodes: 20000, vctShare: 0,
    timeMin: 3600000, timeMax: 3600000,   // 时间不设限，只让深度说话
    stable: 1e9,                          // 永不因「着法稳定」提前收手
    solid: DEPTH
  });
  const ms = Date.now() - t0;
  totalNodes += r.nodes; totalMs += ms;
  mix(r.nodes); mix(r.score); mix(r.move);
  console.log(`  ${entry.name.padEnd(12)} ${String(entry.size)}路  ` +
              `${C.pToLabel(r.move).padEnd(4)} ${String(r.source).padEnd(7)} ` +
              `深度 ${String(r.depth).padStart(2)}  ${String(r.nodes).padStart(9)} 节点  ` +
              `${String(ms).padStart(6)}ms`);
}

console.log('');
console.log(`总节点   ${totalNodes.toLocaleString()}`);
console.log(`总耗时   ${totalMs}ms`);
console.log(`速度     ${Math.round(totalNodes * 1000 / Math.max(1, totalMs)).toLocaleString()} 节点/秒`);
console.log(`行为指纹 ${hash.toString(16).padStart(8, '0')}`);
console.log('');
console.log('指纹一致 = 决策完全没变，这次改动是纯提速，比 nodes/s 即可；');
console.log('指纹变了 = 决策变了，必须做强度测试（node arena.js --sprt ...）。');
// 这台开发机持续满载 8 秒后会降频到 30%（见 tools/throttle.js）。
// 整个 bench 约 1.3 秒，卡在阈值以内，所以耗时数字才是可比的 ——
// 往 BENCH 里加局面加到跑超过 3 秒，nodes/s 就会开始骗人（节点数和指纹不受影响）。
if (totalMs > 3000) {
  console.log('');
  console.log(`⚠ 本次跑了 ${(totalMs / 1000).toFixed(1)} 秒，超过 3 秒。`);
  console.log('  CPU 降频会让后面的局面偏慢，nodes/s 不再可比（节点数和指纹仍然可信）。');
  console.log('  先跑 node tools/throttle.js 确认这台机器降不降频。');
}
