/*
 * learn.js — 从实战日志里吸取经验，补进开局库
 *
 * 和 gen-openings.js 的分工：
 *   gen-openings  穷举**所有**不等价开局（到第 5 手），保证任何开局都有得查
 *   learn（本工具）沿着**真人实际走过的路**往深里补，外加他们的近邻变化
 *
 * 为什么需要后者：穷举到第 5 手之后分支就爆了（每 2 层乘 27~40 倍），
 * 再往深处穷举没有可能。但真人的开局分布远比全集窄 —— 实战日志里那些线路
 * 才是真正会被用到的。沿着它们补，等于把有限的算力花在真会遇到的局面上。
 *
 * 每个局面用**比实战长得多**的预算深算（默认 8 秒 vs 实战的几百毫秒），
 * 所以库里的着法严格强于现场临时算出来的 —— 这也是敢把 maxPly 放宽的前提。
 *
 * 用法:
 *   node learn.js --dry                    # 只看会补哪些局面，不动库
 *   node learn.js --ply 10 --ms 8000       # 真的补
 *
 *   --ply   补到第几手（默认 10；库的查询上限见 book.js 的 maxPly）
 *   --ms    每个局面深算多少毫秒（默认 8000）
 *   --near  连对手的哪些变着一起补：0=只补实战走过的，1=外加一层近邻（默认 1）
 *   --logs  日志目录（默认 ../logs）
 *   --dry   只统计，不写库
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
const has = n => process.argv.indexOf('--' + n) > 0;

const MAX_PLY = parseInt(arg('ply', 10), 10);
const MS = parseInt(arg('ms', 8000), 10);
const NEAR = parseInt(arg('near', 1), 10);
const DRY = has('dry');
const LOGDIR = path.resolve(arg('logs', path.join(__dirname, '../logs')));

// ---------- 读日志，取出所有实战棋谱 ----------
function loadGames() {
  if (!fs.existsSync(LOGDIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(LOGDIR)) {
    if (!f.endsWith('.json')) continue;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(LOGDIR, f), 'utf8')); }
    catch (e) { continue; }
    // 服务器写的是「一局一个」，浏览器导出的是「一个数组装多局」，两种都认
    for (const g of (Array.isArray(raw) ? raw : [raw])) {
      if (g && Array.isArray(g.moves) && g.moves.length >= 6 && g.size) out.push(g);
    }
  }
  return out;
}

const games = loadGames();
if (!games.length) {
  console.log(`${LOGDIR} 里没有可用的实战棋谱。先用 npm start 打几局。`);
  process.exit(0);
}

// 按棋盘尺寸分组：两个尺寸的库是分开的，坐标和对称性都不通用
const bySize = {};
for (const g of games) (bySize[g.size] = bySize[g.size] || []).push(g);
console.log(`读到 ${games.length} 局实战：` +
  Object.keys(bySize).map(s => `${s} 路 ${bySize[s].length} 局`).join('，'));

/**
 * 从一批棋谱里收集「该轮到 AI 走」的局面。
 * 返回 Map: 规范化哈希 -> { moves, role }
 *
 * 顺带把对手的近邻变着也收进来（--near）：真人下一次未必走同一手，
 * 但大概率落在附近。只补实战那一条线的话，对手稍微变一下就又查不到了。
 */
function collect(list, size) {
  C.setSize(size);
  const want = new Map();
  const seen = new Set();

  const add = (moves) => {
    if (moves.length >= MAX_PLY) return;
    const b = new C.Board();
    let bad = false;
    moves.forEach((p, i) => {
      if (b.cells[p] !== C.EMPTY) bad = true;
      else b.put(p, i % 2 === 0 ? C.BLACK : C.WHITE);
    });
    if (bad || b.lastMoveWins()) return;
    const role = moves.length % 2 === 0 ? C.BLACK : C.WHITE;
    const key = B.hashKey(C.canonicalKey(b, role).key);
    if (seen.has(key)) return;
    seen.add(key);
    want.set(key, { moves: moves.slice(), role: role, board: b });
  };

  for (const g of list) {
    const mv = g.moves.map(C.labelToP);
    if (mv.some(p => p < 0)) continue;
    for (let n = 0; n < Math.min(mv.length, MAX_PLY); n++) {
      add(mv.slice(0, n));
      // 对手那一手换成附近的点，看看换了之后的局面我们有没有准备
      if (NEAR > 0 && n > 0) {
        const b = new C.Board();
        mv.slice(0, n - 1).forEach((p, i) => b.put(p, i % 2 === 0 ? C.BLACK : C.WHITE));
        const orig = mv[n - 1];
        const ox = C.pToX(orig), oy = C.pToY(orig);
        for (let dy = -NEAR; dy <= NEAR; dy++) {
          for (let dx = -NEAR; dx <= NEAR; dx++) {
            if (!dx && !dy) continue;
            const x = ox + dx, y = oy + dy;
            if (x < 0 || y < 0 || x >= size || y >= size) continue;
            const p = C.xyToP(x, y);
            if (b.cells[p] !== C.EMPTY) continue;
            add(mv.slice(0, n - 1).concat([p]));
          }
        }
      }
    }
  }
  return want;
}

const eng = new E.Engine();
let grandNew = 0, grandHave = 0;

for (const size of Object.keys(bySize).map(Number).sort()) {
  C.setSize(size);
  const bookPath = path.join(__dirname, size === 15 ? '../data/book.json' : `../data/book${size}.json`);
  let book = { version: 1, size: size, generated: '', games: 0, maxPly: 26, entries: {} };
  if (fs.existsSync(bookPath)) {
    const old = JSON.parse(fs.readFileSync(bookPath, 'utf8'));
    if ((old.size || 15) === size) book = old;
  }

  const want = collect(bySize[size], size);
  const todo = [];
  for (const [key, v] of want) {
    if (book.entries[key] && book.entries[key][0] === v.moves.length) grandHave++;
    else todo.push([key, v]);
  }
  console.log(`\n${size} 路：实战线路上共 ${want.size} 个局面，库里已有 ${want.size - todo.length} 个，` +
              `待补 ${todo.length} 个`);
  if (DRY || !todo.length) { grandNew += todo.length; continue; }

  const t0 = Date.now();
  let done = 0;
  for (const [key, v] of todo) {
    eng.reset();
    // fastOpening:false —— 离线造库就是要在开局局面上深算，不能被开局提速上限压住
    const r = eng.bestMove(v.board, v.role, {
      level: 'master', useBook: false, fastOpening: false, timeMin: MS, timeMax: MS
    });
    const ck = C.canonicalKey(v.board, v.role);
    const cm = C.symFwd(ck.transform, C.pToX(r.move), C.pToY(r.move));
    // 条目格式 [棋子数, 着法, 局数, 胜局, 和局, 总手数]。
    // 这些是算出来的不是统计出来的，给一组中性计数：过得了 minGames 门槛即可，
    // 不去污染真实棋谱的胜率。
    book.entries[key] = [v.moves.length, cm[1] * 15 + cm[0], 4, 2, 0, 240];
    done++;
    if (done % 10 === 0 || done === todo.length) {
      const el = (Date.now() - t0) / 1000;
      console.log(`  深算 ${done}/${todo.length}  已用 ${el.toFixed(0)}s  ` +
                  `预计还要 ${((el / done) * (todo.length - done)).toFixed(0)}s`);
    }
  }
  grandNew += done;
  book.generated = new Date().toISOString();
  book.positions = Object.keys(book.entries).length;
  fs.writeFileSync(bookPath, JSON.stringify(book));
  fs.writeFileSync(bookPath.replace(/\.json$/, '.js'),
    '(function(g){g.GOMOKU_BOOKS=g.GOMOKU_BOOKS||{};g.GOMOKU_BOOKS[' + size + ']=' +
    JSON.stringify(book) + ';})(typeof self!=="undefined"?self:this);\n');
  console.log(`  ${size} 路库现有 ${book.positions} 个局面 -> ${path.basename(bookPath)}`);
}

console.log(`\n实战线路命中 ${grandHave} 个已有局面，${DRY ? '待补' : '新增'} ${grandNew} 个`);
if (DRY) console.log('（--dry 只统计，没动库。去掉它才会真的深算写入）');
