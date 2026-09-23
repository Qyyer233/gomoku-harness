// 开局库自检：命中率、对称等价、与引擎的衔接
// 用法: node test-book.js [book.json 路径] [棋谱目录]
const fs = require('fs');
const path = require('path');
const C = require('../js/core.js');
const E = require('../js/engine.js');
const B = require('../js/book.js');
const R = require('./records.js');

const bookPath = path.resolve(process.argv[2] || path.join(__dirname, '../data/book.json'));
const recDir = path.resolve(process.argv[3] || path.join(__dirname, '../data/records'));

if (!fs.existsSync(bookPath)) {
  console.error('找不到开局库: ' + bookPath + '\n先跑 node tools/build-book.js');
  process.exit(1);
}
const book = B.Book.load(fs.readFileSync(bookPath, 'utf8'));
console.log(`开局库: ${book.meta.positions} 局面 / ${book.meta.moves} 着法 / 来自 ${book.meta.games} 局棋谱\n`);

let fail = 0;
const check = (ok, msg, extra) => {
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}${extra ? '  ' + extra : ''}`);
};

// ---------- 1. 命中率：沿着录入过的棋谱走，库应当一路命中 ----------
const files = R.loadDir(recDir);
const games = files.flatMap(f => f.games);
if (!games.length) { console.error('棋谱目录为空: ' + recDir); process.exit(1); }

// 注意：整体命中率**本来就不该是 100%**，有两道刻意的闸门：
//   1. 样本不足的着法被 minMoveGames / Book.minGames 剔除；
//   2. 超过 Book.maxPly 的局面根本不查库 —— 棋谱由自对弈产生，
//      现场搜索一旦强过造谱时的引擎，深层库着法就会拖后腿
//      （实测不设这道闸门会让困难档从 62.5% 掉到 40.0%）。
// 所以这里按手数分段看，并且分别断言「开局要命中」和「超深度要不命中」。
// 最后一段要**越过** Book.maxPly，否则「超出深度就不查库」那条断言没有样本可验
const buckets = [[0, 4], [4, 8], [8, 14], [14, 26], [26, 40]];
const tally = buckets.map(() => ({ probes: 0, hits: 0 }));
// 等距取样，而不是 `slice(0, 400)`。
// 语料里现在混了 Gomocup 的比赛对局，而它们在目录里排在最前面 ——
// 取前 400 局的话整个样本都是它们，量到的东西就跑偏了。
const stride = Math.max(1, Math.floor(games.length / 400));
const sample = games.filter((_, i) => i % stride === 0).slice(0, 400);

for (const g of sample) {
  const b = new C.Board();
  // 探到第 40 手 —— 必须越过 Book.maxPly，否则「超出深度就不查库」没样本可验
  const limit = Math.min(40, g.moves.length);
  // `#o<K>`：前 K 手是赛会**指定**的开局，不是任何人的选择，
  // 造库时就跳过了（见 build-book.js），所以这里也不能拿它们问命中率 ——
  // 那等于在问「库记没记住我们故意没记的东西」。
  const skip = g.openLen || 0;
  for (let ply = 0; ply < limit; ply++) {
    const role = ply % 2 === 0 ? C.BLACK : C.WHITE;
    const bi = buckets.findIndex(([lo, hi]) => ply >= lo && ply < hi);
    if (bi >= 0 && ply >= skip) {
      tally[bi].probes++;
      if (book.lookup(b, role, 0)) tally[bi].hits++;
    }
    b.put(g.moves[ply], role);
  }
}
buckets.forEach(([lo, hi], i) => {
  const t = tally[i];
  const rate = t.probes ? t.hits / t.probes : 0;
  console.log(`       第 ${lo}-${hi - 1} 手命中率 ${(rate * 100).toFixed(1)}%  (${t.hits}/${t.probes})`);
});
const openRate = tally[0].hits / Math.max(1, tally[0].probes);
check(openRate > 0.9, '开局(前 4 手)几乎必然命中', `${(openRate * 100).toFixed(1)}%`);
// 超过 maxPly 必须一手都不命中，否则那道闸门就是漏的
let beyond = 0, beyondProbes = 0;
buckets.forEach(([lo], i) => {
  if (lo >= book.maxPly) { beyond += tally[i].hits; beyondProbes += tally[i].probes; }
});
check(beyondProbes > 0 && beyond === 0,
  `第 ${book.maxPly} 手之后不再查库（交给搜索）`, `${beyond}/${beyondProbes} 命中`);

// ---------- 2. 对称等价 ----------
// 判据不是“字面镜像”：完全对称的局面（空盘、只有天元一子）本身有多个等价规范形，
// 库返回的是等价着法。正确的不变量是：镜像输入落子后，局面的规范键必须相同。
function mirrorGame(moves, t) {
  return moves.map(p => {
    const q = C.symFwd(t, C.pToX(p), C.pToY(p));
    return C.xyToP(q[0], q[1]);
  });
}
let symOk = true, symTested = 0, symBad = '';
for (const g of sample.slice(0, 12)) {
  for (let t = 1; t < 8; t++) {
    const mm = mirrorGame(g.moves, t);
    const b0 = new C.Board(), b1 = new C.Board();
    const limit = Math.min(10, g.moves.length);
    for (let ply = 0; ply < limit; ply++) {
      const role = ply % 2 === 0 ? C.BLACK : C.WHITE;
      const r0 = book.lookup(b0, role, 0);
      const r1 = book.lookup(b1, role, 0);
      if (!!r0 !== !!r1) {
        symOk = false; symBad = `第 ${ply} 手命中情况不一致`;
      } else if (r0 && r1) {
        symTested++;
        b0.put(r0.move, role); b1.put(r1.move, role);
        const k0 = C.canonicalKey(b0, 3 - role).key;
        const k1 = C.canonicalKey(b1, 3 - role).key;
        b0.undo(); b1.undo();
        if (k0 !== k1) { symOk = false; symBad = `第 ${ply} 手 (变换 ${t}) 结果局面不等价`; }
      }
      b0.put(g.moves[ply], role);
      b1.put(mm[ply], role);
    }
  }
}
check(symOk && symTested > 50, '镜像/旋转后的局面给出等价着法',
  `比对 ${symTested} 次${symBad ? ' — ' + symBad : ''}`);

// ---------- 3. 库里的着法都是合法空点 ----------
let legal = true, checked = 0;
for (const g of sample) {
  const b = new C.Board();
  const limit = Math.min(book.meta.maxPly, g.moves.length);
  for (let ply = 0; ply < limit; ply++) {
    const role = ply % 2 === 0 ? C.BLACK : C.WHITE;
    for (const alt of book.probe(b, role)) {
      checked++;
      if (b.cells[alt.move] !== C.EMPTY) legal = false;
    }
    b.put(g.moves[ply], role);
  }
}
check(legal, '库中着法全部落在空点上', `检查 ${checked} 条`);

// ---------- 4. 库不会盖掉战术（必胜/必挡永远优先） ----------
const eng = new E.Engine();
eng.setBook(book);
const tb = new C.Board();
[['H8', C.BLACK], ['A1', C.WHITE], ['I8', C.BLACK], ['A2', C.WHITE],
 ['J8', C.BLACK], ['A3', C.WHITE], ['K8', C.BLACK], ['B1', C.WHITE]]
  .forEach(([s, r]) => tb.put(C.labelToP(s), r));
const must = eng.bestMove(tb, C.BLACK, { level: 'hard', useBook: true });
check(['G8', 'L8'].includes(C.pToLabel(must.move)),
  '四连局面必定成五（不被开局库覆盖）', `${C.pToLabel(must.move)} [${must.source}]`);

// ---------- 5. 开局速度 ----------
const b2 = new C.Board();
let t0 = Date.now(), n = 0, bookHits = 0;
for (let ply = 0; ply < 16; ply++) {
  const role = ply % 2 === 0 ? C.BLACK : C.WHITE;
  const r = eng.bestMove(b2, role, { level: 'hard', useBook: true, bookRandom: 0 });
  if (r.source === 'book' || r.source === 'opening') bookHits++;
  n++;
  b2.put(r.move, role);
  if (b2.lastMoveWins()) break;
}
console.log(`\n  开局 ${n} 手总耗时 ${Date.now() - t0}ms，其中 ${bookHits} 手来自开局库/定式`);

console.log(fail === 0 ? '\n全部通过' : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
