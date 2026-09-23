/*
 * sprt.js — 序贯概率比检验（Sequential Probability Ratio Test）
 *
 * 借鉴国际象棋引擎圈的标准做法（Stockfish 的 fishtest、cutechess-cli）。
 * 解决的是这个项目反复吃亏的事：**「固定跑 40 局然后读胜率」本身就是错的方法**。
 * 同一个改动，种子 424242 读出 58.8%，种子 90210 读出 46.3% —— 结论完全相反。
 * 固定 N 的问题在于 N 是拍脑袋定的：改动小就不够用，改动大就浪费。
 *
 * SPRT 反过来：不预先定局数，每下完一局就更新一次对数似然比（LLR），
 * 撞到上界就判「确实更强」，撞到下界就判「没有变强」，都没撞到就继续下。
 * 需要多少局由数据自己决定。
 *
 * 两个假设用 Elo 表示：
 *   H0: Elo 差 = elo0（默认 0，即「没有提升」）
 *   H1: Elo 差 = elo1（默认 15，即「提升了 15 Elo」）
 *
 * LLR 用正态近似（cutechess-cli 的做法）：
 *   s  = 观测得分率，var_s = 得分率的方差
 *   LLR = (s1 - s0) * (2s - s0 - s1) / (2 * var_s)
 * 边界由第一类/第二类错误率给出：
 *   下界 = ln(beta / (1 - alpha))，上界 = ln((1 - beta) / alpha)
 * alpha = beta = 0.05 时就是常见的 ±2.94。
 *
 * **注意它不是免费的**：SPRT 只是让你在正确的时候停下来，
 * 想要分辨「提升了 3 Elo」这种小改动，仍然需要上千局。
 * 所以能用 bench.js 的行为指纹判断的（纯提速），就别来打比赛。
 */
(function (root, factory) {
  var m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.GomokuSprt = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Elo 差 -> 期望得分率 */
  function eloToScore(elo) {
    return 1 / (1 + Math.pow(10, -elo / 400));
  }

  /** 期望得分率 -> Elo 差（得分率为 0 或 1 时给一个有限的大值，别返回 Infinity） */
  function scoreToElo(s) {
    if (s <= 0) return -800;
    if (s >= 1) return 800;
    return -400 * Math.log10(1 / s - 1);
  }

  /**
   * @param opts { elo0, elo1, alpha, beta }
   */
  function Sprt(opts) {
    opts = opts || {};
    this.elo0 = opts.elo0 != null ? opts.elo0 : 0;
    this.elo1 = opts.elo1 != null ? opts.elo1 : 15;
    this.alpha = opts.alpha != null ? opts.alpha : 0.05;
    this.beta = opts.beta != null ? opts.beta : 0.05;
    this.lower = Math.log(this.beta / (1 - this.alpha));
    this.upper = Math.log((1 - this.beta) / this.alpha);
    this.w = 0; this.d = 0; this.l = 0;
  }

  Sprt.prototype.add = function (result) {
    if (result > 0) this.w++;
    else if (result < 0) this.l++;
    else this.d++;
  };

  Sprt.prototype.games = function () { return this.w + this.d + this.l; };

  /** 观测得分率 */
  Sprt.prototype.score = function () {
    var n = this.games();
    return n ? (this.w + this.d * 0.5) / n : 0.5;
  };

  /** 对数似然比。样本太少或方差为 0（全胜/全负/全和）时返回 0，不让它假装有结论 */
  Sprt.prototype.llr = function () {
    var n = this.games();
    if (n < 2) return 0;
    var pw = this.w / n, pd = this.d / n, pl = this.l / n;
    var s = pw + pd * 0.5;
    // 每局得分的方差：E[x^2] - E[x]^2，x 取 1 / 0.5 / 0
    var variance = pw + pd * 0.25 - s * s;
    if (variance <= 1e-12) {
      // 全胜或全负：方差为 0，正态近似算不出 LLR（会给 0，看起来像「没结论」）。
      // 但一面倒本身就是强证据：势均力敌时连胜 n 局的概率是 2^-n，
      // n>=10 已经是 0.1%，远低于 alpha=5%，所以这里直接给判决。
      // 这是对正态近似的一个务实补丁，不是教科书公式。
      if (n >= 10) return s > 0.5 ? this.upper * 1.5 : s < 0.5 ? this.lower * 1.5 : 0;
      return 0;                            // 样本还太少，不下结论
    }
    var varS = variance / n;
    var s0 = eloToScore(this.elo0), s1 = eloToScore(this.elo1);
    if (s1 === s0) return 0;
    return (s1 - s0) * (2 * s - s0 - s1) / (2 * varS);
  };

  /** 'H1'=接受「更强」, 'H0'=接受「没变强」, ''=还没结论 */
  Sprt.prototype.verdict = function () {
    var v = this.llr();
    if (v >= this.upper) return 'H1';
    if (v <= this.lower) return 'H0';
    return '';
  };

  /** 当前估计的 Elo 差 */
  Sprt.prototype.elo = function () { return scoreToElo(this.score()); };

  Sprt.prototype.line = function () {
    return `${this.w}-${this.l}-${this.d} (胜-负-和)  得分率 ${(this.score() * 100).toFixed(1)}%  ` +
           `Elo ${this.elo() >= 0 ? '+' : ''}${this.elo().toFixed(1)}  ` +
           `LLR ${this.llr().toFixed(2)} / [${this.lower.toFixed(2)}, ${this.upper.toFixed(2)}]`;
  };

  Sprt.prototype.conclusion = function () {
    var v = this.verdict();
    if (v === 'H1') return `✓ 接受 H1：确实比对照强（至少 ${this.elo1} Elo 的可能性已被支持）`;
    if (v === 'H0') return `✗ 接受 H0：没有证据表明更强（相对 ${this.elo0} Elo 的提升不成立）`;
    return `— 未达结论：LLR 还在 [${this.lower.toFixed(2)}, ${this.upper.toFixed(2)}] 之间，需要更多对局`;
  };

  return { Sprt: Sprt, eloToScore: eloToScore, scoreToElo: scoreToElo };
});
