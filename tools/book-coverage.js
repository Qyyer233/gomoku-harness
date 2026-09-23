/*
 * book-coverage.js — 棋谱库对「对手可能怎么走」覆盖到什么程度
 *
 * 用户的抱怨是「前几手就开始思考几秒，而人类选手早就形成肌肉记忆了」。
 * 要回答这个，光看「库里有多少条」没用 —— 得问：
 *
 *   **轮到我们走的时候，对手此前那一手的所有合理下法里，我们答得上来的占几成？**
 *
 * 和 book-hitrate.js 的分工：
 *   book-hitrate.js  真下棋，量「一局里有多少手是 0ms」（结果指标，慢）
 *   book-coverage.js 纯查表，量「覆盖面有多宽」（过程指标，秒出，能指出该往哪补）
 *
 * 「合理下法」定义为离已有棋子 radius 格以内的空点 —— 和 book-rapfi.js 的
 * --full 展开用的是同一个定义，所以这里的数字直接告诉你那个任务还差多少。
 *
 * 用法：
 *   node tools/book-coverage.js --size 12 --plies 8 --radius 4
 */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../js/core.js');
const B = require('../js/book.js');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i < 0 ? d : (isNaN(+process.argv[i + 1]) ? process.argv[i + 1] : +process.argv[i + 1]);
};
const SIZE   = arg('size', 12);
const PLIES  = arg('plies', 8);
const RADIUS = arg('radius', 4);
const CAP    = arg('cap', 4000);     // 每层最多枚举多少个局面，免得指数爆炸

C.setSize(SIZE);
const BOOK_JSON = path.join(ROOT, 'data', SIZE === 15 ? 'book.json' : `book${SIZE}.json`);
const book = B.Book.load(fs.readFileSync(BOOK_JSON, 'utf8'));

/** 离已有棋子 R 格以内的空点 */
function candidates(b, R) {
  const out = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const p = C.xyToP(x, y);
      if (b.cells[p] !== C.EMPTY) continue;
      let near = false;
      for (let dy = -R; dy <= R && !near; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
          if (b.cells[C.xyToP(nx, ny)] !== C.EMPTY) { near = true; break; }
        }
      }
      if (near) out.push(p);
    }
  }
  return out;
}

/**
 * 从 `us` 的视角走一遍：我们按库走（库没有就停止这条线），
 * 对手每一手都把**全部**合理应手展开，统计我们在下一手能不能查到库。
 */
function walk(us) {
  const rows = [];
  // 每层的局面集合（去重后的代表局面）
  let level = [[]];                       // 着法序列
  for (let ply = 0; ply < PLIES; ply++) {
    const role = ply % 2 === 0 ? C.BLACK : C.WHITE;
    const ourTurn = role === us;
    const next = [], seen = new Set();
    let hit = 0, total = 0;

    for (const line of level) {
      const b = new C.Board();
      for (let i = 0; i < line.length; i++) b.put(line[i], i % 2 === 0 ? C.BLACK : C.WHITE);

      if (ourTurn) {
        total++;
        const r = book.lookup(b, role, 0);
        if (r && b.cells[r.move] === C.EMPTY) {
          hit++;
          if (next.length < CAP) {
            const key = line.concat([r.move]).join(',');
            if (!seen.has(key)) { seen.add(key); next.push(line.concat([r.move])); }
          }
        }
        // 查不到就断在这里 —— 那之后要现场长考，正是我们想消灭的情形
      } else {
        // 对手：全部合理应手都要展开
        for (const p of (line.length ? candidates(b, RADIUS) : allFirstMoves())) {
          if (b.cells[p] !== C.EMPTY) continue;
          if (next.length >= CAP) break;
          b.put(p, role);
          const h = B.hashKey(C.canonicalKey(b, role === C.BLACK ? C.WHITE : C.BLACK).key);
          b.undo();
          if (seen.has(h)) continue;
          seen.add(h);
          next.push(line.concat([p]));
        }
      }
    }
    if (ourTurn) rows.push({ ply: ply + 1, hit, total });
    level = next;
    if (!level.length) break;
  }
  return rows;
}

/** 空盘上本质不同的第一手 */
function allFirstMoves() {
  const seen = new Set(), out = [];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const p = C.xyToP(x, y);
    const b = new C.Board(); b.put(p, C.BLACK);
    const h = B.hashKey(C.canonicalKey(b, C.WHITE).key);
    if (seen.has(h)) continue;
    seen.add(h); out.push(p);
  }
  return out;
}

console.log(`${SIZE} 路 · 对手应手取半径 ${RADIUS} 内的全部空点 · 每层最多枚举 ${CAP} 个局面`);
console.log(`棋谱库：统计局面 ${book.size()} 个 · 引擎裁定 ${book.verdictCount()} 条\n`);

for (const [us, name] of [[C.BLACK, '我们执黑'], [C.WHITE, '我们执白']]) {
  console.log(name + '：');
  const rows = walk(us);
  if (!rows.length) { console.log('   （没有可统计的局面）\n'); continue; }
  for (const r of rows) {
    const pct = r.total ? (r.hit / r.total * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 5)).padEnd(20, '·');
    console.log(`   我方第 ${String(r.ply).padStart(2)} 手   ${bar} ${pct.toFixed(0).padStart(3)}%   ` +
                `(${r.hit}/${r.total} 个局面查得到)`);
  }
  console.log();
}
console.log('说明：这一层「查不到」的线就此中断，所以后面的层只统计前面都命中的那些分支 ——');
console.log('      也就是说，数字回答的是「顺着库走下去，能连着走多少手不用思考」。');
