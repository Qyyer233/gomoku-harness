/*
 * book.js — 开局库（棋谱知识）
 *
 * 库里存的是「局面 -> 该局面下各着法的统计」。局面用 8 种对称规范化后再哈希，
 * 所以一条棋谱等于同时喂进了它的 8 个镜像；查询是一次 Map 查找，0ms。
 *
 * 文件格式(JSON):
 * {
 *   version, generated, games, maxPly,
 *   entries: { "<hash>": [n, mv, games, wins, draws, plySum, ...每着 5 个数] }
 * }
 * 其中 n    = 该局面的棋子数（用于降低哈希碰撞风险），
 *     mv   = 「规范坐标」下的 y*15+x，
 *     wins = 从“当前轮到走的一方”角度统计的胜局数，
 *     plySum = 这些对局的总手数（用于在必败线里挑最顽强的下法）。
 */
(function (root, factory) {
  var Core = (typeof module === 'object' && module.exports)
    ? require('./core.js') : root.GomokuCore;
  var m = factory(Core);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.GomokuBook = m;
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  /** FNV-1a 64 位（用两个 32 位半部实现），输出 base36 短串 */
  function hashKey(str) {
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      h1 ^= c; h1 = (h1 * 16777619) | 0;
      h2 = (h2 + c) | 0; h2 = (h2 * 2654435761) | 0; h2 ^= h2 >>> 15;
    }
    return ((h1 >>> 0).toString(36) + '_' + (h2 >>> 0).toString(36));
  }

  function Book(data) {
    this.entries = (data && data.entries) || {};
    // 引擎裁定：局面 -> Rapfi 在充足时间下认定的最佳着法。
    // 和上面的统计库是**两种不同的知识**，所以分开存、分开用（见 lookup）。
    this.verdicts = (data && data.verdicts) || {};
    this.meta = data || { games: 0, maxPly: 0 };
    // 样本门槛：只有 1 局支撑的“着法”不过是某盘棋里随手走的一手，
    // 并不比现场搜索更可信，直接放弃查库交给引擎算。
    this.minGames = 2;

    // ---- 深层条目：门槛更高，但确实可以用 ----
    //
    // 这里曾经写死 `maxPly = 8`，理由是实测「不限深度的库让困难档从 62.5% 掉到 40.0%」。
    // 后来查清楚了：**拖后腿的不是深度，是样本太薄。**
    // 第 15 手的局面在棋谱里出现两次就进库，那个胜率纯粹是噪声，
    // 而现场搜索是针对这个局面真算出来的。
    //
    // 同一份库、同样放开到第 26 手，只把门槛从 2 提到 5（A/B 各 300 / 118 局）：
    //     门槛 2 -> 44.1%，Elo -41   （拖后腿，和当年的结论一致）
    //     门槛 5 -> 53.5%，Elo +24   （不亏，而且查库是 0ms）
    //
    // 所以按手数分档：前 deepPly 手保持低门槛（那里样本本来就厚，
    // 天元 3519 局、第 4 手仍有上百局），之后才要求更多支撑。
    this.deepPly = 8;
    this.deepMinGames = 5;
    this.maxPly = 26;
    this.enabled = true;
  }

  Book.prototype.size = function () { return Object.keys(this.entries).length; };

  /**
   * 查询当前局面的库着法。
   * @param random 0 = 总是选最优；>0 = 在胜率相近的着法里按权重随机（增加棋局变化）
   * @return { move, games, wins, winRate, total } 或 null
   */
  Book.prototype.lookup = function (board, role, random) {
    if (!this.enabled) return null;
    // 棋盘尺寸必须对得上：15 路的库用在 12 路上，坐标和对称性全是错的
    if ((this.meta.size || 15) !== Core.SIZE) return null;

    var stones = board.history.length;
    var ck = Core.canonicalKey(board, role);
    var key = hashKey(ck.key);

    // ---- 引擎裁定优先，而且**不受 maxPly 限制** ----
    //
    // maxPly 那道闸门是为统计库设的：棋谱由较弱的自对弈产生，一旦现场搜索比
    // 造谱时更强，深层库着法就会反过来拖后腿（见下面 maxPly 的注释）。
    // 引擎裁定没有这个问题 —— 它是 Rapfi 花几十秒算出来的，比现场那几秒更可信。
    // 所以它可以铺到任意手数，这正是「开局一路不长考」的来源。
    var v = this.verdicts[key];
    if (v && v[0] === stones) {
      var vp = Core.xyToP.apply(null, Core.symInv(ck.transform, v[1] % 15, (v[1] / 15) | 0));
      if (board.cells[vp] === Core.EMPTY) {
        return {
          move: vp, kind: 'verdict',
          evalCentis: v[2], depth: v[3], ms: v[4],
          games: 0, wins: 0, winRate: 0, total: 0
        };
      }
    }

    if (board.history.length >= this.maxPly) return null;
    var e = this.entries[key];
    if (!e) return null;

    if (e[0] !== stones) return null;          // 哈希碰撞，丢弃

    // 解析 (mv, games, wins, draws, plySum) 五元组
    // 样本门槛按手数分档：深层局面在棋谱里出现次数少，低门槛下胜率全是噪声
    var need = stones >= this.deepPly ? this.deepMinGames : this.minGames;
    var cands = [], totalGames = 0;
    for (var i = 1; i + 4 < e.length; i += 5) {
      var g = e[i + 1], w = e[i + 2], d = e[i + 3];
      totalGames += g;
      if (g < need) continue;
      cands.push({
        mv: e[i], games: g, wins: w, draws: d,
        rate: (w + d * 0.5) / g, avgLen: e[i + 4] / g
      });
    }
    if (!cands.length) return null;

    // 胜率优先；胜率接近时：占优就选样本最多的，劣势就选最能拖长的（最顽强）
    cands.sort(function (a, b) {
      if (Math.abs(a.rate - b.rate) > 0.02) return b.rate - a.rate;
      if (a.rate < 0.4) return b.avgLen - a.avgLen;
      return b.games - a.games;
    });

    var pick = cands[0];
    if (random) {
      // 变化只在「确实旗鼓相当」的着法之间取：胜率差不超过 4 个百分点，
      // 且样本量不少于最优着法的一半 —— 求变化不能以走差棋为代价。
      var top = cands[0];
      var pool = cands.filter(function (c) {
        return c.rate >= top.rate - 0.04 && c.games * 2 >= top.games;
      });
      var sum = 0, k;
      for (k = 0; k < pool.length; k++) sum += pool[k].games;
      var r = Math.random() * sum;
      for (k = 0; k < pool.length; k++) { r -= pool[k].games; if (r <= 0) { pick = pool[k]; break; } }
    }

    // 规范坐标 -> 当前实际坐标
    var cx = pick.mv % 15, cy = (pick.mv / 15) | 0;
    var real = Core.symInv(ck.transform, cx, cy);
    var p = Core.xyToP(real[0], real[1]);
    if (board.cells[p] !== Core.EMPTY) return null;

    return {
      move: p, kind: 'stats', games: pick.games, wins: pick.wins,
      winRate: pick.rate, total: totalGames
    };
  };

  /** 库里一共有多少条引擎裁定 */
  Book.prototype.verdictCount = function () { return Object.keys(this.verdicts).length; };

  /** 只读探测：该局面在库中有几种着法（调试/展示用） */
  Book.prototype.probe = function (board, role) {
    var ck = Core.canonicalKey(board, role);
    var e = this.entries[hashKey(ck.key)];
    if (!e || e[0] !== board.history.length) return [];
    var out = [];
    for (var i = 1; i + 4 < e.length; i += 5) {
      var cx = e[i] % 15, cy = (e[i] / 15) | 0;
      var real = Core.symInv(ck.transform, cx, cy);
      out.push({
        move: Core.xyToP(real[0], real[1]),
        label: Core.pToLabel(Core.xyToP(real[0], real[1])),
        games: e[i + 1], wins: e[i + 2], draws: e[i + 3]
      });
    }
    return out.sort(function (a, b) { return b.games - a.games; });
  };

  Book.load = function (json) {
    return new Book(typeof json === 'string' ? JSON.parse(json) : json);
  };

  return { Book: Book, hashKey: hashKey };
});
