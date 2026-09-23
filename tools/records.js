/*
 * records.js — 棋谱读取
 *
 * 支持三种常见写法，自动识别：
 *   1. 字母坐标   "H8 I9 J10"、"h8i9j10"、"H8,I9,J10"   （列 A-O，行 1-15 自下而上）
 *   2. 数字坐标   "8,8 9,9" 或 .psq 里的 "8,8,0" 每行一手  （1-15）
 *   3. .psq 文件  Gomocup/Piskvork 格式
 *
 * 行尾可以用 #B / #W / #D 标注结果（黑胜/白胜/和）；不写则由复盘自动判定
 * （谁先连成五子谁胜）。
 *
 * 注意：整盘棋的翻转/旋转不影响开局库——库在写入前会做对称规范化，
 * 所以即使某份棋谱的行号方向与本项目相反，喂进来依然是正确的知识。
 */
const fs = require('fs');
const path = require('path');
const C = require('../js/core.js');

const LETTER_RE = /([a-oA-O])\s*(1[0-5]|[1-9])(?![0-9])/g;
const PAIR_RE = /(1[0-5]|[1-9])\s*,\s*(1[0-5]|[1-9])/g;

/** 从一段文本里抽取着法坐标，返回 [[x,y], ...]（0 基） */
function extractMoves(text) {
  const byLetter = [];
  let m;
  LETTER_RE.lastIndex = 0;
  while ((m = LETTER_RE.exec(text))) {
    const x = m[1].toUpperCase().charCodeAt(0) - 65;
    const row = parseInt(m[2], 10);
    byLetter.push([x, C.SIZE - row]);
  }
  if (byLetter.length >= 3) return byLetter;

  const byPair = [];
  PAIR_RE.lastIndex = 0;
  while ((m = PAIR_RE.exec(text))) {
    byPair.push([parseInt(m[1], 10) - 1, parseInt(m[2], 10) - 1]);
  }
  return byPair.length >= 3 ? byPair : byLetter;
}

/** 复盘一局，返回 { moves:[p...], winner: 1|2|0 }；非法棋谱返回 null */
function replay(coords, declared) {
  const b = new C.Board();
  const moves = [];
  let winner = 0;
  for (let i = 0; i < coords.length; i++) {
    const [x, y] = coords[i];
    if (!(x >= 0 && x < C.SIZE && y >= 0 && y < C.SIZE)) return null;
    const p = C.xyToP(x, y);
    if (b.cells[p] !== C.EMPTY) return null;          // 重复落子 -> 棋谱有误
    const role = i % 2 === 0 ? C.BLACK : C.WHITE;
    b.put(p, role);
    moves.push(p);
    if (b.lastMoveWins()) { winner = role; break; }   // 连成五子，后续着法忽略
  }
  if (declared) winner = declared;
  if (moves.length < 4) return null;
  return { moves, winner };
}

/** 解析一份文件，返回若干局 */
function parseFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const games = [];

  if (path.extname(file).toLowerCase() === '.psq' || /piskvork/i.test(raw.slice(0, 200))) {
    const coords = [];
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*(\d{1,2})\s*,\s*(\d{1,2})\s*(?:,\s*\d+)?\s*$/.exec(line);
      if (m) coords.push([parseInt(m[1], 10) - 1, parseInt(m[2], 10) - 1]);
    }
    const g = replay(coords, 0);
    if (g) games.push(g);
    return games;
  }

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith(';')) continue;
    const tag = /#\s*([BWD])\b/i.exec(t);
    // `#o<K>` = 前 K 手不是任何人选的，是外部指定的开局（Gomocup 赛会分配）。
    // 棋子照摆（后面的局面要靠它们），但统计着法时要跳过 —— 否则库会学到
    // 「顶尖引擎的第一手是 A10」这种赛制产物。见 tools/import-gomocup.js
    const op = /#\s*o(\d+)\b/i.exec(t);
    const body = t.split('#')[0];
    const declared = tag ? ({ B: C.BLACK, W: C.WHITE, D: 0 })[tag[1].toUpperCase()] : null;
    const coords = extractMoves(body);
    if (coords.length < 4) continue;
    const g = replay(coords, declared);
    if (g) { g.openLen = op ? parseInt(op[1], 10) : 0; games.push(g); }
  }
  return games;
}

/** 读取整个目录（含子目录）下的全部棋谱 */
function loadDir(dir) {
  const out = [];
  const stat = fs.existsSync(dir) && fs.statSync(dir);
  if (!stat) return out;
  const walk = d => {
    for (const name of fs.readdirSync(d)) {
      const f = path.join(d, name);
      const st = fs.statSync(f);
      if (st.isDirectory()) { walk(f); continue; }
      if (name.startsWith('_') || name.startsWith('.')) continue;   // 日志等非棋谱文件
      if (!/\.(txt|psq|rec|dat)$/i.test(name)) continue;
      try {
        const g = parseFile(f);
        out.push({ file: f, games: g });
      } catch (e) {
        console.error('跳过无法解析的文件 ' + f + ': ' + e.message);
      }
    }
  };
  walk(dir);
  return out;
}

/** 把一局写成标准文本行 */
function formatGame(moves, winner) {
  return moves.map(p => C.pToLabel(p)).join(' ') + ' #' + (winner === C.BLACK ? 'B' : winner === C.WHITE ? 'W' : 'D');
}

module.exports = { extractMoves, replay, parseFile, loadDir, formatGame };
