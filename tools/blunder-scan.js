/*
 * blunder-scan.js — 漏着扫描
 *
 * 让引擎自我对弈，每走一手就问一句：
 *   「这一手下完之后，对手是不是立刻就有算杀了？」
 * 如果是，再问：「当时有没有别的着法能避开？」
 * 两个都成立，才算真正的漏着（而不是本来就已经输了的局面）。
 *
 * 这个数字比胜率更能说明引擎的防守短板在哪：
 * VCF 漏着说明 VCF 防守没兜住，VCT 漏着说明需要更强的威胁防守。
 *
 * 用法: node blunder-scan.js [--games 12] [--level hard]
 */
const fs = require('fs');
const path = require('path');
const C = require('../js/core.js');
const E = require('../js/engine.js');
const B = require('../js/book.js');

function arg(n, d) {
  const i = process.argv.indexOf('--' + n);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
}
const GAMES = parseInt(arg('games', 12), 10);
const LEVEL = arg('level', 'hard');
const VCT_DEPTH = parseInt(arg('vctDepth', 10), 10);
const VCT_MS = parseInt(arg('vctMs', 400), 10);

let book = null;
const bp = path.join(__dirname, '../data/book.json');
if (fs.existsSync(bp)) book = B.Book.load(fs.readFileSync(bp, 'utf8'));

let seed = parseInt(arg('seed', 31337), 10) >>> 0;
const rnd = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 4294967296;
};

const probe = new E.Engine();           // 只用来检查，不参与对局
const eng = new E.Engine();
if (book) eng.setBook(book);

const stat = { moves: 0, vcfLost: 0, vctLost: 0, avoidable: 0, forced: 0 };
const samples = [];

for (let g = 0; g < GAMES; g++) {
  const b = new C.Board();
  b.put(C.xyToP(7, 7), C.BLACK);
  eng.reset();
  for (let ply = 1; ply < 200; ply++) {
    const role = ply % 2 === 0 ? C.BLACK : C.WHITE;
    const opp = 3 - role;
    let mv;
    if (ply < 4) {           // 随机铺开开局，保证每局不同
      const cand = b.emptyNear([])
        .map(p => [p, E.threatScore(b, p, role) + E.threatScore(b, p, opp) * 0.85])
        .sort((x, y) => y[1] - x[1]).slice(0, 8);
      mv = cand[Math.floor(rnd() * cand.length) % cand.length][0];
    } else {
      mv = eng.bestMove(b, role, { level: LEVEL, useBook: true, bookRandom: 1 }).move;
    }
    if (b.cells[mv] !== C.EMPTY) break;

    // 走之前先看：这个局面是不是本来就已经被对手算死了？
    let alreadyLost = false;
    if (ply >= 4) {
      alreadyLost = probe.runVct(b, opp, VCT_DEPTH, 60000, VCT_MS) >= 0;
    }

    b.put(mv, role);
    if (b.lastMoveWins()) break;

    if (ply >= 4) {
      stat.moves++;
      const vcf = probe.vcfFrom(b, opp, 12, VCT_MS);
      const vct = vcf >= 0 ? vcf : probe.runVct(b, opp, VCT_DEPTH, 60000, VCT_MS);
      if (vct >= 0) {
        if (vcf >= 0) stat.vcfLost++; else stat.vctLost++;
        if (alreadyLost) {
          stat.forced++;             // 走之前就已经输了，不赖这一手
        } else {
          stat.avoidable++;
          if (samples.length < 6) {
            samples.push({
              moves: b.history.map(C.pToLabel).join(' '),
              side: role === C.BLACK ? '黑' : '白',
              played: C.pToLabel(mv),
              kill: C.pToLabel(vct),
              kind: vcf >= 0 ? 'VCF' : 'VCT'
            });
          }
        }
      }
    }
  }
  process.stdout.write(`\r对局 ${g + 1}/${GAMES}  已检查 ${stat.moves} 手`);
}

console.log('\n');
console.log(`难度 ${LEVEL}，检查 ${stat.moves} 手`);
console.log(`  走完后对手有杀: ${stat.vcfLost + stat.vctLost} 手 (VCF ${stat.vcfLost} / VCT ${stat.vctLost})`);
console.log(`    其中走之前就已经输了: ${stat.forced} 手（不算漏着）`);
console.log(`    真正的漏着:           ${stat.avoidable} 手  = ${(stat.avoidable / Math.max(1, stat.moves) * 100).toFixed(2)}%`);
if (samples.length) {
  console.log('\n漏着样本:');
  for (const s of samples) {
    console.log(`  ${s.side}走 ${s.played} 后，对手 ${s.kind} 杀于 ${s.kill}`);
    console.log(`    ${s.moves}`);
  }
}
