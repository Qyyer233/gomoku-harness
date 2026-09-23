/*
 * import-rif.js — 导入 RenjuNet 的 .rif 对局库
 *
 * RenjuNet（renju.net）提供全库免费下载，文件名形如 renjunet_v10_YYYYMMDD.rif，
 * 是 XML 格式，每日更新，收录了几十万盘正式比赛对局。
 *
 * 用法:
 *   node tools/import-rif.js <renjunet_v10_20260101.rif> [--out ../data/records/renjunet.txt]
 *   node tools/build-book.js --minMoveGames 2
 *
 * ── 两个必须知道的前提 ─────────────────────────────────────────
 *
 * 1. 授权限制。RenjuNet 的下载条款原文是：
 *      "I agree to use this database for non-commercial purposes in the forms of
 *       OFFLINE databases only. It is forbidden to use any contents of this
 *       database or its modifications in any website or ONLINE system."
 *    也就是说：自己本地离线玩没问题，但**不能把由它生成的开局库发布到网站上**。
 *    所以这个脚本默认把结果写进 data/records/，要不要打包进 data/book.js 由你决定。
 *
 * 2. 规则不同。RenjuNet 是**连珠（有禁手）**对局，黑棋受三三/四四/长连限制，
 *    开局理论跟本项目的无禁手自由规则并不一致。里面的着法质量很高，
 *    但「黑棋为什么不走某处」的理由在自由规则下可能并不成立。
 *    建议配合 build-book.js 的 --minMoveGames 使用，并且别把 Book.maxPly 调得太大。
 *
 * ── 关于棋盘方向 ───────────────────────────────────────────────
 * 不用担心。开局库入库前会做 8 种对称规范化，整盘棋旋转/翻转不影响结果。
 */
const fs = require('fs');
const path = require('path');
const C = require('../js/core.js');
const R = require('./records.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

const src = process.argv[2];
if (!src || src.startsWith('--')) {
  console.error('用法: node tools/import-rif.js <renjunet_v10_YYYYMMDD.rif> [--out 输出文件]');
  console.error('      .rif 从 https://www.renju.net/downloads/games.php 下载（需同意其使用条款）');
  process.exit(1);
}
if (!fs.existsSync(src)) { console.error('找不到文件: ' + src); process.exit(1); }

const OUT = path.resolve(arg('out', path.join(__dirname, '../data/records/renjunet.txt')));
const MIN_MOVES = parseInt(arg('minMoves', 8), 10);

console.log('读取 ' + src + ' …');
const xml = fs.readFileSync(src, 'utf8');

/*
 * .rif 里每盘棋形如：
 *   <game id="123" rule="1" black="45" white="67" bresult="1" ...>
 *     <move>h8 i9 j10 ...</move>
 *   </game>
 * 着法是空格分隔的字母坐标，正是 records.js 已经认识的写法。
 * bresult: 1 = 黑胜，0 = 白胜，0.5 = 和。
 */
const GAME_RE = /<game\b([^>]*)>([\s\S]*?)<\/game>/g;
const MOVE_RE = /<move>([\s\S]*?)<\/move>/;
const RESULT_RE = /bresult\s*=\s*"([^"]*)"/;
const RULE_RE = /rule\s*=\s*"([^"]*)"/;

let total = 0, kept = 0, skipped = 0, byRule = {};
const lines = [];

let m;
while ((m = GAME_RE.exec(xml))) {
  total++;
  const attrs = m[1], body = m[2];
  const mv = MOVE_RE.exec(body);
  if (!mv) { skipped++; continue; }

  const coords = R.extractMoves(mv[1]);
  if (coords.length < MIN_MOVES) { skipped++; continue; }

  const rr = RESULT_RE.exec(attrs);
  let declared = null;
  if (rr) {
    const v = rr[1].trim();
    if (v === '1') declared = C.BLACK;
    else if (v === '0') declared = C.WHITE;
    else if (v === '0.5') declared = 0;
  }

  const ru = RULE_RE.exec(attrs);
  if (ru) byRule[ru[1]] = (byRule[ru[1]] || 0) + 1;

  const g = R.replay(coords, declared);
  if (!g) { skipped++; continue; }         // 非法棋谱（重复落子等）自动丢弃

  lines.push(R.formatGame(g.moves, g.winner));
  kept++;
  if (kept % 20000 === 0) process.stdout.write(`\r  已转换 ${kept} 局…`);
}

if (!kept) {
  console.error('\n一盘都没解析出来。确认这是 RenjuNet 的 .rif 文件（XML，含 <game>…<move> 标签）。');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n') + '\n');

console.log(`\n共 ${total} 盘，转换 ${kept} 盘，跳过 ${skipped} 盘（着法太少或棋谱非法）`);
const ruleList = Object.keys(byRule).sort((a, b) => byRule[b] - byRule[a]).slice(0, 6);
if (ruleList.length) {
  console.log('规则分布(rule 属性): ' + ruleList.map(k => `${k}=${byRule[k]}`).join('  '));
}
console.log('输出 -> ' + OUT);
console.log('\n接下来跑: node tools/build-book.js --minMoveGames 2');
console.log('提醒：RenjuNet 的条款禁止把它的内容用于任何网站/在线系统，本地离线使用不受影响。');
