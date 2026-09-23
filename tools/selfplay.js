/*
 * selfplay.js — 自对弈生成棋谱
 *
 * 开局库要有用，棋谱就不能「撒胡椒面」：如果每局的开局都不一样，
 * 每个局面只会被走到一次，那种「着法」只是引擎随手下的一手，
 * 并不比现场搜索更可信。所以这里的策略是「先收窄，再探索」：
 *
 *   1. 前三手从**规范开局集**里取 —— 天元 + 白方两种应手(直指/斜指) +
 *      黑方第三手的全部非等价点（用对称规范化自动去重，通常 20 多种）。
 *      这样几千局棋会反复落在同一批开局上，样本自然堆起来。
 *   2. 之后按 --explore 概率走「次优着法」而不是最优着法，
 *      让同一个局面的不同后续都被试到，胜率统计才有意义。
 *   3. 探索只在双方都没有冲四/活三级威胁的安静局面里发生，
 *      不会造出「无视四连」这种垃圾棋谱。
 *
 * 用法:
 *   node selfplay.js --games 300 --seed 7 --out ../data/records/sp-01.txt
 *
 *   --games 局数        --out 输出文件      --seed 随机种子
 *   --time  每手毫秒    --level 难度
 *   --explore 探索概率(默认 .22)   --exploreTop 探索候选数(默认 3)
 *   --exploreUntil 探索到第几手为止(默认 18)
 */
const fs = require('fs');
const path = require('path');
const C = require('../js/core.js');
const E = require('../js/engine.js');
const R = require('./records.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

C.setSize(parseInt(arg('size', 15), 10));
const GAMES = parseInt(arg('games', 100), 10);
const OUT = path.resolve(arg('out', path.join(__dirname, '../data/records/selfplay.txt')));
const TIME = parseInt(arg('time', 60), 10);
const LEVEL = arg('level', 'hard');
const EXPLORE = parseFloat(arg('explore', 0.22));
const EXPLORE_TOP = parseInt(arg('exploreTop', 3), 10);
const EXPLORE_UNTIL = parseInt(arg('exploreUntil', 18), 10);

// 自带 PRNG，保证不同 seed 的进程产出不同棋谱且可复现
let seed = parseInt(arg('seed', 1), 10) >>> 0 || 1;
function rnd() {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 4294967296;
}
const pickIdx = n => Math.floor(rnd() * n) % n;

// ---------- 规范开局集 ----------
/**
 * 枚举前三手的全部非等价开局。
 * 第 1 手固定天元；第 2 手取天元周围一圈（对称去重后只剩「直指」「斜指」两种）；
 * 第 3 手取中心 5x5 内的全部空点，同样按对称去重。
 * 全程用 canonicalKey 去重，不需要手工维护开局表，也就不会记错。
 */
function buildOpenings() {
  const center = C.center();
  const cx = C.pToX(center), cy = C.pToY(center);
  const lo = Math.max(0, cx - 2), hi = Math.min(C.SIZE - 1, cx + 2);
  const out = [];
  const seenSecond = new Set();

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const b2 = new C.Board();
      b2.put(center, C.BLACK);
      const second = C.xyToP(cx + dx, cy + dy);
      b2.put(second, C.WHITE);
      const k2 = C.canonicalKey(b2, C.BLACK).key;
      if (seenSecond.has(k2)) continue;
      seenSecond.add(k2);

      const seenThird = new Set();
      for (let ty = Math.max(0, cy - 2); ty <= Math.min(C.SIZE - 1, cy + 2); ty++) {
        for (let tx = lo; tx <= hi; tx++) {
          const third = C.xyToP(tx, ty);
          if (b2.cells[third] !== C.EMPTY) continue;
          b2.put(third, C.BLACK);
          const k3 = C.canonicalKey(b2, C.WHITE).key;
          b2.undo();
          if (seenThird.has(k3)) continue;
          seenThird.add(k3);
          out.push([center, second, third]);
        }
      }
    }
  }
  return out;
}
const OPENINGS = buildOpenings();

// ---------- 探索用的次优着法 ----------
const T_QUIET = 100000;   // 高于这个分数说明局面有硬威胁，不能乱走

function exploreMove(board, role, best) {
  const opp = 3 - role;
  const empties = board.emptyNear([]);
  const scored = [];
  let maxAtk = 0, maxDef = 0;
  for (const p of empties) {
    const atk = E.threatScore(board, p, role);
    const def = E.threatScore(board, p, opp);
    if (atk > maxAtk) maxAtk = atk;
    if (def > maxDef) maxDef = def;
    scored.push([p, atk + def * 0.85]);
  }
  // 局面不安静（任一方能做出四三/双三以上）就老实走最优着
  if (maxAtk >= T_QUIET || maxDef >= T_QUIET) return best;

  scored.sort((a, b) => b[1] - a[1]);
  const pool = scored.slice(0, EXPLORE_TOP)
    .filter(([p, s]) => p !== best && s >= scored[0][1] * 0.55);
  if (!pool.length) return best;
  return pool[pickIdx(pool.length)][0];
}

function playGame(eng, gameIndex) {
  const b = new C.Board();
  const open = OPENINGS[gameIndex % OPENINGS.length];
  open.forEach((p, i) => b.put(p, i % 2 === 0 ? C.BLACK : C.WHITE));

  let winner = 0;
  const MAX_PLY = C.SIZE * C.SIZE;
  for (let ply = open.length; ply < MAX_PLY; ply++) {
    const role = ply % 2 === 0 ? C.BLACK : C.WHITE;
    let mv = eng.bestMove(b, role, { level: LEVEL, timeMs: TIME, useBook: false }).move;
    if (ply < EXPLORE_UNTIL && rnd() < EXPLORE) mv = exploreMove(b, role, mv);
    if (b.cells[mv] !== C.EMPTY) break;
    b.put(mv, role);
    if (b.lastMoveWins()) { winner = role; break; }
  }
  return { moves: b.history.slice(), winner };
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
// 对局循环是同步的，事件循环没有机会跑，所以用同步追加写：
// 每局立刻落盘，中途 Ctrl+C 也不会丢棋谱。
const buf = [];
const flush = () => { if (buf.length) { fs.appendFileSync(OUT, buf.join('')); buf.length = 0; } };
const eng = new E.Engine();
const t0 = Date.now();
let bw = 0, ww = 0, dw = 0;

console.log(`规范开局 ${OPENINGS.length} 种，每种约 ${Math.round(GAMES / OPENINGS.length)} 局`);

for (let g = 1; g <= GAMES; g++) {
  eng.reset();                                  // 每局清置换表，避免跨局误用
  // 乘一个与开局数互质的步长，保证各开局轮转均匀
  const r = playGame(eng, (g - 1) * 7 + parseInt(arg('seed', 1), 10));
  if (r.winner === C.BLACK) bw++; else if (r.winner === C.WHITE) ww++; else dw++;
  buf.push(R.formatGame(r.moves, r.winner) + '\n');
  if (buf.length >= 5) flush();
  if (g % 10 === 0 || g === GAMES) {
    const el = (Date.now() - t0) / 1000;
    process.stdout.write(
      `\r[seed ${arg('seed', 1)}] ${g}/${GAMES} 局  黑胜${bw} 白胜${ww} 和${dw}  ` +
      `${el.toFixed(0)}s  (${(el / g).toFixed(2)}s/局)`);
  }
}
flush();
console.log('\n完成 -> ' + OUT);
