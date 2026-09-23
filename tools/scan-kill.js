/*
 * scan-kill.js — 沿着一局棋，逐手查「这时谁已经有算杀了」
 *
 * review.js 的送杀判定是「走之前没有、走之后有」，
 * 一旦杀在更早就成立了，中间每一手都会被归为「本来就已经输了」而不报。
 * 所以要定位「从哪一手开始输的」，得把整局的算杀状态画成一条线。
 *
 * 用法: node scan-kill.js --moves "..." [--size 12] [--ms 3000] [--vct 16]
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
if (arg('file', '')) text = fs.readFileSync(path.resolve(arg('file', '')), 'utf8');
const tokens = text.trim().split(/[\s,]+/).filter(Boolean);

let maxIdx = 0;
for (const t of tokens) {
  maxIdx = Math.max(maxIdx, t.toUpperCase().charCodeAt(0) - 64, parseInt(t.slice(1), 10));
}
const SIZE = parseInt(arg('size', maxIdx <= 12 ? 12 : 15), 10);
C.setSize(SIZE);

const MS = parseInt(arg('ms', 3000), 10);
const VCT_D = parseInt(arg('vct', 16), 10);
const FROM = parseInt(arg('from', 1), 10);
const TO = parseInt(arg('to', 999), 10);

const moves = tokens.map(C.labelToP);
const probe = new E.Engine();

/** 尽力搜：VCF 便宜先跑，不行再上 VCT */
function killFor(b, role) {
  const vcf = probe.vcfFrom(b, role, 20, MS);
  if (vcf >= 0) return { p: vcf, kind: 'VCF' };
  const vct = probe.runVct(b, role, VCT_D, 2000000, MS);
  return vct >= 0 ? { p: vct, kind: 'VCT' } : null;
}

const board = new C.Board();
console.log(`${SIZE} 路，逐手查算杀（每次最多 ${MS}ms，VCT 深度 ${VCT_D}）`);
console.log('「黑有杀」= 此刻轮谁走都不管，黑方存在一条强制取胜线\n');

for (let i = 0; i < moves.length; i++) {
  const role = i % 2 === 0 ? C.BLACK : C.WHITE;
  board.put(moves[i], role);
  if (board.lastMoveWins()) { console.log(`第 ${i + 1} 手 五连，结束`); break; }
  const n = i + 1;
  if (n < FROM || n > TO) continue;

  const kb = killFor(board, C.BLACK);
  const kw = killFor(board, C.WHITE);
  const turn = role === C.BLACK ? '白' : '黑';   // 下一手轮谁
  let s = `${String(n).padStart(3)}. ${role === C.BLACK ? '黑' : '白'} ${C.pToLabel(moves[i])}  轮${turn}走 | `;
  s += kb ? `黑 ${kb.kind}@${C.pToLabel(kb.p)}  ` : '黑 -        ';
  s += kw ? `白 ${kw.kind}@${C.pToLabel(kw.p)}` : '白 -';
  console.log(s);
}
