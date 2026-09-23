/*
 * logs.js — 看对局日志，找下一个该修的地方
 *
 * 日志里每手都带着 depth / nodes / 用时 / 收手原因 / 根候选表。
 * 这个工具把它们聚成几个能直接指导改算法的数字：
 *   - 预算到底用掉多少（用不掉说明被收手规则卡住，不是搜不动）
 *   - 各种收手原因各占多少
 *   - 带异常标记的手（搜索没跑完、几十毫秒交卷、最后一层还在改主意）
 *   - 每局的棋谱，可以直接喂给 review.js / audit.js
 *
 * 用法:
 *   node logs.js                 # 概览
 *   node logs.js --game <id>     # 某一局逐手详情
 *   node logs.js --moves         # 只打印各局棋谱，方便复制
 *   node logs.js --import x.json # 导入浏览器「导出日志」下载的文件
 *   node logs.js --clear         # 分析完清空（日志是消耗品，别攒着）
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '../logs');
function arg(n, d) {
  const i = process.argv.indexOf('--' + n);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
}
const has = n => process.argv.indexOf('--' + n) > 0;

// 浏览器导出的是一个数组，拆成一局一个文件，后续流程就统一了
if (arg('import', '')) {
  const src = JSON.parse(fs.readFileSync(path.resolve(arg('import', '')), 'utf8'));
  fs.mkdirSync(DIR, { recursive: true });
  let n = 0;
  for (const g of (Array.isArray(src) ? src : [src])) {
    const id = String(g.id || Date.now() + '-' + n).replace(/[^\w.-]/g, '');
    fs.writeFileSync(path.join(DIR, id + '.json'), JSON.stringify(g));
    n++;
  }
  console.log(`导入 ${n} 局 -> ${DIR}`);
  process.exit(0);
}

if (has('clear')) {
  if (!fs.existsSync(DIR)) { console.log('没有日志目录，无需清理'); process.exit(0); }
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
  for (const f of files) fs.unlinkSync(path.join(DIR, f));
  console.log(`已清空 ${files.length} 个日志文件`);
  process.exit(0);
}

if (!fs.existsSync(DIR)) {
  console.log('还没有日志。用 npm start 打开对局，AI 每走一手就会自动写进 logs/。');
  console.log('（双击 index.html 打开的话没有服务器，日志存在浏览器里，');
  console.log('  点面板上的「导出日志」下载后用 --import 导进来）');
  process.exit(0);
}

// logs/ 里可能有两种文件：服务器写的「一局一个」，
// 以及用户从浏览器「导出日志」直接丢进来的「一个数组装多局」。
// 两种都要认 —— 以前只认前者，遇到后者直接崩在 `g.ai is not iterable`。
const games = [];
for (const f of fs.readdirSync(DIR).filter(x => x.endsWith('.json'))) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); }
  catch (e) { console.error(`跳过读不动的文件 ${f}: ${e.message}`); continue; }
  for (const g of (Array.isArray(raw) ? raw : [raw])) {
    if (!g || !Array.isArray(g.ai) || !Array.isArray(g.moves)) {
      console.error(`跳过格式不对的记录（${f}）`);
      continue;
    }
    games.push(g);
  }
}
games.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));

if (!games.length) { console.log('日志目录是空的'); process.exit(0); }

if (has('moves')) {
  for (const g of games) {
    console.log(`# ${g.id}  ${g.size} 路  AI 执${g.aiColor === 'B' ? '黑' : '白'}  ${g.result || '未终局'}`);
    console.log(g.moves.join(' '));
    console.log('');
  }
  process.exit(0);
}

const only = arg('game', '');
if (only) {
  const g = games.find(x => String(x.id).includes(only));
  if (!g) { console.error('找不到这一局: ' + only); process.exit(1); }
  console.log(`${g.id}  ${g.size} 路  AI 执${g.aiColor === 'B' ? '黑' : '白'}  ` +
              `难度 ${g.level}  思考上限 ${g.thinkCap}ms  ${g.result || '未终局'}`);
  console.log(g.moves.join(' ') + '\n');
  for (const a of g.ai) {
    const pct = a.cap ? (a.ms / a.cap * 100).toFixed(0) + '%' : '-';
    console.log(`第 ${String(a.ply).padStart(3)} 手 ${a.role}  ${String(a.move).padEnd(4)} ` +
                `${String(a.source).padEnd(7)} 深度 ${String(a.depth).padStart(2)}  ` +
                `${String(a.nodes).padStart(8)} 节点  ${String(a.ms).padStart(5)}ms (${pct})` +
                (a.flags ? '  ★ ' + a.flags.join('；') : ''));
    if (a.stop) console.log(`        收手: ${a.stop}`);
    if (a.iters && a.iters.length) {
      console.log('        逐层: ' + a.iters.map(i =>
        `${i.depth}层→${i.move}(${i.score}) ${i.ms}ms`).join('  '));
    }
    if (a.roots && a.roots.length) {
      console.log('        根候选: ' + a.roots.slice(0, 6).map(r =>
        `${r.p}(攻${r.atk}/守${r.def})`).join(' '));
    }
  }
  process.exit(0);
}

// ---------- 概览 ----------
const all = [];
for (const g of games) for (const a of g.ai) all.push(a);
const searched = all.filter(a => a.source === 'search');

console.log(`${games.length} 局，AI 共 ${all.length} 手\n`);

const bySrc = {};
for (const a of all) bySrc[a.source] = (bySrc[a.source] || 0) + 1;
console.log('决策来源: ' + Object.keys(bySrc).sort((x, y) => bySrc[y] - bySrc[x])
  .map(k => `${k} ${bySrc[k]}`).join('  '));

if (searched.length) {
  const ms = searched.reduce((s, a) => s + a.ms, 0);
  const cap = searched.reduce((s, a) => s + (a.cap || 0), 0);
  const dep = searched.reduce((s, a) => s + a.depth, 0);
  console.log(`\n搜索 ${searched.length} 手：平均深度 ${(dep / searched.length).toFixed(1)}，` +
              `平均 ${(ms / searched.length).toFixed(0)}ms`);
  if (cap) console.log(`  预算利用率 ${(ms / cap * 100).toFixed(1)}%  ` +
                       `（用不掉说明是收手规则在卡，不是搜不动）`);

  const stops = {};
  for (const a of searched) {
    // 收手原因里带具体数字，归类时只取前缀
    const k = (a.stop || '(无)').replace(/（.*/, '').replace(/第 \d+ 层/, '第 N 层');
    stops[k] = (stops[k] || 0) + 1;
  }
  console.log('  收手原因:');
  for (const k of Object.keys(stops).sort((x, y) => stops[y] - stops[x])) {
    console.log(`    ${String(stops[k]).padStart(4)} 手  ${k}`);
  }
}

const flagged = all.filter(a => a.flags);
console.log(`\n带异常标记的手: ${flagged.length}`);
for (const a of flagged.slice(0, 20)) {
  const g = games.find(x => x.ai.indexOf(a) >= 0);
  console.log(`  ${g.id} 第 ${a.ply} 手 ${a.move} (${a.source}, 深度 ${a.depth}, ${a.ms}ms)` +
              `  ★ ${a.flags.join('；')}`);
  if (a.stop) console.log(`      ${a.stop}`);
}

const maxTt = all.reduce((m, a) => Math.max(m, a.ttSize || 0), 0);
if (maxTt) console.log(`\n置换表最大条目数: ${maxTt.toLocaleString()}（跨手复用，从不清理）`);

console.log(`\n逐手详情: node logs.js --game ${games[games.length - 1].id}`);
console.log(`取棋谱:   node logs.js --moves`);
console.log(`清空:     node logs.js --clear`);
