/*
 * import-gomocup.js — 把 Gomocup 比赛对局导入成我们的棋谱格式
 *
 * 之前库里全是自对弈 —— 引擎跟自己下，学到的只有它自己已经会的东西。
 * Gomocup 是五子棋 AI 世界赛，参赛的是 Rapfi / Yixin / JAX 这些顶尖引擎，
 * 历年对局全部公开。这是现成的轮子。
 *
 * ⚠ 必须按「分组」筛，不能整包倒进来 —— 一个包里混着四种规则、两种尺寸：
 *
 *   Freestyle15_1/2  15×15 无禁手  ← **只有这个和我们规则完全一致**
 *   Freestyle20_1/2  20×20 无禁手     规则对，尺寸不对
 *   Fastgame         20×20            （名字有迷惑性，它是 20 路）
 *   Standard1/2      15×15 标准       只能正好五连，长连不算赢 —— 规则不同
 *   Renju            15×15 连珠       黑棋有禁手 —— 规则差得更远
 *   Caro             15×15 Caro       规则不同
 *
 * 而且 **Gomocup 没有 12 路**。开局理论不能跨尺寸搬（12 路中心离边 5~6 格，
 * 15 路是 7 格，同一个棋形价值完全不同），所以这些棋谱对 15 路有用、
 * 对 12 路没用。12 路只能靠 book-rapfi.js 自己算。
 *
 * 用法：
 *   node tools/import-gomocup.js                     # 默认导 Freestyle15
 *   node tools/import-gomocup.js --div Freestyle20 --size 20
 *   node tools/import-gomocup.js --list              # 只看各分组有多少局
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { open } = require('./unzip.js');
const C = require('../js/core.js');

const ROOT = path.join(__dirname, '..');
const ZIP_DIR = path.join(ROOT, 'data', 'gomocup');
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i < 0 ? d : process.argv[i + 1];
};
const DIV  = String(arg('div', 'Freestyle15'));
const SIZE = parseInt(arg('size', '15'), 10);
const OUT  = arg('out', path.join(ROOT, 'data', 'records', `gomocup-${DIV.toLowerCase()}.txt`));
const LIST = process.argv.includes('--list');

C.setSize(SIZE);

/**
 * 解析一个 .psq 文件，返回 {size, moves:[[x,y]...], zeroLead} 或 null
 *
 * psq 每行是 `x,y,毫秒`。**第三个字段是这一手想了多久** —— 赛会指定的开局
 * 那几手全是 0，引擎自己算的通常是几万。`zeroLead` 就是开头连续 0ms 的手数。
 */
function parsePsq(text) {
  const lines = text.split(/\r?\n/);
  // 首行形如 "Piskvorky 15x15, 11:11, 0"
  const m = /(\d+)\s*x\s*(\d+)/.exec(lines[0] || '');
  if (!m) return null;
  const w = +m[1], h = +m[2];
  if (w !== h) return null;                  // 非正方形棋盘，不处理
  const moves = [], times = [];
  for (let i = 1; i < lines.length; i++) {
    const mv = /^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*$/.exec(lines[i]);
    if (!mv) { if (moves.length) break; else continue; }   // 着法段结束
    moves.push([+mv[1] - 1, +mv[2] - 1]);    // psq 是 1 基
    times.push(+mv[3]);
  }
  let zeroLead = 0;
  while (zeroLead < times.length && times[zeroLead] === 0) zeroLead++;
  return { size: w, moves, zeroLead };
}

/**
 * 读出某个分组的「指定开局」长度集合。
 *
 * **这是这次导入里最重要的一件事。** Gomocup 每局的前几手是赛会**指定**的，
 * 不是引擎选的 —— 包里 `openings_freestyle15_piskvork.txt` 就是那张表，
 * 每行一条开局，坐标是相对棋盘中心的偏移（实测 `4,6 / 1,5 / 0,3` 对应
 * 15 路的 (11,13) (8,12) (7,10)，中心取 (7,7)）。
 *
 * 不把这几手标出来的话，统计出来的「顶尖引擎的第一手」里会混进一堆
 * 角上的点（实测：空盘第一手 A10 有 1226 局支撑）—— 那是赛制的产物，
 * 不是任何人的选择，而且正好污染开局库唯一使用的前 8 手。
 */
function openingTable(zip, div, size) {
  const base = div.toLowerCase().replace(/_\d+$/, '');   // Freestyle15_1 -> freestyle15
  // **文件名逐年不同**：2024/2025 是 openings_freestyle15.txt，
  // 2026 是 openings_freestyle15_piskvork.txt。少写这个可选后缀就全匹配不上，
  // 于是退化成裸用 zeroLead，标出 #o225 这种荒谬值（踩过）。
  const e = zip.entries.find(x => new RegExp('openings_' + base + '[_.]', 'i').test(x.name));
  if (!e) return null;
  const c = (size - 1) >> 1;                 // 表里的坐标是相对棋盘中心的偏移
  const seqs = [];
  for (const line of zip.read(e).toString('latin1').split(/\r?\n/)) {
    const pairs = line.trim().match(/(-?\d+)\s*,\s*(-?\d+)/g);
    if (!pairs || !pairs.length) continue;
    const seq = pairs.map(s => {
      const [dx, dy] = s.split(',').map(v => parseInt(v, 10));
      return [c + dx, c + dy];
    });
    seqs.push(seq);
  }
  if (!seqs.length) return null;
  return { seqs, lens: [...new Set(seqs.map(s => s.length))].sort((a, b) => a - b) };
}

/**
 * 判定这局有多少手是赛会指定的。两道判据：
 *
 * 1. **精确比对**：拿开局表里每条的坐标去对这局的前 L 手。对上就是它。
 * 2. 对不上（比如这一届的开局表换了方向）才退回启发式：以「开头连续 0ms」
 *    为准，再按表里的合法长度**向下取整** —— 引擎的第一手偶尔也秒答，
 *    会让 zeroLead 比真实开局多 1~2 手。
 */
function assignedLen(moves, zeroLead, table) {
  if (!table) return 0;                      // 没有开局表就别乱标
  for (const seq of table.seqs) {
    if (moves.length < seq.length) continue;
    let same = true;
    for (let i = 0; i < seq.length; i++)
      if (moves[i][0] !== seq[i][0] || moves[i][1] !== seq[i][1]) { same = false; break; }
    if (same) return seq.length;             // 精确命中
  }
  let best = 0;
  for (const L of table.lens) if (L <= zeroLead) best = L;
  return best;
}

function main() {
  if (!fs.existsSync(ZIP_DIR)) {
    console.error(`${path.relative(ROOT, ZIP_DIR)}/ 不存在。先跑 node tools/fetch-gomocup.js 2025 2024`);
    process.exit(1);
  }
  const zips = fs.readdirSync(ZIP_DIR).filter(f => f.endsWith('.zip')).sort();
  if (!zips.length) { console.error('没有找到任何 .zip'); process.exit(1); }

  if (LIST) {
    console.log('各包的分组构成（局数）：\n');
    for (const f of zips) {
      let z;
      try { z = open(path.join(ZIP_DIR, f)); }
      catch (e) { console.log(`  ${f}  ✗ ${e.message}`); continue; }
      const by = new Map();
      for (const e of z.entries) {
        if (!e.name.endsWith('.psq')) continue;
        const d = e.name.split('/')[0];
        by.set(d, (by.get(d) || 0) + 1);
      }
      console.log(`  ${f}`);
      for (const [k, v] of [...by].sort((a, b) => b[1] - a[1]))
        console.log(`      ${String(v).padStart(6)}  ${k}`);
    }
    return;
  }

  console.log(`筛选分组 /${DIV}/  ·  棋盘 ${SIZE} 路\n`);
  const seen = new Set();          // 整局去重（同一局可能在多个包里）
  const out = [];
  let scanned = 0, wrongSize = 0, tooShort = 0, illegal = 0, openTotal = 0, exact = 0;

  for (const f of zips) {
    let z;
    try { z = open(path.join(ZIP_DIR, f)); }
    catch (e) { console.log(`  ${f}  跳过：${e.message}`); continue; }
    let took = 0;
    const lensCache = new Map();
    for (const e of z.entries) {
      if (!e.name.endsWith('.psq')) continue;
      const div = e.name.split('/')[0];
      if (!div.startsWith(DIV)) continue;
      scanned++;
      let g;
      try { g = parsePsq(z.read(e).toString('latin1')); } catch (err) { continue; }
      if (!g) continue;
      if (g.size !== SIZE) { wrongSize++; continue; }
      if (g.moves.length < 6) { tooShort++; continue; }
      if (!lensCache.has(div)) lensCache.set(div, openingTable(z, div, SIZE));
      const tbl = lensCache.get(div);
      const openLen = assignedLen(g.moves, g.zeroLead, tbl);
      if (tbl && openLen && g.moves.length >= openLen) exact += (openLen === g.zeroLead ? 1 : 0);

      // 重放一遍，把非法棋谱（重复落子、越界）挡在库外面
      const b = new C.Board();
      const labels = [];
      let ok = true;
      for (let i = 0; i < g.moves.length; i++) {
        const [x, y] = g.moves[i];
        if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) { ok = false; break; }
        const p = C.xyToP(x, y);
        if (b.cells[p] !== C.EMPTY) { ok = false; break; }
        b.put(p, i % 2 === 0 ? C.BLACK : C.WHITE);
        labels.push(C.pToLabel(p));
        if (b.lastMoveWins()) break;            // 连成五子，后面的着法不要
      }
      if (!ok) { illegal++; continue; }
      if (labels.length < 6) { tooShort++; continue; }

      const line = labels.join(' ');
      if (seen.has(line)) continue;
      seen.add(line);
      // `#o<K>` = 前 K 手是赛会指定的开局，不是任何人的选择。
      // build-book.js 会跳过它们，只统计引擎真正选出来的着法。
      out.push(line + (openLen > 0 ? ' #o' + openLen : ''));
      openTotal += openLen;
      took++;
    }
    console.log(`  ${f.padEnd(20)} 取用 ${String(took).padStart(6)} 局`);
  }

  if (!out.length) { console.log('\n一局都没取到 —— 检查 --div 写对了没（用 --list 看有哪些分组）'); return; }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out.join('\n') + '\n');
  console.log(`\n扫描 ${scanned} 个文件：尺寸不符 ${wrongSize}，太短 ${tooShort}，非法 ${illegal}`);
  console.log(`去重后写出 ${out.length} 局 -> ${path.relative(ROOT, OUT)}`);
  console.log(`下一步：node tools/build-book.js --size ${SIZE} ` +
              (SIZE === 15 ? '' : `--records data/records${SIZE} --out data/book${SIZE}.json`));
}

main();
