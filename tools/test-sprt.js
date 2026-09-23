/*
 * test-sprt.js — SPRT 的数学自检
 *
 * 这是个统计判据，错了不会报错，只会给出安静的错误结论 ——
 * 所以必须用「已知答案」的场景钉住它。
 */
const assert = require('assert');
const S = require('./sprt.js');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

console.log('SPRT');

ok('Elo 与得分率互为反函数', () => {
  for (const elo of [-400, -100, -15, 0, 15, 100, 400]) {
    const s = S.eloToScore(elo);
    assert.ok(Math.abs(S.scoreToElo(s) - elo) < 1e-6, `${elo} -> ${s} -> ${S.scoreToElo(s)}`);
  }
  assert.strictEqual(S.eloToScore(0), 0.5);
});

ok('alpha=beta=0.05 时边界是 ±2.94', () => {
  const t = new S.Sprt({ alpha: 0.05, beta: 0.05 });
  assert.ok(Math.abs(t.upper - 2.9444) < 0.001, '上界 ' + t.upper);
  assert.ok(Math.abs(t.lower + 2.9444) < 0.001, '下界 ' + t.lower);
});

ok('样本不足时不给结论', () => {
  const t = new S.Sprt({ elo0: 0, elo1: 15 });
  assert.strictEqual(t.verdict(), '');
  t.add(1);
  assert.strictEqual(t.verdict(), '', '1 局就下结论是错的');
  for (let i = 0; i < 6; i++) t.add(1);
  assert.strictEqual(t.llr(), 0, '7 连胜还不足以下结论（方差为 0，样本也少）');
});

ok('一面倒时不会卡在「无结论」', () => {
  // 正态近似在方差为 0 时给 LLR=0，看起来像没结论 ——
  // 但势均力敌下连胜 10 局的概率是 0.1%，远低于 alpha，必须能判出来
  const win = new S.Sprt({ elo0: 0, elo1: 15 });
  for (let i = 0; i < 12; i++) win.add(1);
  assert.strictEqual(win.verdict(), 'H1', '12 连胜应判 H1：' + win.line());
  const lose = new S.Sprt({ elo0: 0, elo1: 15 });
  for (let i = 0; i < 12; i++) lose.add(-1);
  assert.strictEqual(lose.verdict(), 'H0', '12 连负应判 H0：' + lose.line());
  const drawn = new S.Sprt({ elo0: 0, elo1: 15 });
  for (let i = 0; i < 12; i++) drawn.add(0);
  assert.strictEqual(drawn.verdict(), '', '全和不该判成任何一边：' + drawn.line());
});

ok('明显更强的一方最终被判 H1', () => {
  const t = new S.Sprt({ elo0: 0, elo1: 15 });
  // 70% 得分率，掺入和局制造方差
  let n = 0;
  while (!t.verdict() && n < 5000) {
    const r = n % 10;
    t.add(r < 6 ? 1 : r < 7 ? 0 : -1);     // 6 胜 1 和 3 负 = 65%
    n++;
  }
  assert.strictEqual(t.verdict(), 'H1', `跑了 ${n} 局仍未判 H1：${t.line()}`);
  assert.ok(n < 500, `${n} 局才判出来，对 65% 这么大的差距太慢了`);
});

ok('势均力敌最终被判 H0', () => {
  const t = new S.Sprt({ elo0: 0, elo1: 15 });
  let n = 0;
  while (!t.verdict() && n < 20000) {
    const r = n % 10;
    t.add(r < 4 ? 1 : r < 6 ? 0 : -1);     // 4 胜 2 和 4 负 = 50%
    n++;
  }
  assert.strictEqual(t.verdict(), 'H0', `跑了 ${n} 局仍未判 H0：${t.line()}`);
});

ok('今天那两次 40 局读数都不该给出结论', () => {
  // 种子 424242: 20 胜 13 负 7 和；种子 90210: 14 胜 17 负 9 和
  for (const [w, l, d] of [[20, 13, 7], [14, 17, 9]]) {
    const t = new S.Sprt({ elo0: 0, elo1: 15 });
    for (let i = 0; i < w; i++) t.add(1);
    for (let i = 0; i < l; i++) t.add(-1);
    for (let i = 0; i < d; i++) t.add(0);
    assert.strictEqual(t.verdict(), '',
      `${w}-${l}-${d} 被判成了 ${t.verdict()}，但 40 局根本不足以下结论：${t.line()}`);
  }
});

ok('胜负方向相反时 LLR 符号相反', () => {
  const good = new S.Sprt({ elo0: 0, elo1: 15 });
  const bad = new S.Sprt({ elo0: 0, elo1: 15 });
  for (let i = 0; i < 100; i++) { good.add(i % 10 < 6 ? 1 : i % 10 < 7 ? 0 : -1); }
  for (let i = 0; i < 100; i++) { bad.add(i % 10 < 3 ? 1 : i % 10 < 4 ? 0 : -1); }
  assert.ok(good.llr() > 0, '占优方 LLR 应为正: ' + good.llr());
  assert.ok(bad.llr() < 0, '劣势方 LLR 应为负: ' + bad.llr());
});

console.log(`\n${pass} 项通过${fail ? '，' + fail + ' 项失败' : ''}`);
process.exit(fail ? 1 : 0);
