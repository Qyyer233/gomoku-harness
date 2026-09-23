/*
 * e2e-timing.js — 回答三个问题，而且必须在**真实路径**上回答：
 *
 *   1. Rapfi 的手感（每手要等多久）和自研引擎比如何？
 *   2. 棋力是不是真的更强？
 *   3. 会不会超出界面设的思考上限？
 *
 * 关键：不能用 vs-js.js 那种进程内对弈来量时间。那里 js.bestMove() 是同步阻塞的，
 * 会把 Node 的事件循环堵死，量出来的 Rapfi 用时里混着大段排队时间（实测墙钟 2830ms
 * 而引擎自报 280ms）。所以这里**真的把 serve.js 起起来**，走 HTTP，
 * 用和 ui.js 完全相同的调用序列：先查库 → 命中就 /engine/ponder → 没命中才 /engine/move。
 * 量的是「浏览器按下去到拿到着法」的端到端时间，也就是用户真正等的那个时间。
 *
 * 用法：node tools/e2e-timing.js --games 6 --size 12 --cap 6000 --pace 21
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const C = require('../js/core.js');
const E = require('../js/engine.js');
const B = require('../js/book.js');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i < 0 ? d : (isNaN(+process.argv[i + 1]) ? process.argv[i + 1] : +process.argv[i + 1]);
};
const SIZE  = arg('size', 12);
const GAMES = arg('games', 6);
const CAP   = arg('cap', 6000);
const PACE  = arg('pace', 21);
const PORT  = arg('port', 8199);
// 预备宽度。界面上是「超前思考强度」那个下拉框，默认 3。
// 设 0 就只测引擎本身，不测预备。
const WIDTH = arg('width', 3);
// 对手回合有多长 —— 也就是预备的窗口。实战里录入对手着法要十几秒，
// 不补这段等待，预备根本没时间跑（踩过：命中率从 70.8% 掉到 12.5%）。
const OPPWAIT = arg('oppwait', 0);
const MAXPLY = SIZE * SIZE;

C.setSize(SIZE);
const book = B.Book.load(fs.readFileSync(
  path.join(ROOT, 'data', SIZE === 15 ? 'book.json' : `book${SIZE}.json`), 'utf8'));

const DEBUG = process.argv.includes('--debug');
const post = (p, body) => fetch(`http://127.0.0.1:${PORT}${p}`, {
  // 这个脚本自己也有同步阻塞的 JS 引擎，会饿死 undici 的连接池定时器，
  // 于是复用到已被服务器关掉的连接。测试工具不在乎建连开销，直接不复用。
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
  body: JSON.stringify(body)
}).then(r => r.json()).catch(e => { const c = e.cause ? (e.cause.code || e.cause.message) : e.message; throw new Error(p + ' 请求失败：' + c); });

/** 和 ui.js 的 rapfiMove 一样：先查库，命中就顺手起后台思考 */
async function appMove(gid, b, role, moves) {
  const t0 = Date.now();
  const hit = book.lookup(b, role, 0);
  if (hit && b.cells[hit.move] === C.EMPTY) {
    const ms = Date.now() - t0;
    const hist = moves.concat([hit.move]).map(q => [C.pToX(q), C.pToY(q)]);
    if (DEBUG) console.log('   [第 ' + moves.length + ' 手] 查库命中 ' + C.pToLabel(hit.move) + '，发起后台思考');
    post('/engine/ponder', { gid, size: SIZE, moves: hist, width: WIDTH, ms: CAP }).catch(() => {});
    return { move: hit.move, ms, src: 'book' };
  }
  if (DEBUG) console.log('   [第 ' + moves.length + ' 手] 求 Rapfi 出手，已知 ' + moves.length + ' 子');
  const d = await post('/engine/move', {
    gid, size: SIZE, moves: moves.map(q => [C.pToX(q), C.pToY(q)]), ms: CAP, pace: PACE
  });
  if (d.error) throw new Error(d.error);
  return { move: C.xyToP(d.x, d.y), ms: Date.now() - t0, src: 'rapfi',
           depth: d.depth, engineMs: d.engineMs, prepared: d.prepared };
}

function pct(a, q) { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }
const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;

function openings(n, seed) {
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const c = (SIZE - 1) >> 1, out = [];
  for (let i = 0; i < n; i++) {
    const mv = [], used = new Set();
    for (let k = 0; k < 2; k++) {
      let x, y, t = 0;
      do { x = c + ((rnd() * 5) | 0) - 2; y = c + ((rnd() * 5) | 0) - 2; }
      while (used.has(y * SIZE + x) && ++t < 40);
      used.add(y * SIZE + x); mv.push(C.xyToP(x, y));
    }
    out.push(mv);
  }
  return out;
}

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, 'serve.js'), String(PORT)],
                    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', d => process.stdout.write('[serve.js stderr] ' + d));
  srv.on('exit', c => process.stdout.write('[serve.js 退出] code=' + c + String.fromCharCode(10)));
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('serve.js 没起来')), 20000);
    srv.stdout.on('data', d => { if (DEBUG) process.stdout.write('[serve.js] ' + d); if (/已启动/.test(String(d))) { clearTimeout(to); res(); } });
  });
  console.log(`serve.js 已起在 ${PORT}（和你 npm start 起的是同一个东西）`);
  console.log(`${SIZE} 路 · 思考上限 ${CAP}ms · 用时风格 ${PACE} · ${GAMES} 局`);
  console.log('对手 = 自研引擎大师档（同样 ' + CAP + 'ms 上限），负责把局面下到真实难度\n');

  const opens = openings(Math.ceil(GAMES / 2), 424242);
  const rap = { lat: [], eng: [], book: 0, prep: 0, over: [], win: 0, loss: 0, draw: 0, depth: [] };
  const js  = { lat: [], book: 0, over: [] };
  const jsEng = new E.Engine(); jsEng.setBook(book);

  for (let g = 0; g < GAMES; g++) {
    const gid = 't' + Date.now() + '-' + g;
    const rapfiBlack = g % 2 === 0;
    const b = new C.Board(); const moves = [];
    for (const p of opens[g >> 1]) { if (b.cells[p] === C.EMPTY) { b.put(p, moves.length % 2 ? C.WHITE : C.BLACK); moves.push(p); } }
    jsEng.reset();
    let res = 0;
    while (moves.length < MAXPLY) {
      const role = moves.length % 2 === 0 ? C.BLACK : C.WHITE;
      const isApp = (role === C.BLACK) === rapfiBlack;
      let p;
      if (isApp) {
        const r = await appMove(gid, b, role, moves);
        p = r.move;
        if (r.prepared) rap.prep++;
        if (r.src === 'book') rap.book++;
        else {
          rap.lat.push(r.ms);
          if (r.engineMs) rap.eng.push(r.engineMs);
          if (r.depth) rap.depth.push(r.depth);
          if (r.ms > CAP) rap.over.push(r.ms);
        }
      } else {
        // 对手走自研引擎。顺带也量它的手感：界面上换成 JS 内核就是这个延迟。
        const t0 = Date.now();
        const hit = book.lookup(b, role, 0);
        if (hit && b.cells[hit.move] === C.EMPTY) { p = hit.move; js.book++; }
        else {
          p = jsEng.bestMove(b, role, { level: 'master', useBook: false, timeMax: CAP }).move;
          const ms = Date.now() - t0;
          js.lat.push(ms); if (ms > CAP) js.over.push(ms);
        }
      }
      if (p < 0 || b.cells[p] !== C.EMPTY) { res = isApp ? -1 : 1; break; }
      b.put(p, role); moves.push(p);
      if (b.lastMoveWins()) { res = isApp ? 1 : -1; break; }

      // 我方刚落完子 -> 轮到对手。和 ui.js 的 startPonder() 一样，
      // 这时候把预备发起来；然后补上对手思考的时间。
      // **不补这段等待就测不出预备** —— 本地对手是瞬间出手的，窗口不存在。
      if (isApp && WIDTH > 0) {
        const hist2 = moves.map(q => [C.pToX(q), C.pToY(q)]);
        post('/engine/ponder', { gid, size: SIZE, moves: hist2, width: WIDTH, ms: CAP }).catch(() => {});
        if (OPPWAIT > 0) await new Promise(r2 => setTimeout(r2, OPPWAIT));
      }
    }
    if (res > 0) rap.win++; else if (res < 0) rap.loss++; else rap.draw++;
    await post('/engine/end', { gid }).catch(() => {});
    process.stdout.write(`  第 ${g + 1}/${GAMES} 局  Rapfi ${rap.win}-${rap.loss}-${rap.draw}` +
      `  本方均 ${avg(rap.lat)}ms / 最慢 ${Math.max(0, ...rap.lat)}ms  超限 ${rap.over.length}\n`);
  }

  const row = (name, s, extra) => console.log(
    `  ${name.padEnd(12)} 平均 ${String(avg(s.lat)).padStart(5)}ms   ` +
    `中位 ${String(pct(s.lat, 0.5)).padStart(5)}ms   ` +
    `p95 ${String(pct(s.lat, 0.95)).padStart(5)}ms   ` +
    `最慢 ${String(Math.max(0, ...s.lat)).padStart(5)}ms   ` +
    `查库 ${s.book} 手 / 预备命中 ${s.prep || 0} 手 / 思考 ${s.lat.length} 手${extra || ''}`);

  console.log('\n================ 手感（端到端，用户真正等的时间）================');
  console.log(`  思考上限 ${CAP}ms`);
  row('Rapfi 内核', rap, `   引擎自报均 ${avg(rap.eng)}ms · 均 ${avg(rap.depth)} 层`);
  row('自研 JS', js);
  console.log('\n================ 超限 ================');
  console.log(`  Rapfi   超出 ${CAP}ms 的手数：${rap.over.length} / ${rap.lat.length}` +
              (rap.over.length ? `   最大超出 ${Math.max(...rap.over) - CAP}ms` : '   ✓'));
  console.log(`  自研 JS 超出 ${CAP}ms 的手数：${js.over.length} / ${js.lat.length}` +
              (js.over.length ? `   最大超出 ${Math.max(...js.over) - CAP}ms` : '   ✓'));
  const n = rap.win + rap.loss + rap.draw, sc = (rap.win + rap.draw / 2) / n;
  console.log('\n================ 棋力 ================');
  console.log(`  Rapfi ${rap.win} 胜 ${rap.loss} 负 ${rap.draw} 和   得分率 ${(sc * 100).toFixed(1)}%（局数少，只作旁证，主结论看 vs-js.js 的 120 局）`);

  srv.kill();
  process.exit(0);
}
main().catch(e => {
  console.error(e);
  // 缓一秒再退：serve.js / Rapfi 的崩溃信息往往比这个错误晚一拍才到
  setTimeout(() => process.exit(1), 1500);
});
