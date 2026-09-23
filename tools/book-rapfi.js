/*
 * book-rapfi.js — 用 Rapfi 离线造开局库
 *
 * 这是这个项目真正在积累的东西。逻辑很简单：
 *
 *   离线（不限时间）：Rapfi 每个局面算够久 -> 最正确的一手 -> 写进棋谱库
 *   在线（15 秒读秒）：查库命中 -> 0ms 直出，开局一路不用思考
 *
 * 比赛规则禁止引擎带开局库，所以 Rapfi 自己不带 —— 于是「开局就长思考，
 * 一直长思考」。我们没有这个限制，Rapfi 越强，灌进库里的开局就越正确。
 *
 * 和 build-book.js 的区别（两者并存、互不覆盖）：
 *   build-book.js  从**棋谱统计**造库 -> book.entries，受 maxPly=8 限制
 *   book-rapfi.js  从**引擎裁定**造库 -> book.verdicts，不受手数限制
 * 为什么裁定可以不限手数：maxPly 那道闸门是防「造谱的引擎比现场搜索弱」，
 * 而这里造谱的就是 Rapfi 本体，且给的时间比实战多一个数量级。
 *
 * 用法：
 *   node tools/book-rapfi.js --size 12 --ms 8000 --depth 8 --width 3
 *   node tools/book-rapfi.js --size 12 --ms 15000 --from-logs      # 吸收实战局面
 *   node tools/book-rapfi.js --size 12 --dry                        # 只看会算多少个局面
 *
 * 可以反复跑：已经有裁定的局面会跳过（--redo 强制重算），所以随时中断、随时续。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../js/core.js');
const B = require('../js/book.js');
const { Rapfi } = require('./rapfi.js');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : (isNaN(+v) ? v : +v);
};
const has = k => process.argv.includes('--' + k);

const SIZE   = arg('size', 12);
const MS     = arg('ms', 8000);
const DEPTH  = arg('depth', 8);        // 展开到第几手
/**
 * 每个对手节点展开前几个候选。可以写成逗号分隔的一串，**按手数索引**，
 * 最后一个值往后一直沿用：`--width 10,10,8,8,5,5,3`。
 *
 * 为什么要按手数分配：均匀的 width=3 造出来的库又深又窄 —— 铺到第 10 手，
 * 但放到真人对局上第 3 手就出库了，因为真人走的不是那 3 个候选之一。
 * 开局恰恰是**该宽不该深**的地方：分支最多，而且那里的局面最便宜
 * （棋子少、搜起来快），同一份机时买到的覆盖率高得多。
 */
const WIDTHS = String(arg('width', '3')).split(',').map(s => Math.max(1, parseInt(s, 10) || 1));
const widthAt = ply => WIDTHS[Math.min(ply, WIDTHS.length - 1)];

/**
 * `--margin N`：对手的应手里，**比最优差 N 分以上的直接不算**。
 *
 * 这比按「离棋子多远」筛准得多。走得远不等于蠢 —— 走完立刻亏分才叫蠢。
 * 实测我方 G6 之后对手第 2 手的分数分布（数值是对手视角，越高越好）：
 *
 *     F7 -237(最优)  H6 -285  H7 -347  G7 -361  H5 -388  I4 -416
 *     F8 -438  H8 -439  J5 -477  I5 -481 …… G8 -641  E8 -654
 *
 * 差 400 分那些没人会走。而更深的局面里排在后面的候选常常直接是 `-M34`
 * （对手自己被将死），那更是白算。
 *
 * 好处是它**自适应**：局面尖锐时能走的本来就少，自然收窄；平缓时才展开。
 * `--width` 退化成一个上限，真正起作用的是这条分数线。
 */
const MARGIN = arg('margin', 250);

/**
 * `--full N --radius R`：前 N 手里，对手的应手按**半径 R 穷举**，不看引擎排序。
 *
 * 为什么光有分数线不够：真人第 2 手经常走到离对方子 2~3 格的位置，而引擎的
 * 前几名全挤在贴身处。用户实战里对手走的 J8 离我方 G6 是 3 格 ——
 * **它进不了引擎前 20 名，但人就是这么走的**。这种手不算蠢，只是不最优。
 *
 * 半径要取得克制：R=3 是 27 个局面，R=4 就是 44 个，而 R=4 多出来的那些
 * （离 4 格、基本在角上）才是「特别蠢、可以放弃」的那类。
 */
const FULL_PLY = arg('full', 0);
const FULL_R   = arg('radius', 3);

/** 离已有棋子 R 格以内的全部空点 */
function allCandidates(board, R) {
  const out = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const p = C.xyToP(x, y);
      if (board.cells[p] !== C.EMPTY) continue;
      let near = false;
      for (let dy = -R; dy <= R && !near; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
          if (board.cells[C.xyToP(nx, ny)] !== C.EMPTY) { near = true; break; }
        }
      }
      if (near) out.push(p);
    }
  }
  return out;
}

/** 把候选折成一个可比的分数（对手视角），杀棋算成极值 */
function candValue(c) {
  if (c.mate) return c.mate > 0 ? 30000 - c.mate : -30000 - c.mate;
  return c.eval == null ? -30000 : c.eval;
}

/**
 * 从引擎给的候选里挑出「对手真有可能走的那些」。
 * 按分数排序 -> 砍掉比最优差 MARGIN 以上的 -> 再按 width 截断。至少留一手。
 */
function plausible(cands, width) {
  const sorted = cands.filter(c => c.xy).slice().sort((a, b) => candValue(b) - candValue(a));
  if (!sorted.length) return [];
  const best = candValue(sorted[0]);
  const keep = sorted.filter(c => best - candValue(c) <= MARGIN);
  return (keep.length ? keep : [sorted[0]]).slice(0, Math.max(1, width));
}
const THREADS = arg('threads', require('os').cpus().length);   // 离线造库，把机器用满
const DRY    = has('dry');
const REDO   = has('redo');
const MAXPOS = arg('max', 100000);

C.setSize(SIZE);

const BOOK_JSON = path.join(ROOT, 'data', SIZE === 15 ? 'book.json' : `book${SIZE}.json`);
const BOOK_JS   = BOOK_JSON.replace(/\.json$/, '.js');

/**
 * 空盘上所有**本质不同**的第一手。
 *
 * 为什么要特殊处理：空盘时 Rapfi 直接给一手就完事，根本不搜索
 * （日志里是 `第 0 手 (空盘) -> G6 · 0 层`），于是 YXNBEST 拿不到候选表，
 * 我们执白时就只覆盖了对手的 1 种开局 —— 这是个实打实的大洞。
 *
 * 而空盘恰好有完整的 8 重对称，去重之后 12 路只剩 21 种本质不同的开局，
 * 全部覆盖也就 21 次搜索。对手第一手随便下在哪，我们都有备。
 */
function distinctFirstMoves() {
  const seen = new Set(), out = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const p = C.xyToP(x, y);
      const b = new C.Board();
      b.put(p, C.BLACK);
      const h = B.hashKey(C.canonicalKey(b, C.WHITE).key);
      if (seen.has(h)) continue;
      seen.add(h);
      out.push(p);
    }
  }
  return out;
}

/* ---------------- 待分析局面的收集 ---------------- */

/** 把一条着法序列（padded 下标）上的每个局面都登记进来 */
function addLine(targets, line) {
  const b = new C.Board();
  for (let ply = 0; ply < line.length && ply <= DEPTH; ply++) {
    const role = ply % 2 === 0 ? C.BLACK : C.WHITE;
    const h = B.hashKey(C.canonicalKey(b, role).key);
    // 实战局面两种执色都登记：这一局我们执黑，下一局可能执白
    if (!targets.has(h)) targets.set(h, { moves: line.slice(0, ply), role, ply, us: role });
    if (ply < line.length) b.put(line[ply], role);
  }
}

/**
 * 从棋谱文件里收集局面（默认 data/records/）。
 *
 * 这是把「公开棋谱」和「引擎裁定」接起来的那一环：Gomocup 的对局告诉我们
 * **顶尖引擎实战中真正会走到哪些局面**，然后让 Rapfi 逐个给出最正确的一手。
 * 比单纯让 Rapfi 推演自己的主变强 —— 主变只有一条，实战分支要宽得多。
 *
 * 注意棋谱按**出现频次**排序后再截取：同一个开局在几千局里反复出现，
 * 先算那些覆盖面最大的。
 */
function fromRecords(targets, dir, topN) {
  const R = require('./records.js');
  // loadDir 返回的是 [{file, games:[...]}]，一层是文件、一层才是对局，要展平
  const games = R.loadDir(dir).reduce((a, f) => a.concat(f.games), []);
  if (!games.length) { console.log(`${dir} 里没有棋谱`); return 0; }
  // 先统计每个局面出现多少次，热门的优先
  const freq = new Map(), info = new Map();
  for (const g of games) {
    const b = new C.Board();
    for (let ply = 0; ply < g.moves.length && ply <= DEPTH; ply++) {
      const role = ply % 2 === 0 ? C.BLACK : C.WHITE;
      const h = B.hashKey(C.canonicalKey(b, role).key);
      freq.set(h, (freq.get(h) || 0) + 1);
      if (!info.has(h)) info.set(h, { moves: g.moves.slice(0, ply), role, ply, us: role });
      if (ply < g.moves.length) b.put(g.moves[ply], role);
    }
  }
  const ranked = [...freq.entries()].sort((a, b2) => b2[1] - a[1]);
  let n = 0;
  for (const [h] of ranked) {
    if (topN && n >= topN) break;
    if (!targets.has(h)) { targets.set(h, info.get(h)); n++; }
  }
  console.log(`从 ${games.length} 局棋谱里挑出 ${n} 个局面（按出现频次排序）`);
  return games.length;
}

/** 从 logs/ 里的实战棋谱收集局面 —— 吸取实战经验，拓展棋谱 */
function fromLogs(targets) {
  const dir = path.join(ROOT, 'logs');
  if (!fs.existsSync(dir)) { console.log('logs/ 不存在，跳过'); return 0; }
  let n = 0;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    let games;
    try { games = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
    for (const g of (Array.isArray(games) ? games : [games])) {
      if (!g || !Array.isArray(g.moves) || (g.size || 15) !== SIZE) continue;
      const line = g.moves.map(s => C.labelToP(s)).filter(p => p >= 0);
      if (line.length) { addLine(targets, line); n++; }
    }
  }
  return n;
}

/* ---------------- 主流程 ---------------- */

function loadBook() {
  if (!fs.existsSync(BOOK_JSON)) return { version: 3, size: SIZE, games: 0, maxPly: 0, entries: {}, verdicts: {} };
  const d = JSON.parse(fs.readFileSync(BOOK_JSON, 'utf8'));
  if (!d.verdicts) d.verdicts = {};
  return d;
}

function saveBook(data) {
  data.verdictsUpdated = new Date().toISOString();
  fs.writeFileSync(BOOK_JSON, JSON.stringify(data));
  // 浏览器和 Worker 都没有 require，所以另存一份 .js。
  // **格式必须和 build-book.js 写出来的完全一致**，否则两个工具轮流跑就会
  // 产生两种格式的文件。用 self/this 而不是 window —— Worker 里没有 window，
  // 写 window 会抛 ReferenceError，后台线程静默丢掉开局库。
  fs.writeFileSync(BOOK_JS,
    '(function(g){g.GOMOKU_BOOKS=g.GOMOKU_BOOKS||{};g.GOMOKU_BOOKS[' + SIZE + ']=' +
    JSON.stringify(data) + ';})(typeof self!=="undefined"?self:this);\n');
}

async function main() {
  const book = loadBook();
  const before = Object.keys(book.verdicts).length;

  // 1) 先把要分析的局面收齐。
  //
  // 两棵树：我们执黑一棵，执白一棵。**分支只发生在对手的回合** ——
  // 轮到我们时只有一手（就是裁定的那一手），轮到对手时才要把前 width 种应手都展开。
  // 这把树从 width^深度 降到 2 × width^(深度/2)，是能不能造到第 10 手的关键。
  const targets = new Map();       // hash -> {moves(padded), role, ply, us}
  for (const us of [C.BLACK, C.WHITE])
    targets.set('root-' + us, { moves: [], role: C.BLACK, ply: 0, us });
  let logGames = 0;
  if (has('from-logs')) logGames = fromLogs(targets);
  let recGames = 0;
  if (has('from-records')) {
    const dir = path.join(ROOT, 'data', SIZE === 15 ? 'records' : `records${SIZE}`);
    recGames = fromRecords(targets, dir, arg('top', 2000));
  }

  console.log(`${SIZE} 路 · 每局面 ${MS}ms · 展开到第 ${DEPTH} 手 · 对手节点宽度 ${WIDTHS.join(",")}`);
  if (logGames) console.log(`已从 logs/ 收进 ${logGames} 局实战棋谱的局面`);
  console.log(`现有裁定 ${before} 条${REDO ? '（--redo：全部重算）' : '（已有的会跳过）'}\n`);

  if (DRY) {
    console.log(`起始待分析局面 ${targets.size} 个（--expand 展开后会更多）`);
    return;
  }

  const eng = new Rapfi({ threads: THREADS, pondering: false, showDetail: true });
  await eng.start();
  await eng.newGame(SIZE);
  if (eng.nnueActive === false)
    console.log('⚠ 警告：这个尺寸上 NNUE 没启用，造出来的库质量会打折（见 engines/rapfi/README.md）');

  // 2) 广度优先展开：每个局面问一次 Rapfi，答案入库，前 widthAt(ply) 个候选作为子局面
  const queue = [...targets.values()];
  const done = new Set();               // 「hash|执色」，同一局面两种执色要分别展开
  let n = 0, added = 0, skipped = 0, t0 = Date.now();

  while (queue.length && n + skipped < MAXPOS) {
    const node = queue.shift();
    const b = new C.Board();
    for (let i = 0; i < node.moves.length; i++) b.put(node.moves[i], i % 2 === 0 ? C.BLACK : C.WHITE);
    const ck = C.canonicalKey(b, node.role);
    const h = B.hashKey(ck.key);
    const tag = h + '|' + node.us;
    if (done.has(tag)) continue;
    done.add(tag);

    // 轮到我们时只走一手；轮到对手时把「说得过去的应手」都备好
    // （按分数筛，见 plausible / MARGIN —— 明显亏的不算）。
    const ourTurn = node.role === node.us;
    // 穷举节点不需要引擎给候选表，multiPV=1 就够（反而更快、更深）
    const full = !ourTurn && node.ply < FULL_PLY && node.ply < DEPTH && node.moves.length > 0;
    const branch = (node.ply >= DEPTH) ? 0 : (ourTurn || full ? 1 : widthAt(node.ply));

    const existing = book.verdicts[h];
    if (existing && existing[0] === node.moves.length && !REDO && branch <= 1) {
      // 只有「不需要引擎给候选表」的节点才能靠已有裁定跳过；
      // 要按引擎排序展开多路分支时光有裁定不够，还得重搜一次拿候选。
      skipped++;
      if (branch === 1) {
        // 穷举节点的子局面不看引擎排序，所以跳过重搜照样能往下铺；
        // 我们自己的节点则只有裁定那一手
        let kids;
        if (full) kids = allCandidates(b, FULL_R);
        else {
          const real = C.symInv(ck.transform, existing[1] % 15, (existing[1] / 15) | 0);
          kids = [C.xyToP(real[0], real[1])];
        }
        for (const p of kids) {
          if (b.cells[p] !== C.EMPTY) continue;
          queue.push({ moves: node.moves.concat([p]), role: node.role === C.BLACK ? C.WHITE : C.BLACK,
                       ply: node.ply + 1, us: node.us });
        }
      }
      continue;
    }

    const xy = node.moves.map(p => [C.pToX(p), C.pToY(p)]);
    let r;
    try {
      r = await eng.analyse(xy, MS, Math.max(1, branch));
    } catch (e) {
      console.log(`  第 ${node.ply} 手局面分析失败：${e.message}`);
      continue;
    }

    // 裁定：引擎最终给出的那一手（analyse 保证 cands[0] 就是它）
    const best = r.cands[0];
    const cm = C.symFwd(ck.transform, best.xy[0], best.xy[1]);
    book.verdicts[h] = [
      node.moves.length,                 // 棋子数，防哈希碰撞（和 entries 一致）
      cm[1] * 15 + cm[0],                // 规范坐标下的着法
      best.mate ? (best.mate > 0 ? 30000 : -30000) : (best.eval | 0),
      r.depth | 0,
      MS
    ];
    added++; n++;

    // **中途落盘。** 这活儿要跑一两个小时，原先只在结束时写一次 ——
    // 断电、断网、误关窗口，前面几千个局面的算力全部作废。
    // 每 100 个存一档；saveBook 是整文件覆盖写，100 次的额外开销可以忽略。
    if (added % 100 === 0) {
      saveBook(book);
      console.log(`  —— 已存档：新增 ${added} 条裁定，共 ${Object.keys(book.verdicts).length} 条 ——`);
    }

    // 3) 展开子局面。两道筛子叠加：
    //    - 前 FULL_PLY 手：对手的应手按**半径**穷举（真人第 2 手常走到 2~3 格外，
    //      而引擎的前几名都挤在贴身处 —— 实测用户对手走的 J8 就落在半径 3 上、
    //      却进不了引擎前 20 名）；
    //    - 之后：按**分数**筛（`plausible`），明显亏的不算。
    //    空盘是特例：Rapfi 在空盘上不搜索、给不出候选表，改用「全部本质不同的
    //    第一手」（12 路 21 种，一次性成本，保证不被开局偷袭）。
    const kids =
      node.moves.length === 0 && branch > 1 ? distinctFirstMoves()
      : full                                ? allCandidates(b, FULL_R)
      : (branch <= 1 ? r.cands.slice(0, branch) : plausible(r.cands, branch))
          .map(c => C.xyToP(c.xy[0], c.xy[1]));

    const label = p => C.pToLabel(p);
    const bestP = C.xyToP(best.xy[0], best.xy[1]);
    const line = node.moves.map(label).join(' ');
    console.log(
      `  [${String(n + skipped).padStart(4)}] ${node.us === C.BLACK ? '黑' : '白'} ` +
      `第 ${String(node.ply).padStart(2)} 手 ${(line || '(空盘)').padEnd(30).slice(0, 30)} ` +
      `-> ${label(bestP).padEnd(4)} ${best.mate ? 'M' + best.mate : (best.eval | 0)} · ` +
      `${r.depth} 层 · ${(r.ms / 1000).toFixed(1)}s · 队列 ${queue.length}` +
      // 打**真正展开的那些**，不是引擎的原始候选 —— 早先这里打的是后者，
      // 看上去像是筛选没生效，白白查了半天
      (kids.length > 1 ? `  展开 ${kids.length} 手` : ''));

    for (const p of kids) {
      if (b.cells[p] !== C.EMPTY) continue;
      queue.push({
        moves: node.moves.concat([p]),
        role: node.role === C.BLACK ? C.WHITE : C.BLACK,
        ply: node.ply + 1,
        us: node.us
      });
    }

    if (added % 20 === 0) saveBook(book);   // 随时可中断，进度不丢
  }

  eng.stop();
  saveBook(book);
  const secs = (Date.now() - t0) / 1000;
  console.log(`\n新增/更新裁定 ${added} 条，跳过已有 ${skipped} 条，` +
              `现在共 ${Object.keys(book.verdicts).length} 条（原 ${before}）`);
  console.log(`用时 ${(secs / 60).toFixed(1)} 分钟，已写入 ${path.relative(ROOT, BOOK_JSON)} 和 .js`);
}

main().catch(e => { console.error(e); process.exit(1); });
