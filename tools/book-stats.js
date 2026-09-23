// book-stats.js — 看开局库的样本分布：哪些深度的着法是“有据可依”的
const fs = require('fs');
const path = require('path');
const B = require('../js/book.js');

const bookPath = path.resolve(process.argv[2] || path.join(__dirname, '../data/book.json'));
const book = B.Book.load(fs.readFileSync(bookPath, 'utf8'));

// 按棋子数（= 手数）统计
const byPly = new Map();
for (const key of Object.keys(book.entries)) {
  const e = book.entries[key];
  const ply = e[0];
  let top = 0, total = 0, variants = 0;
  for (let i = 1; i + 4 < e.length; i += 5) {
    total += e[i + 1];
    top = Math.max(top, e[i + 1]);
    variants++;
  }
  const s = byPly.get(ply) || { positions: 0, total: 0, topSum: 0, variants: 0, thin: 0 };
  s.positions++; s.total += total; s.topSum += top; s.variants += variants;
  if (top < 2) s.thin++;
  byPly.set(ply, s);
}

console.log(`开局库: ${book.meta.positions} 局面 / 来自 ${book.meta.games} 局棋谱\n`);
console.log('手数  局面数   最佳着法平均样本   只有1局支撑的局面占比');
console.log('----  -------  ----------------   --------------------');
let cumThin = 0, cumPos = 0;
[...byPly.keys()].sort((a, b) => a - b).forEach(ply => {
  const s = byPly.get(ply);
  cumThin += s.thin; cumPos += s.positions;
  console.log(
    String(ply).padStart(3) + '   ' +
    String(s.positions).padStart(6) + '   ' +
    (s.topSum / s.positions).toFixed(1).padStart(12) + '       ' +
    (s.thin / s.positions * 100).toFixed(0).padStart(5) + '%');
});
console.log(`\n全库中「只有 1 局支撑」的局面占 ${(cumThin / cumPos * 100).toFixed(1)}%`);
console.log('样本 <2 的着法本质上只是“引擎当时随手下的一手”，不比现场搜索更可信，');
console.log('所以运行时会用 Book.minGames 把它们过滤掉，交给搜索处理。');
