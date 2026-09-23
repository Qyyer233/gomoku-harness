/*
 * memo.js — 实战记忆库：把引擎算过的每一手存下来，并且记住它后来赢没赢
 *
 * 为什么需要它
 * ------------
 * 实战里同一个对手会反复走同一套开局。实测 12 路那四局白棋，
 * 前 10 手一模一样：
 *     G7 H8 H6 F8 I6 G6 H5 J7 H4 H7
 * 引擎每一局都把这十手重新算一遍，算出同样的答案，白烧掉十几秒 ——
 * 而快棋的时间预算恰恰是最紧的东西。
 *
 * 更要命的是第二件事：**那条线是输的**。四局里前三局对手走岔了，
 * 第四局他走对了，我们就照着同一条路又走了一遍，然后输掉。
 * 一个只记「引擎当时怎么想」的库会把这个错误永远固化下来。
 *
 * 所以这里存的不只是着法，还有两样东西：
 *   1. **分析量**（当时给了多少预算、搜了多深、花了多久）—— 决定走哪一手
 *   2. **战绩**（这手之后赢了还是输了）—— 只决定把哪些局面排进复查，不参与选着法
 *
 * 信任规则
 * --------
 *   · 当时的预算比这次少、或质量太低 -> 不用，现场重算（免得用一条更差的旧答案）
 *   · 同一局面有多条记忆               -> **预算大的说了算**（见 lookup）
 *   · 其余                             -> 直接用，0ms
 *
 * 输棋之后不禁任何着法（那样输过一局，见下面那段），只把那局的局面排进复查队列，
 * 空闲时用远超实战的预算重算 —— 深搜的结论会因为预算更大而自动排到前面。
 *
 * 局面用 core.js 的 8 向对称规范化后哈希，所以镜像和旋转自动共享同一条记忆。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../js/core.js');
const { hashKey } = require('../js/book.js');

/** 规范坐标打包成一个整数。步长取 32，22 路也够用（棋谱库那边写死 15，只能管到 15 路）。 */
const STRIDE = 32;
const packXY = (x, y) => y * STRIDE + x;
const unpackXY = v => [v % STRIDE, (v / STRIDE) | 0];

/*
 * ⚠⚠ 这里**曾经**有一个 refuted() —— 按胜负决定禁掉哪一手。删了，别再加回来。
 *
 * 它输掉过一局：12 路 [G6 H5 F5] 的 H7 背后有 22 层 / 19 秒的分析，
 * 因为「2 胜 1 负、最近输」被禁，换上 12 层 / 73ms 的 E4。
 * 事后 25 秒深搜判决：H7 是**唯一没被证明必输**的一手，E4 是 +M27 必败。
 *
 * 根子上的错是拿胜负当棋力证据：
 *   「完全无法保证对弈者的水平高低，最正确的棋对高水平对弈者也有可能输，
 *     但这完全是正确路线，而低水平棋对低水平对弈者也完全可能胜利，
 *     但这个水分很大。」
 *
 * 所以现在的分工是死的：
 *   · **分析深度决定走哪一手** —— 算得越深越可信，越浅越该被丢掉；
 *   · **胜负只决定往哪儿花算力** —— 输了一局就把那些局面排进复查队列，
 *     用远超实战的预算重算，深搜说什么就是什么。
 * 胜负数据照记（w / l / last），但不参与任何一次选着法的决策。
 */

/**
 * 搜索质量 -> 0..1 的分数。深度和用时各占一半，都到顶就饱和。
 * 24 层 / 3 秒 封顶是照着实战量的：12 路 6 秒预算下主搜索通常落在 20~26 层。
 */
function quality(depth, ms) {
  const d = Math.min(1, Math.max(0, depth || 0) / 24);
  const t = Math.min(1, Math.max(0, ms || 0) / 3000);
  return 0.5 * d + 0.5 * t;
}

class Memo {
  /**
   * @param file   落盘位置
   * @param opts.minQuality 低于这个质量的记忆不外供（默认 0.45）
   * @param opts.maxPly     只记到第几手（默认 40；再深就几乎不会重复了，纯占地方）
   */
  constructor(file, opts) {
    opts = opts || {};
    this.file = file;
    this.minQuality = opts.minQuality == null ? 0.45 : opts.minQuality;
    this.maxPly = opts.maxPly == null ? 40 : opts.maxPly;
    // **上限。** 注意理由不是「加载慢」—— 量过了，6 万个局面 7MB，
    // 启动解析只要 37.7ms，和棋谱库（1.58MB / 10.3ms）一个量级，都不算事。
    //
    // 真正的成本在**写**：记忆库每次变动都整份重写，而棋谱库是离线造好只读的。
    // 6 万局面一次落盘 51ms，对局中每隔十几秒就来一次，还会把这么多字节
    // 反复刷到磁盘上。封顶是为了给这个量级设一条线，不是为了加载。
    this.maxPositions = opts.maxPositions == null ? 60000 : opts.maxPositions;
    this.positions = Object.create(null);
    this.dirty = false;
    this._saveTimer = null;
    this._writing = false;
    // 攒多久再落盘。对局中每记一手就标一次脏，攒着写能把整份重写的开销摊掉。
    this.saveDelay = opts.saveDelay == null ? 15000 : opts.saveDelay;
    // 复查：输棋之后排进来的局面，空闲时用这么大的预算重算
    this.reviewMs = opts.reviewMs == null ? 30000 : opts.reviewMs;
    this.maxReview = opts.maxReview == null ? 200 : opts.maxReview;
    this.review = [];
    this.load();
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.positions = j.positions || Object.create(null);
      this.review = Array.isArray(j.review) ? j.review : [];
    } catch (e) {
      this.positions = Object.create(null);     // 文件不存在就是空库，正常
      this.review = [];
    }
  }

  /**
   * 标记有改动，稍后落盘。
   *
   * **攒着写，而且异步写。** 落盘是整份重写 —— 6 万个局面 7MB，
   * 序列化加写文件实测 51ms，而这是同步的，会卡住响应落子的那条事件循环。
   * 对局中每记一手就触发一次，攒 15 秒再写，等于把这个开销摊到近乎为零。
   *
   * @param immediate true = 立刻同步写完再返回。只在「非写不可」时用：
   *                  一局结束回灌胜负、进程退出。那些时刻不在走棋的关键路径上。
   */
  save(immediate) {
    this.dirty = true;
    if (immediate) {
      if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
      return this._flush();
    }
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this._flushAsync(); }, this.saveDelay);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  /** 同步落盘。进程退出和一局结束时用。 */
  _flush() {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // 先写临时文件再改名：服务器被 Ctrl+C 掐在写一半的时候，
      // 整个记忆库就成了一个解析不了的 JSON，下次启动直接归零。
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, this._payload());
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (e) { /* 写不进去不能影响下棋 */ }
  }

  /** 异步落盘。对局中走这条 —— 写文件那段不占事件循环。 */
  _flushAsync() {
    if (!this.dirty || this._writing) return;
    let payload;
    try { payload = this._payload(); } catch (e) { return; }
    this._writing = true;
    this.dirty = false;                 // 失败了再置回去
    const tmp = this.file + '.tmp';
    fs.promises.mkdir(path.dirname(this.file), { recursive: true })
      .then(() => fs.promises.writeFile(tmp, payload))
      .then(() => fs.promises.rename(tmp, this.file))
      .catch(() => { this.dirty = true; })
      .then(() => { this._writing = false; });
  }

  _payload() {
    return JSON.stringify({
      version: 1, updated: new Date().toISOString(),
      positions: this.positions, review: this.review
    });
  }

  /**
   * 把 moves（[[x,y],…] 全局着法，从第一手起）还原成局面，取规范化键。
   * @return { key, transform, role, stones } 或 null
   *
   * 注意 Core.setSize 是全局状态。这里取完键就用完了，中间没有 await，
   * 所以单线程的服务端是安全的 —— 但别把这个函数拆开用。
   */
  _at(size, rule, moves) {
    if (!Array.isArray(moves) || moves.length > this.maxPly) return null;
    C.setSize(size);
    const b = new C.Board();
    for (let i = 0; i < moves.length; i++) {
      const p = C.xyToP(moves[i][0], moves[i][1]);
      if (p < 0 || b.cells[p] !== C.EMPTY) return null;     // 棋谱对不上，不碰记忆库
      b.put(p, i % 2 === 0 ? C.BLACK : C.WHITE);
    }
    const role = moves.length % 2 === 0 ? C.BLACK : C.WHITE;
    const ck = C.canonicalKey(b, role);
    return {
      key: size + ':' + (rule | 0) + ':' + hashKey(ck.key),
      transform: ck.transform, role, stones: moves.length
    };
  }

  /** 找到（或建）某个局面下某一手的记录 */
  _entry(at, x, y, create) {
    let pos = this.positions[at.key];
    if (!pos) {
      if (!create) return null;
      pos = this.positions[at.key] = { n: at.stones, m: [] };
    }
    if (pos.n !== at.stones) return null;        // 哈希撞了，宁可不用
    const cxy = C.symFwd(at.transform, x, y);
    const mv = packXY(cxy[0], cxy[1]);
    let e = pos.m.find(r => r.mv === mv);
    if (!e && create) { e = { mv, ev: 0, mate: 0, d: 0, ms: 0, b: 0, hits: 0, w: 0, l: 0 }; pos.m.push(e); }
    return e ? { pos, e } : null;
  }

  /**
   * 查这个局面记没记过。
   * @param budgetMs 这次本来打算想多久 —— 存的那次想得比这还短就不用，现场重算更好
   * @return { x, y, ev, mate, d, ms, b, hits, w, l, trust } 或 null
   *         选的是**分析质量最高**的那一手，胜负不参与
   */
  lookup(size, rule, moves, budgetMs) {
    const at = this._at(size, rule, moves);
    if (!at) return null;
    const pos = this.positions[at.key];
    if (!pos || pos.n !== at.stones || !pos.m.length) return null;

    const real = e => {
      const c = unpackXY(e.mv);
      const r = C.symInv(at.transform, c[0], c[1]);
      return { x: r[0], y: r[1] };
    };

    // 可用的记忆：质量过得去，而且**当时给的预算不比这次少**。
    //
    // 这里比的是预算（b）而不是实际用时（ms），教训来自一次端到端测试：
    // Rapfi 开着自适应用时，2500ms 的预算它 930ms、21 层就收手了 ——
    // 着法已经稳定，再想下去也是同一手。按用时比，这条又深又好的记忆被当成
    // 「浅搜索」丢掉，记忆库几乎永远不命中。预算才是「当时有多少机会想得更好」。
    const need = (budgetMs || 0) * 0.8;
    const budget = e => e.b || e.ms || 0;
    const usable = pos.m
      .filter(e => quality(e.d, e.ms) >= this.minQuality && budget(e) >= need)
      // **先比预算，再比质量。** 胜负一概不参与 —— 赢过三局可能只说明那三个对手弱。
      //
      // 预算必须排在质量前面：quality() 在 24 层 / 3 秒就封顶，于是 30 秒的复查、
      // 20 秒的种子分析，和一次普通的 6 秒搜索质量分一样（都是 ~1.0），
      // 平局时再按 ev 排 —— 而浅搜索的 ev 往往更乐观，深结论反倒被压在下面。
      // 实测 data/memo.json 里 6 个多候选局面，有 2 个就这样选了 6 秒的那手、
      // 丢掉了 20 秒的结论；复查队列算出来的东西也会同样被压住，等于白算。
      // 预算大的那次搜索本来就看过这个局面的所有着法，它选了别的，就是推翻了旧答案。
      // 同预算时按质量、再按引擎自己的评分排，仍然是引擎的判断，不掺胜负。
      .sort((a, b) => budget(b) - budget(a) ||
                      quality(b.d, b.ms) - quality(a.d, a.ms) || (b.ev || 0) - (a.ev || 0));

    if (!usable.length) return null;
    const best = usable[0];
    const r = real(best);
    // 记忆里的点可能早被占了（换了条路走到同一个哈希，或者哈希撞了）
    if (moves.some(m => m[0] === r.x && m[1] === r.y)) return null;
    return {
      x: r.x, y: r.y, ev: best.ev, mate: best.mate, d: best.d, ms: best.ms, b: best.b || 0,
      hits: best.hits, w: best.w, l: best.l,
      trust: quality(best.d, best.ms)
    };
  }

  /** 记一次真实搜索的结果。只在引擎真算过时调用（命中记忆的那次不要再记）。 */
  record(size, rule, moves, res, budgetMs) {
    if (!res || res.x == null || res.y == null) return;
    const at = this._at(size, rule, moves);
    if (!at) return;
    const hit = this._entry(at, res.x, res.y, true);
    if (!hit) return;
    const e = hit.e;
    // 只在这次算得更好时覆盖，否则一次被时限掐断的浅搜索会把好记忆冲掉
    if (quality(res.depth, res.ms) >= quality(e.d, e.ms)) {
      e.ev = res.eval == null ? e.ev : Math.round(res.eval);
      e.mate = res.mate || 0;
      e.d = res.depth || 0;
      e.ms = res.ms || 0;
    }
    // 预算取见过的最大值：同一个局面在「充分」档下算过一次，
    // 之后即使在「快」档下再遇到，那条记忆依然算数。
    e.b = Math.max(e.b || 0, budgetMs || res.ms || 0);
    e.hits++;
    e.t = Date.now();
    this.save();
    if (Object.keys(this.positions).length > this.maxPositions) this.prune();
  }

  /**
   * 一局下完，把结果记进去。
   *
   * @param game 浏览器上报的日志对象（moves / ai / result / size）
   * @param rule 这局用的规则
   *
   * **胜负只是指路牌，不是裁判。** 记下 w / l 纯粹为了排查；
   * 真正的动作是：输了就把这局我方面临过的局面排进**复查队列**，
   * 等空闲时用远超实战的预算重算，让深搜自己下结论。
   *
   * 为什么不直接按胜负禁着法 —— 见文件顶部那段（为此输过一局）。
   */
  ingest(game, rule) {
    if (!game || !Array.isArray(game.moves) || !Array.isArray(game.ai)) return null;
    const won = game.result === 'AI 胜';
    const lost = game.result === '对手胜';
    if (!won && !lost) return null;
    const size = game.size | 0;
    if (size < 5) return null;

    C.setSize(size);
    const xy = label => {
      const p = C.labelToP(label);
      return p < 0 ? null : [C.pToX(p), C.pToY(p)];
    };
    const all = game.moves.map(xy);
    if (all.some(v => !v)) return null;

    const marks = [];
    for (const a of game.ai) {
      const ply = a.ply;
      if (!(ply >= 1 && ply <= all.length)) continue;
      const before = all.slice(0, ply - 1);
      const at = this._at(size, rule, before);
      if (!at) continue;
      const hit = this._entry(at, all[ply - 1][0], all[ply - 1][1], false);
      if (!hit) continue;                       // 库里没有这手，没什么可记的
      hit.e[won ? 'w' : 'l']++;
      hit.e.last = won ? 'w' : 'l';
      marks.push({ ply, label: game.moves[ply - 1], field: won ? 'w' : 'l' });
    }

    // **输了才排复查。** 赢了不代表每一手都对，但也没有线索指向哪里，
    // 而复查是要花整整 30 秒一个局面的，得把算力用在有线索的地方。
    let queued = 0;
    if (lost) queued = this.queueReview(size, rule, game, all);
    if (marks.length || queued) this.save(true);
    return { result: game.result, marks, queued };
  }

  /**
   * 把这局我方面临过的局面排进复查队列。
   *
   * 跳过两类：
   *   · 已经用同等或更大预算算过的 —— 再算一遍也是同一个答案；
   *   · 引擎当时就已经报 -M 的 —— 那个局面走什么都输，责任在更早的地方，
   *     复查它纯属浪费 30 秒。
   */
  queueReview(size, rule, game, all) {
    const hopeless = new Set((game.ai || [])
      .filter(a => typeof a.score === 'number' && a.score <= -900000)
      .map(a => a.ply));
    const seen = new Set(this.review.map(r => r.key));
    let n = 0;
    for (const a of game.ai || []) {
      const ply = a.ply;
      if (!(ply >= 1 && ply <= all.length)) continue;
      if (hopeless.has(ply)) continue;
      const before = all.slice(0, ply - 1);
      const at = this._at(size, rule, before);
      if (!at || seen.has(at.key)) continue;
      const pos = this.positions[at.key];
      // 已经算得比复查预算还足的，跳过
      if (pos && pos.m.some(e => (e.b || 0) >= this.reviewMs)) continue;
      seen.add(at.key);
      this.review.push({ key: at.key, size, rule, moves: before, at: Date.now() });
      n++;
    }
    // 队列封顶，免得连输几局堆成几百个局面（一个 30 秒，算不完的）
    if (this.review.length > this.maxReview) this.review = this.review.slice(-this.maxReview);
    return n;
  }

  /** 取一条待复查的局面（不出队 —— 算完再调 doneReview） */
  peekReview() { return this.review.length ? this.review[0] : null; }

  /** 这条复查完了，出队 */
  doneReview(key) {
    const i = this.review.findIndex(r => r.key === key);
    if (i >= 0) this.review.splice(i, 1);
    this.save(true);
  }

  reviewCount() { return this.review.length; }

  /**
   * 超上限时砍掉价值最低的那一半。
   *
   * 留下的优先级：**算得深的 > 被查到过的 > 新的**。
   * 和选着法一样，这里也以分析量为准 —— 一条 30 秒算出来的结论值得留，
   * 一条没被用过的浅预备记录重算一次只要几百毫秒。
   * 胜负不再当免死金牌（它说明不了这手棋好坏，见文件顶部）。
   */
  prune() {
    const rows = [];
    for (const key of Object.keys(this.positions)) {
      const p = this.positions[key];
      let score = 0;
      for (const e of p.m) {
        // 质量是主项（×100 拉开档次），查得多的略加分。
        // 预算也要算进来：quality() 在 3 秒就封顶，不加这一项的话
        // 30 秒的复查结论和 6 秒的普通记录分数一样，砍的时候分不出来。
        score += quality(e.d, e.ms) * 100 + Math.min(60, (e.b || 0) / 500) + Math.min(10, e.hits || 0);
      }
      rows.push({ key, score, t: Math.max.apply(null, p.m.map(e => e.t || 0).concat([0])) });
    }
    rows.sort((a, b) => b.score - a.score || b.t - a.t);
    const keep = Math.floor(this.maxPositions * 0.5);
    let dropped = 0;
    for (let i = keep; i < rows.length; i++) { delete this.positions[rows[i].key]; dropped++; }
    if (dropped) this.save(true);
    return dropped;
  }

  stats() {
    const keys = Object.keys(this.positions);
    let moves = 0, deep = 0;
    for (const k of keys) {
      for (const e of this.positions[k].m) {
        moves++;
        if ((e.b || 0) >= this.reviewMs) deep++;      // 复查级别的深结论有几条
      }
    }
    return { positions: keys.length, moves, deep, review: this.review.length };
  }
}

module.exports = { Memo, quality };
