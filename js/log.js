/*
 * log.js — 对局日志：棋谱 + AI 思维链
 *
 * 为什么需要它：今天这个「根节点置换表剪枝」的 bug，离线怎么测都测不出来，
 * 因为离线每手新建引擎，而 app 里引擎是跨手复用的。实战里 AI 明明配了 6 秒，
 * 实际 156ms 就交卷、深度 0，界面上只显示一个着法，什么都看不出来。
 * 有了每手的 depth / nodes / 收手原因，这种事一眼就能看见。
 *
 * 落盘策略（按顺序试，一路退到最后）：
 *   1. POST 到同源的 /log —— npm start 打开时走这条，直接写进 logs/
 *   2. POST 到 http://localhost:<常见端口>/log —— **双击 index.html 打开时也能落盘**，
 *      只要服务器在另一个终端里跑着。serve.js 为此给 /log 开了 CORS。
 *      没有这一条，用户就得点「导出日志」下载再手动拖进 logs/ —— 纯属折腾人。
 *   3. localStorage + 「导出日志」按钮 —— 真的连服务器都没开时的最后退路
 * 三条都不通也不影响下棋 —— 日志永远不能挡着对局。
 *
 * 一局一个文件，AI 每走一手追加一条。分析完用 `npm run logs -- --clear` 清掉。
 */
(function (root, factory) {
  var m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.GomokuLog = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KEY = 'gomoku.logs';
  var MAX_LOCAL = 40;             // localStorage 里最多留几局，免得撑爆配额

  function Recorder() {
    this.game = null;
    this.serverOk = null;         // null=还没试过, true/false=试过了
    this.endpoint = null;         // 试通了的上报地址，之后就固定用它
  }

  /** 开新一局。meta: { size, aiColor, level, thinkCap } */
  Recorder.prototype.start = function (meta) {
    this.game = {
      id: new Date().toISOString().replace(/[:.]/g, '-'),
      startedAt: new Date().toISOString(),
      size: meta.size, aiColor: meta.aiColor,
      // 规则决定了每个局面的评估，记忆库按它分档存 —— 回灌胜负时必须知道
      rule: meta.rule | 0,
      level: meta.level, thinkCap: meta.thinkCap,
      moves: [],                  // 整局着法标签，双方都记
      ai: [],                     // AI 每手的决策细节
      result: ''
    };
    return this.game;
  };

  /**
   * 同步棋谱。传的是**当前完整着法表**而不是「又走了一手」——
   * 界面支持悔棋和从中途改下法，增量追加会把日志写成一条不存在的棋路。
   * 整表覆盖的话，悔棋自然就等于把后面截掉。
   */
  Recorder.prototype.sync = function (labels, result) {
    if (!this.game) return;
    this.game.moves = labels.slice();
    // **胜负和棋谱在同一次上报里写。** 原先是 sync() 先报一次（result 还是空的）、
    // finish() 紧接着再报一次；两个 POST 同时在路上，服务端谁后到写谁 ——
    // 2026-09-23 的 35 局里有 5 局 AI 成五赢了，日志文件却是「未完」。
    // result 传了就以它为准：悔棋悔掉了胜负，这里也要跟着清空。
    if (result !== undefined) {
      if (result && result !== this.game.result) this.game.endedAt = new Date().toISOString();
      if (!result) delete this.game.endedAt;
      this.game.result = result;
    }
    // AI 那些被悔掉的决策也要一起截掉，否则 ply 会对不上棋谱
    var n = labels.length, ai = this.game.ai;
    while (ai.length && ai[ai.length - 1].ply > n) ai.pop();
    // **还要标出「这一手后来被换掉了」。** 上面那行只丢掉 ply 更大的记录，
    // 悔棋重下时旧决策会原地留下来 —— 于是日志写着「AI 走 C10」，棋谱里却是 B10，
    // 事后完全无从判断是 AI 走错了还是这一手被改过（实战为此查了很久）。
    for (var k = 0; k < ai.length; k++) {
      var onBoard = this.game.moves[ai[k].ply - 1];
      if (onBoard && ai[k].move !== onBoard && !ai[k].replaced) {
        ai[k].replaced = onBoard;
        (ai[k].flags = ai[k].flags || []).push(
          '这一手后来被换成了 ' + onBoard + '（原决策 ' + ai[k].move + '）');
      }
    }
    this.flush();
  };

  /**
   * 记 AI 的一次决策。r 是 engine.bestMove 的返回值（含 trace）。
   * ply 从 1 开始，指这是整局第几手。
   */
  Recorder.prototype.decide = function (ply, role, r, labelOf) {
    if (!this.game) return;
    var t = r.trace || {};
    var ent = {
      ply: ply, role: role === 1 ? 'B' : 'W',
      move: labelOf(r.move), source: r.source, note: r.note,
      score: r.score, depth: r.depth, nodes: r.nodes, ms: r.timeMs,
      phase: r.phase, stop: t.stop || '', budgetMs: t.budgetMs || 0, cap: t.cap || 0,
      iters: t.iters || [], roots: t.roots || [],
      empties: t.empties || 0, width: t.width || 0, ttSize: t.ttSize || 0,
      // **ms 记的是你真正等了多久，engineMs 才是引擎自报的搜索时间。**
      // 两者差额是建会话、HTTP 往返、收预备那些 —— 实战出现过「日志写 3.4 秒、
      // 人等了 15 秒」，当时就是因为只记了引擎自报的那个数。
      // **白名单**：不写在这里的字段，从别处传多少次都进不了日志文件。
      // played 由 Recorder.played() 事后回填，这里先占个位。
      played: null,
      engineMs: r.engineMs || 0,
      // 绝境搏命换手的记录 { tried, kept, reason, from, lines }。
      // 事后要能回答「那一手是搏命挑的还是引擎原意」，否则复盘无从下手。
      swindle: r.swindle || null,
      // 服务端的耗时拆解 { session, queue, think, total, sessions, engines }。
      // 慢手时这是唯一能定位的东西。**这里是白名单**：不写进来的字段
      // 再怎么从服务端传过来也进不了日志文件（我就漏过一次）。
      timing: r.timing || null,
      // 等这一手时标签页是否进过后台 —— 「服务端早答完、页面没处理」的唯一证据
      tabHidden: !!r.tabHidden,
      // 这一手之前后台白捡的思考量，用来事后量化「后台思考」值不值
      ponderMs: r.ponderMs || 0, ponderNodes: r.ponderNodes || 0
    };
    // 自检：配了几秒却几十毫秒交卷、或者一层都没搜完，都是出事了的信号。
    // 与其事后翻数字，不如当场打上标记。
    var flags = [];
    if (r.source === 'search' && r.depth === 0) flags.push('搜索未完成任何一层');
    if (r.source === 'search' && ent.cap > 0 && r.timeMs < ent.cap * 0.05 && r.depth < 6) {
      flags.push('用时不足预算的 5%');
    }
    if (ent.iters.length > 1) {
      var last = ent.iters[ent.iters.length - 1], prev = ent.iters[ent.iters.length - 2];
      if (last.move !== prev.move) flags.push('最后一层仍在改主意');
    }
    if (flags.length) ent.flags = flags;
    this.game.ai.push(ent);
    return ent;                   // 不在这里 flush：紧接着的 sync 会落盘
  };

  /**
   * 给某一手补一条异常标记。
   * 「AI 给的着法没落到盘上」这种事以前完全没有记录 —— 日志和棋谱对不上，
   * 事后只能干瞪眼。凡是"决定了却没执行"的路径都要走这里。
   */
  /**
   * 回填「这一手最后实际落在哪」。
   *
   * decide() 记的是**引擎的决定**，不是棋盘上的结果 —— 两者之间还隔着
   * 「点位被占就放弃」「用户手动改了」「悔棋重下」几种可能。实战出现过
   * 日志写 C10、棋盘上是 B10，而当时 C10 明明是空的，靠现有字段根本没法定性。
   * 有了 played，一条决策是被执行了、被改了、还是压根没落盘，一目了然。
   */
  Recorder.prototype.played = function (ply, label) {
    if (!this.game) return;
    var ai = this.game.ai || [];
    for (var i = ai.length - 1; i >= 0; i--) {
      if (ai[i].ply === ply) {
        ai[i].played = label;
        if (label !== ai[i].move) {
          (ai[i].flags = ai[i].flags || []).push(
            '决策是 ' + ai[i].move + '，实际落的是 ' + label);
        }
        return;
      }
    }
  };

  Recorder.prototype.flag = function (ply, why) {
    if (!this.game) return;
    var ai = this.game.ai || [];
    for (var i = ai.length - 1; i >= 0; i--) {
      if (ai[i].ply === ply) {
        (ai[i].flags = ai[i].flags || []).push(why);
        ai[i].notPlayed = true;
        return;
      }
    }
  };

  Recorder.prototype.finish = function (result) {
    if (!this.game) return;
    this.game.result = result;
    this.game.endedAt = new Date().toISOString();
    this.flush();
  };

  // ---------- 落盘 ----------
  /** 候选上报地址：同源优先，然后是本机常见端口（给 file:// 打开的情况兜底） */
  Recorder.prototype._targets = function () {
    var out = ['log'];
    var ports = [8080, 3000, 8081, 5173];
    try {
      // 同源已经在列表里了；这里补的是「页面不是从服务器来的」那种情况
      var here = (typeof location === 'object' && location.port) ? parseInt(location.port, 10) : 0;
      for (var i = 0; i < ports.length; i++) {
        if (ports[i] !== here) out.push('http://localhost:' + ports[i] + '/log');
      }
    } catch (e) { /* 没有 location 就只试同源 */ }
    return out;
  };

  Recorder.prototype.flush = function () {
    if (!this.game) return;
    var g = this.game;
    // 每次上报带一个递增序号，服务端据此丢掉**晚到的旧快照**。
    // 对手落子和 AI 应手常常只隔几十毫秒，两个 POST 同时在路上，
    // 旧的那份后到就会把新的整份覆盖掉（丢最后一手、丢胜负）。
    // JSON.stringify 在 _post 里同步执行，所以每个请求带的是当时的序号。
    g.seq = (g.seq || 0) + 1;
    if (typeof fetch !== 'function') { this.local(g); return; }

    // 已经试出哪个地址能用就一直用它，不再每手把所有端口重试一遍
    if (this.endpoint) { this._post(this.endpoint, g, null); return; }
    if (this.serverOk === false) { this.local(g); return; }

    var self = this, list = this._targets(), i = 0;
    var next = function () {
      if (i >= list.length) { self.serverOk = false; self.local(g); return; }
      self._post(list[i++], g, next);
    };
    next();
  };

  /** @param onFail 传了就在失败时调用（用于继续试下一个地址） */
  Recorder.prototype._post = function (url, g, onFail) {
    var self = this;
    try {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(g)
      }).then(function (res) {
        if (res.ok) { self.endpoint = url; self.serverOk = true; }
        else if (onFail) onFail();
        else self.local(g);
      }).catch(function () {
        if (onFail) onFail();
        else { self.endpoint = null; self.serverOk = false; self.local(g); }
      });
    } catch (e) {
      if (onFail) onFail(); else this.local(g);
    }
  };

  /** 退路：存进 localStorage，等着用「导出日志」拿出来 */
  Recorder.prototype.local = function (g) {
    try {
      var all = JSON.parse(localStorage.getItem(KEY) || '[]');
      var at = -1;
      for (var i = 0; i < all.length; i++) if (all[i].id === g.id) { at = i; break; }
      if (at >= 0) all[at] = g; else all.push(g);
      while (all.length > MAX_LOCAL) all.shift();
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch (e) { /* 隐私模式/配额满：日志没了也不能影响下棋 */ }
  };

  Recorder.prototype.dump = function () {
    try { return localStorage.getItem(KEY) || '[]'; } catch (e) { return '[]'; }
  };
  Recorder.prototype.clearLocal = function () {
    try { localStorage.removeItem(KEY); } catch (e) { /* 无所谓 */ }
  };
  Recorder.prototype.countLocal = function () {
    try { return JSON.parse(this.dump()).length; } catch (e) { return 0; }
  };

  return { Recorder: Recorder };
});
