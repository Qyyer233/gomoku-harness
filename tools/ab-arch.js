/*
 * ab-arch.js — 新架构 对 旧架构，在**实战的真实条件**下打一场
 *
 * 要回答的问题：把 24 核切成「主引擎 8 线程 + 2 个预备引擎各 8 线程」之后，
 * 整体是更强还是更弱？
 *
 *   新（A）：主引擎 8 线程，每手上限 6 秒；轮到对手时用 2 个预备引擎并行预测、
 *           把我们的应手提前算好。命中就直出 —— 而且那一手是用 10 秒算的，
 *           比我们自己现场能花的 6 秒还多。
 *   旧（B）：主引擎 24 线程，每手上限 6 秒，不预备。
 *
 * **为什么必须模拟"对手思考的窗口"**：实战里对手是人，
 * 他想棋、再把他的着法录进来要十几秒，这段时间本机 CPU 全空着 —— 那正是预备吃饭的地方。
 * 引擎对弈里两边都是瞬间出手，不补上这个窗口，预备根本没时间跑，
 * 测出来必然是「预备没用」。（踩过：窗口没补时命中率只有 12.5%，补上之后 70.8%。）
 *
 * **开局必须用平衡开局**。随机撒子的开局胜负由开局本身决定：
 * 实测 24 核对 1 核连着两次都是精确的 15 胜 15 负 —— 先手每局都赢，
 * 棋力差别一点没体现。先跑 tools/balanced-openings.js 造一批。
 *
 * 用法：node tools/ab-arch.js --games 16 --window 12000
 */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../js/core.js');
const { Rapfi } = require('./rapfi.js');
const { Prepare } = require('./prepare.js');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i < 0 ? d : (isNaN(+process.argv[i + 1]) ? process.argv[i + 1] : +process.argv[i + 1]);
};
const SIZE = arg('size', 12);
const GAMES = arg('games', 16);
const CAP = arg('ms', 6000);           // 双方正式出手的上限
const WINDOW = arg('window', 12000);   // 对手回合有多长（= 预备的窗口）
const A_MAIN = arg('amain', 8);
const A_PREPN = arg('aprepn', 2);
const A_PREPT = arg('aprept', 8);
const A_PREPMS = arg('aprepms', 10000);
const A_WIDTH = arg('awidth', 5);
const B_MAIN = arg('bmain', 24);
const MAXPLY = arg('maxply', 60);

C.setSize(SIZE);

const OPENS_FILE = path.join(ROOT, 'data', `openings${SIZE}-balanced.json`);
if (!fs.existsSync(OPENS_FILE)) {
  console.error(`没有平衡开局文件：${path.relative(ROOT, OPENS_FILE)}`);
  console.error('先跑：node tools/balanced-openings.js --size ' + SIZE);
  process.exit(1);
}
const OPENS = JSON.parse(fs.readFileSync(OPENS_FILE, 'utf8')).openings;

function stats(win, loss, draw) {
  const n = win + loss + draw;
  if (!n) return { score: 0, se: 0 };
  const w = win / n, d = draw / n, score = w + d / 2;
  return { score, se: Math.sqrt(Math.max(w + d / 4 - score * score, 0) / n) };
}
const elo = s => s <= 0 ? -800 : s >= 1 ? 800 : -400 * Math.log10(1 / s - 1);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`${SIZE} 路 · ${GAMES} 局 · 双方每手上限 ${CAP}ms · 对手回合窗口 ${WINDOW}ms`);
  console.log(`A（新）主引擎 ${A_MAIN} 线程 + ${A_PREPN} 个预备各 ${A_PREPT} 线程，宽度 ${A_WIDTH}，每条 ${A_PREPMS}ms`);
  console.log(`B（旧）主引擎 ${B_MAIN} 线程，不预备`);
  console.log(`开局：${path.relative(ROOT, OPENS_FILE)} 的 ${OPENS.length} 个平衡开局，每个正反各打一遍\n`);

  const A = new Rapfi({ threads: A_MAIN, pondering: false, matchSpread: 21 });
  const B = new Rapfi({ threads: B_MAIN, pondering: false, matchSpread: 21 });
  const preps = [];
  for (let i = 0; i < A_PREPN; i++) preps.push(new Rapfi({ threads: A_PREPT, pondering: false, matchSpread: 0 }));
  await A.start(); await B.start();
  for (const p of preps) await p.start();

  let win = 0, loss = 0, draw = 0, hit = 0, miss = 0, aMs = 0, aN = 0, bMs = 0, bN = 0;

  for (let g = 0; g < GAMES; g++) {
    const open = OPENS[(g >> 1) % OPENS.length];
    await A.newGame(SIZE); await B.newGame(SIZE);
    for (const p of preps) await p.newGame(SIZE);
    await A.think([], 50); A.restart();
    await B.think([], 50); B.restart();
    for (const p of preps) { await p.think([], 50); p.restart(); }
    const prep = new Prepare(preps, { width: A_WIDTH, perMoveMs: A_PREPMS });

    const b = new C.Board(), moves = [];
    for (const m of open.moves) {
      const p = C.xyToP(m[0], m[1]);
      if (b.cells[p] !== C.EMPTY) continue;
      b.put(p, moves.length % 2 === 0 ? C.BLACK : C.WHITE);
      moves.push(p);
    }
    const aBlack = g % 2 === 0;
    let res = 0;

    while (moves.length < MAXPLY) {
      const role = moves.length % 2 === 0 ? C.BLACK : C.WHITE;
      const isA = (role === C.BLACK) === aBlack;
      const xy = moves.map(q => [C.pToX(q), C.pToY(q)]);
      let mv;
      if (isA) {
        const t0 = Date.now();
        const ready = prep.get(xy);
        if (ready) { hit++; prep.stop(); mv = [ready.x, ready.y]; }
        else {
          miss++;
          prep.stop();
          let r; try { r = await A.think(xy, CAP); } catch (e) { res = -1; break; }
          mv = [r.x, r.y];
        }
        aMs += Date.now() - t0; aN++;
      } else {
        const t0 = Date.now();
        let r; try { r = await B.think(xy, CAP); } catch (e) { res = 1; break; }
        mv = [r.x, r.y];
        bMs += Date.now() - t0; bN++;
      }
      const p = C.xyToP(mv[0], mv[1]);
      if (p < 0 || b.cells[p] !== C.EMPTY) { res = isA ? -1 : 1; break; }
      b.put(p, role); moves.push(p);
      if (b.lastMoveWins()) { res = isA ? 1 : -1; break; }

      // A 刚落完子 -> 轮到 B。这就是 A 的预备窗口：
      // 对手在另一台机器上想 WINDOW 毫秒，本机 CPU 全归预备。
      if (isA) {
        prep.start(moves.map(q => [C.pToX(q), C.pToY(q)]));
        const spent = 0;
        await sleep(Math.max(0, WINDOW - spent));
      }
    }
    await prep.cancel();
    if (res > 0) win++; else if (res < 0) loss++; else draw++;
    const { score, se } = stats(win, loss, draw);
    console.log(`  ${String(g + 1).padStart(3)}/${GAMES}  ${win}-${loss}-${draw}  ` +
      `A 得分率 ${(score * 100).toFixed(1)}%  ±${(se * 196).toFixed(1)}%  Elo ${elo(score).toFixed(0)}  ` +
      `预备命中 ${hit}/${hit + miss}  每手 A ${aN ? Math.round(aMs / aN) : 0}ms / B ${bN ? Math.round(bMs / bN) : 0}ms`);
  }

  A.stop(); B.stop(); for (const p of preps) p.stop();

  const { score, se } = stats(win, loss, draw);
  const lo = score - 1.96 * se, hi = score + 1.96 * se;
  console.log('\n================ 结论 ================');
  console.log(`A（新架构）${win} 胜 ${loss} 负 ${draw} 和`);
  console.log(`得分率 ${(score * 100).toFixed(1)}%  95% 区间 [${(lo * 100).toFixed(1)}%, ${(hi * 100).toFixed(1)}%]  Elo ${elo(score).toFixed(0)}`);
  console.log(`预备命中率 ${((hit / (hit + miss)) * 100).toFixed(1)}%   每手 A ${aN ? Math.round(aMs / aN) : 0}ms / B ${bN ? Math.round(bMs / bN) : 0}ms`);
  if (lo > 0.5) console.log('判定：新架构更强 ✓');
  else if (hi < 0.5) console.log('判定：新架构更弱 ✗ —— 那 0.9 层的代价没换回来，该退回 24 线程');
  else console.log('判定：棋力上分不出高下 —— 但新架构的手更快，而且省下的核是白捡的');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
