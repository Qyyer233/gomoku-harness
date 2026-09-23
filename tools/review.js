/*
 * review.js — 复盘一局已有棋谱
 *
 * blunder-scan 是让引擎自对弈然后统计漏着率，回答「引擎整体有多稳」。
 * 这个工具回答的是另一个问题：「这一局，哪一手走坏了，本来该走哪」。
 *
 * 每一手做三件事：
 *   1. 走之前，这一方有没有现成的算杀（VCF/VCT）没看见 —— 漏杀
 *   2. 走之后，对手有没有立刻成立的算杀，而走之前还没有 —— 送杀
 *   3. 把「实战这一手」和「引擎推荐的那一手」放到同样深度下对比，算出分差
 *
 * 第 3 步必须两边都从子节点搜起。只拿根节点的 bestScore 去比，
 * PVS 的空窗返回的是边界不是准确分，两个数根本不可比。
 *
 * 用法:
 *   node review.js --moves "F8 F6 E7 ..." [--size 12] [--ms 1500]
 *   node review.js --file game.txt
 *
 *   --size  棋盘边长，不给就按棋谱里出现过的最大行列自动判断
 *   --ms    每次搜索的毫秒数（默认 1500）
 *   --top   只详列分差最大的前几手（默认 12）
 *   --loss  分差超过多少才算「值得一看」（默认 300）
 */
const fs = require('fs');
const path = require('path');
const C = require('../js/core.js');
const E = require('../js/engine.js');

function arg(n, d) {
  const i = process.argv.indexOf('--' + n);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
}

let text = arg('moves', '');
const file = arg('file', '');
if (file) text = fs.readFileSync(path.resolve(file), 'utf8');
if (!text.trim()) { console.error('要给 --moves 或 --file'); process.exit(1); }

const tokens = text.trim().split(/[\s,]+/).filter(Boolean);

// 自动判尺寸：棋谱里用到的最大列号和最大行号，往上取到 12 或 15
let maxIdx = 0;
for (const t of tokens) {
  const col = t.toUpperCase().charCodeAt(0) - 65;
  const row = parseInt(t.slice(1), 10);
  if (!(row >= 1)) { console.error('看不懂的坐标: ' + t); process.exit(1); }
  maxIdx = Math.max(maxIdx, col + 1, row);
}
const SIZE = parseInt(arg('size', maxIdx <= 12 ? 12 : 15), 10);
C.setSize(SIZE);

const MS = parseInt(arg('ms', 1500), 10);
const TOP = parseInt(arg('top', 12), 10);
const LOSS_GATE = parseInt(arg('loss', 300), 10);

const moves = tokens.map(t => {
  const p = C.labelToP(t);
  if (p < 0) { console.error(`坐标 ${t} 不在 ${SIZE} 路棋盘上`); process.exit(1); }
  return p;
});

const eng = new E.Engine();      // 出推荐着法
const probe = new E.Engine();    // 只做算杀检查，不共用置换表免得互相污染

// 分析用参数：不查开局库（要的是引擎自己的判断），不压开局用时
const OPTS = { level: 'master', useBook: false, timeMin: MS, timeMax: MS, fastOpening: false };

/** 某个局面对 role 而言值多少分。从子节点搜，保证两个候选着法可比。 */
function scoreAfter(b, role, mv) {
  b.put(mv, role);
  if (b.lastMoveWins()) { b.undo(); return E.WIN; }
  eng.reset();
  const r = eng.bestMove(b, 3 - role, OPTS);
  b.undo();
  return -r.score;
}

/** role 现在有没有算杀？返回制胜点或 -1 */
function killFor(b, role) {
  const vcf = probe.vcfFrom(b, role, 16, 400);
  if (vcf >= 0) return { p: vcf, kind: 'VCF' };
  const vct = probe.runVct(b, role, 14, 120000, 700);
  return vct >= 0 ? { p: vct, kind: 'VCT' } : null;
}

const board = new C.Board();
const rows = [];
let winner = 0, winPly = 0;

console.log(`${SIZE} 路，共 ${moves.length} 手，每手搜 ${MS}ms\n`);

for (let i = 0; i < moves.length; i++) {
  const role = i % 2 === 0 ? C.BLACK : C.WHITE;
  const opp = 3 - role;
  const mv = moves[i];
  if (board.cells[mv] !== C.EMPTY) {
    console.error(`第 ${i + 1} 手 ${C.pToLabel(mv)} 落在已有子上，棋谱有问题`);
    break;
  }

  // 走之前：这一方有没有现成的杀？走之前对手是不是已经有杀了？
  const myKill = killFor(board, role);
  const oppKillBefore = killFor(board, opp);

  // 引擎推荐 + 两手同深度对比
  eng.reset();
  const rec = eng.bestMove(board, role, OPTS);
  const sPlayed = scoreAfter(board, role, mv);
  const sRec = mv === rec.move ? sPlayed : scoreAfter(board, role, rec.move);

  board.put(mv, role);
  const won = board.lastMoveWins();
  const oppKillAfter = won ? null : killFor(board, opp);

  rows.push({
    ply: i + 1,
    side: role === C.BLACK ? '黑' : '白',
    played: C.pToLabel(mv),
    rec: C.pToLabel(rec.move),
    same: mv === rec.move,
    loss: Math.max(0, sRec - sPlayed),
    // 走之前有杀却没走 = 漏杀
    missed: myKill && mv !== myKill.p ? myKill : null,
    // 走之前对手没杀，走完就有了 = 送杀（走之前就有的话不赖这一手）
    gave: oppKillAfter && !oppKillBefore ? oppKillAfter : null,
    lost: !!oppKillBefore
  });

  const r = rows[rows.length - 1];
  let tag = r.same ? '=' : ` (引擎: ${r.rec}  -${r.loss})`;
  if (r.missed) tag += `  [漏杀! ${r.missed.kind} ${C.pToLabel(r.missed.p)}]`;
  if (r.gave) tag += `  [送杀! 对手 ${r.gave.kind} ${C.pToLabel(r.gave.p)}]`;
  process.stdout.write(`${String(i + 1).padStart(3)}. ${r.side} ${r.played}${tag}\n`);

  if (won) { winner = role; winPly = i + 1; break; }
}

console.log('\n' + '='.repeat(60));
if (winner) console.log(`第 ${winPly} 手 ${winner === C.BLACK ? '黑' : '白'}棋五连获胜`);
else console.log('棋谱走完，没有五连');

const miss = rows.filter(r => r.missed);
const gave = rows.filter(r => r.gave);
console.log(`\n漏杀 ${miss.length} 处，送杀 ${gave.length} 处`);
for (const r of miss) console.log(`  第 ${r.ply} 手 ${r.side} 走了 ${r.played}，当时 ${r.missed.kind} 杀于 ${C.pToLabel(r.missed.p)}`);
for (const r of gave) console.log(`  第 ${r.ply} 手 ${r.side} 走了 ${r.played}，之后对手 ${r.gave.kind} 杀于 ${C.pToLabel(r.gave.p)}`);

const worst = rows.filter(r => r.loss >= LOSS_GATE).sort((a, b) => b.loss - a.loss).slice(0, TOP);
console.log(`\n分差最大的 ${worst.length} 手（门槛 ${LOSS_GATE}）:`);
for (const r of worst) {
  console.log(`  第 ${String(r.ply).padStart(2)} 手 ${r.side} ${r.played} -> 引擎推荐 ${r.rec}，分差 ${r.loss}`);
}

// 双方各自的平均分差：谁的失误更多，一眼就能看出来
for (const s of ['黑', '白']) {
  const rs = rows.filter(r => r.side === s);
  if (!rs.length) continue;
  const sum = rs.reduce((a, r) => a + Math.min(r.loss, 20000), 0);
  const agree = rs.filter(r => r.same).length;
  console.log(`\n${s}方 ${rs.length} 手：与引擎一致 ${agree} 手 (${(agree / rs.length * 100).toFixed(0)}%)，` +
              `平均分差 ${(sum / rs.length).toFixed(0)}`);
}
