/*
 * test-rapfi.js — Rapfi 接入层的回归测试（全部不需要启动引擎，秒级跑完）
 *
 * 钉死三件最容易悄悄坏掉、而且坏了不会报错的事：
 *
 * 1. **权重补丁**：12 路的 NNUE 全靠 boardsize_mask 那 1 个字节。
 *    补丁文件一旦校验和对不上，Rapfi 会静默退回传统估值继续下棋 ——
 *    看上去一切正常，棋力却掉一截。所以这里直接验校验和。
 *
 * 2. **坐标换算**：Rapfi 的行号方向和我们相反（它的 G1 = 我们的 G12）。
 *    这个换算错了不会崩，只会在复盘时让人照着错坐标找棋。
 *
 * 3. **引擎裁定入库**：verdicts 必须绕开 maxPly、必须跟着 8 种对称走。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const C = require('../js/core.js');
const B = require('../js/book.js');
const { parseInfo, labelToXY } = require('./rapfi.js');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

console.log('Rapfi 接入层');

const W_DIR = path.join(ROOT, 'engines', 'rapfi');
const W_ORIG = path.join(W_DIR, 'mix9svqfreestyle_bsmix.bin.lz4');
const W_BS12 = path.join(W_DIR, 'mix9svqfreestyle_bsmix_bs12.bin.lz4');
const haveWeights = fs.existsSync(W_ORIG) && fs.existsSync(W_BS12);

function weightInfo(file) {
  return execFileSync(process.execPath,
    [path.join(__dirname, 'rapfi-weight.js'), 'info', file],
    { encoding: 'utf8' });
}

if (!haveWeights) {
  console.log('  --   跳过权重检查（engines/rapfi 下没有权重文件）');
} else {
  ok('官方权重：本地 LZ4/xxHash32 实现能复现它的内容校验和', () => {
    const out = weightInfo(W_ORIG);
    assert.ok(/一致 ✓/.test(out), '校验和对不上，说明解压或 xxHash32 实现坏了：\n' + out);
    assert.ok(/适用尺寸\s+13~22 路/.test(out), '官方权重的尺寸声明变了：\n' + out);
  });

  ok('12 路补丁权重：校验和自洽，且尺寸声明含 12', () => {
    const out = weightInfo(W_BS12);
    assert.ok(/一致 ✓/.test(out), '补丁文件校验和不一致 —— Rapfi 会静默禁用 NNUE：\n' + out);
    assert.ok(/适用尺寸\s+12~22 路/.test(out), '补丁没生效：\n' + out);
  });

  ok('补丁只动了 1 个字节，网络参数一字未动', () => {
    const a = fs.readFileSync(W_ORIG), b = fs.readFileSync(W_BS12);
    assert.strictEqual(a.length, b.length, '文件长度不同，说明重新压缩过了');
    const diff = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
    // 1 个是 boardsize_mask 的那个字节，另外 4 个是 frame 末尾重算的内容校验和
    assert.strictEqual(diff.length, 5,
      '不同的字节有 ' + diff.length + ' 个（期望 5 = 1 个掩码 + 4 个校验和），偏移：' + diff.join(','));
    assert.strictEqual(diff[0], 0x1b, '掩码字节位置不对：0x' + diff[0].toString(16));
    assert.strictEqual(a[0x1b], 0xf0); assert.strictEqual(b[0x1b], 0xf8);
    assert.strictEqual(diff[4] - diff[1], 3, '末尾 4 个字节应该是连续的校验和');
  });

  ok('两份权重都在 config.toml 里，且官方原版排在补丁版前面', () => {
    const cfg = fs.readFileSync(path.join(W_DIR, 'config.toml'), 'utf8');
    const iOrig = cfg.indexOf('weight_file = "mix9svqfreestyle_bsmix.bin.lz4"');
    const iBs12 = cfg.indexOf('weight_file = "mix9svqfreestyle_bsmix_bs12.bin.lz4"');
    assert.ok(iOrig >= 0, 'config.toml 里没有官方自由规则权重');
    assert.ok(iBs12 >= 0, 'config.toml 里没有 12 路补丁权重');
    // 权重按顺序匹配，原版在前才能保证 13~22 路走未修改的官方文件
    assert.ok(iOrig < iBs12, '补丁版排到了官方版前面，13~22 路会改用补丁文件');
  });
}

ok('Rapfi 的标签和我们的行号方向相反（G1 ↔ G12）', () => {
  assert.deepStrictEqual(labelToXY('G1'), [6, 0]);
  assert.deepStrictEqual(labelToXY('A1'), [0, 0]);
  assert.deepStrictEqual(labelToXY('F6'), [5, 5]);
  assert.deepStrictEqual(labelToXY('L12'), [11, 11]);
  C.setSize(12);
  // 同一个点，两边叫法不同 —— 这正是必须转换的理由
  assert.strictEqual(C.pToLabel(C.xyToP(6, 0)), 'G12');
  assert.strictEqual(C.pToLabel(C.xyToP(5, 5)), 'F7');
});

ok('思维链解析：层数 / 评分 / 杀棋 / 节点数 / PV', () => {
  const r = parseInfo([
    '[Pondering] Depth 15-23 | Eval -288 | Time 337ms | F6',
    'Depth 17-42 | Eval 469 | Time 708ms | F6 F7 E8',
    'Speed 3351K | Depth 17-42 | Eval 469 | Node 2372K | Time 708ms'
  ]);
  assert.strictEqual(r.depth, 17);
  assert.strictEqual(r.seldepth, 42);
  assert.strictEqual(r.eval, 469);
  assert.strictEqual(r.mate, 0);
  assert.strictEqual(r.nodes, 2372000);
  assert.deepStrictEqual(r.pvXY, [[5, 5], [5, 6], [4, 7]]);

  const m = parseInfo(['Depth 28-21 | Eval +M25 | Time 1340ms | F6 F5']);
  assert.strictEqual(m.mate, 25, '「+M25」应解析成 25 步杀');
  const m2 = parseInfo(['Depth 26-2 | Eval -M2 | Time 1ms | G1']);
  assert.strictEqual(m2.mate, -2, '「-M2」应解析成被杀 2 步');
});

ok('引擎裁定：能查到，且不受 maxPly 限制', () => {
  C.setSize(12);
  const b = new C.Board();
  // 造一个第 10 手的局面 —— 远超统计库的 maxPly(8)
  const line = ['G6', 'F7', 'H7', 'F5', 'G7', 'G5', 'H5', 'I5', 'E7', 'D7'];
  line.forEach((s, i) => b.put(C.labelToP(s), i % 2 === 0 ? C.BLACK : C.WHITE));
  const role = C.BLACK;                      // 10 手之后轮到黑
  const ck = C.canonicalKey(b, role);
  const want = C.labelToP('I7');
  const cm = C.symFwd(ck.transform, C.pToX(want), C.pToY(want));

  const book = B.Book.load({
    size: 12, games: 0, maxPly: 0, entries: {},
    verdicts: { [B.hashKey(ck.key)]: [10, cm[1] * 15 + cm[0], 250, 24, 30000] }
  });
  const hit = book.lookup(b, role, 0);
  assert.ok(hit, '第 10 手的裁定没查到 —— maxPly 那道闸门不该拦引擎裁定');
  assert.strictEqual(hit.kind, 'verdict');
  assert.strictEqual(hit.move, want, '裁定还原出的坐标不对');
  assert.strictEqual(hit.depth, 24);
});

ok('引擎裁定跟着 8 种对称走（镜像局面也命中镜像着法）', () => {
  C.setSize(12);
  const mk = labels => {
    const b = new C.Board();
    labels.forEach((s, i) => b.put(C.labelToP(s), i % 2 === 0 ? C.BLACK : C.WHITE));
    return b;
  };
  const b1 = mk(['G6']);                      // (6,6)
  const ck = C.canonicalKey(b1, C.WHITE);
  const want = C.labelToP('F7');              // (5,5)
  const cm = C.symFwd(ck.transform, C.pToX(want), C.pToY(want));
  const book = B.Book.load({
    size: 12, games: 0, maxPly: 0, entries: {},
    verdicts: { [B.hashKey(ck.key)]: [1, cm[1] * 15 + cm[0], 0, 15, 1000] }
  });

  assert.strictEqual(book.lookup(b1, C.WHITE, 0).move, want, '原局面就没命中');
  // F6 = (5,6) 是 G6 关于竖轴的镜像，答案应该是 F7 的镜像 G7
  const b2 = mk(['F6']);
  const hit2 = book.lookup(b2, C.WHITE, 0);
  assert.ok(hit2, '镜像局面没命中 —— 对称规范化坏了');
  assert.strictEqual(C.pToLabel(hit2.move), 'G7',
    '镜像局面命中了，但着法没跟着镜像：得到 ' + C.pToLabel(hit2.move));
});

ok('裁定坐标落在已有棋子上时必须拒绝，不能返回非法着法', () => {
  C.setSize(12);
  const b = new C.Board();
  b.put(C.labelToP('G6'), C.BLACK);
  const ck = C.canonicalKey(b, C.WHITE);
  const occupied = C.labelToP('G6');
  const cm = C.symFwd(ck.transform, C.pToX(occupied), C.pToY(occupied));
  const book = B.Book.load({
    size: 12, games: 0, maxPly: 0, entries: {},
    verdicts: { [B.hashKey(ck.key)]: [1, cm[1] * 15 + cm[0], 0, 10, 1000] }
  });
  assert.strictEqual(book.lookup(b, C.WHITE, 0), null, '返回了一个已经有子的点');
});

ok('尺寸不符时裁定也不能查（12 路的库不能用在 15 路上）', () => {
  C.setSize(12);
  const b = new C.Board();
  const ck = C.canonicalKey(b, C.BLACK);
  const book = B.Book.load({
    size: 12, games: 0, maxPly: 0, entries: {},
    verdicts: { [B.hashKey(ck.key)]: [0, 6 * 15 + 6, 0, 20, 1000] }
  });
  assert.ok(book.lookup(new C.Board(), C.BLACK, 0), '12 路下本该命中');
  C.setSize(15);
  assert.strictEqual(book.lookup(new C.Board(), C.BLACK, 0), null,
    '15 路棋盘上查 12 路的库，必须拒绝');
  C.setSize(12);
});

/**
 * **对方成四就立刻封堵，不必再问引擎。**
 *
 * 这一层原先只在自研引擎里有，Rapfi 那条路上每手都要走一次进程间往返。
 * 现在抽成 Engine.instantTactic，两条路共用 —— 所以这里测的就是实战走的那份代码。
 */
const E = require('../js/engine.js');
function pos(blacks, whites) {
  C.setSize(12);
  const b = new C.Board();
  for (const L of blacks) b.put(C.labelToP(L), C.BLACK);
  for (const L of whites) b.put(C.labelToP(L), C.WHITE);
  return b;
}

ok('对方冲四（唯一封堵点）必须直接挡，不走引擎', () => {
  // 白 F6 G7 H8 I9 对角四连，E5 已被黑占，只剩 J10 能成五
  const b = pos(['E5', 'A1', 'A2'], ['F6', 'G7', 'H8', 'I9']);
  const r = E.instantTactic(b, C.BLACK);
  assert.ok(r, '该出手的局面却返回了 null');
  assert.strictEqual(C.pToLabel(r.move), 'J10');
  assert.strictEqual(r.win, false);
});

ok('对方跳四也要认（F6 G7 _ I9 J10 挡 H8）', () => {
  const b = pos(['A1', 'A2'], ['F6', 'G7', 'I9', 'J10']);
  const r = E.instantTactic(b, C.BLACK);
  assert.ok(r, '跳四没认出来');
  assert.strictEqual(C.pToLabel(r.move), 'H8');
});

ok('我方能成五时优先自己赢，而不是去挡对方', () => {
  // 黑 D4-G7 四连（H8 成五），白同时也有 F6-I9 少一子的四
  const b = pos(['D4', 'E5', 'F6', 'G7'], ['B10', 'C9', 'D8', 'E7']);
  const r = E.instantTactic(b, C.BLACK);
  assert.ok(r && r.win, '自己能成五却没认出来');
  assert.strictEqual(C.pToLabel(r.move), 'H8');
});

ok('平静局面必须返回 null（交给引擎算，不能乱出手）', () => {
  const b = pos(['G6', 'F7'], ['G7', 'F8']);
  assert.strictEqual(E.instantTactic(b, C.BLACK), null);
});

/* ---------------------------------------------------------------- */
/* 下面这条要真的启动引擎，所以放在最后，而且允许没装引擎时跳过。      */

/**
 * **后台思考之后不许走增量推进。**
 *
 * 这条是拿一整局输棋换来的（logs 2026-09-20T12-42-17，12 路，AI 执黑）：
 * 界面每手 AI 走完都会发 /engine/ponder，而协议里**引擎输出着法就等于在它
 * 自己的棋盘上落子** —— 后台思考结束时引擎盘上就多了一子，我们这边的
 * this.moves 却被还原了。下一手若走增量 TURN，那颗子会被当成对方的棋，
 * 连「轮到谁」都跟着反过来。
 *
 * 实战后果：第 13 手引擎以**白棋身份**给出 D8（把对手的 E8-F8 连成三连），
 * 评分 -M22「被杀 22 步」。而同一局面整盘重置后它 62ms 就找到 I4，+M5，
 * 我方五步杀。就这一手直接输掉整局。
 *
 * 所以：跑过后台思考之后，下一次正式求着必须是 incremental === false。
 */
async function liveCheck() {
  const { Rapfi, pickExe, ENGINE_DIR } = require('./rapfi.js');
  if (!pickExe(ENGINE_DIR)) { console.log('  --   跳过真引擎回归（engines/rapfi 下没有可执行文件）'); return; }
  C.setSize(12);
  const GAME = 'G6 G7 F7 F8 H5 E8 H6 F6 H4 H7 F4 H8'.split(' ');
  const xy = GAME.map(L => { const p = C.labelToP(L); return [C.pToX(p), C.pToY(p)]; });
  const r = new Rapfi({ threads: 4, pondering: true, matchSpread: 21 });
  await r.start();
  await r.newGame(12);
  await r.think([], 50); r.restart();
  try {
    // 先正常走一手，让 this.moves 对齐到 11 子
    await r.think(xy.slice(0, 10), 2000);
    // 再像界面那样发起后台思考，然后收掉
    r.startPonder(xy.slice(0, 11), 3000);
    await new Promise(res => setTimeout(res, 800));
    await r.endPonder();
    // 现在问第 13 手。必须整盘重置，而且必须找到我方杀棋。
    const d = await r.think(xy, 4000);
    const lbl = C.pToLabel(C.xyToP(d.x, d.y));
    ok('后台思考之后必须整盘重置（不重置会让引擎按对方颜色思考）', () => {
      assert.strictEqual(d.incremental, false,
        '后台思考弄脏了引擎棋盘，这一手却走了增量 TURN');
    });
    ok('那一局输棋的局面：必须给出我方杀棋，而不是 D8', () => {
      assert.ok(d.mate > 0, '评分应为我方必胜，实际 mate=' + d.mate + '（实战当时是 -22）');
      assert.notStrictEqual(lbl, 'D8', '又走回了那手白棋才该走的 D8');
    });
  } finally { r.stop(); }
}

liveCheck().catch(e => { console.log('  FAIL 真引擎回归\n       ' + e.message); fail++; }).then(() => {
  console.log(`\n${pass} 项通过${fail ? '，' + fail + ' 项失败' : ''}`);
  process.exit(fail ? 1 : 0);
});
