/*
 * prepare.js — 预测式超前思考（"预备"）
 *
 * 做的事：
 *   1. 我们落子后，先问引擎「对手最可能走哪几手」（multiPV）；
 *   2. 挨个假设对手真走了那一手，把**我们的应手算好、存进缓存**；
 *   3. 对手真落子时，缓存命中就直出 —— 效果等同于本局临时长出来的一段棋谱库。
 *
 * 为什么不用「在对手要走的局面上空转、指望热置换表」那一套：实测**净负收益**。
 * 4 条实战线路交替 3 轮：不开 2243ms / 26.5 层，开了 2769ms / 22.3 层，
 * 慢 23%、浅 4.2 层。收掉它要发 STOP 再等引擎吐子，那几百毫秒从本手预算里扣，
 * 而烘热的那点东西补不回来。
 *
 * ---------------------------------------------------------------------------
 * **为什么要一池子引擎，而不是一个**
 *
 * 线程收益实测（12 路，6 秒烧满，`tools/thread-curve.js`）：
 *
 *     线程    1     2     4     8    12    24
 *     层数  27.3  28.9  28.9  29.9  30.5  30.8
 *
 * 12 核之后基本白给（12→24 只多 0.3 层）。而预备是一条一条串行算的，
 * 12 秒窗口只备完 2.4 条 —— 瓶颈在「条数」不在「每条多深」。
 *
 * 所以把富余的核切成几个小引擎并行备，同样的窗口能备完更多条，
 * 而且**每条都能吃满整个窗口**（串行时每条只分到 3 秒）。
 * 少几个线程掉的层数，被多出来的时间补回来还有余。
 *
 * 附带两个好处：
 *   - 预备在独立进程上，正式出手时**不用等它停** —— 取消代价归零；
 *   - 不再和正式搜索共用一个进程，今天那个协议串线打崩引擎的风险直接消失。
 * ---------------------------------------------------------------------------
 *
 * **并发仍然是这里最容易写错的地方。** Gomocup 协议一问一答，
 * 同一个引擎进程上同时跑两个搜索会串线（实测退出码 0xC0000374 堆损坏）。
 * 所以每个引擎自己有一条串行链 + 代次号，跑着的那轮每做一步核对一次代次。
 */
'use strict';

const key = moves => moves.map(m => m[0] + ',' + m[1]).join(' ');
/** [x,y] -> 我们界面上的标签（和 core.js 的 pToLabel 同一套：列字母 + 从下往上数的行号）。
 *  不能直接打 Rapfi PV 里的标签 —— 它的行号方向和我们相反（它的 G1 是我们的 G12）。 */
const label = (size, xy) => String.fromCharCode(65 + xy[0]) + (size - xy[1]);

/** 一个预备引擎：自带串行链，保证同一时刻只有一个搜索在它身上 */
class Slot {
  constructor(eng) {
    this.eng = eng;
    this.chain = Promise.resolve();
    this.busy = false;
  }
  /** 排队执行 fn(eng)；fn 里可以 await 引擎命令 */
  run(fn) {
    this.chain = this.chain.catch(() => {}).then(async () => {
      this.busy = true;
      try { return await fn(this.eng); } finally { this.busy = false; }
    });
    return this.chain;
  }
  stop() { if (this.busy) { try { this.eng.stopThinking(); } catch (e) {} } }
}

class Prepare {
  /**
   * @param engines 一个或多个已经 start() 过的 Rapfi 实例。
   *                传单个实例也行（退化成原来的串行行为）。
   * @param opts  { width, perMoveMs, analyseMs, onLog, onPrepared }
   *              width      = 预备对手的前几手（0 = 关闭）
   *              perMoveMs  = 每条预备线路给多少思考时间
   *              analyseMs  = 预测对手着法（multiPV）给多少时间
   *              onPrepared = 算好一条就回调 (line, r, budgetMs)，
   *                           用来把成果存进记忆库。**每条都要回调**，
   *                           不只是后来被走中的那条 —— 没被走中的同样是
   *                           正经搜索结果，下一局遇到就能 0ms 直出。
   */
  constructor(engines, opts) {
    opts = opts || {};
    const list = Array.isArray(engines) ? engines : [engines];
    this.slots = list.map(e => new Slot(e));
    this.width = opts.width != null ? opts.width : 3;
    this.perMoveMs = opts.perMoveMs || 3000;
    // 预测这一步只要排序、不要精度：300ms 的前 4 名命中率和 2 秒几乎一样，
    // 而这段时间里第二个预备引擎是干等着的（候选没出来它不知道备哪条）。
    this.analyseMs = opts.analyseMs || 300;
    this.onLog = opts.onLog || function () {};
    this.onPrepared = opts.onPrepared || function () {};
    this.cache = new Map();          // 局面 key -> 我们的应手
    this.gen = 0;
    this.job = Promise.resolve();
    this.stat = { hit: 0, miss: 0, prepared: 0 };
    // 诊断用：这一轮预测了哪几手、真正备完了几条。
    // 「预测不准」和「来不及备」是两个不同的问题，解法相反，必须分开看。
    this.lastCands = [];
    this.doneThisTurn = 0;
  }

  get size() { return this.slots.length; }

  /** 我们刚落完子、轮到对手。开始预备。发起就返回，不等结果。 */
  start(moves) {
    if (this.width <= 0 || !this.slots.length || !this.slots[0].eng.size) return;
    const gen = ++this.gen;
    this.lastCands = [];
    this.doneThisTurn = 0;
    this.job = this.job.catch(() => {}).then(() => {
      if (gen !== this.gen) return;            // 还没轮到就已经被取代了
      return this._run(moves, gen);
    }).catch(e => {
      // 已经被作废的那一轮（换局、关会话）出错是预料之中的，不算事故，别刷日志
      if (gen === this.gen) this.onLog('预备出错: ' + (e && e.message || e));
    });
  }

  async _run(moves, gen) {
    const t0 = Date.now();
    const size = this.slots[0].eng.size;
    // 预测用第一个槽（它同时也是备第一条的那个，候选算完正好接着用）。
    //
    // ⚠ 签名是 analyse(moves, budgetMs, multiPV)。这里曾经写反成
    // (moves, width, analyseMs)：预测只拿到 50ms、却要 2000 条 PV。
    // 实测（12 路 · 129 个局面 · 对手 Rapfi 2 秒 · 每档独立引擎）对手真走的那手：
    //                 前 1   前 2   前 4
    //   写反(50ms)     38%    51%    73%
    //   300ms          63%    83%    94%
    //   1000ms         71%    89%    95%
    // 两个预备引擎一个窗口大约备完 4 条，看「前 4」：300ms 已经饱和。
    const a = await this.slots[0].run(eng => eng.analyse(moves, this.analyseMs, this.width));
    if (gen !== this.gen) return;

    const cands = (a.cands || []).slice(0, this.width).filter(c => c.xy);
    this.lastCands = cands.map(c => c.xy);
    this.onLog('预备：对手可能走 ' + (cands.map(c => label(size, c.xy)).join(' / ') || '（没有候选）'));

    // 把候选发给各个槽并行算。每个槽自己排队，谁先空谁先领下一条。
    let next = 0;
    const worker = slot => slot.run(async eng => {
      for (;;) {
        if (gen !== this.gen) return;
        const c = cands[next++];
        if (!c) return;
        const line = moves.concat([c.xy]);
        const k = key(line);
        if (this.cache.has(k)) continue;
        const r = await eng.think(line, this.perMoveMs);
        // 被打断的那条不可信（搜索没跑完就被 STOP 了），丢掉
        if (gen !== this.gen) return;
        r.prepared = true;
        this.cache.set(k, r);
        this.stat.prepared++;
        this.doneThisTurn++;
        // 存进记忆库。回调自己吞掉异常 —— 记忆库出问题不能影响下棋。
        try { this.onPrepared(line, r, this.perMoveMs); } catch (e) {}
        this.onLog('预备好一条：对手若走 ' + label(size, c.xy) + '，我们走 ' +
                   label(size, [r.x, r.y]) + '（' + r.depth + ' 层，' + r.ms + 'ms）');
      }
    });
    await Promise.all(this.slots.map(worker));
    if (gen === this.gen)
      this.onLog('预备完成，本轮 ' + this.doneThisTurn + ' 条，用时 ' + (Date.now() - t0) + 'ms');
  }

  /** 对手真落子了。查缓存。 */
  get(moves) {
    const r = this.cache.get(key(moves));
    if (r) this.stat.hit++; else this.stat.miss++;
    return r || null;
  }

  /**
   * **同步作废 + 发 STOP，不等它停。**
   *
   * 预备跑在独立进程上，正式出手用的是另一个进程 —— 没有任何理由等它。
   * 等的代价还不小：2 个引擎各跑着 10 秒的搜索，停下来要几百毫秒，
   * 实测命中率 63.9% 却只省了 10% 的时间，差额几乎全在这里。
   *
   * 作废是同步生效的（gen++ 立刻加），所以过期的结果绝不会被写进缓存；
   * 那两个进程再多烧几百毫秒的 CPU 就自己收了，和正式搜索的重叠很短。
   */
  stop() {
    this.gen++;
    for (const s of this.slots) s.stop();
  }

  /** 要确保它真的停干净时才用这个（换局面、关会话）。日常出手用 stop()。 */
  async cancel() {
    this.stop();
    await this.job.catch(() => {});
    await Promise.all(this.slots.map(s => s.chain.catch(() => {})));
  }

  /** 换了局面（悔棋、复盘跳转、新开一局）就得作废 */
  clear() { this.cache.clear(); }
}

module.exports = { Prepare, Slot, key };
