/*
 * audit.js — 拿真实棋谱当考卷，考我们自己的引擎
 *
 * review.js 是「实战着法 vs 引擎着法」，评分的裁判也是引擎自己 —— 循环论证，
 * 只能说明实战偏离了引擎，说明不了引擎对不对。
 *
 * 这个工具反过来：走一遍棋谱，每个局面都让引擎出手，然后用**独立于评估函数**
 * 的标准去验：引擎选的这一手走完，对手是不是就有强制杀了；如果是，
 * 再看当时有没有别的着法能活。两条都成立 = 引擎的真漏着。
 *
 * 顺带记录每手实际用掉多少预算 —— 自适应用时是不是过早收手，只能这么看出来。
 *
 * **默认按 app 的方式用引擎：一个实例跨手复用，局内不 reset。**
 * 这条很要紧 —— 每手 reset 出来的结论不能外推到实战。
 * 想看「干净引擎」的表现加 --fresh。
 *
 * 用法: node audit.js --moves "..." [--ms 6000] [--level master] [--fresh]
 */
const C = require('../js/core.js');
const E = require('../js/engine.js');

function arg(n, d) {
  const i = process.argv.indexOf('--' + n);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
}
const tokens = arg('moves', '').trim().split(/[\s,]+/).filter(Boolean);
let maxIdx = 0;
for (const t of tokens) maxIdx = Math.max(maxIdx, t.toUpperCase().charCodeAt(0) - 64, parseInt(t.slice(1), 10));
const SIZE = parseInt(arg('size', maxIdx <= 12 ? 12 : 15), 10);
C.setSize(SIZE);

const MS = parseInt(arg('ms', 6000), 10);
const LEVEL = arg('level', 'master');
// app 里引擎是跨手复用的，默认就照这样跑；--fresh 才每手重置
const FRESH = process.argv.indexOf('--fresh') > 0;
const PROBE_MS = parseInt(arg('probeMs', 1500), 10);

const moves = tokens.map(C.labelToP);
const eng = new E.Engine();
const probe = new E.Engine();

/** 对手有没有强制杀 */
function killed(b, opp) {
  const vcf = probe.vcfFrom(b, opp, 20, PROBE_MS);
  if (vcf >= 0) return 'VCF';
  return probe.runVct(b, opp, 14, 500000, PROBE_MS) >= 0 ? 'VCT' : null;
}

/** 这个局面有没有活路（试静态分前 24 手） */
function anySafe(b, role, exclude) {
  const opp = 3 - role;
  const cand = b.emptyNear([])
    .map(p => [p, E.threatScore(b, p, role) + E.threatScore(b, p, opp) * 0.85])
    .sort((x, y) => y[1] - x[1]).slice(0, 24).map(x => x[0]);
  for (const p of cand) {
    if (p === exclude) continue;
    b.put(p, role);
    const w = b.lastMoveWins();
    const k = w ? null : killed(b, opp);
    b.undo();
    if (!k) return p;
  }
  return -1;
}

const board = new C.Board();
const times = [], depths = [];
let blunders = 0, forced = 0, zeroDepth = 0;

console.log(`${SIZE} 路，${moves.length} 手，引擎按 ${LEVEL} / 上限 ${MS}ms 逐手作答` +
            `（${FRESH ? '每手重置引擎' : '引擎跨手复用，和 app 一致'}）\n`);
console.log('手  轮  实战  引擎  用时   深度  节点     说明');

for (let i = 0; i < moves.length; i++) {
  const role = i % 2 === 0 ? C.BLACK : C.WHITE;
  const opp = 3 - role;

  if (FRESH) eng.reset();
  const r = eng.bestMove(board, role,
    { level: LEVEL, useBook: false, timeMin: MS, timeMax: MS, trace: true });
  times.push(r.timeMs); depths.push(r.depth);
  // 深度 0 = 走了搜索却一层都没搜完，落的是兜底着法。真出过这种事故
  if (r.source === 'search' && r.depth === 0) zeroDepth++;

  // 引擎这一手走完，对手是否立刻有杀
  board.put(r.move, role);
  const won = board.lastMoveWins();
  const k = won ? null : killed(board, opp);
  board.undo();

  let note = '';
  if (k) {
    // 走之前是不是已经没救了？有救才算引擎的错
    const alt = anySafe(board, role, r.move);
    if (alt >= 0) { blunders++; note = `★漏着 走完对手 ${k}，本可走 ${C.pToLabel(alt)}`; }
    else { forced++; note = `（已无救，走完对手 ${k}）`; }
  }

  console.log(
    `${String(i + 1).padStart(3)} ${role === C.BLACK ? '黑' : '白'}  ` +
    `${C.pToLabel(moves[i]).padEnd(5)} ${C.pToLabel(r.move).padEnd(5)} ` +
    `${String(r.timeMs).padStart(5)}ms ${String(r.depth).padStart(4)} ` +
    `${String(r.nodes).padStart(8)}  ${note}`);

  board.put(moves[i], role);
  if (board.lastMoveWins()) break;
}

const sum = times.reduce((a, b) => a + b, 0);
const used = times.filter(t => t >= MS * 0.9).length;
const quick = times.filter(t => t < MS * 0.1).length;
console.log('\n' + '='.repeat(64));
console.log(`引擎漏着 ${blunders} 手，已无救 ${forced} 手`);
if (zeroDepth) console.log(`★ ${zeroDepth} 手走了搜索却一层都没搜完（落的是兜底着法）`);
console.log(`用时：合计 ${(sum / 1000).toFixed(1)}s，平均 ${(sum / times.length).toFixed(0)}ms / ${MS}ms 预算 ` +
            `= ${(sum / times.length / MS * 100).toFixed(1)}%`);
console.log(`  用满预算(>90%) ${used} 手；只用了不到 10% 就收手 ${quick} 手`);
console.log(`深度：平均 ${(depths.reduce((a, b) => a + b, 0) / depths.length).toFixed(1)}，` +
            `最浅 ${Math.min.apply(null, depths)}，最深 ${Math.max.apply(null, depths)}`);
