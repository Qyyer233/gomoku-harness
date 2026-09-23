/*
 * test-memo.js — 实战记忆库
 *
 * 这里测的每一条都对应一个真实会犯的错：
 *   · 记了却查不回来（对称规范化写反过一次，镜像局面就查不到）
 *   · 输过的线路还照走（这正是输掉那一局的直接原因）
 *   · 浅搜索把好记忆冲掉（一手被时限掐断的 3 层搜索覆盖掉 25 层的结论）
 *   · 一局输棋把沿途每一手都否掉（那样记忆库会自己把自己清空）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../js/core.js');
const { Memo, quality } = require('./memo.js');

let pass = 0, fail = 0;
const ok = m => { pass++; console.log('  ✓ ' + m); };
const bad = m => { fail++; console.log('  ✗ ' + m); };
const check = (cond, m) => cond ? ok(m) : bad(m);

const tmp = path.join(os.tmpdir(), 'memo-test-' + process.pid + '.json');
const fresh = () => { try { fs.unlinkSync(tmp); } catch (e) {} return new Memo(tmp); };

/** 把 "G7 H8" 这样的棋谱转成 [[x,y],…]（先 setSize） */
function mv(size, s) {
  C.setSize(size);
  return s.trim().split(/\s+/).filter(Boolean).map(t => {
    const p = C.labelToP(t);
    return [C.pToX(p), C.pToY(p)];
  });
}

console.log('实战记忆库');

// ---------- 1. 记了就要能查回来 ----------
let m = fresh();
let moves = mv(12, 'G7 H8 H6');
m.record(12, 0, moves, { x: 5, y: 7, eval: -116, mate: 0, depth: 25, ms: 3000 }, 6000);
let hit = m.lookup(12, 0, moves, 6000);
check(hit && hit.x === 5 && hit.y === 7, '记录之后查得回来');
check(hit && hit.d === 25 && hit.ms === 3000, '深度和用时一起存下来了');

// ---------- 2. 对称局面共享同一条记忆 ----------
// 把整盘左右翻过来，查到的着法也应该跟着翻。
// 规范化写反的话这里会直接查不到 —— 而实战中对手的开局本来就是各个方向都有。
{
  const flip = s => { C.setSize(12); return s.map(([x, y]) => [11 - x, y]); };
  const mirrored = flip(moves);
  const h = m.lookup(12, 0, mirrored, 6000);
  check(h && h.x === 11 - 5 && h.y === 7, '镜像局面命中同一条记忆，坐标跟着翻');
}

// ---------- 3. 浅搜索不能覆盖深结论 ----------
m.record(12, 0, moves, { x: 5, y: 7, eval: 0, mate: 0, depth: 3, ms: 40 }, 6000);
hit = m.lookup(12, 0, moves, 6000);
check(hit && hit.d === 25, '一手 3 层的浅搜索没有把 25 层的结论冲掉');

// ---------- 4. 质量不够就不供，交回现场搜索 ----------
{
  const m2 = fresh();
  const p2 = mv(12, 'G7 H8');
  m2.record(12, 0, p2, { x: 4, y: 4, eval: 0, mate: 0, depth: 4, ms: 60 }, 6000);
  check(m2.lookup(12, 0, p2, 6000) === null, '质量太低的记忆不外供（现场算更好）');
  // 存的那次比这次预算想得还短 -> 也不供
  const m3 = fresh();
  m3.record(12, 0, p2, { x: 4, y: 4, eval: 0, mate: 0, depth: 22, ms: 900 }, 900);
  check(m3.lookup(12, 0, p2, 6000) === null, '当时预算就小，这次预算大，不供（现场算更好）');
  check(m3.lookup(12, 0, p2, 800) !== null, '预算本来就小的时候，同一条记忆可以用');

  // **提前收手的搜索不算浅。** Rapfi 开着自适应用时，着法一稳定就收手：
  // 2500ms 的预算 930ms、21 层就给答案了。按「用时」比会把这条好记忆丢掉，
  // 记忆库就几乎永远不命中 —— 端到端测试真的这么失败过一次。
  const m3b = fresh();
  m3b.record(12, 0, p2, { x: 4, y: 4, eval: 0, mate: 0, depth: 21, ms: 930 }, 2500);
  check(m3b.lookup(12, 0, p2, 2500) !== null, '提前收手但预算充足的记忆照样可用');
}

// ---------- 5. 规则和尺寸分档 ----------
check(m.lookup(12, 4, moves, 6000) === null, '换了规则查不到（禁手与否是两套评估）');
check(m.lookup(15, 0, moves, 6000) === null, '换了棋盘尺寸查不到');

// ---------- 6. ⚠ 胜负绝不能决定走哪一手 ----------
// **这一条是拿一局实战换来的，别再退回去。**
// 旧版按胜负禁着法：[G6 H5 F5] 的 H7（22 层 / 19 秒的分析）因为「2 胜 1 负、
// 最近输」被禁，换上 12 层 / 73ms 的 E4。事后 25 秒深搜判决 ——
// H7 是唯一没被证明必输的一手，E4 是 +M27 必败。
// 根子上的错：拿胜负当棋力证据。对手水平完全不可控，正着也可能输给高手。
{
  const m4 = fresh();
  const before = mv(12, 'G6 H5 F5');
  const h7 = mv(12, 'H7')[0], e4 = mv(12, 'E4')[0];
  // 深分析的那一手战绩难看，浅分析的那一手战绩漂亮
  m4.record(12, 0, before, { x: h7[0], y: h7[1], eval: -548, mate: 0, depth: 22, ms: 19213 }, 20000);
  m4.record(12, 0, before, { x: e4[0], y: e4[1], eval: -380, mate: 0, depth: 12, ms: 73 }, 20000);
  const seq = 'G6 H5 F5 H7'.split(' ');
  const one = r => m4.ingest({ size: 12, rule: 0, result: r, moves: seq,
                               ai: [{ ply: 4, source: 'memo', score: -548 }] }, 0);
  one('AI 胜'); one('AI 胜'); one('对手胜');       // H7 = 2 胜 1 负，最近输

  const hit = m4.lookup(12, 0, before, 6000);
  check(hit && hit.x === h7[0] && hit.y === h7[1],
        '照样给分析最深的 H7（22 层），不因为「最近输了」就换掉');
  check(hit.w === 2 && hit.l === 1, '胜负照记（' + hit.w + ' 胜 ' + hit.l + ' 负），但只用来排查');
  check(hit.avoid === undefined, '不存在黑名单这个概念了');
}

// ---------- 7. 质量高的排前面，战绩漂亮的浅记录排后面 ----------
{
  const m5 = fresh();
  const pos = mv(12, 'G6 H5');
  const deep = mv(12, 'F5')[0], shallow = mv(12, 'H7')[0];
  m5.record(12, 0, pos, { x: deep[0], y: deep[1], eval: -500, mate: 0, depth: 24, ms: 20000 }, 20000);
  m5.record(12, 0, pos, { x: shallow[0], y: shallow[1], eval: -100, mate: 0, depth: 9, ms: 80 }, 20000);
  // 给浅的那手刷一堆胜绩
  const seq = 'G6 H5 H7'.split(' ');
  for (let i = 0; i < 5; i++)
    m5.ingest({ size: 12, rule: 0, result: 'AI 胜', moves: seq,
                ai: [{ ply: 3, source: 'memo' }] }, 0);
  const hit = m5.lookup(12, 0, pos, 6000);
  check(hit && hit.x === deep[0] && hit.y === deep[1],
        '5 胜 0 负的浅记录（9 层 / 80ms）也抢不过 24 层 / 20 秒的深结论');
}

// ---------- 8. 输棋不禁着法，而是排进复查队列 ----------
// 胜负从「裁判」降成「指路牌」：它只决定把算力花在哪个局面上。
{
  const m6 = fresh();
  const seq = 'G6 H5 F5 H7 E4'.split(' ');
  for (const ply of [2, 4]) {
    const before = mv(12, seq.slice(0, ply - 1).join(' '));
    const cur = mv(12, seq[ply - 1])[0];
    m6.record(12, 0, before, { x: cur[0], y: cur[1], eval: 0, mate: 0, depth: 20, ms: 1500 }, 6000);
  }
  check(m6.reviewCount() === 0, '一开始复查队列是空的');

  const r = m6.ingest({
    size: 12, rule: 0, result: '对手胜', moves: seq,
    ai: [{ ply: 2, source: 'memo', score: -300 }, { ply: 4, source: 'memo', score: -400 }]
  }, 0);
  check(r && r.queued === 2, '输了一局 -> 两个局面排进复查队列（实际 ' + (r && r.queued) + '）');
  check(r.marks.length === 2 && r.marks.every(x => x.field === 'l'), '胜负照记');

  const job = m6.peekReview();
  check(job && job.size === 12 && Array.isArray(job.moves), '队列里取得出待复查的局面');
  m6.doneReview(job.key);
  check(m6.reviewCount() === 1, '复查完一个就出队');
}

// ---------- 8b. 复查队列要会挑：没救的局面和已经算透的都别排 ----------
{
  const m7 = fresh();
  const seq = 'G6 H5 F5 H7 E4 I8'.split(' ');
  // 第 2 手已经用 30 秒算过了
  const p2 = mv(12, seq.slice(0, 1).join(' '));
  m7.record(12, 0, p2, { x: mv(12, seq[1])[0][0], y: mv(12, seq[1])[0][1],
                         eval: 0, mate: 0, depth: 30, ms: 29000 }, 30000);
  const r = m7.ingest({
    size: 12, rule: 0, result: '对手胜', moves: seq,
    ai: [{ ply: 2, source: 'memo', score: -300 },        // 已经算透，跳过
         { ply: 4, source: 'rapfi', score: -9999000 },   // 引擎当时已认输，跳过
         { ply: 6, source: 'rapfi', score: -400 }]       // 这个才该排
  }, 0);
  check(r && r.queued === 1, '只排该排的那一个（实际 ' + (r && r.queued) + '）');
}

// ---------- 9. 记忆里的点已经有子了就别供 ----------
{
  const m7 = fresh();
  const before = mv(12, 'G7 H8');
  m7.record(12, 0, before, { x: 7, y: 4, eval: 0, mate: 0, depth: 25, ms: 3000 }, 6000);
  // 同一个哈希下如果那个点已被占（哈希碰撞或走到了同形异位），必须放弃
  const occupied = mv(12, 'G7 H8').concat([[7, 4]]);
  const h = m7.lookup(12, 0, occupied, 6000);
  check(!h || h.x == null, '记忆里的点已经有子，不供（否则发出去就是非法着法）');
}

// ---------- 10. 坏输入不能把库弄坏 ----------
{
  const m8 = fresh();
  check(m8.lookup(12, 0, [[0, 0], [0, 0]], 6000) === null, '重复落点的棋谱直接拒绝');
  check(m8.ingest({ size: 12, result: '对手胜' }, 0) === null, '缺字段的日志不报错');
  check(m8.ingest({ size: 12, result: '', moves: [], ai: [] }, 0) === null, '没分出胜负的局不记');
}

// ---------- 11. 落盘之后读得回来 ----------
{
  const m9 = fresh();
  const before = mv(12, 'G7 H8 H6');
  m9.record(12, 0, before, { x: 5, y: 7, eval: -116, mate: 0, depth: 25, ms: 3000 }, 6000);
  m9.save(true);
  const reopened = new Memo(tmp);
  const h = reopened.lookup(12, 0, before, 6000);
  check(h && h.x === 5 && h.y === 7, '写盘再读回来，记忆还在');
}

// ---------- 12. 复查队列要落盘，服务器重启也不丢 ----------
// 复查是「空闲时慢慢算」的活，中途重启很正常 —— 队列丢了就等于没排。
{
  const f2 = tmp + '.review';
  try { fs.unlinkSync(f2); } catch (e) {}
  const mA = new Memo(f2);
  const seq = 'G6 H5 F5 H7'.split(' ');
  const before = mv(12, 'G6');
  mA.record(12, 0, before, { x: mv(12, 'H5')[0][0], y: mv(12, 'H5')[0][1],
                             eval: 0, mate: 0, depth: 20, ms: 1500 }, 6000);
  mA.ingest({ size: 12, rule: 0, result: '对手胜', moves: seq,
              ai: [{ ply: 2, source: 'memo', score: -300 }] }, 0);
  mA.save(true);
  const reopened = new Memo(f2);
  check(reopened.reviewCount() === mA.reviewCount() && reopened.reviewCount() > 0,
        '复查队列写盘再读回来还在（' + reopened.reviewCount() + ' 个）');
  try { fs.unlinkSync(f2); } catch (e) {}
}

// ---------- 13. 队列封顶，连输几局也不会堆成算不完的量 ----------
{
  const mB = fresh();
  mB.maxReview = 5;
  for (let g = 0; g < 10; g++) {
    const seq = ['G6', 'H5', 'F5', 'H7'];
    const before = mv(12, 'G6');
    // 每局换个不同的第 2 手，制造不同的局面
    const alt = mv(12, ['H5', 'I5', 'J5', 'H4', 'I4', 'J4', 'H3', 'I3', 'J3', 'H2'][g])[0];
    mB.record(12, 0, before, { x: alt[0], y: alt[1], eval: 0, mate: 0, depth: 20, ms: 1500 }, 6000);
    mB.ingest({ size: 12, rule: 0, result: '对手胜',
                moves: ['G6', ['H5','I5','J5','H4','I4','J4','H3','I3','J3','H2'][g]],
                ai: [{ ply: 2, source: 'memo', score: -300 }] }, 0);
  }
  check(mB.reviewCount() <= 5, '队列不超过上限（实际 ' + mB.reviewCount() + '）');
}

// ---------- 14. 预热过的局面，老日志也能回灌 ----------
// memo-seed 之后，当时记作 rapfi 的那些手现在已经在库里了 ——
// 下次走到那儿就是记忆命中，所以追责必须认它们，否则老日志的胜负永远白记。
{
  const mK = fresh();
  const seq = 'G7 H8 H6 F8'.split(' ');
  const before = mv(12, 'G7 H8 H6');
  const cur = mv(12, 'F8')[0];
  const game = {
    size: 12, rule: 0, result: '对手胜', moves: seq,
    ai: [{ ply: 4, source: 'rapfi', score: -300 }]
  };
  check(mK.ingest(game, 0).marks.length === 0, '库里没有这一手时，rapfi 来源不追责');
  mK.record(12, 0, before, { x: cur[0], y: cur[1], eval: 0, mate: 0, depth: 25, ms: 3000 }, 6000);
  const r = mK.ingest(game, 0);
  check(r && r.marks.length === 1 && r.marks[0].ply === 4,
        '预热进库之后，同一条老日志就能追责了');
}

// ---------- 15. 预算取见过的最大值 ----------
// 同一个局面先在「充分」档算过，之后在「快」档再遇到，那条深记忆不该被降级。
{
  const mA = fresh();
  const pos = mv(12, 'G7 H8 H6');
  mA.record(12, 0, pos, { x: 5, y: 7, eval: 0, mate: 0, depth: 25, ms: 3000 }, 6000);
  mA.record(12, 0, pos, { x: 5, y: 7, eval: 0, mate: 0, depth: 25, ms: 800 }, 1000);
  check(mA.lookup(12, 0, pos, 6000) !== null, '低预算的重复访问没有把高预算记忆降级');
}

// ---------- 16. 超上限时按质量砍，深结论留下 ----------
// 预备成果也进库之后每局新增几十个局面，不封顶文件会一直涨。
// 砍的依据和选着法一样是**分析质量** —— 一条 30 秒算出来的结论值得留，
// 一条没被用过的浅预备记录重算一次只要几百毫秒。
{
  const mP = new Memo(tmp + '.prune', { maxPositions: 20 });
  try { fs.unlinkSync(tmp + '.prune'); } catch (e) {}
  mP.positions = Object.create(null);

  // 30 条浅的预备记录
  for (let i = 0; i < 30; i++) {
    const seq = mv(12, 'G7 H8').concat([[i % 11, ((i / 11) | 0) + 3]]);
    mP.record(12, 0, seq, { x: 5, y: 5 + (i % 5), eval: 0, mate: 0, depth: 9, ms: 90 }, 6000);
  }
  // 1 条复查级别的深结论
  const deep = mv(12, 'G7 H8 H6');
  mP.record(12, 0, deep, { x: 5, y: 4, eval: -300, mate: 0, depth: 31, ms: 29500 }, 30000);

  const before = mP.stats().positions;
  mP.prune();
  const after = mP.stats().positions;
  check(after < before && after <= 10, '超上限之后砍到一半以内（' + before + ' -> ' + after + '）');
  const kept = mP.lookup(12, 0, deep, 6000);
  check(kept && kept.x === 5 && kept.y === 4, '30 秒算出来的深结论没被砍掉');
  try { fs.unlinkSync(tmp + '.prune'); } catch (e) {}
}

// ---------- 17. 同一局面多条记忆：预算大的说了算 ----------
// 取自 data/memo.json 的真实局面：20 秒的种子分析（19 层）选了一手，
// 之后一次 6 秒的实战搜索（20 层）选了另一手。质量分在 3 秒 / 24 层就封顶，
// 两者只差 0.02（层数的噪声），旧的排序于是选了 6 秒那手 —— 20 秒的结论白算了。
// 复查队列（30 秒一个局面）算出来的东西也会同样被压住。
{
  const mR = fresh();
  const pos = mv(12, 'G7');
  const seed = mv(12, 'F7')[0], live = mv(12, 'G6')[0];
  mR.record(12, 0, pos, { x: seed[0], y: seed[1], eval: -397, mate: 0, depth: 19, ms: 19218 }, 20000);
  mR.record(12, 0, pos, { x: live[0], y: live[1], eval: -528, mate: 0, depth: 20, ms: 5411 }, 6000);
  const h = mR.lookup(12, 0, pos, 6000);
  check(h && h.x === seed[0] && h.y === seed[1], '20 秒的结论压过 6 秒的（哪怕后者层数多 1）');

  // 复查：30 秒重算推翻了原来的答案，下次必须走复查给的那手
  const pos2 = mv(12, 'G7 H8');
  const old = mv(12, 'H6')[0], fixed = mv(12, 'F8')[0];
  mR.record(12, 0, pos2, { x: old[0], y: old[1], eval: 120, mate: 0, depth: 26, ms: 5600 }, 6000);
  mR.record(12, 0, pos2, { x: fixed[0], y: fixed[1], eval: -40, mate: 0, depth: 33, ms: 29800 }, 30000);
  const h2 = mR.lookup(12, 0, pos2, 6000);
  check(h2 && h2.x === fixed[0] && h2.y === fixed[1],
        '复查（30 秒）推翻的旧答案不再被交出去 —— 哪怕旧答案的评分更乐观');

  // 同预算时仍按质量排（原有行为不变）
  const pos3 = mv(12, 'G7 H8 H6');
  mR.record(12, 0, pos3, { x: 1, y: 1, eval: 500, mate: 0, depth: 10, ms: 400 }, 6000);
  mR.record(12, 0, pos3, { x: 2, y: 2, eval: 100, mate: 0, depth: 26, ms: 5000 }, 6000);
  const h3 = mR.lookup(12, 0, pos3, 6000);
  check(h3 && h3.x === 2 && h3.y === 2, '同预算时按质量排：26 层压过 10 层');
}

// ---------- 18. 砍的时候分得出 30 秒复查和 6 秒的普通记录 ----------
// 两者质量分都是 1.0（封顶），只比质量就是随机砍。复查一个局面要 30 秒，丢不得。
{
  const mQ = new Memo(tmp + '.prune2', { maxPositions: 20 });
  try { fs.unlinkSync(tmp + '.prune2'); } catch (e) {}
  mQ.positions = Object.create(null);
  // 深结论**先**写：同分时 prune 按新旧排，最后写的那条会靠「最新」侥幸留下，测不出问题
  const deep = mv(12, 'G7 H8 H6');
  mQ.record(12, 0, deep, { x: 5, y: 4, eval: -300, mate: 0, depth: 31, ms: 29500 }, 30000);
  mQ.positions[Object.keys(mQ.positions)[0]].m[0].t -= 60000;
  for (let i = 0; i < 30; i++) {
    const seq = mv(12, 'G7 H8').concat([[i % 11, ((i / 11) | 0) + 3]]);
    mQ.record(12, 0, seq, { x: 5, y: 5 + (i % 5), eval: 0, mate: 0, depth: 26, ms: 5500 }, 6000);
  }
  mQ.prune();
  const kept = mQ.lookup(12, 0, deep, 6000);
  check(kept && kept.x === 5 && kept.y === 4, '质量同样封顶时，30 秒的复查结论留下');
  try { fs.unlinkSync(tmp + '.prune2'); } catch (e) {}
}

check(quality(24, 3000) === 1 && quality(0, 0) === 0, '质量分在 0..1 之间且两端饱和');

try { fs.unlinkSync(tmp); } catch (e) {}
console.log('\n' + pass + ' 条通过' + (fail ? '，' + fail + ' 条失败' : ''));
process.exit(fail ? 1 : 0);
