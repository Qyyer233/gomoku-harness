/*
 * probe-pos.js — 单个局面的「有没有救」检查
 *
 * scan-kill 能告诉你「第 N 手之后对手有杀」，但答不出更要紧的一句：
 * 当时**有没有哪一手能挡住**。没有的话，这一手不是漏着，输在更早；
 * 有的话，这就是引擎该修的防守洞。
 *
 * 做法：把轮走方的所有合理着法逐个试一遍，看对手是否仍有 VCF/VCT。
 *
 * 用法: node probe-pos.js --moves "..." [--ms 2500] [--vct 16] [--top 0]
 *   --top  只试静态分最高的前 N 个着法（0 = 全试）
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

const MS = parseInt(arg('ms', 2500), 10);
const VCT_D = parseInt(arg('vct', 16), 10);
const TOPN = parseInt(arg('top', 0), 10);

const b = new C.Board();
tokens.forEach((t, i) => b.put(C.labelToP(t), i % 2 === 0 ? C.BLACK : C.WHITE));

const role = tokens.length % 2 === 0 ? C.BLACK : C.WHITE;   // 轮谁走
const opp = 3 - role;
const probe = new E.Engine();

console.log(`${SIZE} 路，已走 ${tokens.length} 手，轮${role === C.BLACK ? '黑' : '白'}走`);

// 先确认对手确实有杀，否则没什么好挡的
const pre = probe.vcfFrom(b, opp, 20, MS);
const preV = pre >= 0 ? -1 : probe.runVct(b, opp, VCT_D, 2000000, MS);
if (pre < 0 && preV < 0) { console.log('对手此刻并没有算杀，不用挡'); process.exit(0); }
console.log(`对手的杀: ${pre >= 0 ? 'VCF@' + C.pToLabel(pre) : 'VCT@' + C.pToLabel(preV)}\n`);

let cands = b.emptyNear([]);
if (TOPN > 0) {
  cands = cands.map(p => [p, E.threatScore(b, p, role) + E.threatScore(b, p, opp) * 0.85])
               .sort((x, y) => y[1] - x[1]).slice(0, TOPN).map(x => x[0]);
}
console.log(`试 ${cands.length} 个着法…`);

const safe = [];
for (const p of cands) {
  b.put(p, role);
  if (b.lastMoveWins()) { b.undo(); safe.push({ p, why: '自己先成五' }); continue; }
  const vcf = probe.vcfFrom(b, opp, 20, MS);
  let kind = vcf >= 0 ? 'VCF' : null;
  if (!kind) { const v = probe.runVct(b, opp, VCT_D, 2000000, MS); if (v >= 0) kind = 'VCT'; }
  b.undo();
  if (!kind) safe.push({ p, why: '对手无杀' });
}

if (!safe.length) {
  console.log('\n没有任何一手能挡住 —— 这个局面已经输定了，问题出在更早的某一手。');
} else {
  console.log(`\n能挡住的着法 ${safe.length} 个:`);
  for (const s of safe) console.log(`  ${C.pToLabel(s.p)}  (${s.why})`);
}
