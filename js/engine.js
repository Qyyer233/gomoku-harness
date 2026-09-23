/*
 * engine.js — 搜索引擎
 *
 * 出手顺序（越靠前越快，绝大多数局面在前三步就结束）:
 *   0. 开局库命中            —— O(1)，0ms
 *   1. 己方成五 / 挡对手成五 —— 查表，微秒级
 *   2. 己方活四 / 必胜组合   —— 查表
 *   3. VCF 连续冲四算杀      —— 毫秒级
 *   4. α-β 搜索（置换表 + 强制着法延伸 + VCF 防守过滤）
 */
(function (root, factory) {
  var Core = (typeof module === 'object' && module.exports)
    ? require('./core.js') : root.GomokuCore;
  var m = factory(Core);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.GomokuEngine = m;
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  var BLACK = Core.BLACK, WHITE = Core.WHITE, EMPTY = Core.EMPTY;
  var S_OPEN_THREE = Core.S_OPEN_THREE, S_FOUR = Core.S_FOUR,
      S_OPEN_FOUR = Core.S_OPEN_FOUR, S_FIVE = Core.S_FIVE;
  var SHAPE_SCORE = Core.SHAPE_SCORE;

  var HIST_SPAN = Core.AREA;          // 历史启发表按 role 分段
  // 「再明显的一手也至少搜到这个深度才敢收手」的默认值。
  // 实测过它的代价：连续两层选同一手就停，绝大多数局面正好卡在 6 层 ——
  // 给 6 秒和给 180 秒跑出来的节点数一字不差（201794），预算完全用不掉。
  // 所以各档位可以覆盖（LEVELS.solid），arena 也能 --asolid 做 A/B。
  var MIN_SOLID_DEPTH = 6;
  var STABLE_NEED = 2;                // 连着几层选同一手才算「稳」
  // 「稳」还要求分数别大幅摆动。2000 这个量级来自 SHAPE_SCORE[活三]=2200 ——
  // 分数跳过一个活三的量，说明更深一层看见了新东西，这时候收手是不负责任的。
  var STABLE_SCORE_SWING = 2000;
  var ITER_GATE = 0.6;                // 预算用掉这个比例后不再开新一层（见 bestMove）
  // 开局前几手的用时上限（按棋盘上已有子数索引，单位毫秒）。
  // 子数少的时候没有战术可算，深搜纯属浪费；超过这个长度就不再限制。
  var OPENING_FAST = [50, 120, 250, 400, 600, 900];
  var WIN = 10000000;
  // 分数高过这个就当成「已经算到杀」。杀棋分是 WIN - ply，ply 最多几十层，
  // 而普通估值分永远到不了这个量级（真出现五连时搜索早就返回 WIN 了，不会走到估值），
  // 所以这条线能干净地把两类分数分开。
  var MATE_MIN = WIN - 1000;
  var T_FIVE = 9000000;     // 成五
  var T_OPEN_FOUR = 500000; // 活四 / 双冲四
  var T_FOUR_THREE = 400000;// 四三
  var T_DOUBLE_THREE = 100000;

  // 难度预设

  // vcf/vct   = 算杀深度（威胁手数），0 = 关闭
  // vctShare  = 留给 VCT 的时间占比
  //
  // VCT 默认只在大师档开。它本身是正确的（test-vct.js 用实战兑现验证过），
  // 但引擎互搏实测下来并不划算：困难档 43.8% / 45.0%，大师档 48.1%（共 106 局）。
  // 原因是战术查表 + VCF + 威胁排序的 α-β 已经把这些杀棋捞走了，
  // 而 VCT「找不到」时代价很高 —— 实测 24 局里只触发 2 次。
  // 大师档时间预算宽裕，留着它换「被证明的杀棋」；困难档以速度为先，关掉。
  // timeMin = 局面明显时的用时下限，timeMax = 复杂局面的上限。
  // 简单局面几十毫秒就收手，难的局面才把上限用满 —— 时间花在刀刃上。
  var LEVELS = {
    easy:   { depth: 2,  timeMin: 20,  timeMax: 20,    width: 8,  vcf: 0,  vct: 0,  vctNodes: 0,      vctShare: 0,    vcfDefend: false, noise: 0.35 },
    normal: { depth: 4,  timeMin: 40,  timeMax: 120,   width: 10, vcf: 8,  vct: 0,  vctNodes: 0,      vctShare: 0,    vcfDefend: false, noise: 0.10 },
    hard:   { depth: 12, timeMin: 120, timeMax: 1500,  width: 12, vcf: 14, vct: 10, vctNodes: 40000,  vctShare: 0.15, vcfDefend: true,  noise: 0 },
    master: { depth: 20, timeMin: 300, timeMax: 12000, width: 16, vcf: 20, vct: 16, vctNodes: 200000, vctShare: 0.18, vcfDefend: true,  noise: 0 }
  };

  // ---------- 单点威胁评估 ----------
  /** role 在空点 p 落子后的威胁分（不落子，纯查表） */
  function threatScore(board, p, role) {
    var four = 0, open3 = 0, sum = 0, five = 0;
    for (var d = 0; d < 4; d++) {
      var sh = board.shapeAt(p, d, role);
      if (sh === S_FIVE) five++;
      else if (sh === S_OPEN_FOUR) four += 2;   // 活四相当于两个冲四
      else if (sh === S_FOUR) four++;
      else if (sh === S_OPEN_THREE) open3++;
      sum += SHAPE_SCORE[sh];
    }
    if (five) return T_FIVE;
    if (four >= 2) return T_OPEN_FOUR;          // 活四或双冲四
    if (four >= 1 && open3 >= 1) return T_FOUR_THREE;
    if (open3 >= 2) return T_DOUBLE_THREE;
    return sum;
  }

  /** 详细威胁描述（给 UI 解说用） */
  function describeMove(board, p, role) {
    var best = 0, four = 0, open3 = 0;
    for (var d = 0; d < 4; d++) {
      var sh = board.shapeAt(p, d, role);
      if (sh > best) best = sh;
      if (sh === S_OPEN_FOUR) four += 2;
      else if (sh === S_FOUR) four++;
      else if (sh === S_OPEN_THREE) open3++;
    }
    if (best === S_FIVE) return '五连';
    if (best === S_OPEN_FOUR) return '活四';
    if (four >= 2) return '双冲四';
    if (four >= 1 && open3 >= 1) return '四三';
    if (open3 >= 2) return '双活三';
    return Core.SHAPE_NAME[best];
  }

  // 比较器提到模块级：写成内联箭头/函数字面量的话，每个节点都要新建一个闭包
  function cmpScore(a, b) { return b[1] - a[1]; }

  // ---------- 置换表 ----------
  /*
   * 定长开放寻址表，全部用 TypedArray。取代原来的 `Map` + 每条一个对象。
   *
   * 换掉 Map 的三个理由，按重要性排：
   *
   * 1. **旧实现会冻死**。原来是 `if (tt.size < 400000) tt.set(...)` ——
   *    到 40 万条之后**一条都不再写**，表里全是旧局面，再也学不进新东西。
   *    实测后台思考约 25 秒就能灌满，正好落在「15 秒一手」的使用区间里。
   *    定长表永远不会满，只会按策略替换。
   * 2. **每条 `{h2,depth,score,flag,move}` 是一次对象分配**，一个节点一次。
   *    TypedArray 版本零分配。
   * 3. Map 在几十万条时 get/set 的哈希与指针追逐成本不低，直接下标寻址更快。
   *
   * 替换策略是「深度优先 + 世代老化」：
   * 同一局面直接覆盖；否则只有新条目更深、或者旧条目是上一次搜索留下的，才覆盖。
   * 这样浅层的垃圾冲不掉深层的有效结论，而陈旧条目又会被自然淘汰。
   */
  var TT_BITS = 20;                       // 2^20 = 1,048,576 条，约 17MB
  var TT_SIZE = 1 << TT_BITS;
  var TT_MASK = TT_SIZE - 1;

  /*
   * 一条记录 = 连续 4 个 int32（16 字节，正好一条缓存行装得下）：
   *   [0] key    哈希低 32 位
   *   [1] key2   校验位，抗哈希碰撞
   *   [2] score
   *   [3] meta   位域：着法(0-15) | 深度(16-23) | 标志(24-25) | 世代(26-29)
   *
   * 一开始写成 8 个平行 TypedArray，冷进程实测比原来的 Map **慢 3~6%** ——
   * 因为每次访问要碰 8 条缓存行，而 Map 的那个对象是连在一起的。
   * 压进一条缓存行之后才拿回局部性。这个项目里「位域打包进 int32」
   * 已经是第三次用了（另见 vct 的候选打包）。
   */
  /*
   * 多线程共享时的「无锁校验」（Hyatt 的经典做法）：
   *
   * 多个 Worker 同时写同一条记录时，可能出现**撕裂**：key 已经是新的，
   * 而 score/meta 还是旧的 —— 于是校验通过、数据却是拼凑出来的，
   * 引擎会拿一个根本不存在的结论去剪枝，安静地下错棋。JS 没有跨 int32 的原子写。
   *
   * 解决办法不是加锁（太慢），而是**把数据异或进校验位**：
   *   存：a[0] = key ^ score ^ meta,  a[1] = key2 ^ score ^ meta
   *   取：a[0] ^ score ^ meta 必须等于 key，a[1] ^ score ^ meta 必须等于 key2
   * 任何撕裂都会让这两个等式几乎必然不成立，于是那条记录被当成未命中丢掉。
   * 代价只有两次异或，单线程下也完全无害，所以不分情况一律这么存。
   */
  var M_MOVE = 0xffff;                    // 落点 < 529，16 位绰绰有余

  /**
   * @param sab 可选。传入 SharedArrayBuffer 就和其它 Worker 共用同一张表
   *            （并行搜索靠这个互相加速）；不传就自己开一块普通内存。
   */
  function TT(sab) {
    this.a = new Int32Array(sab || (TT_SIZE * 4));
    this.shared = !!sab;
    this.generation = 1;
    this.count = 0;                       // 只用于统计展示，共享时是近似值
  }

  /** 并行搜索要把这块内存分给每个 Worker */
  TT.bytes = TT_SIZE * 4 * 4;

  TT.prototype.store = function (key, k2, depth, score, flag, move) {
    // 深度只有 8 位，必须夹住上界。后台思考是逐片加深的，跑上一分钟请求深度
    // 就能超过 255 —— 溢出之后「深度不够」的条目会被当成「深度足够」拿来剪枝，
    // 静默下出错棋。
    if (depth > 100) depth = 100;
    else if (depth < 0) depth = 0;
    var a = this.a, i = (key & TT_MASK) << 2;
    var oldScore = a[i + 2], oldMeta = a[i + 3];
    if (oldMeta !== 0) {
      // 比对也要走异或校验，否则会拿撕裂的旧记录去判断该不该覆盖
      var x = oldScore ^ oldMeta;
      var same = (a[i] ^ x) === key && (a[i + 1] ^ x) === k2;
      var oldDepth = (oldMeta >>> 16) & 0xff;
      var oldGen = (oldMeta >>> 26) & 0xf;
      // 同一局面永远覆盖；不同局面则要新条目更深，或者旧条目已经过时
      if (!same && depth < oldDepth && oldGen === this.generation) return;
    } else {
      this.count++;
    }
    // meta 恒不为 0：世代从 1 起，所以「meta===0」可以安全地当作「这格没写过」
    var meta = (move & M_MOVE) | (depth << 16) | (flag << 24) | (this.generation << 26);
    var mix = score ^ meta;
    // 先写数据再写校验位：这样即使被打断，校验也只会失败（丢一条），不会读出脏数据
    a[i + 2] = score; a[i + 3] = meta;
    a[i] = key ^ mix; a[i + 1] = k2 ^ mix;
  };

  /** 新的一次搜索：世代 +1，让上一轮的条目变成「可被替换」而不是被清空 */
  TT.prototype.bump = function () {
    this.generation = (this.generation + 1) & 0xf;   // 只有 4 位
    if (this.generation === 0) this.generation = 1;  // 0 留给「空槽位」
  };

  TT.prototype.clear = function () {
    this.a.fill(0);
    this.count = 0;
    this.generation = 1;
  };

  Object.defineProperty(TT.prototype, 'size', {
    get: function () { return this.count; }
  });

  // ---------- 引擎 ----------
  function Engine(options) {
    options = options || {};
    // 传 ttBuffer（SharedArrayBuffer）就和其它 Worker 共用同一张置换表，
    // 这是并行搜索互相加速的唯一通道。不传就各用各的。
    this.tt = new TT(options.ttBuffer);
    this.nodes = 0;
    this.deadline = 0;
    this.aborted = false;
    this.book = null;
    this.pools = [];
    this.killer = [];
    this.vctFail = new Map();
    this.vctLine = [];
    this.vctNodes = 0;
    this.vctBudget = 0;
    this.defSeen = new Int32Array(Core.AREA);   // _threatDefenses 去重用的时间戳表
    this.defStamp = 0;
    this.hist = new Int32Array(Core.AREA * 3);  // 历史启发：[role][落点] -> 造成剪枝的次数
    this.options = options;
  }

  Engine.prototype.setBook = function (book) { this.book = book; };

  // 算杀每个节点都要几个临时数组。一局棋下来是几十万次分配，
  // GC 压力会让引擎越跑越慢（实测能从 78 节点/ms 掉到 12），所以按层复用。
  // 槽位按调用方分段，靠 ply 偏移错开：gen 用 _pool(ply)，vcf 用 _pool(20+ply)，
  // vct 用 _pool(30+ply)。negamax 体内不调算杀，所以三者不会交错使用同一层。
  // g/h 是 gen 专用（候选表 + 候选槽位），别被别处借走。
  Engine.prototype._pool = function (ply) {
    var p = this.pools[ply];
    if (!p) p = this.pools[ply] = { a: [], b: [], c: [], d: [], e: [], f: [], g: [], h: [], i: [] };
    return p;
  };

  Engine.prototype._timeUp = function () {
    if (this.aborted) return true;
    if ((this.nodes & 1023) === 0 && Date.now() > this.deadline) this.aborted = true;
    return this.aborted;
  };

  // ---------- 候选着法 ----------
  /**
   * 生成候选着法。返回 { list, forced }
   * forced=true 表示这是被迫的唯一应手（搜索时不消耗深度）。
   */
  Engine.prototype.gen = function (board, role, width, ply, ttMove) {
    var opp = 3 - role;
    var pool = this._pool(ply);
    var tmp = pool.a;

    // 1) 己方能直接成五 —— 立刻下
    board.winPoints(role, tmp);
    if (tmp.length) return { list: [tmp[0]], forced: true };

    // 2) 对手能成五 —— 必须挡（挡不过来时随便挡一个）
    board.winPoints(opp, tmp);
    if (tmp.length) return { list: tmp.slice(0, 2), forced: tmp.length === 1 };

    // 3) 常规候选：按“进攻分 + 防守分”排序
    var empties = board.emptyNear(pool.b);
    var cn = empties.length;
    if (!cn) return { list: [], forced: false };

    // 候选表整个复用（外层数组和每个槽位都从池里取，稳态下这段零分配）。
    //
    // 别高估这一条：单独做池化是**零收益**（实测 ±1% 以内）。
    // V8 新生代分配本来就近乎免费，实测 GC 只占 0.2%（mu=0.998）。
    // 它值 ~2% 是因为和下面的有界插入配合 —— 槽位地址稳定，插入时只搬引用。
    // 真正的大头是下面那段选择逻辑，不是这里。
    var scored = pool.g, slots = pool.h;
    var hasMyFour = false, hasOppFour = false;
    var hist = this.hist, histBase = role * HIST_SPAN;
    for (var i = 0; i < cn; i++) {
      var p = empties[i];
      var atk = threatScore(board, p, role);
      var def = threatScore(board, p, opp);
      if (atk >= T_OPEN_FOUR) hasMyFour = true;
      if (def >= T_OPEN_FOUR) hasOppFour = true;
      // 历史启发只用来给分数接近的安静着法排序，封顶避免盖掉棋形判断
      var h = this.basicOrder ? 0 : hist[histBase + p];
      if (h > 4000) h = 4000;
      var slot = slots[i];
      if (slot === undefined) slot = slots[i] = [0, 0, 0, 0];
      slot[0] = p; slot[1] = atk + def * 0.85 + h; slot[2] = atk; slot[3] = def;
      scored[i] = slot;                 // slots 保持下标不变，scored 才是被排序的那个
    }
    scored.length = cn;                 // 上一次调用可能更长，要截掉

    // 只取前 width(≤16) 个，却对全部 ~80 个候选做了全排序 ——
    // 消融实验（去掉排序）实测：排序占每节点 25% 的时间，是 gen 里最大的一块。
    // 改成有界插入选出前 width 个：比较全是内联数值比较，没有比较器函数调用。
    // 实测（冷进程 7 次取最小，节点数与着法完全一致）：12 路 12.32->11.24us/节点，
    // 15 路 14.15->12.70us/节点，约快 9~10%。
    // 「相等时保留先出现的」这条必须和原来的稳定排序一致，否则着法顺序会变
    //（下面那个 v <= 最差值就跳过、以及插入时遇到相等即停，就是为了这个）。
    // 唯一的例外是「对手有活四」那条分支，它要扫完整个有序表，
    // 那时再退回全排序（实测占到排序节点的 40%）。
    var need = width < cn ? width : cn;
    var top = pool.i, cnt = 0;
    for (var t = 0; t < cn; t++) {
      var cand = scored[t], v = cand[1];
      if (cnt === need && v <= top[cnt - 1][1]) continue;
      var j2 = cnt < need ? cnt : need - 1;
      while (j2 > 0 && top[j2 - 1][1] < v) { top[j2] = top[j2 - 1]; j2--; }
      top[j2] = cand;
      if (cnt < need) cnt++;
    }
    top.length = cnt;

    // 己方有活四/双四，直接成杀，不必再想别的
    if (hasMyFour && top[0][2] >= T_OPEN_FOUR) {
      return { list: [top[0][0]], forced: true };
    }
    // 对手已能做出活四（也就是他已经有活三）：只考虑化解它的着法。
    // 三类都要：直接封堵点、己方的大威胁、以及**己方的冲四**。
    // 冲四逼对手先应，是人类化解活三最常用的一手；
    // 但它的 threatScore 只有两三千分，够不到 T_DOUBLE_THREE 的门槛，
    // 以前被漏在候选之外 —— 这是个实打实的防守缺口。
    if (hasOppFour) {
      scored.sort(cmpScore);            // 这条分支要完整有序表，退回全排序

      // **化解一个威胁，不等于占住那个威胁点。**
      // 只认「威胁点本身」是个实打实的 bug：实战输掉的那局里，白棋在 G6 有活四威胁，
      // 而黑棋的 E6（同一行、隔两格）落在那条线的窗口里，不占 G6 也能破掉它，
      // 并且那才是唯一的取胜手。旧写法把 E6 整个滤掉，候选表只剩 G6 一个，
      // 还被标成 forced（连深度都不消耗），于是搜到 18 层也翻不了案。
      //
      // `_threatDefenses` 正是算「能破掉这个威胁的全部点」的（VCT 一直在用）：
      // 威胁线上的所有空点 + 己方的冲四反击。这里直接复用。
      // 先找出对手所有的活四级威胁点（可能不止一个）
      var tps = pool.f; tps.length = 0;
      for (var j0 = 0; j0 < scored.length; j0++) {
        if (scored[j0][3] >= T_OPEN_FOUR) tps.push(scored[j0][0]);
      }
      var seenD = this.defSeen, stampD = -1;
      if (tps.length) {
        this._threatDefenses(board, opp, role, tps[0], pool.c, pool.e);
        stampD = this.defStamp;         // _threatDefenses 刚刚把防守点都打上了这个时间戳
        // **逐个验一遍**：`_threatDefenses` 给的是威胁线上所有空点，
        // 其中很多并不真能破掉威胁。不验的话候选表会被灌进一堆没用的点，
        // 挤掉真正的应手，还会把 `forced`（被迫手不消耗深度的那次延伸）冲没 ——
        // 实测宽度换深度是亏的。验一遍能把 6 个缩到 3 个，且每个都确实管用。
        var defs = pool.c;
        for (var di = 0; di < defs.length; di++) {
          var dq = defs[di];
          board.put(dq, role);
          var still = false;
          for (var ti = 0; ti < tps.length; ti++) {
            if (board.cells[tps[ti]] === EMPTY &&
                threatScore(board, tps[ti], opp) >= T_OPEN_FOUR) { still = true; break; }
          }
          board.undo();
          if (still) seenD[dq] = 0;     // 挡不住，撤掉标记
        }
      }

      var urgent = [];
      for (var j = 0; j < scored.length && urgent.length < 6; j++) {
        var q = scored[j][0];
        if ((stampD >= 0 && seenD[q] === stampD) ||  // 真能破掉威胁的点（含隔空堵线）
            scored[j][3] >= T_OPEN_FOUR ||           // 威胁点本身
            scored[j][2] >= T_DOUBLE_THREE ||        // 己方更大的威胁
            board.isFourPoint(q, role)) {            // 己方冲四，抢回先手
          urgent.push(q);
        }
      }
      if (urgent.length) return { list: urgent, forced: urgent.length === 1 };
    }

    // 按「进攻分 + 防守分」取前 width 个。
    // 试过额外把所有威胁点无条件补进来，结果是深度从 10 掉到 8 而收益不明：
    // 威胁点的 threatScore 本来就远高于安静着法（冲四 2600+、组合 10 万+），
    // width 取 12~16 时它们几乎不可能被截掉，补进来只是白花分支。
    // top 里已经是按分数降序的前 need 个（need = min(width, 候选数)）
    var list = [];
    for (var k = 0; k < cnt; k++) list.push(top[k][0]);

    // 杀手着法提前
    var km = this.killer[ply];
    if (km !== undefined && board.cells[km] === EMPTY) {
      var at = list.indexOf(km);
      if (at > 0) { list.splice(at, 1); list.unshift(km); }
    }
    // 置换表着法排在最前（即使它不在候选表里也值得一试：
    // 它是同一局面上一轮搜索选出来的最好一手）
    if (ttMove !== undefined && ttMove >= 0 && board.cells[ttMove] === EMPTY) {
      var tat = list.indexOf(ttMove);
      if (tat > 0) list.splice(tat, 1);
      if (tat !== 0) list.unshift(ttMove);
    }
    return { list: list, forced: false };
  };

  // ---------- 静态评估 ----------
  Engine.prototype.evaluate = function (board, role) {
    var opp = 3 - role;
    // 防守系数略大于 1：宁可稳一点
    return board.total[role] - Math.round(board.total[opp] * 1.05);
  };

  // ---------- VCF：连续冲四算杀 ----------
  /**
   * 返回制胜的第一手（padded index），找不到返回 -1。
   * 只走“成五 / 冲四”这类对手必须应的着法，所以分支极小、速度极快。
   */
  Engine.prototype.vcf = function (board, role, depth, ply) {
    if (this._timeUp()) return -1;
    this.nodes++;
    var opp = 3 - role;
    var pool = this._pool(20 + (ply || 0));
    var tmp = pool.a;

    // 能直接成五就赢了
    board.winPoints(role, tmp);
    if (tmp.length) return tmp[0];
    if (depth <= 0) return -1;

    // 对手有成五点，我方冲四无意义（我方成五已在上面排除）
    board.winPoints(opp, tmp);
    if (tmp.length) return -1;

    // 枚举己方所有冲四点
    var empties = board.emptyNear(pool.b);
    var cand = [];
    for (var i = 0; i < empties.length; i++) {
      var p = empties[i];
      if (!board.isFourPoint(p, role)) continue;
      cand.push([p, threatScore(board, p, role)]);
    }
    if (!cand.length) return -1;
    cand.sort(function (a, b) { return b[1] - a[1]; });

    for (var c = 0; c < cand.length; c++) {
      var mv = cand[c][0];
      board.put(mv, role);
      var need = board.winPoints(role, []);     // 冲四后己方的成五点
      var good = false;
      if (need.length > 1) {
        good = true;                            // 双四，对手挡不住
      } else if (need.length === 1) {
        var blk = need[0];
        board.put(blk, opp);
        // 对手的封堵若本身成五，则我方这条线失败
        if (!board.isWinPoint(blk, opp)) {
          good = this.vcf(board, role, depth - 1, (ply || 0) + 1) >= 0;
        }
        board.undo();
      }
      board.undo();
      if (good) return mv;
      if (this._timeUp()) return -1;
    }
    return -1;
  };

  /** 对外的 VCF 入口：自带时限初始化（内部的 vcf 假设调用方已设好 deadline） */
  Engine.prototype.vcfFrom = function (board, role, depth, ms) {
    this.aborted = false;
    this.deadline = Date.now() + (ms != null ? ms : 300);
    return this.vcf(board, role, depth, 0);
  };

  // ---------- VCT：连续威胁取胜 ----------
  /*
   * VCF 只走冲四，VCT 把「活三」也算进来 —— 对手同样必须应，
   * 但分支比冲四大得多，所以必须靠节点预算兜住。
   *
   * 关键的正确性点：
   *  - 走出活四即胜。此时对手无法成五（进入本层前已确认），
   *    他就算冲四逼我应，我也可以直接成五先赢。
   *  - 走出冲四后对手只有唯一封堵点，分支为 1，非常便宜。
   *  - 走出活三后对手的应手集合必须是**超集**，否则会误报必胜。
   *    这里取「威胁线上全部空点 + 对手自己的冲四反击」，
   *    活三只能靠堵线或反击化解，这个集合是站得住的。
   */

  /** p 与这条杀棋线上任一落子的切比雪夫距离是否 <= 4（一条五连的跨度） */
  var PW = Core.W;
  function nearLine(p, line) {
    var px = p % PW, py = (p / PW) | 0;
    for (var i = 0; i < line.length; i++) {
      var q = line[i];
      var dx = (q % PW) - px; if (dx < 0) dx = -dx;
      if (dx > 4) continue;
      var dy = ((q / PW) | 0) - py; if (dy < 0) dy = -dy;
      if (dy <= 4) return true;
    }
    return false;
  }

  /** 对手化解 mv 这手威胁的全部候选应手（out / scratch 由调用方按层提供） */
  Engine.prototype._threatDefenses = function (board, atk, def, mv, out, scratch) {
    out.length = 0;
    var cells = board.cells;
    var seen = this.defSeen, stamp = ++this.defStamp;
    // 1) 造成威胁的那几条线上的所有空点（堵线）
    for (var d = 0; d < 4; d++) {
      if (board.shapeAt(mv, d, atk) < S_OPEN_THREE) continue;
      var step = Core.DIRS[d];
      for (var k = -4; k <= 4; k++) {
        if (!k) continue;
        var p = mv + k * step;
        if (cells[p] === EMPTY && seen[p] !== stamp) { seen[p] = stamp; out.push(p); }
      }
    }
    // 2) 对手自己的冲四反击（可以抢先逼我应手）
    var empties = board.emptyNear(scratch);
    for (var i = 0; i < empties.length; i++) {
      var q = empties[i];
      if (seen[q] !== stamp && board.isFourPoint(q, def)) { seen[q] = stamp; out.push(q); }
    }
    return out;
  };

  /**
   * 连续威胁算杀。返回制胜的第一手，找不到返回 -1。
   * @param depth 还能走几个「威胁手」
   */
  Engine.prototype.vct = function (board, role, depth, ply, oppFourThreat) {
    if (this._timeUp() || this.vctNodes > this.vctBudget) return -1;
    this.nodes++; this.vctNodes++;
    var opp = 3 - role;
    var pool = this._pool(30 + ply);
    var tmp = pool.a;

    // 能直接成五就赢了
    board.winPoints(role, tmp);
    if (tmp.length) return tmp[0];
    if (depth <= 0) return -1;
    // 对手刚冲四反将而我不能立刻成五 —— 这条威胁线断了。
    // 用调用方传进来的局部判定代替「全盘扫描对手成五点」，省掉一次全盘扫描；
    // 对手的四只可能由他自己刚落的那一子造成，所以这个判定是充分的。
    if (oppFourThreat) return -1;

    // 失败局面缓存：同一局面在更浅的深度失败过，就不必再试
    var key = (board.hash ^ (role * 0x85ebca6b)) >>> 0;
    var memo = this.vctFail.get(key);
    if (memo !== undefined && memo >= depth) return -1;

    // 候选：活四 > 冲四 > 活三
    //
    // 依赖性限制：进入第二层之后，只考虑与本条杀棋线上已落子「够得着」的威胁手
    // （切比雪夫距离 <= 4，也就是一条五连的跨度）。组合杀必须建立在刚才那几手
    // 造出来的棋形上；棋盘另一头随便找个活三点只会让这棵树炸开而毫无收益。
    // 冲四例外：它分支为 1、代价极低，全部保留。
    var line = this.vctLine;
    var empties = board.emptyNear(pool.b);
    // 候选打包进一个复用数组，免掉每节点几十个小数组的分配。
    // 位域: [威胁等级 4bit | 威胁分 17bit | 落点 10bit]，整体保持在 int32 内，
    // 超出 int32 会退化成双精度，排序和取模都会变慢。
    var cand = pool.f;
    cand.length = 0;
    for (var i = 0; i < empties.length; i++) {
      var p = empties[i];
      var kind = board.threatKind(p, role);
      if (kind === Core.K_NONE) continue;
      if (kind === Core.K_OPEN_THREE && ply > 0 && !nearLine(p, line)) continue;
      var sc = threatScore(board, p, role) >> 7;
      if (sc > 0x1ffff) sc = 0x1ffff;
      cand.push((kind << 27) | (sc << 10) | p);
    }
    if (!cand.length) { this.vctFail.set(key, depth); return -1; }
    cand.sort(function (a, b) { return b - a; });

    for (var c = 0; c < cand.length; c++) {
      var mv = cand[c] & 1023;
      board.put(mv, role);
      line.push(mv);
      var won = false;

      if (board.isOpenFourPoint(mv, role)) {
        won = true;                                   // 活四，对手挡不住
      } else {
        var need = board.winPoints(role, pool.c);
        if (need.length > 1) {
          won = true;                                 // 双四
        } else if (need.length === 1) {
          // 冲四：对手唯一应手
          var blk = need[0];
          board.put(blk, opp);
          if (!board.isWinPoint(blk, opp)) {
            won = this.vct(board, role, depth - 1, ply + 1,
                           board.isFourPoint(blk, opp)) >= 0;
          }
          board.undo();
        } else {
          // 活三：枚举对手的全部化解手，必须**每一手**都挡不住才算赢
          var defs = this._threatDefenses(board, role, opp, mv, pool.d, pool.e);
          won = defs.length > 0;
          for (var j = 0; j < defs.length; j++) {
            board.put(defs[j], opp);
            var survived = board.isWinPoint(defs[j], opp) ||
                           this.vct(board, role, depth - 1, ply + 1,
                                    board.isFourPoint(defs[j], opp)) < 0;
            board.undo();
            if (survived) { won = false; break; }
          }
        }
      }

      line.pop();
      board.undo();
      if (won) return mv;
      if (this._timeUp() || this.vctNodes > this.vctBudget) return -1;
    }
    this.vctFail.set(key, depth);
    return -1;
  };

  /**
   * 跑一次 VCT（负责预算、缓存与时限的初始化）。
   * @param ms 可选的独立时限；不给就沿用调用方已设好的 deadline
   *           （单独调用时 deadline 可能是 0，会被当成「早已超时」）
   */
  Engine.prototype.runVct = function (board, role, depth, budget, ms) {
    this.vctNodes = 0;
    this.vctBudget = budget;
    // 复用而不是重建：这个 Map 每手能涨到几万条，
    // 每步都 new 一个会制造可观的 GC 压力（实测出现过 2.6 秒的停顿）
    this.vctFail.clear();
    this.vctLine.length = 0;
    this.aborted = false;
    if (ms != null || this.deadline <= Date.now()) {
      this.deadline = Date.now() + (ms != null ? ms : 300);
    }
    // 根节点这一次全盘扫描是必要的：之前对手可能已经摆好了冲四
    var oppFour = board.winPoints(3 - role, []).length > 0;
    var mv = this.vct(board, role, depth, 0, oppFour);
    return this.vctNodes > this.vctBudget ? -1 : mv;   // 预算烧完的结果不可信
  };

  // ---------- α-β ----------
  // this.basicOrder = true 时退回「只有杀手着法 + 全窗口」的老式搜索，
  // 用来量化置换表着法 / PVS / 历史启发到底省了多少节点
  Engine.prototype.negamax = function (board, role, depth, alpha, beta, ply, ext) {
    this.nodes++;
    if (this._timeUp()) return 0;

    var opp = 3 - role;
    var hash = board.hash, hash2 = board.hash2;
    var key = hash ^ (role * 0x9e3779b9);
    var tta = this.tt.a, slot = (key & TT_MASK) << 2;
    var meta = tta[slot + 3];
    var ttMove = -1;
    // 异或校验：撕裂的记录（多 Worker 共享表时可能发生）会在这里被当成未命中丢掉
    var ttx = tta[slot + 2] ^ meta;
    if (meta !== 0 && (tta[slot] ^ ttx) === key && (tta[slot + 1] ^ ttx) === hash2) {
      // 根节点绝不能靠置换表剪枝返回：this.rootBest 是在下面的着法循环里赋值的，
      // 提前 return 等于一手都没选，bestMove 保持 -1，最后落到「静态评分最高点」
      // 那个兜底 —— 也就是整手棋没有搜索。
      // app 里引擎跨手复用，上一手的搜索早把本手的局面写进表了，必然命中，
      // 所以这个 bug 只在实战出现，离线每手新建引擎的测法永远测不到。
      if (ply > 0 && ((meta >>> 16) & 0xff) >= depth) {
        // 存的时候把杀棋分转成了「距本节点多少层」，取出来要转回「距根多少层」
        var hsc = tta[slot + 2], hfl = (meta >>> 24) & 3;
        if (hsc >= MATE_MIN) hsc -= ply;
        else if (hsc <= -MATE_MIN) hsc += ply;
        if (hfl === 0) return hsc;
        if (hfl === 1 && hsc <= alpha) return hsc;
        if (hfl === 2 && hsc >= beta) return hsc;
      }
      // 深度不够不能直接剪枝，但这一手仍然值得最先试 —— 好的着法顺序
      // 比多搜一层更省节点
      if (!this.basicOrder) ttMove = meta & M_MOVE;
    }

    if (depth <= 0) return this.evaluate(board, role);

    // 深度相关的宽度：靠近根部想得宽，越深看得越窄。
    // 五子棋每加 2 层分支要涨 5~10 倍，不收窄的话永远停在 6 层。
    // 注意强制着法（成五/封堵/化解活四）走的是 gen 里的提前返回分支，
    // 不受这个宽度限制，所以战术不会因为收窄而漏掉。
    var w = this.width;
    if (depth <= 3) w = w < 6 ? w : 6;
    else if (depth <= 5) w = w < 9 ? w : 9;
    else if (depth <= 7) w = w < 12 ? w : 12;

    var gen = this.gen(board, role, w, ply, ttMove);
    var list = gen.list;
    if (!list.length) return this.evaluate(board, role);

    // 被迫应手不消耗深度（让算杀线能走到底），但限制延伸总量防爆炸
    var childDepth = depth - 1;
    if (gen.forced && ext < 10) { childDepth = depth; ext++; }

    var best = -WIN * 2, bestMove = list[0];
    var origAlpha = alpha;

    for (var i = 0; i < list.length; i++) {
      var mv = list[i];
      board.put(mv, role);
      var val;
      if (board.isWinPoint(mv, role)) {
        val = WIN - ply;                        // 越早取胜越好
      } else if (i === 0 || this.basicOrder) {
        val = -this.negamax(board, opp, childDepth, -beta, -alpha, ply + 1, ext);
      } else {
        // LMR：排在后面的安静着法先减 2 层浅搜一遍，浅搜都打不过 alpha
        // 就不必全深度再算。排序已经足够好，绝大多数都会被这一刀砍掉。
        var red = (i >= 4 && childDepth >= 4 && !gen.forced) ? 2 : 0;
        // PVS：先用零窗口验证「不会更好」，只有验证失败才重搜
        val = -this.negamax(board, opp, childDepth - red, -alpha - 1, -alpha, ply + 1, ext);
        if (red && val > alpha) {
          val = -this.negamax(board, opp, childDepth, -alpha - 1, -alpha, ply + 1, ext);
        }
        if (val > alpha && val < beta) {
          val = -this.negamax(board, opp, childDepth, -beta, -alpha, ply + 1, ext);
        }
      }
      board.undo();
      if (this.aborted) return 0;

      if (val > best) { best = val; bestMove = mv; }
      if (val > alpha) alpha = val;
      if (alpha >= beta) {
        this.killer[ply] = mv;
        if (!this.basicOrder) this.hist[role * HIST_SPAN + mv] += depth * depth;
        break;
      }
    }

    var flag = best <= origAlpha ? 1 : (best >= beta ? 2 : 0);
    {
      // 杀棋分存的是「距**本节点**多少层」，不是「距根多少层」。
      // 上面 val = WIN - ply 里的 ply 是相对当前搜索根节点的，
      // 而置换表是跨搜索复用的（引擎一局用到底，后台思考更是天天跨搜索命中），
      // 同一个局面下次出现时 ply 不一样，直接存原值就会把杀棋步数记错。
      var st = best;
      if (st >= MATE_MIN) st += ply;
      else if (st <= -MATE_MIN) st -= ply;
      // 定长表按「深度优先 + 世代老化」替换，不会再出现「满了就罢工」
      this.tt.store(key, hash2, depth, st, flag, bestMove);
    }
    if (ply === 0) this.rootBest = bestMove;
    return best;
  };

  // ---------- 对外接口 ----------
  /**
   * 求最佳着法。
   * @param board 当前局面（不会被修改）
   * @param role  轮到谁走
   * @param opts  { level, timeMs, depth, width, useBook, randomize }
   * @return { move, score, depth, nodes, timeMs, source, note }
   */
  Engine.prototype.bestMove = function (board, role, opts) {
    opts = opts || {};
    var lv = LEVELS[opts.level || 'hard'] || LEVELS.hard;
    var timeMin = opts.timeMin != null ? opts.timeMin : (opts.timeMs != null ? opts.timeMs : lv.timeMin);
    var timeMax = opts.timeMax != null ? opts.timeMax : (opts.timeMs != null ? opts.timeMs : lv.timeMax);
    if (timeMax < timeMin) timeMax = timeMin;
    var maxDepth = opts.depth != null ? opts.depth : lv.depth;
    var width = opts.width != null ? opts.width : lv.width;
    // 算杀参数允许外部覆盖，方便 arena 做 A/B 对比
    var vcfDepth = opts.vcf != null ? opts.vcf : lv.vcf;
    var vctDepth = opts.vct != null ? opts.vct : lv.vct;
    var vctNodes = opts.vctNodes != null ? opts.vctNodes : lv.vctNodes;
    var vctShare = opts.vctShare != null ? opts.vctShare : (lv.vctShare || 0);
    // 收手阈值：档位可配，opts 可再覆盖（arena 用它做 A/B）
    var solidDepth = opts.solid != null ? opts.solid : (lv.solid != null ? lv.solid : MIN_SOLID_DEPTH);
    var stableNeed = opts.stable != null ? opts.stable : (lv.stable != null ? lv.stable : STABLE_NEED);
    if (vctDepth <= 0) vctShare = 0;

    // 开局阶段压缩用时：棋盘上只有几颗子时根本不存在战术，
    // 深搜是纯浪费。而且候选着法彼此差不多，「最佳着法」会一直变，
    // 自适应用时反而会一路加时到上限 —— 开局第一手空耗好几秒就是这么来的。
    // opts.fastOpening === false 用于离线分析（gen-openings.js 造开局库时
    // 就是要在开局局面上深算，不能被这个提速上限压住）
    var stones = board.history.length;
    if (opts.fastOpening !== false && stones < OPENING_FAST.length) {
      var capOpen = OPENING_FAST[stones];
      if (timeMax > capOpen) timeMax = capOpen;
      if (timeMin > timeMax) timeMin = timeMax;
    }
    // 算杀各阶段（VCF / VCT / 防守过滤）都按 timeMs 分预算，所以它必须取
    // **上限压缩之后**的值。曾经写在压缩之前，于是开局阶段出现这种事：
    // 给 6000ms 时 VCF 拿到 timeMs*0.25 = 1500ms 的 deadline，而主搜索的
    // ceiling 被开局上限压到 738ms —— VCF 一跑完，主搜索的 deadline 已是过去时间，
    // 每层开 1024 个节点就被中断。实测同一局面 6000ms 只搜到 6 层 / 7 千节点，
    // 1000ms 反而搜到 10 层 / 10 万节点，还选了不同的一手：预算越大搜得越浅。
    var timeMs = timeMax;   // 算杀等阶段按（压缩后的）上限分配
    this.width = width;
    this.basicOrder = !!opts.basicOrder;
    // 新一轮搜索 = 新世代。上一轮的条目不会被清掉，只是变成「可被替换」，
    // 于是既保住了跨手复用的价值，又不会让陈旧条目永久占位。
    this.tt.bump();
    this.nodes = 0;
    this.aborted = false;
    this.deadline = Date.now() + timeMs;
    this.killer = [];
    // 历史表每手减半：保留「最近哪些点好用」的趋势，又不会被旧局面的经验绑死
    for (var hi = 0; hi < this.hist.length; hi++) this.hist[hi] >>= 1;
    var t0 = Date.now();
    var opp = 3 - role;
    var tmp = [];

    // 分阶段计时：定位「某一手突然卡住」这类问题时，没有它只能靠猜
    var phase = this.phase = { vcf: 0, search: 0, vct: 0, defend: 0 };
    // 思维链：opts.trace 打开后逐层记下「搜到几层、选了谁、多少分、花了多久」，
    // 外加**收手原因**。少了收手原因，事后根本分不清引擎是搜不动还是被规则叫停
    // —— 这两件事的修法完全相反。
    var trace = this.trace = opts.trace ? { iters: [], stop: '', budgetMs: 0, cap: timeMax } : null;
    var result = function (move, source, note, score, depth, self) {
      return {
        move: move, source: source, note: note || '',
        score: score || 0, depth: depth || 0,
        nodes: self.nodes, timeMs: Date.now() - t0, phase: phase,
        trace: trace
      };
    };

    // 空盘：天元
    if (board.history.length === 0) {
      return result(Core.center(), 'opening', '天元', 0, 0, this);
    }

    // 1. 己方成五
    board.winPoints(role, tmp);
    if (tmp.length) return result(tmp[0], 'tactic', '直接成五', WIN, 0, this);

    // 2. 挡对手成五
    board.winPoints(opp, tmp);
    if (tmp.length) {
      var blk = tmp[0];
      // 多个封堵点时挑同时最有攻击性的那个
      for (var i = 1; i < tmp.length; i++) {
        if (threatScore(board, tmp[i], role) > threatScore(board, blk, role)) blk = tmp[i];
      }
      return result(blk, 'tactic', '封堵成五点', 0, 0, this);
    }

    // 3. 扫一遍所有候选点，记下双方最强的一步
    var empties = board.emptyNear([]);
    var bestKill = -1, bestKillScore = 0, oppRush = 0;
    for (var e = 0; e < empties.length; e++) {
      var s = threatScore(board, empties[e], role);
      if (s >= T_FOUR_THREE && s > bestKillScore) { bestKillScore = s; bestKill = empties[e]; }
      var os = threatScore(board, empties[e], opp);
      if (os > oppRush) oppRush = os;
    }

    // 己方一步必胜组合（活四 / 双四 / 四三）。
    // 对手若也能马上做出活四，我方的四三未必更快，这时交给搜索判断。
    if (bestKill >= 0 && (bestKillScore >= T_OPEN_FOUR || oppRush < T_OPEN_FOUR)) {
      return result(bestKill, 'tactic', describeMove(board, bestKill, role), T_OPEN_FOUR, 0, this);
    }

    // 4. 开局库。放在战术层之后，这样即使棋谱里混进了劣着，
    //    也绝不会因为查库而漏掉一步杀或送掉必挡的点。
    //    对手已经摆出活四级威胁时同样跳过库，直接进搜索。
    if (opts.useBook !== false && this.book && oppRush < T_OPEN_FOUR) {
      var bm = this.book.lookup(board, role, opts.bookRandom);
      if (bm && bm.move >= 0 && board.cells[bm.move] === EMPTY) {
        return result(bm.move, 'book',
          bm.kind === 'verdict'
            ? 'Rapfi 裁定 · ' + bm.depth + ' 层 · ' + (bm.ms / 1000).toFixed(0) + ' 秒算出'
            : '开局库 · ' + bm.total + ' 局棋谱 · 此着胜率 ' + (bm.winRate * 100).toFixed(0) + '%',
          0, 0, this);
      }
    }

    // 5. 算杀。VCF/VCT/搜索各分一段预算，避免算杀把搜索的时间吃光。
    if (vcfDepth > 0) {
      var tv0 = Date.now();
      this.deadline = t0 + Math.round(timeMs * 0.25);
      var kill = this.vcf(board, role, vcfDepth, 0);
      phase.vcf = Date.now() - tv0;
      if (kill >= 0 && !this.aborted) {
        return result(kill, 'vcf', 'VCF 连续冲四杀', WIN - 100, vcfDepth, this);
      }
    }
    // 6. α-β 迭代加深。
    //    注意顺序：VCT 排在主搜索**之后**。失败的 VCT 搜索代价很高，
    //    放在前面会把主搜索的时间吃光（实测这样反而从 50% 掉到 40% 胜率）。
    //    放在后面，它要么找到一条被证明的杀棋（严格优于搜索给的启发式着法），
    //    要么什么也不改 —— 只可能帮忙，不可能拖后腿。
    this.aborted = false;
    // 只给 VCT 留 vctShare 那一小段；没开 VCT 的档位把预算全花在搜索上，
    // 否则等于白白少想（实测会让困难档对普通档从 75% 掉到 52%）。
    this.deadline = t0 + Math.round(timeMs * (1 - vctShare));
    var ts0 = Date.now();
    var work = board.clone();
    var bestMove = -1, bestScore = 0, reached = 0;
    if (trace) {
      // 根节点的候选表：事后想知道「正解到底在不在它眼里」，只能靠这个
      var cands = [];
      for (var ci = 0; ci < empties.length; ci++) {
        var cp = empties[ci];
        cands.push({ p: Core.pToLabel(cp),
                     atk: threatScore(board, cp, role), def: threatScore(board, cp, opp) });
      }
      cands.sort(function (a, b2) { return (b2.atk + b2.def * 0.85) - (a.atk + a.def * 0.85); });
      trace.roots = cands.slice(0, 12);
      trace.empties = empties.length;
      trace.width = width;
    }
    // ── 自适应用时 ──
    // 判据是「最佳着法稳不稳」，不是分差：PVS 的零窗口搜索返回的是边界值而非
    // 精确分，拿次优分做差根本不可靠（试过，结果是 42/60 手都跑满上限）。
    // 规则很简单：连着两层选同一手就收手；每改一次主意就把时限翻一档。
    // 于是简单局面几十毫秒结束，真正纠结的局面才把上限用满。
    var budget = timeMin * (1 - vctShare);
    var ceiling = timeMax * (1 - vctShare);
    var prevIterMs = 0, prevBest = -1, stable = 0, prevScore = null;
    // 并行搜索（Lazy SMP）的关键是**让各线程走不一样的路**，否则 N 个线程
    // 做的是同一份重复劳动，共享置换表也帮不上忙。
    // 这里用最简单也最稳的办法：副线程跳过前面几层，直接从更深处起跑，
    // 抢先把深层结论写进共享表。副线程的返回值一律丢弃，只有主线程的算数，
    // 所以这个偏移不会影响正确性。
    var d0 = opts.startDepth ? Math.max(2, opts.startDepth | 0) : 2;
    // 用掉多少预算之后就不再开新的一层。可调是为了能实测，不是为了留旋钮。
    var iterGate = opts.iterGate != null ? opts.iterGate : ITER_GATE;
    if (d0 > maxDepth) d0 = maxDepth;
    for (var d = d0; d <= maxDepth; d += 2) {
      var iterStart = Date.now();
      this.rootBest = -1;
      this.deadline = t0 + ceiling;
      var nodes0 = this.nodes;
      var sc = this.negamax(work, role, d, -WIN * 2, WIN * 2, 0, 0);
      if (this.aborted) { if (trace) trace.stop = '超时中断于第 ' + d + ' 层'; break; }
      if (this.rootBest >= 0) { bestMove = this.rootBest; bestScore = sc; reached = d; }
      if (trace) {
        trace.iters.push({
          depth: d, move: bestMove >= 0 ? Core.pToLabel(bestMove) : '-', score: sc,
          nodes: this.nodes - nodes0, ms: Date.now() - iterStart
        });
      }
      // **只在算出必胜时收手，算出必败绝不能收手。**
      //
      // 必胜时停下没问题：那一手反正要走。但浅层算出的「必败」经常是假的 ——
      // 实战抓到过三处：引擎在第 4~8 层判定自己必败就不再加深，随手落子，
      // 而那个局面其实有两手能活（probe-pos 逐手验证过）。
      // 它不是「输定了随便走」，是「以为输定了」—— 再深一层就能看见活路。
      // 越是劣势越该往深里找，这跟国际象棋引擎的做法一致。
      if (sc >= WIN - 100) {
        if (trace) trace.stop = '第 ' + d + ' 层已算出必胜';
        break;
      }

      // 「稳」= 着法没变 **而且** 分数没大幅摆动。
      //
      // 只看着法会出事：实战里抓到过这样一手 —— 逐层 2层→G6(-7198)
      // 4层→G6(-13856) 6层→G6(-11421)，着法三层没动就被判「稳定」，
      // **主搜索只跑了 14 毫秒**就收手，剩下 4 秒全喂给了 VCT 而 VCT 一无所获，
      // 最后走出的 G6 被对手 VCT 反杀。着法不变但分数在几千分上下翻飞，
      // 说明更深一层确实看见了新东西，这时候收手是不负责任的。
      //
      // 根节点是全窗口搜索，所以这个分数是精确值，不是 PVS 的边界
      //（当年放弃「最优分减次优分」那个判据，是因为次优分来自零窗口，不可信 —— 两回事）。
      var swing = prevScore === null ? 0 : Math.abs(sc - prevScore);
      if (bestMove === prevBest && swing < STABLE_SCORE_SWING) {
        stable++;
      } else {
        stable = 0;
        budget = Math.min(ceiling, budget * 2.5);       // 还没定下来 -> 这局面值得多想
      }
      prevBest = bestMove;
      prevScore = sc;

      // 连续 stableNeed 层认定同一手，且已经搜到最低可信深度 -> 不必再想
      if (stable >= stableNeed && d >= solidDepth) {
        if (trace) trace.stop = '着法已稳定（连续 ' + stable + ' 层选同一手，solid=' + solidDepth + '）';
        break;
      }

      // 只要预算还剩得多，就直接开下一层，不去预测它够不够。
      //
      // 这里原来是「上一层耗时 × 实测增长倍数」的外推，结果成了并行搜索的瓶颈：
      // 副线程把结论灌进共享表之后，主线程每层都变得很便宜（实测同样深度节点少 7 倍），
      // 可外推公式一算「下一层装不下」就收手 —— **剩下的时间整段空着**。
      // 而 deadline 是硬的：开了搜不完只会被中断、丢弃这一层，不会超时，
      // 所以「先开再说」严格优于「预测不够就不开」。被中断的那层也不是白搭，
      // 它填进置换表的东西下一次搜索还能用。
      //
      // 60% 这个线是留给「已经用掉大半预算」的情况：那时再开一层几乎必然搜不完，
      // 不如把时间留给后面的 VCT 阶段。
      var iterMs = Date.now() - iterStart;
      prevIterMs = iterMs;
      var used = Date.now() - t0;
      if (used > budget * iterGate) {
        if (trace) {
          trace.budgetMs = budget;
          trace.stop = '预算已用掉 ' + Math.round(used) + 'ms / ' + Math.round(budget) +
                       'ms（超过 60%），不再开下一层';
        }
        break;
      }
    }
    if (trace && !trace.stop) trace.stop = '搜满配置深度 ' + maxDepth;
    // 置换表条目数：它从不清理，一局下来能涨到几十万。
    // 「根节点剪枝」那个 bug 就是靠这个数字才想到「引擎跨手复用」这条线索的。
    if (trace) trace.ttSize = this.tt.size;

    phase.search = Date.now() - ts0;

    // 兜底：搜索被打断也要有子可下
    if (bestMove < 0 || work.cells[bestMove] !== EMPTY) {
      var fb = -1, fbs = -1;
      for (var q = 0; q < empties.length; q++) {
        var v = threatScore(board, empties[q], role) + threatScore(board, empties[q], opp) * 0.85;
        if (v > fbs) { fbs = v; fb = empties[q]; }
      }
      bestMove = fb >= 0 ? fb : Core.center();
    }

    // 7. VCT 算杀：用主搜索剩下的时间。找到就采用（被证明的杀棋优于任何启发式着法）。
    if (vctDepth > 0 && bestScore < WIN - 1000) {
      var tc0 = Date.now();
      this.aborted = false;
      // 必须显式把「剩余时间」传进去。主搜索跑完后 t0+timeMs 往往已是过去时间，
      // 只设 this.deadline 的话会命中 runVct 里「已过期就给 5 秒」的兜底，
      // 结果 VCT 一路跑到节点预算耗尽 —— 实测单手飙到 2.9 秒。
      var leftMs = Math.max(20, t0 + timeMs - tc0);
      var kill2 = this.runVct(board, role, vctDepth, vctNodes, leftMs);
      phase.vct = Date.now() - tc0;
      if (kill2 >= 0 && !this.aborted && board.cells[kill2] === EMPTY) {
        return result(kill2, 'vct', 'VCT 连续威胁杀', WIN - 200, vctDepth, this);
      }
    }

    // 8. VCF 防守过滤：若这步会让对手直接算杀，换一手。
    //    搜索通常已经把时间预算用光，这里必须另给一份预算，
    //    否则 vcf() 会立刻因超时返回 -1，这层防守就白做了。
    if (lv.vcfDefend) {
      var td0 = Date.now();
      this.aborted = false;
      this.deadline = Date.now() + Math.min(150, Math.max(25, Math.round(timeMs * 0.5)));
      bestMove = this._vcfSafe(work, role, bestMove, empties, vcfDepth);
      phase.defend = Date.now() - td0;
    }

    // 低难度加入随机扰动，避免每盘一模一样。
    // 只在「前几个候选」里换，不会因此走出离谱的一手。
    if (lv.noise > 0 && Math.random() < lv.noise) {
      var alt = [];
      for (var r = 0; r < empties.length; r++) {
        alt.push([empties[r],
          threatScore(board, empties[r], role) + threatScore(board, empties[r], opp) * 0.85]);
      }
      alt.sort(function (a, b) { return b[1] - a[1]; });
      var top = alt.slice(0, 3);
      if (top.length) bestMove = top[(Math.random() * top.length) | 0][0];
    }

    return result(bestMove, 'search', describeMove(board, bestMove, role), bestScore, reached, this);
  };

  /** 检查候选着法是否会被对手 VCF 反杀，是则换一手 */
  Engine.prototype._vcfSafe = function (work, role, move, empties, vcfDepth) {
    var opp = 3 - role;
    var check = function (self, m) {
      work.put(m, role);
      var lost = self.vcf(work, opp, Math.min(vcfDepth, 10), 0) >= 0;
      work.undo();
      return !lost;
    };
    if (check(this, move)) return move;

    // 原着法不安全，按分数顺序找第一个安全的
    var scored = [];
    for (var i = 0; i < empties.length; i++) {
      if (empties[i] === move) continue;
      scored.push([empties[i],
        threatScore(work, empties[i], role) + threatScore(work, empties[i], opp) * 0.85]);
    }
    scored.sort(function (a, b) { return b[1] - a[1]; });
    for (var k = 0; k < Math.min(10, scored.length); k++) {
      if (this._timeUp()) break;
      if (check(this, scored[k][0])) return scored[k][0];
    }
    return move;   // 都不安全，认命
  };

  Engine.prototype.reset = function () {
    this.tt.clear();
    this.hist.fill(0);
    this.vctFail.clear();
  };

  /**
   * 不需要搜索就能确定的两种着法。返回 null 表示「这局面得真算」。
   *
   *   1. 我方能直接成五 —— 下就赢了；
   *   2. 对方已经成四（只差一点成五）—— 封堵点是唯一的，任何引擎都给不出更好的。
   *
   * 抽成独立函数是为了让 Rapfi 那条路也能用：走外部引擎时每一手都要一次
   * 进程间往返，几百毫秒白等，而这两种局面根本不必问引擎。
   * 对方有两个成五点时是双四，挡哪个都一样输，取第一个即可。
   */
  function instantTactic(board, role) {
    var opp = role === BLACK ? WHITE : BLACK;
    var tmp = [];
    board.winPoints(role, tmp);
    if (tmp.length) return { move: tmp[0], note: "直接成五", score: WIN, win: true };
    tmp.length = 0;
    board.winPoints(opp, tmp);
    if (tmp.length) {
      // 多个封堵点时挑同时对我方最有攻击性的那个（和搜索里的做法一致）
      var blk = tmp[0];
      for (var i = 1; i < tmp.length; i++) {
        if (threatScore(board, tmp[i], role) > threatScore(board, blk, role)) blk = tmp[i];
      }
      return { move: blk, score: 0, win: false,
               note: tmp.length > 1 ? "封堵成五点（对方双四）" : "封堵成五点" };
    }
    return null;
  }

  return {
    Engine: Engine,
    instantTactic: instantTactic,
    LEVELS: LEVELS,
    TT: TT,                 // 导出给并行搜索分配共享内存、以及给测试用
    threatScore: threatScore,
    describeMove: describeMove,
    WIN: WIN
  };
});
