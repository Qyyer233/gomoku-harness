/*
 * build-book.js — 把棋谱“吞”成开局库
 *
 * 读 data/records/ 下的全部棋谱，对每一局的前 maxPly 手：
 *   把局面做对称规范化 -> 哈希 -> 记录「这个局面下走了哪一手、结果如何」。
 * 因为做了规范化，一条棋谱等于同时喂进了它的 8 个镜像。
 *
 * 用法:
 *   node build-book.js                          # 默认参数
 *   node build-book.js --maxPly 30 --minGames 1 --verify 400 --verifyMs 800
 *
 *   --maxPly    收录到第几手（默认 26）
 *   --minGames  局面至少出现多少次才收录（默认 1）
 *   --minMoveGames  单个着法至少被走过几次才收录（默认 2）
 *                   只有 1 局支撑的着法不过是某盘棋里随手走的一手，
 *                   留在库里只会拖慢、甚至拖弱 AI，不如交给现场搜索。
 *   --maxMoves  每个局面最多保留几种着法（默认 5）
 *   --verify N  用引擎深算校验访问量最高的 N 个局面（0 = 不校验）
 *   --verifyMs  校验时每个局面的思考毫秒数（默认 600）
 */
const fs = require('fs');
const path = require('path');
const C = require('../js/core.js');
const E = require('../js/engine.js');
const B = require('../js/book.js');
const R = require('./records.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const SIZE = parseInt(arg('size', 15), 10);
C.setSize(SIZE);
const MAX_PLY = parseInt(arg('maxPly', 26), 10);
const MIN_GAMES = parseInt(arg('minGames', 1), 10);
const MIN_MOVE_GAMES = parseInt(arg('minMoveGames', 2), 10);
const MAX_MOVES = parseInt(arg('maxMoves', 5), 10);
const VERIFY = parseInt(arg('verify', 0), 10);
const VERIFY_MS = parseInt(arg('verifyMs', 600), 10);
const RECORD_DIR = path.resolve(arg('records', path.join(__dirname, '../data/records')));
const OUT = path.resolve(arg('out', path.join(__dirname, '../data/book.json')));

console.log('读取棋谱目录: ' + RECORD_DIR);
const files = R.loadDir(RECORD_DIR);
let allGames = [];
for (const f of files) {
  console.log(`  ${path.basename(f.file)}  ${f.games.length} 局`);
  allGames = allGames.concat(f.games);
}
if (!allGames.length) {
  console.error('没有读到任何棋谱。先跑 selfplay.js，或把你的棋谱放进 data/records/');
  process.exit(1);
}
console.log(`共 ${allGames.length} 局`);

// ---------- 统计 ----------
// stats: hash -> { n, ply, moves: Map(canonMove -> [games, wins, draws, plySum]) }
const stats = new Map();
let positions = 0;

for (const game of allGames) {
  const b = new C.Board();
  const total = game.moves.length;
  const limit = Math.min(MAX_PLY, total);
  // `#o<K>`：前 K 手是外部指定的开局（Gomocup 每局的开头由赛会分配）。
  // 棋子照摆 —— 后面的局面全靠它们 —— 但**不能当成「谁选的着法」去统计**。
  // 不跳过的话，库会学到「顶尖引擎的第一手是 A10（1226 局支撑）」这种
  // 纯粹是赛制产物的东西，而且正好污染开局库唯一使用的前 8 手。
  const skip = game.openLen || 0;
  for (let ply = 0; ply < limit; ply++) {
    const role = ply % 2 === 0 ? C.BLACK : C.WHITE;
    const p = game.moves[ply];
    if (ply < skip) { b.put(p, role); continue; }

    const ck = C.canonicalKey(b, role);
    const h = B.hashKey(ck.key);

    const cm = C.symFwd(ck.transform, C.pToX(p), C.pToY(p));
    const key = cm[1] * 15 + cm[0];

    let ent = stats.get(h);
    if (!ent) { ent = { n: ply, moves: new Map() }; stats.set(h, ent); positions++; }
    let rec = ent.moves.get(key);
    if (!rec) { rec = [0, 0, 0, 0]; ent.moves.set(key, rec); }
    rec[0]++;
    if (game.winner === role) rec[1]++;
    else if (game.winner === 0) rec[2]++;
    rec[3] += total;

    b.put(p, role);
  }
}
console.log(`聚合出 ${positions} 个局面`);

// ---------- 引擎深算校验 ----------
if (VERIFY > 0) {
  console.log(`用引擎校验访问量最高的 ${VERIFY} 个局面 (每个 ${VERIFY_MS}ms)…`);
  // 重放棋谱以取回每个 hash 对应的一个实际局面
  const sample = new Map();      // hash -> {moves(前ply手), role}
  for (const game of allGames) {
    const limit = Math.min(MAX_PLY, game.moves.length);
    const b = new C.Board();
    for (let ply = 0; ply < limit; ply++) {
      const role = ply % 2 === 0 ? C.BLACK : C.WHITE;
      const h = B.hashKey(C.canonicalKey(b, role).key);
      if (!sample.has(h)) sample.set(h, { moves: game.moves.slice(0, ply), role });
      b.put(game.moves[ply], role);
    }
  }

  const ranked = [...stats.entries()]
    .map(([h, e]) => [h, e, [...e.moves.values()].reduce((s, r) => s + r[0], 0)])
    .sort((a, b) => b[2] - a[2])
    .slice(0, VERIFY);

  const eng = new E.Engine();
  let changed = 0, t0 = Date.now();
  ranked.forEach(([h, ent], i) => {
    const s = sample.get(h);
    if (!s) return;
    const b = new C.Board();
    s.moves.forEach((p, k) => b.put(p, k % 2 === 0 ? C.BLACK : C.WHITE));
    eng.reset();
    const best = eng.bestMove(b, s.role, {
      level: 'master', timeMs: VERIFY_MS, useBook: false
    });
    const ck = C.canonicalKey(b, s.role);
    const cm = C.symFwd(ck.transform, C.pToX(best.move), C.pToY(best.move));
    const key = cm[1] * 15 + cm[0];

    // 引擎推荐的着法给一票“信任票”：没有就加进去，有就加权
    let rec = ent.moves.get(key);
    if (!rec) { rec = [0, 0, 0, 0]; ent.moves.set(key, rec); changed++; }
    const bonus = Math.max(1, Math.round([...ent.moves.values()].reduce((m, r) => Math.max(m, r[0]), 0) * 0.5));
    rec[0] += bonus;
    rec[1] += bonus;                       // 引擎认可 -> 记为有利
    rec[3] += bonus * 60;
    if ((i + 1) % 25 === 0) {
      process.stdout.write(`\r  ${i + 1}/${ranked.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  });
  console.log(`\n  校验完成，新增/加权 ${changed} 个着法`);
}

// ---------- 导出 ----------
const entries = {};
let kept = 0, movesKept = 0, dropped = 0;
const perPly = new Map();
for (const [h, ent] of stats) {
  const list = [...ent.moves.entries()]
    .sort((a, b) => b[1][0] - a[1][0])
    .filter(([, rec]) => {                       // 样本不足的着法直接丢掉
      if (rec[0] >= MIN_MOVE_GAMES) return true;
      dropped++; return false;
    });
  if (!list.length) continue;
  const totalGames = list.reduce((s, [, r]) => s + r[0], 0);
  if (totalGames < MIN_GAMES) continue;
  const arr = [ent.n];
  for (const [mv, rec] of list.slice(0, MAX_MOVES)) {
    arr.push(mv, rec[0], rec[1], rec[2], rec[3]);
    movesKept++;
  }
  entries[h] = arr;
  kept++;
  perPly.set(ent.n, (perPly.get(ent.n) || 0) + 1);
}
console.log(`剔除样本 < ${MIN_MOVE_GAMES} 局的着法 ${dropped} 条`);
const plyLine = [...perPly.keys()].sort((a, b) => a - b)
  .map(k => `${k}手:${perPly.get(k)}`).join('  ');
console.log('各手数保留的局面数  ' + plyLine);

// 引擎裁定（book-rapfi.js 造的）必须原样保留下来。
// 它和这里的统计库是两种不同的知识：统计库由棋谱重建，裁定是 Rapfi
// 花几十秒一个局面算出来的，重建一次就没了 —— 那可能是几小时的机时。
let verdicts = {};
if (fs.existsSync(OUT)) {
  try {
    const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (old && old.verdicts) verdicts = old.verdicts;
  } catch (e) { /* 旧文件坏了就当没有 */ }
}
const nVerdict = Object.keys(verdicts).length;
if (nVerdict) console.log(`保留已有的引擎裁定 ${nVerdict} 条`);

// 开局库是**多个工具叠加**出来的产物（build-book 统计 + gen-openings 穷举 +
// learn 吸收实战），单跑这个脚本复现不了全部。我就是这么把一份 3152 局面的库
// 覆盖成 1577 的 —— 而且没有任何警告。所以这里挡一道：
// 条目数明显变少就停下来，要真想覆盖得显式加 --shrink。
if (fs.existsSync(OUT) && !process.argv.includes('--shrink')) {
  let oldCount = 0;
  try { oldCount = Object.keys(JSON.parse(fs.readFileSync(OUT, 'utf8')).entries || {}).length; }
  catch (e) { /* 旧文件坏了就不拦 */ }
  if (oldCount > kept * 1.05) {
    console.error(`\n已停止：现有库有 ${oldCount} 个局面，这次只会写出 ${kept} 个。`);
    console.error('开局库是多个工具叠加的结果，单跑 build-book.js 会丢掉 gen-openings/');
    console.error('book-rapfi 补进去的条目。确认要覆盖请加 --shrink。');
    process.exit(1);
  }
}

const book = {
  version: 1,
  size: SIZE,
  generated: new Date().toISOString(),
  games: allGames.length,
  maxPly: MAX_PLY,
  positions: kept,
  moves: movesKept,
  entries,
  verdicts
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(book));
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`\n开局库已生成: ${OUT}`);
console.log(`  棋谱 ${allGames.length} 局 / 局面 ${kept} 个 / 着法 ${movesKept} 条 / ${kb} KB`);

// 生成给浏览器直接 <script> 引入的版本（避免本地 file:// 下 fetch 被拦）
//
// **只装浏览器真正查得到的部分。** `Book.lookup` 对统计条目有 `maxPly` 闸门，
// 超过那个手数的条目永远不会被命中 —— 全量塞进去只是让每次开页面多解析
// 一兆多的死 JSON。引擎裁定（verdicts）不受手数限制，必须全带上。
//
// `--browserPly` 留了余量（默认比 Book.maxPly 多 8 手），这样临时调大
// maxPly 做实验时不至于静默少数据；真要长期放开，把这个值一起改大。
const BROWSER_PLY = parseInt(arg('browserPly', 26), 10);
// 门槛和 Book.lookup 里的分档保持一致：第 8 手起要求更多样本支撑。
// 达不到门槛的条目**永远不会被命中**，装进浏览器版纯属浪费解析时间。
const DEEP_PLY = parseInt(arg('deepPly', 8), 10);
const DEEP_MIN = parseInt(arg('deepMinGames', 5), 10);
const slimEntries = {};
let slimCount = 0, slimDropped = 0;
for (const h in entries) {
  const e = entries[h], n = e[0];
  if (n > BROWSER_PLY) { slimDropped++; continue; }
  const need = n >= DEEP_PLY ? DEEP_MIN : 1;
  let usable = false;
  for (let i = 1; i + 4 < e.length; i += 5) if (e[i + 1] >= need) { usable = true; break; }
  if (!usable) { slimDropped++; continue; }
  slimEntries[h] = e; slimCount++;
}
const slim = Object.assign({}, book, { entries: slimEntries, browserPly: BROWSER_PLY });

const jsOut = OUT.replace(/\.json$/, '.js');
// 注册进按棋盘边长索引的全局表，于是 12 路和 15 路的库可以并存。
// 用 self/this 而不是 window：Worker 里没有 window，写 window 会抛
// ReferenceError，后台线程就会静默地丢掉开局库。
fs.writeFileSync(jsOut,
  '(function(g){g.GOMOKU_BOOKS=g.GOMOKU_BOOKS||{};g.GOMOKU_BOOKS[' + SIZE + ']=' +
  JSON.stringify(slim) + ';})(typeof self!=="undefined"?self:this);\n');
const jskb = (fs.statSync(jsOut).size / 1024).toFixed(0);
console.log(`  浏览器版: ${jsOut}`);
console.log(`    只装查得到的 ${slimCount} 个局面（剔除 ${slimDropped} 个超深度或够不着样本门槛的）` +
            (nVerdict ? ` + 全部 ${nVerdict} 条裁定` : '') +
            `，${jskb} KB（完整库 ${kb} KB 留给 Node 工具）`);
