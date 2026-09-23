/*
 * core.js — 棋盘表示、棋形模式表、增量评分
 *
 * 设计要点:
 *  1. 棋盘用 23x23 的“带墙”数组(padding 4)，四个方向的位移都是常数，
 *     取窗口不需要任何边界判断 —— 这是速度的基础。
 *  2. 任意一点在某方向上的棋形，由它两侧各 4 格(共 8 格)唯一决定。
 *     每格三种状态(空/己方/阻挡)，所以一共 3^8 = 6561 种情况，
 *     启动时一次性打表，之后所有棋形识别都是 O(1) 查表。
 *  3. 棋盘总分增量维护：落一子只影响它四个方向上各 8 个邻居，
 *     每次落子/悔棋只需刷新 36 个分量。
 */
(function (root, factory) {
  var m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.GomokuCore = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 棋盘边长可变（12x12 / 15x15 …）。关键点：**内部数组尺寸不变**。
  // 棋盘本来就是「带墙」表示的，缩小棋盘等于把墙往里挪 —— 于是
  // 方向位移、Zobrist 表、邻域掩码、6561 项棋形表全都不用动。
  var MAX_SIZE = 15;
  var PAD = 4;                      // 四周留 4 格墙
  var W = MAX_SIZE + PAD * 2;       // 23，恒定
  var AREA = W * W;                 // 529，恒定
  var SIZE = MAX_SIZE;              // 当前棋盘边长，用 setSize 切换

  var EMPTY = 0, BLACK = 1, WHITE = 2, WALL = 3;

  // 四个方向的位移: 横 / 竖 / 右下 / 右上
  var DIRS = [1, W, W + 1, W - 1];

  // ---------- 棋形定义 ----------
  var S_NONE = 0,        // 无
      S_TWO = 1,         // 眠二
      S_OPEN_TWO = 2,    // 活二
      S_SLEEP_THREE = 3, // 眠三
      S_OPEN_THREE = 4,  // 活三
      S_FOUR = 5,        // 冲四
      S_OPEN_FOUR = 6,   // 活四
      S_FIVE = 7;        // 五连

  var SHAPE_NAME = ['-', '眠二', '活二', '眠三', '活三', '冲四', '活四', '五连'];

  // 单颗棋子在单个方向上的分值（用于静态评估；同一棋形会被其中每颗子累加，
  // 这是有意为之：子力越集中的棋形权重越高）
  var SHAPE_SCORE = [0, 12, 120, 150, 2200, 2600, 60000, 10000000];

  var POW3 = [1, 3, 9, 27, 81, 243, 729, 2187];
  var CODE_N = 6561;           // 3^8
  // 窗口 8 格对应的偏移倍数: -4,-3,-2,-1,+1,+2,+3,+4
  var WIN_OFF = [-4, -3, -2, -1, 1, 2, 3, 4];

  // ---------- 打表 ----------
  var SHAPE_OF = new Uint8Array(CODE_N);       // code -> 棋形
  var IS_FIVE = new Uint8Array(CODE_N);        // 落子即成五
  var IS_FOUR = new Uint8Array(CODE_N);        // 再落一子可成五（冲四及以上）
  var IS_OPEN_FOUR = new Uint8Array(CODE_N);
  var IS_OPEN_THREE = new Uint8Array(CODE_N);
  var IS_SLEEP_THREE = new Uint8Array(CODE_N);
  var IS_OPEN_TWO = new Uint8Array(CODE_N);
  var IS_TWO = new Uint8Array(CODE_N);

  function decode(code, cells) {
    // cells[0..8]，中心 cells[4] 固定为己方(1)
    for (var k = 0; k < 8; k++) {
      var v = (code / POW3[k] | 0) % 3;
      cells[k < 4 ? k : k + 1] = v;
    }
    cells[4] = 1;
    return cells;
  }

  function rawIsFive(c) {
    for (var s = 0; s <= 4; s++) {
      var ok = true;
      for (var i = s; i < s + 5; i++) if (c[i] !== 1) { ok = false; break; }
      if (ok) return 1;
    }
    return 0;
  }

  function rawIsOpenFour(c) {
    // 形如 _XXXX_ 且必须包含中心格
    for (var s = 1; s <= 4; s++) {
      if (s + 3 < 4) continue;
      if (c[s - 1] !== 0 || c[s + 4] !== 0) continue;
      var ok = true;
      for (var i = s; i < s + 4; i++) if (c[i] !== 1) { ok = false; break; }
      if (ok) return 1;
    }
    return 0;
  }

  function buildTables() {
    var cells = new Int8Array(9);
    var code;

    for (code = 0; code < CODE_N; code++) {
      decode(code, cells);
      IS_FIVE[code] = rawIsFive(cells);
      IS_OPEN_FOUR[code] = rawIsOpenFour(cells);
    }

    // out[code] = 在任一空位再补一子后可以达成 target
    function lift(target, out) {
      for (var c = 0; c < CODE_N; c++) {
        var hit = 0;
        for (var k = 0; k < 8; k++) {
          if ((c / POW3[k] | 0) % 3 !== 0) continue;   // 该格必须是空位
          if (target[c + POW3[k]]) { hit = 1; break; }
        }
        out[c] = hit;
      }
    }

    lift(IS_FIVE, IS_FOUR);            // 冲四: 再下一子成五
    lift(IS_OPEN_FOUR, IS_OPEN_THREE); // 活三: 再下一子成活四
    lift(IS_FOUR, IS_SLEEP_THREE);     // 眠三: 再下一子成冲四
    lift(IS_OPEN_THREE, IS_OPEN_TWO);  // 活二: 再下一子成活三
    lift(IS_SLEEP_THREE, IS_TWO);      // 眠二

    for (code = 0; code < CODE_N; code++) {
      var s;
      if (IS_FIVE[code]) s = S_FIVE;
      else if (IS_OPEN_FOUR[code]) s = S_OPEN_FOUR;
      else if (IS_FOUR[code]) s = S_FOUR;
      else if (IS_OPEN_THREE[code]) s = S_OPEN_THREE;
      else if (IS_SLEEP_THREE[code]) s = S_SLEEP_THREE;
      else if (IS_OPEN_TWO[code]) s = S_OPEN_TWO;
      else if (IS_TWO[code]) s = S_TWO;
      else s = S_NONE;
      SHAPE_OF[code] = s;
    }
  }
  buildTables();

  // ---------- 坐标工具 ----------
  function xyToP(x, y) { return (y + PAD) * W + (x + PAD); }
  function pToX(p) { return (p % W) - PAD; }
  function pToY(p) { return ((p / W) | 0) - PAD; }
  function pToIdx(p) { return pToY(p) * SIZE + pToX(p); }
  function idxToP(i) { return xyToP(i % SIZE, (i / SIZE) | 0); }

  var COL = 'ABCDEFGHIJKLMNO';
  /** 棋盘中心（偶数边长时取靠左上的那个中心点） */
  function center() { var c = (SIZE - 1) >> 1; return xyToP(c, c); }
  function pToLabel(p) { return COL[pToX(p)] + (SIZE - pToY(p)); }
  function labelToP(s) {
    s = String(s).trim().toUpperCase();
    var c = COL.indexOf(s.charAt(0));
    var n = parseInt(s.slice(1), 10);
    // 列号也要按当前棋盘边长校验：12x12 下 M 列并不存在
    if (c < 0 || c >= SIZE || !(n >= 1 && n <= SIZE)) return -1;
    return xyToP(c, SIZE - n);
  }

  // ---------- Zobrist ----------
  var rngState = 0x2545f491;
  function rnd32() {
    // xorshift32，固定种子保证前后端一致
    rngState ^= rngState << 13; rngState |= 0;
    rngState ^= rngState >>> 17;
    rngState ^= rngState << 5; rngState |= 0;
    return rngState;
  }
  var ZOB = [null, new Int32Array(AREA), new Int32Array(AREA)];
  var ZOB2 = [null, new Int32Array(AREA), new Int32Array(AREA)];
  for (var zi = 0; zi < AREA; zi++) {
    ZOB[1][zi] = rnd32(); ZOB[2][zi] = rnd32();
    ZOB2[1][zi] = rnd32(); ZOB2[2][zi] = rnd32();
  }
  var ZOB_TURN = rnd32(), ZOB_TURN2 = rnd32();

  // 邻域掩码：切比雪夫距离 <= 2 的相对位移（候选点筛选用）
  var NEAR2 = [];
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      if (dx || dy) NEAR2.push(dy * W + dx);
    }
  }
  var NEAR2_N = NEAR2.length;

  // ================= Board =================
  /*
   * 棋形编码缓存：code[(p<<3) | (role-1)<<2 | dir] = 该点该方向、以 role 为己方的 8 格窗口编码。
   *
   * 为什么缓存的是**编码**而不是棋形等级：编码是所有查表的共同输入
   * （IS_FIVE / IS_FOUR / SHAPE_OF / IS_OPEN_THREE …），缓存它就能让所有调用方
   * 一个字都不用改，语义零风险。等级只是编码的一次查表，换不来什么。
   *
   * 为什么值得做：实测每节点 codeAt 调用 329 次，其中候选生成 148 次、
   * winPoints 全盘扫描 126 次、isFourPoint 26 次 —— 这三块都只是在反复重算
   * 同一批窗口。而落子只会影响四个方向上各 8 格、共 32 个点的**那一个方向**，
   * 增量维护的边际成本约 109 次/节点，净剩约 137 次/节点（约 2.4 倍）。
   *
   * 注意 codeAt **不读 p 自身**（只读两侧各 4 格），所以同一份缓存对
   * 空点和已落子点都有效 —— isWinPoint 在落子之后查自己也照样正确。
   */
  function Board() {
    this.cells = new Uint8Array(AREA);
    this.code = new Uint16Array(AREA * 8);   // 6561 < 65536，Uint16 够用
    this.dirScore = new Int32Array(AREA * 4);
    this.near = new Uint8Array(AREA);
    this.total = [0, 0, 0];
    this.history = [];
    this.hash = 0;
    this.hash2 = 0;
    this.reset();
  }

  Board.prototype.reset = function () {
    this.cells.fill(WALL);
    for (var y = 0; y < SIZE; y++) {
      for (var x = 0; x < SIZE; x++) this.cells[xyToP(x, y)] = EMPTY;
    }
    this.dirScore.fill(0);
    this.near.fill(0);
    // 空盘的缓存要整张建一遍：墙的位置会让编码非零，不能简单 fill(0)。
    // 529×4×2 次，只在开新局时跑一次，可以忽略。
    for (var ry = 0; ry < SIZE; ry++) {
      for (var rx = 0; rx < SIZE; rx++) {
        var rp = xyToP(rx, ry);
        for (var rd = 0; rd < 4; rd++) this._recalcCode(rp, rd);
      }
    }
    this.total[BLACK] = 0; this.total[WHITE] = 0;
    this.history.length = 0;
    this.hash = 0; this.hash2 = 0;
  };

  /** 查缓存：p 点在 dir 方向、以 role 为「己方」时的窗口编码 */
  Board.prototype.codeAt = function (p, dir, role) {
    return this.code[(p << 3) | ((role - 1) << 2) | dir];
  };

  /** 真正算一遍（只有维护缓存时才调用） */
  Board.prototype._rawCode = function (p, dir, role) {
    var c = this.cells, d = DIRS[dir], code = 0, v;
    v = c[p - 4 * d]; code += (v === EMPTY ? 0 : v === role ? 1 : 2);
    v = c[p - 3 * d]; code += (v === EMPTY ? 0 : v === role ? 1 : 2) * 3;
    v = c[p - 2 * d]; code += (v === EMPTY ? 0 : v === role ? 1 : 2) * 9;
    v = c[p - d];     code += (v === EMPTY ? 0 : v === role ? 1 : 2) * 27;
    v = c[p + d];     code += (v === EMPTY ? 0 : v === role ? 1 : 2) * 81;
    v = c[p + 2 * d]; code += (v === EMPTY ? 0 : v === role ? 1 : 2) * 243;
    v = c[p + 3 * d]; code += (v === EMPTY ? 0 : v === role ? 1 : 2) * 729;
    v = c[p + 4 * d]; code += (v === EMPTY ? 0 : v === role ? 1 : 2) * 2187;
    return code;
  };

  /** p 点落 role 子后，在 dir 方向形成的棋形 */
  Board.prototype.shapeAt = function (p, dir, role) {
    return SHAPE_OF[this.codeAt(p, dir, role)];
  };

  /** role 在 p 落子是否直接成五（p 已是 role 时同样适用） */
  Board.prototype.isWinPoint = function (p, role) {
    return !!(IS_FIVE[this.codeAt(p, 0, role)] || IS_FIVE[this.codeAt(p, 1, role)] ||
              IS_FIVE[this.codeAt(p, 2, role)] || IS_FIVE[this.codeAt(p, 3, role)]);
  };

  /** role 在 p 落子是否形成冲四及以上 */
  Board.prototype.isFourPoint = function (p, role) {
    return !!(IS_FOUR[this.codeAt(p, 0, role)] || IS_FOUR[this.codeAt(p, 1, role)] ||
              IS_FOUR[this.codeAt(p, 2, role)] || IS_FOUR[this.codeAt(p, 3, role)]);
  };

  /** role 在 p 落子是否形成活四 */
  Board.prototype.isOpenFourPoint = function (p, role) {
    return !!(IS_OPEN_FOUR[this.codeAt(p, 0, role)] || IS_OPEN_FOUR[this.codeAt(p, 1, role)] ||
              IS_OPEN_FOUR[this.codeAt(p, 2, role)] || IS_OPEN_FOUR[this.codeAt(p, 3, role)]);
  };

  /** role 在 p 落子是否形成活三（含跳活三） */
  Board.prototype.isOpenThreePoint = function (p, role) {
    return !!(IS_OPEN_THREE[this.codeAt(p, 0, role)] || IS_OPEN_THREE[this.codeAt(p, 1, role)] ||
              IS_OPEN_THREE[this.codeAt(p, 2, role)] || IS_OPEN_THREE[this.codeAt(p, 3, role)]);
  };

  /** role 在 p 落子是否构成任何「对手必须应」的威胁（冲四或活三及以上） */
  Board.prototype.isThreatPoint = function (p, role) {
    for (var d = 0; d < 4; d++) {
      var c = this.codeAt(p, d, role);
      if (IS_FOUR[c] || IS_OPEN_THREE[c]) return true;
    }
    return false;
  };

  // threatKind 的返回值
  var K_NONE = 0, K_OPEN_THREE = 1, K_FOUR = 2, K_OPEN_FOUR = 3, K_FIVE = 4;

  /**
   * 一次性判定 p 点对 role 的威胁等级。
   * 算杀的热点就在这里：分开调用 isFivePoint/isFourPoint/isOpenThreePoint
   * 会把四个方向的窗口编码重复算三遍，这里只算一遍。
   */
  Board.prototype.threatKind = function (p, role) {
    var best = K_NONE;
    for (var d = 0; d < 4; d++) {
      var c = this.codeAt(p, d, role);
      if (IS_FIVE[c]) return K_FIVE;
      var k = IS_OPEN_FOUR[c] ? K_OPEN_FOUR : IS_FOUR[c] ? K_FOUR
            : IS_OPEN_THREE[c] ? K_OPEN_THREE : K_NONE;
      if (k > best) best = k;
    }
    return best;
  };

  /** 重算 q 点 dir 方向的缓存（黑白两方一起，反正窗口是同一批格子） */
  Board.prototype._recalcCode = function (q, dir) {
    var base = (q << 3) | dir;
    this.code[base] = this._rawCode(q, dir, BLACK);
    this.code[base | 4] = this._rawCode(q, dir, WHITE);
  };

  Board.prototype._setContrib = function (p, dir, val) {
    var key = p * 4 + dir, old = this.dirScore[key];
    if (old === val) return;
    this.dirScore[key] = val;
    var role = this.cells[p];
    if (role === BLACK || role === WHITE) this.total[role] += val - old;
  };

  Board.prototype._refresh = function (p, dir) {
    var role = this.cells[p];
    var val = (role === BLACK || role === WHITE)
      ? SHAPE_SCORE[SHAPE_OF[this.codeAt(p, dir, role)]] : 0;
    this._setContrib(p, dir, val);
  };

  // 落子/悔棋只会改变「四个方向上各 8 格」这 32 个点在**那一个方向**上的窗口，
  // 所以缓存维护并进这趟本来就要走的遍历，不额外开一轮。
  Board.prototype._touchNeighbors = function (p) {
    var c = this.cells;
    for (var dir = 0; dir < 4; dir++) {
      var d = DIRS[dir];
      for (var k = 0; k < 8; k++) {
        var q = p + WIN_OFF[k] * d;
        var r = c[q];
        if (r === WALL) continue;            // 墙外没人会查
        this._recalcCode(q, dir);
        if (r === BLACK || r === WHITE) this._refresh(q, dir);
      }
    }
  };

  Board.prototype.put = function (p, role) {
    this.cells[p] = role;
    // p 自身的窗口不含 p，所以它的缓存不会因为这次落子而变；
    // 但 dirScore 要按新身份重算，_refresh 会从缓存里读，顺序上必须在邻居刷新之前没关系。
    for (var dir = 0; dir < 4; dir++) this._refresh(p, dir);
    this._touchNeighbors(p);
    for (var i = 0; i < NEAR2_N; i++) this.near[p + NEAR2[i]]++;
    this.hash ^= ZOB[role][p] ^ ZOB_TURN;
    this.hash2 ^= ZOB2[role][p] ^ ZOB_TURN2;
    this.history.push(p);
  };

  Board.prototype.undo = function () {
    var p = this.history.pop();
    if (p === undefined) return -1;
    var role = this.cells[p];
    for (var dir = 0; dir < 4; dir++) this._setContrib(p, dir, 0);
    this.cells[p] = EMPTY;
    this._touchNeighbors(p);
    for (var i = 0; i < NEAR2_N; i++) this.near[p + NEAR2[i]]--;
    this.hash ^= ZOB[role][p] ^ ZOB_TURN;
    this.hash2 ^= ZOB2[role][p] ^ ZOB_TURN2;
    return p;
  };

  /** 最后一手是否直接获胜 */
  Board.prototype.lastMoveWins = function () {
    var p = this.history[this.history.length - 1];
    if (p === undefined) return false;
    return this.isWinPoint(p, this.cells[p]);
  };

  /** 所有有意义的空点（离已有棋子 <= 2） */
  Board.prototype.emptyNear = function (out) {
    out.length = 0;
    var c = this.cells, n = this.near;
    for (var y = 0; y < SIZE; y++) {
      var base = (y + PAD) * W + PAD;
      for (var x = 0; x < SIZE; x++) {
        var p = base + x;
        if (c[p] === EMPTY && n[p] > 0) out.push(p);
      }
    }
    return out;
  };

  /** role 在哪些空点落子可以直接成五 */
  Board.prototype.winPoints = function (role, out) {
    out.length = 0;
    var c = this.cells, n = this.near;
    for (var y = 0; y < SIZE; y++) {
      var base = (y + PAD) * W + PAD;
      for (var x = 0; x < SIZE; x++) {
        var p = base + x;
        if (c[p] !== EMPTY || n[p] === 0) continue;
        // 成五点必然紧贴己方棋子（XXXX_ / XXX_X / XX_XX 里那个空位都挨着自家子），
        // 先用 8 邻域快筛掉绝大多数点，省去昂贵的四方向查表。算杀里这是热点。
        if (c[p - 1] !== role && c[p + 1] !== role &&
            c[p - W] !== role && c[p + W] !== role &&
            c[p - W - 1] !== role && c[p + W + 1] !== role &&
            c[p - W + 1] !== role && c[p + W - 1] !== role) continue;
        if (this.isWinPoint(p, role)) out.push(p);
      }
    }
    return out;
  };

  Board.prototype.clone = function () {
    var b = new Board();
    b.cells.set(this.cells);
    b.code.set(this.code);
    b.dirScore.set(this.dirScore);
    b.near.set(this.near);
    b.total[BLACK] = this.total[BLACK];
    b.total[WHITE] = this.total[WHITE];
    b.history = this.history.slice();
    b.hash = this.hash; b.hash2 = this.hash2;
    return b;
  };

  // ---------- 对称规范化（开局库索引用） ----------
  // t 号变换把“当前坐标 (x,y)”映射到“规范坐标”
  function fwd(t, x, y) {
    switch (t) {
      case 0: return [x, y];
      case 1: return [SIZE - 1 - x, y];
      case 2: return [x, SIZE - 1 - y];
      case 3: return [SIZE - 1 - x, SIZE - 1 - y];
      case 4: return [y, x];
      case 5: return [SIZE - 1 - y, x];
      case 6: return [y, SIZE - 1 - x];
      case 7: return [SIZE - 1 - y, SIZE - 1 - x];
    }
    return [x, y];
  }
  // fwd 的逆变换：把“规范坐标”映射回“当前坐标”
  function inv(t, x, y) {
    switch (t) {
      case 0: return [x, y];
      case 1: return [SIZE - 1 - x, y];
      case 2: return [x, SIZE - 1 - y];
      case 3: return [SIZE - 1 - x, SIZE - 1 - y];
      case 4: return [y, x];
      case 5: return [y, SIZE - 1 - x];
      case 6: return [SIZE - 1 - y, x];
      case 7: return [SIZE - 1 - y, SIZE - 1 - x];
    }
    return [x, y];
  }

  /**
   * 规范键：在 8 种对称里取字典序最小的棋盘串。
   * 返回 { key, transform }，transform 用于把库里存的着法还原到当前坐标。
   */
  function canonicalKey(board, turn) {
    var best = null, bestT = 0;
    var buf = new Array(SIZE * SIZE);
    for (var t = 0; t < 8; t++) {
      for (var y = 0; y < SIZE; y++) {
        for (var x = 0; x < SIZE; x++) {
          var q = inv(t, x, y);          // 规范格 (x,y) 取自当前格 q
          buf[y * SIZE + x] = board.cells[xyToP(q[0], q[1])];
        }
      }
      var s = buf.join('');
      if (best === null || s < best) { best = s; bestT = t; }
    }
    return { key: best + '|' + turn, transform: bestT };
  }

  /**
   * 和 p 完全等价的所有落点（含 p 自己）。
   *
   * 只用「让当前局面保持不变」的那几种对称变换去映射 p：局面在变换 t 下不变，
   * 那么落 p 和落 t(p) 得到的两个局面互为镜像，价值**严格相等** —— 不是评估接近，
   * 是同一个局面换了个方向看。所以在这些点里随机挑一个，棋力零损失。
   *
   * 典型情况：12 路空盘的中间 4 点；15 路对手下天元后，紧贴它的上下左右 4 点
   * （斜角 4 点是另一组）。局面一旦不对称，返回的就只有 p 自己。
   */
  function symmetricMoves(board, p) {
    var x = pToX(p), y = pToY(p), stones = board.history, out = [p];
    for (var t = 1; t < 8; t++) {
      var keep = true;
      for (var i = 0; i < stones.length && keep; i++) {
        var s = stones[i], q = fwd(t, pToX(s), pToY(s));
        if (board.cells[xyToP(q[0], q[1])] !== board.cells[s]) keep = false;
      }
      if (!keep) continue;
      var m = fwd(t, x, y), mp = xyToP(m[0], m[1]);
      if (board.cells[mp] === EMPTY && out.indexOf(mp) < 0) out.push(mp);
    }
    return out;
  }

  /**
   * 切换棋盘边长。必须在创建/重置 Board 之前调用；
   * 已经存在的 Board 要再 reset() 一次才会应用新尺寸。
   */
  function setSize(n) {
    n = n | 0;
    if (n < 5 || n > MAX_SIZE) throw new Error('棋盘边长只支持 5..' + MAX_SIZE);
    SIZE = n;
    return SIZE;
  }
  function getSize() { return SIZE; }

  var api = {
    PAD: PAD, W: W, AREA: AREA, MAX_SIZE: MAX_SIZE,
    setSize: setSize, getSize: getSize, center: center,
    EMPTY: EMPTY, BLACK: BLACK, WHITE: WHITE, WALL: WALL,
    DIRS: DIRS,
    S_NONE: S_NONE, S_TWO: S_TWO, S_OPEN_TWO: S_OPEN_TWO,
    S_SLEEP_THREE: S_SLEEP_THREE, S_OPEN_THREE: S_OPEN_THREE,
    S_FOUR: S_FOUR, S_OPEN_FOUR: S_OPEN_FOUR, S_FIVE: S_FIVE,
    SHAPE_NAME: SHAPE_NAME, SHAPE_SCORE: SHAPE_SCORE,
    SHAPE_OF: SHAPE_OF, IS_FIVE: IS_FIVE, IS_FOUR: IS_FOUR,
    IS_OPEN_FOUR: IS_OPEN_FOUR, IS_OPEN_THREE: IS_OPEN_THREE,
    Board: Board,
    xyToP: xyToP, pToX: pToX, pToY: pToY, pToIdx: pToIdx, idxToP: idxToP,
    pToLabel: pToLabel, labelToP: labelToP,
    canonicalKey: canonicalKey, symFwd: fwd, symInv: inv, symmetricMoves: symmetricMoves,
    K_NONE: K_NONE, K_OPEN_THREE: K_OPEN_THREE, K_FOUR: K_FOUR,
    K_OPEN_FOUR: K_OPEN_FOUR, K_FIVE: K_FIVE
  };
  // SIZE 用 getter 暴露：切换棋盘后 Core.SIZE 立刻跟着变。
  // 注意调用方不要写 `var SIZE = Core.SIZE` 把它快照下来。
  Object.defineProperty(api, 'SIZE', { get: function () { return SIZE; }, enumerable: true });
  return api;
});
