/*
 * ui.js — 棋盘绘制与对局流程
 *
 * 核心状态是「一条完整的着法列表 moves[] + 当前看到第几手 viewLen」，
 * 而不是直接拿一个 Board 当真相。好处是复盘、悔棋、分支改写都变成同一件事：
 * 调整 viewLen 然后重放。
 *
 * 用法定位：对手每走一手就录进来（点棋盘或输坐标），AI 立刻给出应手。
 * 所以开局只需要回答一个问题 —— 谁先走 —— 由两个按钮一键决定，
 * 不必先想自己执什么颜色。
 */
(function () {
  'use strict';

  var Core = window.GomokuCore;
  var Eng = window.GomokuEngine;
  var BookNS = window.GomokuBook;
  var LogNS = window.GomokuLog;
  var BLACK = Core.BLACK, WHITE = Core.WHITE, EMPTY = Core.EMPTY;
  // 棋盘边长可切换，所以不能在这里快照成常量
  function size() { return Core.SIZE; }

  var $ = function (id) { return document.getElementById(id); };
  /**
   * 是不是触屏设备（手机/平板）。
   * 用 pointer: coarse 判断，比看 userAgent 靠谱 —— 它问的是"主要指点设备精度够不够"，
   * 正好对应"聚焦输入框会不会弹出虚拟键盘"这件事。
   */
  function isTouch() {
    try { return window.matchMedia && window.matchMedia("(pointer: coarse)").matches; }
    catch (e) { return false; }
  }
  var canvas = $('board'), ctx = canvas.getContext('2d');

  // ---------- 布局 ----------
  var LOGICAL = 720, MARGIN = 38;
  // 格距和星位都随棋盘边长变，不能写死成 15 路的值
  function cell() { return (LOGICAL - MARGIN * 2) / (size() - 1); }
  function starPoints() {
    // 角上四个星位落在第 4 线（下标 3）—— 和用户实际对弈的那副 12 路棋盘一致。
    // 原先 12 路用的是第 3 线（下标 2），和实体盘对不上，
    // 对着屏幕数格子容易数错位。
    var n = size(), d = 3;
    var pts = [[d, d], [n - 1 - d, d], [d, n - 1 - d], [n - 1 - d, n - 1 - d]];
    if (n % 2 === 1) {
      pts.push([(n - 1) / 2, (n - 1) / 2]);                 // 奇数边长有唯一天元
    } else {
      // 偶数边长（12 路）没有唯一中心，就把正中那四个点都标出来 ——
      // 否则只剩四角星位，中腹一片空白，落子时很难快速定位。
      var a = n / 2 - 1, b = n / 2;
      pts.push([a, a], [b, a], [a, b], [b, b]);
    }
    return pts;
  }
  var COLS = 'ABCDEFGHIJKLMNO';

  // ---------- 状态 ----------
  var board = new Core.Board();     // 始终等于 moves 的前 viewLen 手
  var moves = [];                   // 整局着法（padded 下标）
  var viewLen = 0;                  // 当前看到第几手
  var engine = new Eng.Engine();
  var book = null;
  var aiColor = BLACK;              // AI 执什么颜色，由开局那两个按钮决定
  // 对局日志：棋谱 + AI 每手的思维链，供事后改进算法
  var rec = LogNS ? new LogNS.Recorder() : null;
  var thinking = false, winLine = null, winner = 0;
  var thinkMsg = '', thinkTimer = 0;
  var hover = -1, hintMove = -1;

  /** 按当前棋盘边长挂上对应的开局库（12 路和 15 路各一份） */
  function loadBook() {
    var data = window.GOMOKU_BOOKS && window.GOMOKU_BOOKS[size()];
    book = data ? BookNS.Book.load(data) : null;
    engine.setBook(book);
    if (book) {
      // 两种知识分开报：统计库来自棋谱，裁定是 Rapfi 离线深算出来的（后者优先，且不限手数）
      var nv = book.verdictCount();
      $('bookInfo').textContent = size() + ' 路 · ' + book.meta.positions +
        ' 个局面 · 来自 ' + book.meta.games + ' 局棋谱' +
        (nv ? ' · Rapfi 裁定 ' + nv + ' 条' : '');
      $('chkBook').disabled = false;
    } else {
      // 没库不等于不能下 —— 只是开局那几手要现算，不是 0ms 直出。
      // NNUE 权重声明支持 12~22 路，超出这个范围 Rapfi 会静默退回传统估值。
      $('bookInfo').textContent = size() + ' 路没有开局库，开局几手要现算（棋力不受影响）';
      $('chkBook').disabled = true;
    }
  }
  loadBook();

  // ---------- 后台线程 ----------
  // 大师档遇到复杂局面会想十几秒，跑在主线程上页面会整个冻住。
  // 所以优先把搜索丢进 Worker；从 file:// 打开时浏览器不允许创建 Worker，
  // 那就退回主线程，并把思考上限压到不至于卡死的程度。
  var worker = null, workerSeq = 0, workerCb = null;
  var helpers = [];                 // 并行搜索的副线程，只负责往共享置换表里灌
  var FILE_MODE_CAP = 2500;

  /*
   * 并行搜索（Lazy SMP）：多个 Worker 搜同一个局面、**共享同一张置换表**，
   * 靠彼此写进表里的结论互相加速。不是把工作切成 N 份 —— α-β 有强顺序依赖，切不开。
   *
   * 共享置换表要用 SharedArrayBuffer，而它要求页面「跨源隔离」
   * （服务器发 COOP/COEP 两个响应头，见 tools/serve.js）。
   * 拿不到就老老实实退回单线程 —— N 个不共享表的线程只是 N 份重复劳动，没有意义。
   *
   * 线程数不是越多越好：这台机器实测 24 逻辑核只换来 9.7 倍原始吞吐
   *（8 个性能核 + 8 个能效核，超线程只补 20~30%），而 Lazy SMP 把吞吐转成棋力的
   * 效率还要再打一次折。所以取「性能核数量」这个量级，并给浏览器和系统留出余量。
   */
  function pickThreads() {
    var hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    // 上限取 4：实测同一局面下 1 线程搜到 8 层、2 线程就到 10 层，
    // 4 / 6 线程并没有再深 —— 收益在 2 线程就吃满了。留到 4 是给更难的局面一点余量，
    // 再往上只是白烧机器（这台笔记本持续满载会降频）。
    // 注意这个数只在一个局面上量过，不是强结论。
    return Math.max(1, Math.min(4, Math.floor(hc / 3) + 1));
  }

  var sharedTT = null;
  function makeSharedTT() {
    // crossOriginIsolated 为假时 SharedArrayBuffer 要么不存在、要么不能跨线程传
    if (typeof SharedArrayBuffer !== 'function') return null;
    if (typeof self !== 'undefined' && self.crossOriginIsolated === false) return null;
    try { return new SharedArrayBuffer(Eng.TT.bytes); } catch (e) { return null; }
  }

  function spawnWorkers() {
    var want = 1;
    sharedTT = makeSharedTT();
    if (sharedTT) want = pickThreads();
    try {
      for (var i = 0; i < want; i++) {
        var w = new Worker('js/worker.js');
        if (i === 0) {
          w.onmessage = function (ev) {
            var d = ev.data;
            if (d.type === 'move' && workerCb && d.id === workerSeq) {
              var cb = workerCb; workerCb = null; cb(d);
            }
          };
          w.onerror = function () { worker = null; };
          worker = w;
        } else {
          // 副线程的返回值一律丢弃，它的价值全在共享置换表里
          w.onmessage = function () {};
          w.onerror = function () {};
          helpers.push(w);
        }
        w.postMessage({ type: 'init', smp: i, ttBuffer: sharedTT });
      }
    } catch (e) {
      worker = null; helpers = []; sharedTT = null;
    }
  }
  spawnWorkers();

  /** 把同一条消息发给所有线程（副线程要和主线程搜同一个局面才有意义） */
  function postAll(msg) {
    if (worker) worker.postMessage(msg);
    for (var i = 0; i < helpers.length; i++) helpers[i].postMessage(msg);
  }

  // 让用户一眼看出当前是不是满血状态
  $('envNote').textContent = !worker
    ? '⚠ 当前从 file:// 打开，浏览器不允许后台线程：思考上限被压到 ' +
      (FILE_MODE_CAP / 1000) + ' 秒，棋力打折。改用 npm start 打开可发挥全部实力。'
    : helpers.length
      ? '✓ 并行搜索已启用：' + (helpers.length + 1) + ' 个线程共享置换表'
      : '✓ 引擎在后台线程运行，长考不会卡界面（未启用并行：当前页面不是跨源隔离状态）';

  // ---------- Rapfi 内核 ----------
  //
  // Rapfi 是 Gomocup 卫冕冠军（2025 年自由规则 15 路、20 路、连珠三冠）。
  // 但它是**正经比赛引擎**：比赛规则禁止开局库、禁止常驻思考，所以它不带这些。
  // 我们没有这个限制 —— 开局库、对局界面、日志复盘全是我们这一层的东西，
  // 一样都不丢，换掉的只是最里面那个搜索核。
  //
  // 后台思考则是 Rapfi 自己就有的（INFO PONDERING 1）：它每输出一手就立刻在
  // 新局面上继续算，下一条 TURN 到达时置换表已经是热的。前提是**进程跨整局存活**，
  // 这件事由 tools/serve.js 的会话管理负责，所以 Rapfi 模式下我们不再发 ponder 消息。
  var rapfi = { ready: false, base: null, note: '检测中…', gid: '' };

  function rapfiBases() {
    var out = [''];                       // 同源优先
    var ports = [8080, 3000, 8081, 5173];
    try {
      var here = location.port ? parseInt(location.port, 10) : 0;
      for (var i = 0; i < ports.length; i++)
        if (ports[i] !== here) out.push('http://localhost:' + ports[i]);
    } catch (e) {}
    return out;
  }

  function probeRapfi() {
    if (typeof fetch !== 'function') { rapfi.note = '浏览器不支持 fetch'; showEngineNote(); return; }
    var bases = rapfiBases(), i = 0;
    (function next() {
      if (i >= bases.length) {
        rapfi.ready = false;
        rapfi.note = '未连上本地服务，Rapfi 不可用 —— 请用 npm start 启动后刷新';
        showEngineNote();
        return;
      }
      var base = bases[i++];
      fetch(base + '/engine/info').then(function (r) { return r.json(); }).then(function (d) {
        if (!d || !d.available) throw new Error('no engine');
        rapfi.ready = true; rapfi.base = base;
        rapfi.note = '✓ Rapfi 已就绪：' + d.exe.replace(/^pbrain-rapfi-windows-|\.exe$/g, '') +
                     ' · 主引擎 ' + d.threads + ' 线程' +
                     (d.prepEngines ? ' + 超前思考 ' + d.prepEngines + ' 个引擎各 ' + d.prepThreads + ' 线程' : ' · 超前思考已关闭') +
                     (d.cpus ? '（本机 ' + d.cpus + ' 核）' : '');
        showEngineNote();
        // 记忆库的规模也摆出来。用户看得见它在长，才知道这功能有没有在起作用 ——
        // 「棋谱库 0 局」那种静默失效以前坑过一次。
        fetch(base + '/engine/memo').then(function (r) { return r.json(); }).then(function (m) {
          if (!m || !m.positions) return;
          rapfi.note += ' · 实战记忆 ' + m.positions + ' 个局面' +
            (m.review ? '（' + m.review + ' 个待复查）' : '');
          showEngineNote();
        }).catch(function () {});
      }).catch(next);
    })();
  }

  function engineMode() { return $('selEngine').value; }
  function showEngineNote() {
    $('engineNote').textContent = engineMode() === 'rapfi'
      ? rapfi.note
      : '当前用自研 JS 引擎（Rapfi 仍可随时切回）';
    // Rapfi 自带后台思考且跑在服务端，这里的开关只管 JS 引擎
    $('ponderInfo').textContent = engineMode() === 'rapfi' && rapfi.ready
      ? 'Rapfi 自带常驻思考，始终开启（此开关只作用于 JS 引擎）'
      : '等你录入对手着法时继续算，白捡思考时间';
  }
  $('selEngine').addEventListener('change', function () { cancelPending(); showEngineNote(); });
  probeRapfi();

  function newGid() {
    if (rapfi.gid && rapfi.ready && typeof fetch === 'function') {
      fetch(rapfi.base + '/engine/end', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gid: rapfi.gid })
      }).catch(function () {});
    }
    rapfi.gid = 'g' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    // **马上把引擎起起来，别让第一手替启动买单。**
    // 服务端一个会话要起 3 个 Rapfi 进程（主引擎 + 2 个预备），每个都要解压
    // 10MB 权重 —— 实测约 1.5 秒。这段发生在 think() 之前，以前既不算进
    // 预算、也不记进日志，于是「日志显示 3.4 秒、人其实等了 4.9 秒」。
    // width 0 = 只建会话，不真的开始预备。
    if (rapfi.ready && typeof fetch === 'function') {
      fetch(rapfi.base + '/engine/ponder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gid: rapfi.gid, size: size(), moves: [], width: 0,
                               rule: parseInt($('selRule').value, 10) })
      }).catch(function () {});
    }
  }

  /** 把 Rapfi 的答复翻译成界面/日志通用的结果结构 */
  /**
   * @param d      服务端返回的结果
   * @param waited 浏览器实际等待的毫秒数。**日志记这个**，不记 d.ms ——
   *               d.ms 只是引擎内部的搜索时间，漏掉了会话创建等一大段。
   */
  function rapfiResult(d, waited) {
    var note = [];
    if (d.evalText) note.push(d.mate ? (d.mate > 0 ? d.mate + ' 步杀' : '被杀 ' + (-d.mate) + ' 步')
                                     : '评分 ' + d.evalText);
    if (d.nnue === false) note.push('⚠ 未启用 NNUE');
    // 跑过后台思考之后引擎的棋盘必然要整盘重置（见 rapfi.js 的 _boardDirty）——
    // 那是正常的，不该提示。只有**没跑后台思考却还要重置**才值得看一眼。
    // 预备命中 = 这一手在对手思考时就算好了，0ms 直出
    if (d.prepared) note.unshift('超前思考命中 · ' + d.depth + ' 层 · 当时算了 ' + d.preparedMs + 'ms');
    // 记忆命中 = 以前某一局在同一个局面上算过，这次 0ms 直出
    // 记忆命中。**战绩只作展示** —— 选这一手靠的是分析深度，胜负不参与决策
    // （为此输过一局，见 tools/memo.js 顶部）。
    if (d.source === 'memo') note.unshift('记忆命中 · ' + d.memoDepth + ' 层 · 当时算了 ' +
      d.memoMs + 'ms（战绩 ' + d.memoW + ' 胜 ' + d.memoL + ' 负，仅供参考）');
    // 绝境搏命：必输局面里换了一手更难被走对的防守
    if (d.swindle) note.unshift(d.swindle.kept
      ? '搏命 · 试了 ' + d.swindle.tried + ' 手，原手最顽强'
      : '搏命换手 · ' + d.swindle.reason + '（试了 ' + d.swindle.tried + ' 手）');
    if (d.source === 'book' && d.bookNote) note.unshift(d.bookNote);
    if (!d.incremental && !d.afterPonder) note.push('局面重置');
    return {
      move: Core.xyToP(d.x, d.y),
      source: d.source === 'memo' ? 'memo' : d.source === 'book' ? 'book' : 'rapfi',
      score: d.mate ? (d.mate > 0 ? 9999000 : -9999000) : Math.round((d.eval || 0) * 100),
      depth: d.depth || 0, nodes: d.nodes || 0,
      timeMs: waited != null ? waited : (d.ms || 0),
      engineMs: d.ms || 0, ponderMs: 0,
      // 服务端的耗时拆解。慢手时这是唯一能定位的东西 ——
      // 只记引擎自报的搜索时间会漏掉建会话、排队等一大段。
      timing: d.timing || null,
      // 等这一手的过程中标签页是否进过后台（浏览器会冻结后台标签页）
      tabHidden: !!d.tabHidden,
      // 绝境搏命换手的记录，要进日志（log.js 那边也是白名单）
      swindle: d.swindle || null,
      note: note.join(' · '),
      // Rapfi 打印的 PV 标签行号方向和我们相反（它叫 G1 的点我们叫 G12），
      // 所以显示前必须按 (x,y) 重排成我们的标签，否则复盘时会照着错坐标找棋。
      pv: (d.pvXY || []).map(function (q) { return Core.pToLabel(Core.xyToP(q[0], q[1])); }),
      trace: d.lines || []
    };
  }

  /**
   * **别让浏览器冻结这个标签页。**
   *
   * 录完对手的着法你很可能切去别的窗口 —— 标签页一进后台，
   * Chrome 会限流定时器、闲置几分钟后冻结整个页面。结果是服务端 1.5 秒就把
   * 答案算好发回来了，页面却要等你切回来才处理。实战量到过 27 秒，
   * 那一局因此来不及应对输掉了。
   *
   * Chrome 对「正在发声」的标签页不限流也不冻结，所以这里挂一个听不见的
   * 音频源：一个振荡器 + 极低增益，没有音频文件，CPU 和内存都可以忽略。
   * 浏览器的自动播放策略要求先有用户交互，所以等第一次点击/按键再启动。
   */
  var keepAwake = { ctx: null, on: false };
  function startKeepAwake() {
    if (keepAwake.on) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      var ctx = new AC();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      // 0 有可能被浏览器判定为"没在出声"，给一个听不见但确实存在的值
      gain.gain.value = 0.0001;
      osc.frequency.value = 30;                 // 次低频，扬声器基本发不出来
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start();
      if (ctx.state === "suspended") ctx.resume();
      keepAwake.ctx = ctx; keepAwake.on = true;
    } catch (e) { /* 拿不到音频就算了，不影响下棋 */ }
  }
  if (typeof document === "object" && document.addEventListener) {
    document.addEventListener("pointerdown", startKeepAwake, { once: false });
    document.addEventListener("keydown", startKeepAwake, { once: false });
  }

  function rapfiMove(role, opts, cb) {
    // 瞬时战术和开局库都是**按无禁手规则**做出来的：instantTactic 把长连也当成五，
    // 棋谱库 / 引擎裁定全是 RULE 0 下造的（book-rapfi.js 没设过规则）。
    // 换成「标准」（长连不算赢）或「连珠」（黑长连是禁手）时，这两层都可能给出错棋，
    // 所以只在无禁手下启用，其余规则全交给 Rapfi —— 它按当前规则算，这种局面几十毫秒就出手。
    var freestyle = parseInt($('selRule').value, 10) === 0;
    // 不需要搜索就能定下来的两种局面（我方成五 / 挡对方的四）直接出手，
    // 不走引擎往返。**放在开局库之前**：万一棋谱里混进劣着也不会漏挡。
    var quick = freestyle ? Eng.instantTactic(board, role) : null;
    if (quick && board.cells[quick.move] === EMPTY) {
      cb({ move: quick.move, source: "tactic", score: quick.score, depth: 0, nodes: 0,
           timeMs: 0, ponderMs: 0, note: quick.note });
      return;
    }
    // 开局库永远排在引擎前面。Rapfi 作为比赛引擎不许带库，所以得我们在外面查 ——
    // 这也正是「开局一路不长考」的全部来源，是这个项目真正在积累的东西。
    //
    // **但它要先过一遍实战记忆库。** 原先这里命中就直接出手、根本不问服务端，
    // 于是「这手走输过」这条信息对棋谱库完全失效 —— 而实战输掉那一局，
    // 第 2、4 手恰恰都是棋谱库给的。现在把候选带给服务端裁决：
    // 没被否决就原样回来（还是 0ms，多的只是一次本地往返），否决了就当场换招。
    var bookHit = null;
    if (opts.useBook && book && freestyle) {
      var hit = book.lookup(board, role, 0);
      // **12 路的统计条目不能压过 Rapfi。** 它们来自早期自研 JS 引擎的自对弈
      // （data/records12），2026-09-23 实战命中 12 次，只有 3 次和 Rapfi 一致：
      // 4 次把 Rapfi 已证明的必胜换成了非必胜（+M33 -> -M29、+M27 -> 39 …），
      // 2 次把均势走坏两三百分。那些条目「5 局 · 胜率 30%」照样被当成最佳着法直出。
      // 裁定条目（kind=verdict）是 Rapfi 自己算的，不受影响。
      // 15 路的统计库混有 Gomocup 顶级引擎棋谱、又没有裁定可替代，没有实测前不动。
      if (hit && hit.kind !== 'verdict' && size() === 12) hit = null;
      if (hit && board.cells[hit.move] === EMPTY) bookHit = hit;
    }
    var bookNote = bookHit && (bookHit.kind === 'verdict'
      ? 'Rapfi 裁定 · ' + bookHit.depth + ' 层 · 当时算了 ' + Math.round(bookHit.ms / 1000) + ' 秒'
      : bookHit.games + ' 局棋谱 · 胜率 ' + Math.round(bookHit.winRate * 100) + '%');
    // 服务端不通的时候照旧本地直出 —— 不能因为多了一道关卡就不会下棋了
    if (bookHit && !rapfi.ready) {
      cb({ move: bookHit.move, source: 'book', score: 0, depth: 0, nodes: 0,
           timeMs: 0, ponderMs: 0, note: bookNote });
      return;
    }
    // 从这里开始计时：日志要记的是**你真正等了多久**，不是引擎自报的搜索时间。
    // 两者差得不少 —— 中间还有 HTTP 往返、会话创建、收掉预备。
    var askedAt = Date.now();
    // **这一手期间标签页有没有进过后台。**
    // 录完对手的着法你很可能切去别的窗口，而浏览器一旦把标签页
    // 转入后台就会限流、甚至冻结 —— 服务端早把答案发回来了，页面却不处理。
    // 实战抓到过服务端 1.5 秒、浏览器 27 秒。所以要把这件事记下来。
    var wentHidden = (typeof document === "object" && document.hidden) || false;
    var onVis = function () { if (document.hidden) wentHidden = true; };
    if (typeof document === "object" && document.addEventListener)
      document.addEventListener("visibilitychange", onVis);
    var seq = ++workerSeq;
    var hist = moves.slice(0, viewLen).map(function (p) { return [Core.pToX(p), Core.pToY(p)]; });
    // **服务器迟迟不回话时的保险。** 以前这里没有超时 —— 服务器一旦卡住（实测过事件循环
    // 被堵 5 秒、13 秒），界面就一直等，读秒制下等于直接输棋。
    // 过了上限再多给 2.5 秒还没答复，这一手就交给自研引擎快速出手。
    // 只影响这一手：不把 rapfi.ready 置假，下一手照常找 Rapfi（晚到的答复靠 seq 作废）。
    var capMs = opts.timeMax || 6000;
    var guard = setTimeout(function () {
      if (seq !== workerSeq) return;
      if (typeof document === "object" && document.removeEventListener)
        document.removeEventListener("visibilitychange", onVis);
      var o = {};
      for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
      o.timeMax = Math.min(o.timeMax || 1500, 1500);
      o.timeMin = Math.min(o.timeMin || 300, 300);
      var waited = Date.now() - askedAt;
      jsMove(role, o, function (r) {
        r.note = '⚠ 服务器 ' + (waited / 1000).toFixed(1) + ' 秒没回话，这手改用自研引擎' +
                 (r.note ? ' · ' + r.note : '');
        r.timeMs = Date.now() - askedAt;
        cb(r);
      });
    }, capMs + 2500);
    fetch(rapfi.base + '/engine/move', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gid: rapfi.gid, size: size(), moves: hist,
        ms: opts.timeMax || 6000,
        rule: parseInt($('selRule').value, 10),
        swindle: $('chkSwindle').checked,
        // 棋谱库的候选交给服务端裁决（见上面 bookHit 的注释）。
        // **要带上它背后算了多久** —— 服务端拿它和记忆库比分析深度，谁深听谁的。
        book: bookHit ? [Core.pToX(bookHit.move), Core.pToY(bookHit.move)] : null,
        bookNote: bookNote || '',
        bookDepth: (bookHit && bookHit.depth) || 0,
        bookMs: (bookHit && bookHit.ms) || 0,
        // 用时风格：Rapfi 的自适应用时只在「比赛总时限吃紧」时才启用，
        // 所以这里发一个合成的总时限倍数过去（0 = 关掉，每手都想满）。
        pace: parseFloat($('selPace').value)
      })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (seq !== workerSeq) return;              // 期间局面变了（或已超时改用自研引擎），结果作废
      clearTimeout(guard);
      if (d.error) throw new Error(d.error);
      if (typeof document === "object" && document.removeEventListener)
        document.removeEventListener("visibilitychange", onVis);
      var res = rapfiResult(d, Date.now() - askedAt);
      res.tabHidden = wentHidden;
      cb(res);
    }).catch(function (e) {
      if (seq !== workerSeq) return;
      clearTimeout(guard);
      // 引擎这条路断了就退回自研引擎，绝不能让界面卡住不出手
      rapfi.ready = false;
      rapfi.note = '⚠ Rapfi 调用失败（' + e.message + '），已临时退回 JS 引擎';
      showEngineNote();
      jsMove(role, opts, cb);
    });
  }

  function requestMove(role, opts, cb) {
    if (engineMode() === 'rapfi' && rapfi.ready) { rapfiMove(role, opts, cb); return; }
    jsMove(role, opts, cb);
  }

  function jsMove(role, opts, cb) {
    if (worker) {
      workerSeq++;
      workerCb = cb;
      // 发给所有线程：副线程搜同一个局面，把深层结论灌进共享表，主线程跟着受益。
      // 只有主线程（smp=0）的结果会被采用，所以副线程怎么搜都不影响正确性。
      postAll({
        type: 'move', id: workerSeq, size: size(),
        history: moves.slice(0, viewLen),
        role: role, opts: opts
      });
    } else {
      var o = {};
      for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
      o.timeMax = FILE_MODE_CAP;          // 主线程模式，别把页面冻太久
      var seq = ++workerSeq;
      setTimeout(function () {
        if (seq !== workerSeq) return;    // 期间局面变了，结果作废
        cb(engine.bestMove(board, role, o));
      }, 16);
    }
  }
  function cancelPending() {
    workerSeq++; workerCb = null; thinking = false; stopThinkClock();
    // worker 收到任何非 ponder 消息都会停掉后台思考，所以这里随便发一条就行
    postAll({ type: 'stopPonder' });
  }

  /**
   * 让引擎在等对手落子的这段时间里继续想（pondering / 常驻思考）。
   *
   * 实战里这段空闲特别长 —— 等对手思考、再把他的着法录进来，
   * 十几二十秒很常见，比 AI 自己的思考时间还长，闲着是纯浪费。
   * 注意 Gomocup 明文禁止这个功能（比赛时引擎会被管理器挂起），
   * 所以竞赛引擎都不带 —— 而我们没有这个限制，这是白捡的优势。
   *
   * 只在有 Worker 时开。file:// 降级模式下引擎跑在主线程上，
   * 后台思考会把界面卡死，那还不如不想。
   */
  function startPonder() {
    // 暂停时连预备也不能开：这会儿的局面是用户正在改的半成品，
    // 拿它去算等于把 24 个核浪费在一个马上就会变的局面上。
    if (paused || setupMode) return;
    // Rapfi 模式下后台思考在服务端做，这里再让 JS 引擎空转只会白占 CPU、
    // 拖慢真正在算的那个内核。
    //
    // 但有一种情况必须我们显式喊一声：**上一手是查棋谱库直出的**。
    // 那一手 Rapfi 根本没参与，它自带的常驻思考也就没启动，
    // 对手思考的那段时间会整段浪费掉 —— 实战里那常常有十几二十秒。
    if (engineMode() === 'rapfi' && rapfi.ready) {
      if (winner || thinking || viewLen !== moves.length || isAiTurn()) return;
      if (!$('chkPonder').checked) return;
      var hist = moves.slice(0, viewLen).map(function (p) { return [Core.pToX(p), Core.pToY(p)]; });
      // 档位直接带过去：width = 预备对手的前几手，ms = 每条预备线路的思考预算。
      // 服务端做的不是「空转热置换表」，是把我们的应手逐条算好存起来
      //（见 tools/prepare.js）。旧做法实测净负收益：慢 23%、浅 4.2 层。
      fetch(rapfi.base + '/engine/ponder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gid: rapfi.gid, size: size(), moves: hist,
          rule: parseInt($('selRule').value, 10),
          width: parseInt($('selPrep').value, 10),
          ms: parseInt($('selThink').value, 10)
        })
      }).catch(function () {});
      return;
    }
    if (!worker || winner || thinking) return;
    if (!$('chkPonder').checked) return;
    if (viewLen !== moves.length) return;        // 复盘中途，当前局面不是实战局面
    if (isAiTurn()) return;                      // 该我们走了，马上就要真搜，不用预热
    postAll({
      type: 'ponder', size: size(),
      history: moves.slice(0, viewLen),
      role: currentTurn(), opts: levelOpts()
    });
  }

  // ---------- 局面维护 ----------
  function turnOf(n) { return n % 2 === 0 ? BLACK : WHITE; }
  /**
   * 摆局模式：点棋盘交替落黑白，AI 不出手、不记决策。
   * 摆好之后由用户指定 AI 执哪边，再转回正常对局。
   */
  var setupMode = false;

  /**
   * 暂停思考。**这是给「真实棋盘和这里对不上」准备的。**
   * 实战里会出现：我在真棋盘上落错了子，要退回两手重下，可对局那边时间还在走，
   * 而每退一步、每补一步引擎都要重算一遍 —— 等它算完时间早没了。
   * 暂停之后棋盘随便改（点棋盘、悔棋、上一步下一步、整局导入都行），
   * 引擎一步都不想；摆到真实局面再开，该我们走就走，不该走就等对手并开始预备。
   */
  var paused = false;

  function currentTurn() { return turnOf(viewLen); }
  function isAiTurn() { return currentTurn() === aiColor; }

  /** 把棋盘重放到 viewLen 手，并重算胜负 */
  function rebuild() {
    board.reset();
    for (var i = 0; i < viewLen; i++) board.put(moves[i], turnOf(i));
    winner = board.lastMoveWins() ? board.cells[moves[viewLen - 1]] : 0;
    winLine = winner ? findWinLine() : null;
    hintMove = -1;
  }

  function findWinLine() {
    var p = moves[viewLen - 1];
    if (p === undefined) return null;
    var role = board.cells[p];
    for (var d = 0; d < 4; d++) {
      var step = Core.DIRS[d], line = [p], q;
      for (q = p - step; board.cells[q] === role; q -= step) line.unshift(q);
      for (q = p + step; board.cells[q] === role; q += step) line.push(q);
      if (line.length >= 5) {
        var at = line.indexOf(p);
        var start = Math.max(0, Math.min(at - 4, line.length - 5));
        return line.slice(start, start + 5);
      }
    }
    return null;
  }

  /**
   * 落一手。如果当前正在复盘中途，后面的着法会被截掉 ——
   * 也就是「从这里改走别的」，和打谱软件的行为一致。
   */
  function playMove(p) {
    if (winner || p < 0 || board.cells[p] !== EMPTY) return false;
    cancelPending();
    moves.length = viewLen;
    moves.push(p);
    viewLen++;
    rebuild();
    syncLog();
    render();
    maybeAutoMove();
    startPonder();          // 轮到对手了就开始预热；该我们走时它会自己跳过
    return true;
  }

  /** 把当前棋谱和胜负同步进日志。凡是改动 moves 的地方都要调一次。 */
  function syncLog() {
    if (!rec) return;
    // 胜负和棋谱一起报（见 log.js 的 sync），分两次报会在服务端互相覆盖
    rec.sync(moves.map(Core.pToLabel), winner ? (winner === aiColor ? 'AI 胜' : '对手胜') : '');
    setTimeout(renderLogInfo, 300);   // 上报是异步的，等一下再看结果
  }

  /**
   * 把日志落到哪儿显示出来。
   * 踩过的坑：服务器版本旧、没有 /log 路由时，上报拿到 404 就**静默**退回 localStorage，
   * 用户一路打完十几局才发现日志没入库，还得手动把下载的文件拖进 logs/。
   * 状态摆在界面上，这种事一眼就能看见。
   */
  function renderLogInfo() {
    var el = $('logInfo');
    if (!el || !rec) return;
    if (rec.endpoint) {
      el.className = 'logInfo';
      el.textContent = '✓ 自动写入 logs/';
    } else if (rec.serverOk === false) {
      el.className = 'logInfo bad';
      el.textContent = '⚠ 未连上服务器，暂存浏览器（' + rec.countLocal() + ' 局）· 请重启 npm start';
    } else {
      el.className = 'logInfo';
      el.textContent = '日志检测中…';
    }
  }

  function gotoPly(n) {
    n = Math.max(0, Math.min(moves.length, n));
    if (n === viewLen) return;
    cancelPending();
    viewLen = n;
    rebuild();
    render();
    startPonder();
  }

  // ---------- 绘制 ----------
  function px(x) { return MARGIN + x * cell(); }

  function draw() {
    var g = ctx.createLinearGradient(0, 0, LOGICAL, LOGICAL);
    g.addColorStop(0, '#e8c48c');
    g.addColorStop(.5, '#dfb475');
    g.addColorStop(1, '#d3a262');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, LOGICAL, LOGICAL);

    ctx.save();
    ctx.globalAlpha = .05;
    ctx.strokeStyle = '#6b4520';
    for (var i = 0; i < 70; i++) {
      ctx.beginPath();
      var yy = (i * 10.3) % LOGICAL;              // 固定纹理，避免重绘闪烁
      ctx.lineWidth = (i % 5) * .35 + .3;
      ctx.moveTo(0, yy);
      ctx.bezierCurveTo(LOGICAL * .3, yy + 5, LOGICAL * .7, yy - 5, LOGICAL, yy + 2);
      ctx.stroke();
    }
    ctx.restore();

    ctx.strokeStyle = 'rgba(70,44,18,.72)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var k = 0; k < size(); k++) {
      ctx.moveTo(px(0), px(k)); ctx.lineTo(px(size() - 1), px(k));
      ctx.moveTo(px(k), px(0)); ctx.lineTo(px(k), px(size() - 1));
    }
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeRect(px(0), px(0), cell() * (size() - 1), cell() * (size() - 1));

    ctx.fillStyle = 'rgba(60,36,12,.85)';
    starPoints().forEach(function (s) {
      ctx.beginPath(); ctx.arc(px(s[0]), px(s[1]), 3.6, 0, 6.2832); ctx.fill();
    });

    ctx.fillStyle = 'rgba(70,44,18,.66)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (var c = 0; c < size(); c++) {
      ctx.fillText(COLS[c], px(c), LOGICAL - 16);
      ctx.fillText(String(size() - c), 18, px(c));
    }

    if (hintMove >= 0 && board.cells[hintMove] === EMPTY) {
      ctx.save();
      ctx.strokeStyle = '#2f7d4f'; ctx.lineWidth = 2.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(px(Core.pToX(hintMove)), px(Core.pToY(hintMove)), cell() * .42, 0, 6.2832);
      ctx.stroke();
      ctx.restore();
    }

    if (hover >= 0 && !thinking && !winner && board.cells[hover] === EMPTY) {
      ctx.save();
      ctx.globalAlpha = .34;
      stone(Core.pToX(hover), Core.pToY(hover), currentTurn());
      ctx.restore();
    }

    var showNum = $('chkNum').checked;
    for (var n = 0; n < viewLen; n++) {
      var p = moves[n];
      var x = Core.pToX(p), y = Core.pToY(p);
      stone(x, y, board.cells[p]);
      if (showNum) {
        ctx.fillStyle = board.cells[p] === BLACK ? 'rgba(255,255,255,.82)' : 'rgba(20,20,20,.75)';
        ctx.font = '600 ' + Math.round(cell() * .36) + 'px system-ui, sans-serif';
        ctx.fillText(String(n + 1), px(x), px(y));
      }
    }

    // 最后一手必须一眼就能找到 —— 这是对局中最要紧的一个视觉信息。
    // 早期版本画的是 cell*0.16 的细红圈（46px 格子上只有 7px），压在黑子上几乎看不见，
    // 而且一开「显示手数」就整个不画了。现在改成整子外圈 + 四角准星，
    // 并且**不再受显示手数影响**（准星在子外，和中间的手数不打架）。
    var lastP = moves[viewLen - 1];
    if (lastP !== undefined) {
      markLast(lastP, turnOf(viewLen - 1) === aiColor);
    }

    // 复盘到中途时，把「后面还有几手」轻轻标出来，避免以为棋谱丢了
    if (viewLen < moves.length) {
      ctx.save();
      ctx.globalAlpha = .28;
      for (var m = viewLen; m < moves.length; m++) {
        var q = moves[m];
        ctx.beginPath();
        ctx.arc(px(Core.pToX(q)), px(Core.pToY(q)), cell() * .13, 0, 6.2832);
        ctx.fillStyle = turnOf(m) === BLACK ? '#000' : '#fff';
        ctx.fill();
      }
      ctx.restore();
    }

    if (winLine) {
      ctx.save();
      ctx.strokeStyle = 'rgba(217,83,79,.92)';
      ctx.lineWidth = 5; ctx.lineCap = 'round';
      var a = winLine[0], b = winLine[winLine.length - 1];
      ctx.beginPath();
      ctx.moveTo(px(Core.pToX(a)), px(Core.pToY(a)));
      ctx.lineTo(px(Core.pToX(b)), px(Core.pToY(b)));
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * 标出最后一手：整子外圈 + 四角准星。
   * 颜色区分是谁走的 —— 对局中最常问的一句就是「AI 刚才走的是哪个」。
   * 每一笔都先用深色粗描一遍垫底再压上亮色，这样在黑子、白子、木纹背景上都看得清。
   */
  function markLast(p, byAi) {
    var cx = px(Core.pToX(p)), cy = px(Core.pToY(p));
    // 半径取 0.50 格：棋子是 0.44，邻子边缘在 0.56 处，光环加描边刚好塞得下
    var r = cell() * .50;
    var color = byAi ? '#2bff9e' : '#ffab3d';  // AI 青绿 / 对手琥珀
    var k = glowPhase();                       // 0~1 的呼吸相位

    ctx.save();
    // 发光靠 shadowBlur：它会把描边往外晕开，比画一堆同心圆自然得多。
    // 描三遍是为了把光晕叠厚 —— canvas 的阴影单遍太淡。
    ctx.shadowColor = color;
    ctx.shadowBlur = 14 + 12 * k;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.globalAlpha = .5 + .5 * k;
    for (var i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 6.2832);
      ctx.stroke();
    }
    // 最后压一圈不带阴影的实线，保证光晕之外还有清晰的边界
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 6.2832);
    ctx.stroke();
    ctx.restore();
  }

  // ---------- 发光的呼吸动画 ----------
  // 静态的标记再亮也会被忽略（实测根本注意不到），所以让它缓慢明暗。
  // 相位只跟时钟走，不依赖动画循环 —— 于是没有 requestAnimationFrame 的环境
  //（比如 test-ui.js 的 DOM 桩）照样能画出一个合法的静态光环。
  var GLOW_MS = 1700;
  function glowPhase() {
    return .5 - .5 * Math.cos(Date.now() % GLOW_MS / GLOW_MS * 6.2832);
  }

  var glowRaf = 0;
  function pumpGlow() {
    glowRaf = 0;
    if (typeof requestAnimationFrame !== 'function') return;
    if (!moves.length || viewLen < 1) return;       // 没有「最后一手」就不用动
    if (document.hidden) return;                    // 页面在后台就别空转
    draw();
    glowRaf = requestAnimationFrame(pumpGlow);
  }
  function startGlow() {
    if (glowRaf || typeof requestAnimationFrame !== 'function') return;
    glowRaf = requestAnimationFrame(pumpGlow);
  }
  // 切回前台要重新点火：pumpGlow 在页面隐藏时会主动收工，不然是在后台空转
  if (document.addEventListener) {
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) startGlow();
    });
  }

  function stone(x, y, role) {
    var cx = px(x), cy = px(y), r = cell() * .44;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx + 1, cy + 2, r, 0, 6.2832);
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    ctx.fill();
    var g = ctx.createRadialGradient(cx - r * .35, cy - r * .4, r * .12, cx, cy, r);
    if (role === BLACK) { g.addColorStop(0, '#5a5a5a'); g.addColorStop(.55, '#1d1d1d'); g.addColorStop(1, '#000'); }
    else { g.addColorStop(0, '#ffffff'); g.addColorStop(.6, '#efeae3'); g.addColorStop(1, '#c6bfb5'); }
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 6.2832);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  }

  // ---------- 面板 ----------
  function startThinkClock() {
    var t0 = Date.now();
    thinkMsg = '电脑思考中…';
    clearInterval(thinkTimer);
    thinkTimer = setInterval(function () {
      var s = (Date.now() - t0) / 1000;
      thinkMsg = s < 0.8 ? '电脑思考中…' : '电脑思考中… ' + s.toFixed(1) + ' 秒';
      if (thinking) renderStatus();
    }, 200);
  }
  function stopThinkClock() { clearInterval(thinkTimer); thinkTimer = 0; thinkMsg = ''; }

  function renderStatus() {
    var turn = currentTurn();
    var dot = $('turnDot'), txt = $('turnText'), bar = $('resultBar');

    // 结算只是一条横幅，不挡棋盘、不打断复盘
    if (winner) {
      bar.hidden = false;
      var aiWon = winner === aiColor;
      bar.className = 'resultBar ' + (aiWon ? 'win' : 'lose');
      bar.textContent = (aiWon ? '✓ AI 胜' : '✗ 对手胜') + ' · 共 ' + viewLen + ' 手' +
        (viewLen < moves.length ? '（复盘中）' : '');
    } else if (viewLen >= size() * size()) {
      bar.hidden = false;
      bar.className = 'resultBar';
      bar.textContent = '和棋 · 棋盘已满';
    } else {
      bar.hidden = true;
    }

    dot.className = 'dot ' + (turn === BLACK ? 'black' : 'white');
    txt.textContent = paused ? '⏸ 已暂停 · 引擎不思考'
      : thinking ? (thinkMsg || 'AI 思考中…')
      : winner ? '对局结束'
      : (turn === aiColor ? '轮到 AI' : '轮到对手') +
        '（' + (turn === BLACK ? '黑' : '白') + '）';

    $('seatInfo').textContent = 'AI 执' + (aiColor === BLACK ? '黑' : '白') +
      ' · 对手执' + (aiColor === BLACK ? '白' : '黑');

    $('entryHint').textContent = winner
      ? '对局已结束。想从某一手改下法，先用 ◀ 回到那一步。'
      : isAiTurn()
        ? '现在轮到 AI。若你已替它落子，也可直接在这里补录。'
        : '对手落子后，在这里输入坐标回车';

    $('btnUndo').disabled = thinking || viewLen < 1;
    $('btnPlay').disabled = thinking || !!winner;
    $('inpMove').disabled = !!winner;
    $('navPos').textContent = viewLen + ' / ' + moves.length;
    $('navFirst').disabled = $('navPrev').disabled = viewLen === 0;
    $('navNext').disabled = $('navLast').disabled = viewLen >= moves.length;
  }

  /** AI 着法的大字显示 —— 对局时就看这一个地方 */
  function showAnswer(r) {
    $('aiMove').textContent = Core.pToLabel(r.move);
    $('aiMove').className = 'aiMove live';
    var SRC = { book: '开局库', tactic: '棋形', vcf: 'VCF算杀', vct: 'VCT算杀',
                search: '搜索', opening: '定式', rapfi: 'Rapfi', memo: '实战记忆' };
    $('aiMeta').textContent = '第 ' + (viewLen + 1) + ' 手 · ' + (SRC[r.source] || r.source) +
      (r.note ? ' · ' + r.note : '') +
      ((r.source === 'search' || r.source === 'rapfi') && r.depth ? ' · ' + r.depth + ' 层' : '') +
      ' · ' + (r.timeMs / 1000).toFixed(1) + ' 秒';
    // 后台思考白捡了多少 —— 没有这个数字就不知道这功能到底有没有在起作用
    if (r.ponderMs > 200) {
      $('aiMeta').textContent += '  ·  后台已预热 ' + (r.ponderMs / 1000).toFixed(1) + ' 秒';
    }
    $('mTime').textContent = r.timeMs;
    $('mNodes').textContent = r.nodes > 9999 ? (r.nodes / 1000).toFixed(1) + 'k' : r.nodes;
    $('mSource').textContent = SRC[r.source] || r.source;
  }

  function renderMoves() {
    var ol = $('moveList');
    ol.innerHTML = '';
    for (var i = 0; i < moves.length; i++) {
      var li = document.createElement('li');
      li.className = (i % 2 === 0 ? 'b' : '') +
                     (i === viewLen - 1 ? ' last' : '') +
                     (i >= viewLen ? ' future' : '');
      li.textContent = (i + 1) + '. ' + Core.pToLabel(moves[i]);
      li.title = '跳到这一手';
      (function (idx) {
        li.addEventListener('click', function () { gotoPly(idx + 1); });
      })(i);
      ol.appendChild(li);
    }
    ol.scrollTop = ol.scrollHeight;
  }

  // 注意：呼吸动画只能从 render 这个「事件驱动入口」点火。
  // pumpGlow 里调的是 draw() 而不是 render()，否则会自己给自己再点一次火，
  // 变成每帧多开一条 rAF 链。
  function render() { draw(); renderStatus(); renderMoves(); startGlow(); }

  // ---------- 电脑走子 ----------
  function levelOpts() {
    // bookRandom 恒为 0：对局要的是最优着法。
    // 「开局多样化」只在造训练棋谱时有意义（见 tools/selfplay.js 的 --explore），
    // 摆在对战界面上纯粹是拿正确率换花样，已经去掉。
    var o = {
      level: $('selLevel').value,
      useBook: $('chkBook').checked && !!book,
      bookRandom: 0,
      trace: true                  // 记思维链，开销只有一个小数组
    };
    var cap = parseInt($('selThink').value, 10);
    if (cap > 0) o.timeMax = cap;      // 对着比赛的读秒设上限，别把时间用超
    return o;
  }

  function aiMove() {
    // **暂停要拦在这里，不能只拦 maybeAutoMove。** 自动应手是 setTimeout 排队的，
    // 用户前脚按下暂停、后脚那条已经排进队列的着法照样会落下去 ——
    // 而暂停的全部意义就是「这会儿棋盘归我改」。
    if (paused || setupMode) return;
    if (winner || thinking) return;
    thinking = true;
    startThinkClock();
    renderStatus();
    draw();
    var role = currentTurn();
    requestMove(role, levelOpts(), function (r) {
      thinking = false;
      stopThinkClock();
      // **对称等价的几手里随机挑一个。** 不管这手来自开局库、记忆库还是 Rapfi，
      // 只要局面本身是对称的（12 路空盘、15 路对手下在天元……），落在对称位置上的
      // 几手价值严格相等（见 Core.symmetricMoves）。以前每次都走同一个点，
      // 对手很容易摸清我们的套路；现在换个方向走，棋力零损失。
      // 查库和记忆库都按对称规范化后的局面存，换了方向照样命中。
      if (r && r.move >= 0 && board.cells[r.move] === EMPTY) {
        var eq = Core.symmetricMoves(board, r.move);
        if (eq.length > 1) {
          r.move = eq[Math.floor(Math.random() * eq.length)];
          r.note = (r.note ? r.note + ' · ' : '') + '对称等价 ' + eq.length + ' 选 1';
        }
      }
      // 先记决策再落子：playMove 里的 syncLog 会把它一起写盘
      if (rec) {
        var ent = rec.decide(viewLen + 1, role, r, Core.pToLabel);
        if (ent && ent.flags) console.warn('[对局日志] 第 ' + ent.ply + ' 手异常: ' +
                                           ent.flags.join('；') + ' — ' + ent.stop);
      }
      showAnswer(r);
      // **引擎给了一手已经有子的点。** 这里原先是 `return` —— 界面一声不吭地
      // 什么都不做，AI 整手消失，而日志上一行已经把这手记下了。
      // 于是事后看到的是「日志写 C10、棋盘上是 B10」，根本无从查起（踩过，还输了一局）。
      // 现在：喊出来、记进日志、并且退回自研引擎兜底，绝不让 AI 哑火。
      if (board.cells[r.move] !== EMPTY) {
        var why = '引擎返回了已有子的点 ' + Core.pToLabel(r.move) + '（来源 ' + r.source + '），已改用自研引擎';
        console.error('[出手]' + why);
        if (rec) rec.flag(viewLen + 1, why);
        rapfi.note = '⚠ ' + why;
        showEngineNote();
        jsMove(role, levelOpts(), function (r2) {
          if (rec) rec.decide(viewLen + 1, role, r2, Core.pToLabel);
          showAnswer(r2);
          if (board.cells[r2.move] === EMPTY) playMove(r2.move);
          else renderStatus();
        });
        return;
      }
      var atPly = viewLen + 1;
      // **playMove 会静默返回 false**（棋局已结束、点位被占等），而上一行已经把
      // 这条决策记进日志了 —— 不检查返回值的话，日志里会留下一条「决定了却没落子」
      // 的幽灵记录。事后看到的就是「日志写 C10、棋盘上是 B10」，完全无从查起。
      if (!playMove(r.move)) {
        var why = "决策 " + Core.pToLabel(r.move) + " 没能落子（playMove 拒绝）";
        console.error("[出手] " + why);
        if (rec) rec.flag(atPly, why);
        renderStatus();
        return;
      }
      // 回填「实际落的是什么」。decide() 记的是引擎的决定，这里记的是棋盘的结果。
      if (rec) rec.played(atPly, Core.pToLabel(r.move));
      // 落完就把焦点还给录入框：对手一走完就能直接打字，不用再摸鼠标。
      // **触屏设备上不能这么做** —— 聚焦文本框会弹出虚拟键盘，
      // 于是每走一手键盘就蹦一次，把棋盘挤掉半屏。手机上等用户自己点输入框。
      var inp = $('inpMove');
      if (inp.focus && !winner && !isTouch()) inp.focus();
    });
  }

  /** 轮到电脑、且开着自动应手、且不是在复盘中途，才自动落子 */
  function maybeAutoMove() {
    if (setupMode) return;          // 摆局时 AI 不插手
    if (paused) return;             // 暂停中：棋盘随便改，引擎不动
    if (!$('chkAuto').checked) return;
    if (winner || thinking) return;
    if (viewLen !== moves.length) return;
    if (!isAiTurn()) return;
    setTimeout(aiMove, 20);
  }

  // ---------- 交互 ----------
  function pointAt(ev) {
    var rect = canvas.getBoundingClientRect();
    var scale = LOGICAL / rect.width;
    var mx = (ev.clientX - rect.left) * scale;
    var my = (ev.clientY - rect.top) * scale;
    var x = Math.round((mx - MARGIN) / cell());
    var y = Math.round((my - MARGIN) / cell());
    if (x < 0 || y < 0 || x >= size() || y >= size()) return -1;
    if (Math.hypot(mx - px(x), my - px(y)) > cell() * .52) return -1;
    return Core.xyToP(x, y);
  }

  canvas.addEventListener('mousemove', function (ev) {
    var p = pointAt(ev);
    if (p !== hover) { hover = p; draw(); }
  });
  canvas.addEventListener('mouseleave', function () {
    if (hover !== -1) { hover = -1; draw(); }
  });
  canvas.addEventListener('click', function (ev) {
    if (thinking) return;
    var p = pointAt(ev);
    if (p < 0 || board.cells[p] !== EMPTY) return;
    hover = -1;
    // 摆局模式下点哪落哪，交替黑白，不触发 AI，也不判胜负 ——
    // 摆的可能正是一个已经有五连的残局，判胜负会把摆局中途打断。
    if (setupMode) { setupPlace(p); return; }
    if (winner) return;
    // 暂停时点棋盘一样落子（playMove 本来就按 currentTurn 交替），
    // 只是 maybeAutoMove/startPonder 会自己跳过 —— 这正是「随便改」要的效果。
    playMove(p);
  });

  // ---------- 录入框：单手坐标，或整局棋谱 ----------
  var TOKEN_RE = /([a-oA-O])\s*(1[0-5]|[1-9])(?![0-9])/g;
  function parseMoves(text) {
    var out = [], m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text))) {
      var p = Core.labelToP(m[1] + m[2]);
      if (p >= 0) out.push(p);
    }
    return out;
  }

  function flashEntry(bad) {
    var el = $('inpMove');
    el.className = bad ? 'bad' : '';
    if (bad) setTimeout(function () { el.className = ''; }, 900);
  }

  // 对手着法：只吃单手坐标，打完回车立刻落子
  $('inpMove').addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    var text = this.value.trim();
    if (!text) return;
    var list = parseMoves(text);
    if (list.length !== 1 || !playMove(list[0])) { flashEntry(true); return; }
    this.value = '';
    flashEntry(false);
  });

  // 整局导入：把对手那边已经下过的棋一次接过来
  $('inpLoad').addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    var list = parseMoves(this.value);
    if (!list.length) { this.className = 'bad'; return; }
    cancelPending();
    var probe = new Core.Board(), ok = [];
    for (var i = 0; i < list.length; i++) {
      if (probe.cells[list[i]] !== EMPTY) break;        // 遇到非法着法就停在这
      probe.put(list[i], turnOf(i));
      ok.push(list[i]);
      if (probe.lastMoveWins()) break;
    }
    if (!ok.length) { this.className = 'bad'; return; }
    moves = ok;
    viewLen = ok.length;
    rebuild();
    syncLog();
    this.className = '';
    this.value = '';
    $('aiMeta').textContent = '已载入 ' + ok.length + ' 手' +
      (ok.length < list.length ? '（第 ' + (ok.length + 1) + ' 手起无法落子，已截断）' : '') +
      ' · AI 执' + (aiColor === BLACK ? '黑' : '白');
    render();
    maybeAutoMove();
  });

  // ---------- 按钮 ----------
  /* ---------- 思考开关 ---------- */

  function renderPause() {
    var b = $('btnPause');
    b.textContent = paused ? '▶ 开始思考' : '⏸ 暂停思考（改棋盘）';
    b.className = 'btn wide' + (paused ? ' primary' : '');
    if (paused) {
      // 暂停状态必须**抢眼**：忘了自己按过暂停，就会干等一手永远不来的棋。
      // 所以直接占用对局时唯一会盯着的那块大字区域。
      $('aiMove').textContent = '⏸ 已暂停';
      $('aiMove').className = 'aiMove paused';
      $('aiMeta').textContent = '棋盘随便改（点棋盘落子 · 悔棋 · ◀▶ 翻手）· 改好点「开始思考」';
    }
  }

  function setPaused(on) {
    if (paused === on) return;
    paused = on;
    if (paused) {
      cancelPending();          // 正在算的作废，预备也停掉
      renderPause();
      render();
      return;
    }
    // 恢复：该我们走就马上走，不该走就等对手并开始预备 —— 两条路都不能漏
    $('aiMove').textContent = '—';
    $('aiMove').className = 'aiMove';
    $('aiMeta').textContent = 'AI 执' + (aiColor === BLACK ? '黑' : '白');
    renderPause();
    render();
    if (winner) return;
    if (viewLen !== moves.length) gotoPly(moves.length);   // 复盘中途恢复：先回到最新局面
    if (isAiTurn()) aiMove(); else startPonder();
  }

  /* ---------- 自定义摆局 ---------- */

  function renderSetup() {
    $('secSetup').hidden = !setupMode;
    $('secStart').hidden = setupMode;
    $('secEntry').hidden = setupMode;
    $('secReview').hidden = setupMode;
    $('secPause').hidden = setupMode;      // 摆局本来就不思考，这个开关没意义
    $('secExtra').hidden = setupMode;
    if (setupMode) {
      var next = moves.length % 2 === 0 ? BLACK : WHITE;
      $('setupTurn').textContent = '下一子：' + (next === BLACK ? '黑 ●' : '白 ○') +
        '　已摆 ' + moves.length + ' 子';
      $('aiMove').textContent = '摆局中';
      $('aiMeta').textContent = '点棋盘落子，摆好后选 AI 执哪边';
    }
  }

  /** 摆局时落一子。**不判胜负** —— 摆的可能就是个有五连的残局。 */
  function setupPlace(p) {
    moves.length = viewLen;
    moves.push(p);
    viewLen++;
    rebuild();
    winner = 0;           // rebuild 会算胜负，摆局时一律清掉
    render();
    renderSetup();
  }

  function enterSetup() {
    closeUnfinished();              // 摆局会清盘，上一局的胜负得在清之前补上
    cancelPending();
    setupMode = true;
    winner = 0;
    moves = []; viewLen = 0;
    engine.reset();
    newGid();                     // 换会话：摆局是全新的局面，旧的置换表和预备都作废
    postAll({ type: 'reset' });
    rebuild();
    winner = 0;
    render();
    renderSetup();
  }

  /**
   * 摆好了，转回正常对局。
   * @param aiMovesNext true = AI 执「下一手该走的那一方」，点完马上出手；
   *                    false = AI 执另一方，等你录入对手的着法。
   */
  function exitSetup(aiMovesNext) {
    var next = moves.length % 2 === 0 ? BLACK : WHITE;
    aiColor = aiMovesNext ? next : (next === BLACK ? WHITE : BLACK);
    setupMode = false;
    rebuild();                    // 这一次要正常判胜负
    // 日志按摆好的局面重新开一局，执色记对，否则复盘时对不上
    if (rec) {
      rec.start({
        size: size(), aiColor: aiColor === BLACK ? 'B' : 'W',
        rule: parseInt($('selRule').value, 10),
        level: $('selLevel').value, thinkCap: parseInt($('selThink').value, 10)
      });
    }
    syncLog();
    renderSetup();
    $('aiMove').textContent = '—';
    $('aiMove').className = 'aiMove';
    $('aiMeta').textContent = aiColor === BLACK ? 'AI 执黑' : 'AI 执白';
    render();
    maybeAutoMove();
  }

  function cancelSetup() {
    setupMode = false;
    renderSetup();
    newGame(aiColor);
  }

  /**
   * 上一局没录完就开了新局：如果轮到对手、而他手上已经有成五点，这局就是输了，补记下来。
   *
   * 实战里输棋的最后一手（对手成五）常常懒得录 —— 2026-09-23 那批里两局真输了的
   * 都是「未完」。没有结果，服务端就不会把那局的局面排进复查，输了等于白输。
   * 只在**确定**的情况下补：轮到对手、他有现成的五。别的情况（中途不下了、
   * 对手认输）一概不猜。日志里打上 resultInferred，事后分得清是录的还是推的。
   */
  function closeUnfinished() {
    if (!rec || !rec.game || rec.game.result || !moves.length) return;
    if (viewLen !== moves.length) { viewLen = moves.length; rebuild(); }
    if (winner) return;
    var opp = turnOf(moves.length);
    if (opp === aiColor || !board.winPoints(opp, []).length) return;
    rec.game.resultInferred = '对手有成五点、未录入';
    rec.finish('对手胜');
  }

  function newGame(color) {
    closeUnfinished();
    cancelPending();
    aiColor = color;
    moves = []; viewLen = 0;
    engine.reset();
    newGid();                       // 换一局就换一个 Rapfi 会话（旧的会被关掉）
    postAll({ type: 'reset' });
    rebuild();
    if (rec) {
      rec.start({
        size: size(), aiColor: aiColor === BLACK ? 'B' : 'W',
        rule: parseInt($('selRule').value, 10),
        level: $('selLevel').value, thinkCap: parseInt($('selThink').value, 10)
      });
    }
    $('aiMove').textContent = '—';
    $('aiMove').className = 'aiMove';
    $('aiMeta').textContent = aiColor === BLACK
      ? 'AI 执黑先走，马上给出第 1 手'
      : 'AI 执白 · 等对手落子后录入';
    $('mTime').textContent = '0'; $('mNodes').textContent = '0'; $('mSource').textContent = '—';
    render();
    maybeAutoMove();
    if ($('inpMove').focus && !isTouch()) $('inpMove').focus();
  }

  // 开局只问一句：谁先走。AI 的执色由此确定，不必先想自己是黑是白。
  $('btnSetup').addEventListener('click', enterSetup);
  $('btnSetupDone').addEventListener('click', function () { exitSetup(true); });
  $('btnSetupWait').addEventListener('click', function () { exitSetup(false); });
  $('btnSetupCancel').addEventListener('click', cancelSetup);
  $('btnSetupBack').addEventListener('click', function () {
    if (!setupMode || viewLen < 1) return;
    moves.length = viewLen - 1; viewLen--;
    rebuild(); winner = 0; render(); renderSetup();
  });

  $('btnAiFirst').addEventListener('click', function () { newGame(BLACK); });
  $('btnOppFirst').addEventListener('click', function () { newGame(WHITE); });

  $('btnUndo').addEventListener('click', function () {
    if (thinking || viewLen < 1) return;
    cancelPending();
    // 退到「轮到对手走」的位置：通常就是一次退掉 AI 那手 + 对手那手
    var n = viewLen - 1;
    if (n > 0 && turnOf(n) === aiColor) n--;
    moves.length = n;              // 悔棋是真的删掉，不保留分支
    viewLen = n;
    rebuild();
    syncLog();
    render();
  });

  $('btnPlay').addEventListener('click', function () {
    if (thinking || winner) return;
    if (viewLen !== moves.length) { moves.length = viewLen; syncLog(); }   // 从当前复盘点继续
    aiMove();
  });

  $('navFirst').addEventListener('click', function () { gotoPly(0); });
  $('navPrev').addEventListener('click', function () { gotoPly(viewLen - 1); });
  $('navNext').addEventListener('click', function () { gotoPly(viewLen + 1); });
  $('navLast').addEventListener('click', function () { gotoPly(moves.length); });

  document.addEventListener('keydown', function (ev) {
    if (ev.target && ev.target.tagName === 'INPUT') return;
    if (ev.key === 'ArrowLeft') { gotoPly(viewLen - 1); ev.preventDefault(); }
    else if (ev.key === 'ArrowRight') { gotoPly(viewLen + 1); ev.preventDefault(); }
    else if (ev.key === 'Home') { gotoPly(0); ev.preventDefault(); }
    else if (ev.key === 'End') { gotoPly(moves.length); ev.preventDefault(); }
  });

  $('btnCopy').addEventListener('click', function () {
    var txt = moves.map(function (p) { return Core.pToLabel(p); }).join(' ');
    var done = function () {
      $('btnCopy').textContent = '已复制';
      setTimeout(function () { $('btnCopy').textContent = '复制'; }, 1200);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(txt).then(done, done);
    else window.prompt('复制棋谱:', txt);
  });

  // 从 npm start 打开时日志会自动 POST 进 logs/，这个按钮用不上；
  // 双击 index.html（file://）没有服务器，日志只能攒在 localStorage 里，靠它导出。
  $('btnLogs').addEventListener('click', function () {
    if (!rec) return;
    var n = rec.countLocal();
    if (!n) {
      $('btnLogs').textContent = rec.serverOk ? '已自动入库' : '暂无日志';
      setTimeout(function () { $('btnLogs').textContent = '导出日志'; }, 1600);
      return;
    }
    var blob = new Blob([rec.dump()], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'gomoku-logs-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  });

  // 关掉就立刻停，别让它在后台白烧 CPU；重新打开就马上接着想
  $('chkPonder').addEventListener('change', function () {
    if (this.checked) startPonder();
    else postAll({ type: 'stopPonder' });
  });

  $('selSize').addEventListener('change', function () {
    var n = parseInt(this.value, 10);
    if (n === size()) return;
    cancelPending();
    Core.setSize(n);                    // 棋盘几何变了，棋子和棋谱必须清空
    postAll({ type: 'size', size: n });
    loadBook();
    newGame(aiColor);
  });
  $('btnPause').addEventListener('click', function () { setPaused(!paused); });
  $('chkAuto').addEventListener('change', maybeAutoMove);
  $('selThink').addEventListener('change', renderStatus);
  // 换规则必须重开一局：禁手与否会改变**每一个**局面的评估，
  // 旧会话的置换表和预备缓存全都作废。
  $('selRule').addEventListener('change', function () { cancelPending(); newGame(aiColor); });
  $('chkNum').addEventListener('change', draw);

  function fitCanvas() {
    var dpr = window.devicePixelRatio || 1;
    canvas.width = LOGICAL * dpr;
    canvas.height = LOGICAL * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }
  window.addEventListener('resize', fitCanvas);

  fitCanvas();
  newGame(BLACK);
})();
