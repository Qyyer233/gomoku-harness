/*
 * memo-seed.js — 用实战日志预热记忆库
 *
 * 做什么
 * ------
 * 把 logs/ 里我方真正面临过的局面挑出来，用**远超实战的时间**重算一遍，
 * 结果存进记忆库。下次再走到同一个局面，0ms 直出，而且比当场算的更强。
 *
 * 为什么值得
 * ----------
 * 实战里同一个对手反复走同一套开局。实测 12 路那四局白棋，前 10 手
 * 一模一样（G7 H8 H6 F8 I6 G6 H5 J7 H4 H7），每局都重算一遍，答案还一样。
 * 这些局面数量很少（十几个），但**每一局都会撞上**，用 30 秒去换 6 秒
 * 是稳赚的买卖 —— 这正是「接近棋谱的效果」。
 *
 * 和 learn.js 的分工：learn 往开局库（data/book*.json）里补，那份库是
 * 全局的、按对称规范化的知识；这里补的是**你这台机器上真打过的局面**，
 * 两者互不冲突，记忆库查得更早。
 *
 * 用法
 *   node tools/memo-seed.js                      # 默认：logs/ 全部，每局面 20 秒
 *   node tools/memo-seed.js --ms 30000 --ply 16  # 算久一点，只补前 16 手
 *   node tools/memo-seed.js --dry                # 只看会补哪些局面
 *   node tools/memo-seed.js --moves "G7 H8 H6"   # 只补指定的一条线（含其后续）
 *
 *   --ms      每个局面想多久（默认 20000）
 *   --ply     只补到第几手（默认 20）
 *   --rule    规则 0/1/4（默认 0，要和界面上选的一致，否则存了也查不到）
 *   --threads 线程数（默认交给 config.toml）
 *   --outcome 把日志里的胜负也回灌（默认开；--outcome 0 关掉）
 */
const fs = require('fs');
const path = require('path');
const C = require('../js/core.js');
const { Rapfi, labelToXY } = require('./rapfi.js');
const { Memo } = require('./memo.js');

const ROOT = path.join(__dirname, '..');
function arg(n, d) {
  const i = process.argv.indexOf('--' + n);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
}
const has = n => process.argv.indexOf('--' + n) > 0;

const MS = parseInt(arg('ms', 20000), 10);
const MAX_PLY = parseInt(arg('ply', 20), 10);
const RULE = parseInt(arg('rule', 0), 10);
const THREADS = parseInt(arg('threads', 0), 10);
const DRY = has('dry');
const OUTCOME = arg('outcome', '1') !== '0';
const ONLY = arg('moves', '').trim();

const memo = new Memo(process.env.RAPFI_MEMO_FILE || path.join(ROOT, 'data', 'memo.json'));

// **服务器正在跑的时候别补。** 服务端启动时把整个记忆库读进内存，
// 之后每次落盘都是整份覆盖 —— 它一写就会把这边补进去的全部抹掉。
// 补完再 npm start，或者补之前先停掉服务器。
try {
  const http = require('http');
  const req = http.get({ host: '127.0.0.1', port: process.env.PORT || 8080,
                         path: '/engine/info', timeout: 800 }, () => {
    console.log('⚠ 检测到服务器正在运行 —— 它落盘时会覆盖这次补进去的内容。');
    console.log('  请先停掉服务器（Ctrl+C）再补，补完重新 npm start。');
  });
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  if (req.unref) req.unref();
} catch (e) {}

/** 从日志里读出所有对局；--moves 时只造一条假对局 */
function loadGames() {
  if (ONLY) {
    const labels = ONLY.split(/[\s,]+/).filter(Boolean);
    let maxIdx = 0;
    for (const t of labels) maxIdx = Math.max(maxIdx, t.toUpperCase().charCodeAt(0) - 64, parseInt(t.slice(1), 10));
    return [{ id: '(命令行)', size: maxIdx <= 12 ? 12 : 15, moves: labels, ai: [], result: '' }];
  }
  const dir = path.join(ROOT, 'logs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { return null; }
  }).filter(g => g && Array.isArray(g.moves) && g.moves.length);
}

/**
 * 我方需要作答的局面有哪些。
 *
 * 用日志里的 aiColor 判断轮次；它缺失时（比如 --moves 那条路）两边都补 ——
 * 多算几个局面的代价只是时间，而漏掉正是要补的那个局面就白干了。
 */
function positionsOf(game) {
  const out = [];
  const size = game.size | 0;
  if (size < 5) return out;
  const aiIsBlack = game.aiColor ? game.aiColor === 'B' : null;
  const n = Math.min(game.moves.length, MAX_PLY);
  for (let ply = 0; ply < n; ply++) {
    // 已走 ply 手，轮到 (ply % 2 === 0 ? 黑 : 白) 走
    const blackToMove = ply % 2 === 0;
    if (aiIsBlack !== null && blackToMove !== aiIsBlack) continue;
    out.push({ size, prefix: game.moves.slice(0, ply) });
  }
  return out;
}

(async () => {
  const games = loadGames();
  if (!games.length) { console.log('logs/ 里没有可用的对局'); return; }

  // 去重：不同对局常常共享同一段开局，对称局面也要合并。
  // 直接借记忆库自己的规范化键，保证「补了就一定查得到」。
  const seen = new Map();
  let total = 0;
  for (const g of games) {
    for (const pos of positionsOf(g)) {
      total++;
      C.setSize(pos.size);
      const xy = pos.prefix.map(t => { const p = C.labelToP(t); return [C.pToX(p), C.pToY(p)]; });
      if (xy.some(v => v[0] < 0)) continue;
      const at = memo._at(pos.size, RULE, xy);
      if (!at || seen.has(at.key)) continue;
      seen.set(at.key, { size: pos.size, xy, labels: pos.prefix });
    }
  }

  const jobs = [...seen.values()];
  const RULE_NAME = { 0: '无禁手', 1: '标准', 4: '有禁手(连珠)' }[RULE] || ('RULE ' + RULE);
  console.log(`${games.length} 局日志 · 我方面临过 ${total} 个局面 · 去重后 ${jobs.length} 个`);
  console.log(`规则 ${RULE_NAME} · 每个局面 ${MS}ms · 只补到第 ${MAX_PLY} 手`);

  // 已经有同等质量记忆的就跳过，别把时间花在重复劳动上
  const todo = jobs.filter(j => !memo.lookup(j.size, RULE, j.xy, MS));
  console.log(`其中 ${jobs.length - todo.length} 个已有同等或更好的记忆，需要算 ${todo.length} 个`);
  const mins = Math.round(todo.length * MS / 60000);
  console.log(`预计 ${mins} 分钟左右\n`);
  if (DRY) {
    todo.slice(0, 40).forEach(j => console.log('  ' + (j.labels.join(' ') || '(空盘)')));
    if (todo.length > 40) console.log('  …还有 ' + (todo.length - 40) + ' 个');
    return;
  }
  if (!todo.length) { finish(games); return; }

  // 按尺寸分组：换尺寸要重开一局，分好组就只换一次
  todo.sort((a, b) => a.size - b.size || a.xy.length - b.xy.length);
  const eng = new Rapfi({ threads: THREADS, rule: RULE, matchSpread: 0 });  // 0 = 每手都想满
  await eng.start();
  let curSize = 0, done = 0;
  const t0 = Date.now();
  for (const j of todo) {
    if (j.size !== curSize) { await eng.newGame(j.size); curSize = j.size; }
    let r;
    try { r = await eng.think(j.xy, MS); }
    catch (e) { console.log('  ! ' + (j.labels.join(' ') || '(空盘)') + ' 失败：' + e.message); continue; }
    memo.record(j.size, RULE, j.xy, r, MS);
    done++;
    C.setSize(j.size);
    const label = C.pToLabel(C.xyToP(r.x, r.y));
    const score = r.mate ? (r.mate > 0 ? '+M' + r.mate : '-M' + (-r.mate)) : ('评分 ' + r.eval);
    const left = Math.round((todo.length - done) * (Date.now() - t0) / done / 60000);
    console.log(`  [${done}/${todo.length}] ${(j.labels.join(' ') || '(空盘)').padEnd(34)}` +
                ` -> ${label.padEnd(4)} ${String(r.depth).padStart(3)} 层 · ${score}` +
                (left > 0 ? `   （还剩约 ${left} 分钟）` : ''));
  }
  eng.stop();
  memo.save(true);
  finish(games);
})().catch(e => { console.error(e); process.exit(1); });

function finish(games) {
  if (OUTCOME) {
    // 把日志里的胜负回灌一遍。注意这会按 ai[].source 追责，
    // 而老日志里那些手记的是 'rapfi' 而不是 'memo' —— 所以只有走棋谱库的那几手会被追责。
    let n = 0;
    for (const g of games) {
      const r = memo.ingest(g, g.rule | 0);
      if (r && r.marks.length) {
        n++;
        console.log(`  [胜负] ${g.id}：${r.result} —— ` +
          r.marks.map(m => `第 ${m.ply} 手 ${m.label} 记${m.field === 'w' ? '胜' : '负'}`).join('、'));
      }
    }
    if (!n) console.log('  [胜负] 没有可追责的着法（老日志里我方的手大多记为 rapfi 而非 book/memo）');
  }
  const st = memo.stats();
  console.log(`\n记忆库现在有 ${st.positions} 个局面 / ${st.moves} 手` +
              `，其中 ${st.refuted} 手被否决、${st.dead} 手无替代`);
}
