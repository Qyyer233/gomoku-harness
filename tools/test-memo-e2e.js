/*
 * test-memo-e2e.js — 记忆库走完整条链路
 *
 * memo.js 的单元测试只管它自己算得对不对。**真正会出错的是接线**：
 * 查询的时机、和预备缓存的先后、胜负从 /log 回灌进去、
 * 以及「被否决之后引擎真的换了一手吗」。这些只有把服务器真起起来才测得到。
 *
 * 会起一个真的 Rapfi 进程，所以比别的测试慢（半分钟上下），
 * 也因此没放进 npm test —— 手动跑：node tools/test-memo-e2e.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = parseInt(process.env.PORT || '8199', 10);
const MEMO = path.join(os.tmpdir(), 'memo-e2e-' + process.pid + '.json');
// 假棋局写到临时目录，绝不能落进真 logs/
const LOGDIR = path.join(os.tmpdir(), 'memo-e2e-logs-' + process.pid);
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = m => { pass++; console.log('  ✓ ' + m); };
const bad = m => { fail++; console.log('  ✗ ' + m); };

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: url, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(new Error(s)); } });
    });
    req.on('error', reject);
    req.end(data);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 12 路，已走 5 手（就是实战输掉那局的开局），轮白走
const POS = [[6, 5], [7, 4], [7, 6], [5, 4], [8, 6]];
const LABELS = ['G7', 'H8', 'H6', 'F8', 'I6'];

(async () => {
  console.log('记忆库端到端（会起一个真的 Rapfi）');
  const srv = spawn(process.execPath, [path.join(__dirname, 'serve.js'), String(PORT)], {
    cwd: ROOT, env: Object.assign({}, process.env, { RAPFI_MEMO_FILE: MEMO, RAPFI_PREP_ENGINES: '1', RAPFI_MEMO_SAVE_MS: '800', RAPFI_LOG_DIR: LOGDIR,
      // 测试里把空闲门槛和复查预算都调小，否则一轮要等好几分钟
      RAPFI_REVIEW_IDLE_MS: '4000', RAPFI_REVIEW_MS: '1500' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });

  const done = () => {
    srv.kill();
    try { fs.unlinkSync(MEMO); } catch (e) {}
    try { fs.rmSync(LOGDIR, { recursive: true, force: true }); } catch (e) {}
    console.log('\n' + pass + ' 条通过' + (fail ? '，' + fail + ' 条失败' : ''));
    if (fail) console.log('\n--- 服务器输出 ---\n' + log);
    process.exit(fail ? 1 : 0);
  };

  try {
    // 等服务器起来
    for (let i = 0; i < 60; i++) {
      try { await post('/engine/move', {}); break; } catch (e) { await sleep(500); }
    }

    // ---- 1. 第一次：真搜索，并且记进库 ----
    const r1 = await post('/engine/move', { gid: 'e2e-1', size: 12, moves: POS, ms: 2500, rule: 0 });
    if (r1.error) { bad('第一次搜索失败：' + r1.error); return done(); }
    if (r1.source === 'memo') bad('空库不该命中记忆');
    else ok('第一次是真搜索：走 ' + r1.x + ',' + r1.y + '，' + r1.depth + ' 层 / ' + r1.ms + 'ms');
    const first = r1.x + ',' + r1.y;

    await sleep(3500);                          // 等记忆库攒批写盘
    const saved = JSON.parse(fs.readFileSync(MEMO, 'utf8'));
    const nPos = Object.keys(saved.positions).length;
    if (nPos < 1) bad('搜索完了记忆库还是空的');
    else ok('搜索结果已落盘（' + nPos + ' 个局面）');

    // ---- 2. 第二次（新会话）：应当 0ms 命中 ----
    const r2 = await post('/engine/move', { gid: 'e2e-2', size: 12, moves: POS, ms: 2500, rule: 0 });
    if (r2.source !== 'memo') bad('同一局面第二次应命中记忆，实际 source=' + r2.source);
    else if (r2.x + ',' + r2.y !== first) bad('记忆命中却换了一手：' + r2.x + ',' + r2.y);
    else if (r2.timing.total > 800) bad('记忆命中不该慢，用了 ' + r2.timing.total + 'ms');
    else ok('第二次 0ms 命中记忆（服务端共 ' + r2.timing.total + 'ms，省下 2500ms 思考）');

    // ---- 3. 换规则不该命中（禁手与否是两套评估）----
    const r3 = await post('/engine/move', { gid: 'e2e-3', size: 12, moves: POS, ms: 1200, rule: 4 });
    if (r3.source === 'memo') bad('换了规则还命中同一条记忆');
    else ok('换成有禁手规则后不再命中（会话也跟着重建）');

    // ---- 4. 上报一局输棋：不禁着法，改排复查队列 ----
    // 胜负只决定「把算力花在哪个局面上」，不决定「哪一手对」——
    // 对手水平完全不可控，正着也可能输给高手（为此输过一局，见 memo.js 顶部）。
    await post('/log', {
      id: 'e2e-loss', size: 12, rule: 0, aiColor: 'W', result: '对手胜',
      moves: LABELS.concat([labelOf(r1.x, r1.y), 'H5']),
      ai: [{ ply: 6, source: 'memo', score: -300 }]
    });
    await sleep(900);
    const after = JSON.parse(fs.readFileSync(MEMO, 'utf8'));
    const anyRefuted = Object.values(after.positions)
      .some(p => p.m.some(e => e.l > 0 && e.w === 0 && e.dead === undefined && e.banned));
    if (anyRefuted) bad('输棋之后不该有任何「禁用」标记');
    else ok('输棋没有禁掉任何着法');
    if (!Array.isArray(after.review) || !after.review.length)
      bad('输棋之后复查队列还是空的');
    else ok('输棋排进了复查队列（' + after.review.length + ' 个局面）');

    // ---- 5. 同一个局面再问：还是给分析最深的那一手 ----
    const r5 = await post('/engine/move', { gid: 'e2e-5', size: 12, moves: POS, ms: 2500, rule: 0 });
    if (r5.error) bad('再次查询失败：' + r5.error);
    else if (r5.x + ',' + r5.y !== first)
      bad('输过一局就换了手（' + r5.x + ',' + r5.y + '）—— 胜负不该影响选着法');
    else ok('输过之后照样给同一手（' + first + '）—— 深度说了算，不是胜负');

    // ---- 6. 着法必须合法 ----
    if (POS.some(m => m[0] === r5.x && m[1] === r5.y)) bad('给出的着法落在已有子上');
    else ok('给出的着法合法（空点）');

    // ---- 7. 棋谱库 vs 记忆库：谁的分析深听谁的 ----
    {
      const pos2 = POS.slice(0, 3);                 // G7 H8 H6，轮白走
      const bookMv = [0, 0];            // 角落 —— 引擎绝不会自己选，才好验证「听谁的」
      // 棋谱库那一手算了 3 秒；记忆库这个局面只有实战级别的记录 -> 听棋谱库的
      const rb = await post('/engine/move', {
        gid: 'e2e-b', size: 12, moves: pos2, ms: 2500, rule: 0,
        book: bookMv, bookNote: '测试用', bookDepth: 20, bookMs: 3000
      });
      if (rb.source !== 'book') bad('棋谱库算得更久时应原样放行，实际 source=' + rb.source);
      else if (rb.x !== 0 || rb.y !== 0) bad('放行却改了着法：' + rb.x + ',' + rb.y);
      else ok('棋谱库算了 3 秒、记忆库没有更深的 -> 用棋谱库（' + rb.timing.total + 'ms）');

      // 同一个局面塞一条 30 秒的深结论进去 -> 该听记忆库的
      await post('/engine/move', { gid: 'e2e-b', size: 12, moves: pos2, ms: 2500, rule: 0 });
      await sleep(1200);
      const rb2 = await post('/engine/move', {
        gid: 'e2e-b2', size: 12, moves: pos2, ms: 1200, rule: 0,
        book: bookMv, bookNote: '测试用', bookDepth: 20, bookMs: 10
      });
      if (rb2.source === 'book')
        bad('棋谱库那一手只算了 10ms，记忆库有更深的结论，却还是用了棋谱库');
      else ok('棋谱库只算了 10ms -> 改用记忆库的 ' + rb2.x + ',' + rb2.y);
    }

    // ---- 8. 预备算出来的线路也要进记忆库 ----
    // 实战日志查出来的洞：真搜索的 101 手全记了，**预备命中的 51 手一条都没记**。
    // 预备引擎是真的在搜（20 多层），算完就扔太亏 —— 而且每轮备的几条里
    // 只有一条会被走中，其余几条下一局遇到就是 0ms 直出。
    {
      const posA = [[6, 5], [7, 4]];                 // 两手，轮我方走（白）
      await post('/engine/move', { gid: 'e2e-p', size: 12, moves: posA, ms: 1200, rule: 0 });
      await sleep(3500);
      const before = Object.keys(JSON.parse(fs.readFileSync(MEMO, 'utf8')).positions).length;

      // 触发预备：备对手的前 3 手
      await post('/engine/ponder', {
        gid: 'e2e-p', size: 12, moves: posA.concat([[7, 6]]), rule: 0, width: 3, ms: 900
      });
      await sleep(9000);                             // 等它备完 + 攒批写盘
      const after = Object.keys(JSON.parse(fs.readFileSync(MEMO, 'utf8')).positions).length;
      if (after <= before)
        bad('预备算完之后记忆库没变大（' + before + ' -> ' + after + '），成果还是被扔了');
      else
        ok('预备的成果进了记忆库（局面数 ' + before + ' -> ' + after + '，多了 ' + (after - before) + ' 个）');
    }

    // ---- 9. 空闲复查：输棋排的队，闲下来要真的跑掉 ----
    // 这是胜负唯一还起作用的地方 —— 它只决定「往哪儿花算力」。
    // 两个方向都要测：闲下来要跑，有人用时绝不能跑。
    {
      // 先排一局新的进去 —— 前面那条多半已经被跑掉了（说明它确实在工作）
      await post('/engine/move', { gid: 'e2e-r', size: 12, moves: POS.slice(0, 1), ms: 600, rule: 0 });
      await sleep(1200);
      await post('/log', {
        id: 'e2e-loss2', size: 12, rule: 0, aiColor: 'W', result: '对手胜',
        moves: ['G7', 'H8', 'H6'],
        ai: [{ ply: 2, source: 'memo', score: -200 }]
      });
      await sleep(900);
      const q0 = JSON.parse(fs.readFileSync(MEMO, 'utf8')).review.length;
      if (!q0) bad('复查队列是空的，没法验证');
      else {
        // 先证明「有请求就不跑」：连着发请求，队列不该动
        for (let i = 0; i < 6; i++) {
          await post('/engine/move', { gid: 'e2e-busy', size: 12, moves: POS.slice(0, 3), ms: 400, rule: 0 });
          await sleep(400);
        }
        const qBusy = JSON.parse(fs.readFileSync(MEMO, 'utf8')).review.length;
        if (qBusy < q0) bad('一直有请求，复查却跑了 —— 会和对局抢 CPU');
        else ok('有请求时复查不启动（队列仍是 ' + qBusy + ' 个）');

        // 再证明「闲下来就跑」
        let q1 = qBusy;
        for (let i = 0; i < 30 && q1 >= qBusy; i++) {
          await sleep(2000);
          q1 = JSON.parse(fs.readFileSync(MEMO, 'utf8')).review.length;
        }
        if (q1 >= qBusy) bad('闲置很久了，复查队列没动（' + qBusy + ' -> ' + q1 + '）');
        else ok('闲下来自动跑了复查（队列 ' + qBusy + ' -> ' + q1 + '）');
      }
    }

    // ---- 10. 统计接口 ----
    const st = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/engine/memo' }, res => {
        let s = ''; res.on('data', c => s += c); res.on('end', () => resolve(JSON.parse(s)));
      }).on('error', reject);
    });
    if (!st || !st.positions) bad('/engine/memo 没返回统计');
    else ok('/engine/memo: ' + st.positions + ' 个局面 / ' + st.moves + ' 手，' +
            st.deep + ' 条深结论，复查队列 ' + st.review + ' 个');
  } catch (e) {
    bad('异常：' + e.message);
  }
  done();
})();

/** (x,y) -> 界面用的标签。12 路下 y=0 是第 12 行。 */
function labelOf(x, y) { return 'ABCDEFGHIJKL'[x] + (12 - y); }
