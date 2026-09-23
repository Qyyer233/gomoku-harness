/*
 * worker.js — 把引擎放到后台线程
 *
 * 大师档遇到复杂局面可能想十几秒。跑在主线程上页面会整个冻住
 * （不重绘、点不动，浏览器还会弹「页面无响应」），所以搜索必须离开主线程。
 *
 * 注意：从 file:// 打开页面时浏览器会拒绝创建 Worker（跨源限制）。
 * ui.js 因此做了降级：创建失败就退回主线程同步计算，并把大师档的
 * 思考上限压到不至于卡死的程度。想要完整的长考体验，用 `npm start` 起本地服务器。
 */
/* global importScripts, postMessage, GomokuCore, GomokuEngine, GomokuBook */
importScripts('core.js', 'engine.js', 'book.js');

var engine = new GomokuEngine.Engine();
var board = new GomokuCore.Board();
// 并行搜索里的编号：0 = 主线程（它的结果才算数），>0 = 副线程（只负责往共享表里灌）
var smpIndex = 0;

// 开局库是可选的，而且按棋盘边长分开存放。没生成过就算了，引擎照样能下。
for (var f of ['../data/book.js', '../data/book12.js']) {
  try { importScripts(f); } catch (e) { /* 这个尺寸没有库 */ }
}

/** 切到某个棋盘边长：换尺寸，并挂上对应的开局库 */
function useSize(size) {
  GomokuCore.setSize(size);
  board = new GomokuCore.Board();
  var data = self.GOMOKU_BOOKS && self.GOMOKU_BOOKS[size];
  engine.setBook(data ? GomokuBook.Book.load(data) : null);
  engine.reset();
}
useSize(GomokuCore.SIZE);

function bookMeta() {
  return engine.book ? engine.book.meta : null;
}

// ---------- 后台思考（pondering / 常驻思考）----------
//
// 轮到对手时，这条线程本来是闲着的。实战里这段空闲特别长 ——
// 等对手思考、再把他的着法录进来，十几二十秒很常见，
// 比 AI 自己的思考时间还长。把这段时间用起来等于白捡。
//
// 做法不是「猜对手走哪一手再往下算」（猜错就白搭，实测猜中率约 60%），
// 而是**直接搜「轮对手走」的当前局面**：对手所有合理应手的子树都会进置换表，
// 于是不管他实际走哪一手，真正轮到我们时那棵子树都已经是热的 —— 没有猜错这回事。
// 引擎的置换表本来就跨手复用、局内从不清理，正好接得上。
//
// 注意这个功能依赖今天修掉的那个 bug：以前置换表在根节点会直接剪枝返回，
// 而预热恰恰会让每个真实搜索的根节点都命中 —— 那时开这个功能等于让 AI 一手不搜。
//
// 关键约束：`bestMove` 是同步的，跑的时候这条线程收不到任何消息，
// 你敲进来的着法会一直排队等它算完。所以必须**切片**思考：
// 每片几百毫秒，片与片之间用 setTimeout(0) 把控制权交还事件循环。
var PONDER_SLICE_MS = 400;     // 单片时长：太长会拖慢响应，太短则切换开销占比高
var PONDER_MAX_MS = 60000;     // 总上限，别让它无限空转
var ponderOn = false, ponderToken = 0, ponderNodes = 0, ponderMs = 0;

function stopPonder() {
  ponderOn = false;
  ponderToken++;               // 让已经排队的下一片自己作废
}

// 顺着强制线往前推了多少手。推太远就偏离实战了，所以要封顶。
var PONDER_MAX_FORCED = 6;

function ponderTick(token, depth, startedAt, forced) {
  if (!ponderOn || token !== ponderToken) return;
  if (Date.now() - startedAt > PONDER_MAX_MS) { ponderOn = false; return; }
  var r = engine.bestMove(board, ponderRole, {
    level: ponderLevel, useBook: false, fastOpening: false,
    depth: depth, timeMin: PONDER_SLICE_MS, timeMax: PONDER_SLICE_MS,
    stable: 1e9                // 别因为「着法稳定」提前收手，我们要的是把表填满
  });
  ponderNodes += r.nodes;
  ponderMs = Date.now() - startedAt;

  // 0 节点 = 这个局面在战术层（成五/挡五/活四）就有答案，压根没进搜索。
  // 再加深也还是 0 —— 实战日志里有 30% 的预热就是这样白烧了好几秒。
  // 这种局面对手几乎必然走那一手，所以**替他走掉，接着想后面的**，
  // 这就退化成经典的「顺着预测线 ponder」，而且这条线是强制的、猜错的概率极低。
  if (r.nodes === 0 && r.move >= 0 && board.cells[r.move] === GomokuCore.EMPTY &&
      forced < PONDER_MAX_FORCED) {
    board.put(r.move, ponderRole);
    if (board.lastMoveWins()) { ponderOn = false; return; }   // 推到分出胜负就没必要了
    ponderRole = 3 - ponderRole;
    setTimeout(function () { ponderTick(token, 4, startedAt, forced + 1); }, 0);
    return;
  }

  // 逐片加深。上一片的结果都在置换表里，所以下一片不是从头再来。
  setTimeout(function () { ponderTick(token, depth + 2, startedAt, forced); }, 0);
}

var ponderRole = GomokuCore.BLACK, ponderLevel = 'master';

function startPonder(msg) {
  stopPonder();
  if (msg.size && msg.size !== GomokuCore.SIZE) useSize(msg.size);
  board.reset();
  for (var i = 0; i < msg.history.length; i++) {
    board.put(msg.history[i], i % 2 === 0 ? GomokuCore.BLACK : GomokuCore.WHITE);
  }
  if (board.lastMoveWins()) return;            // 已经分出胜负，没什么好想的
  ponderRole = msg.role;
  ponderLevel = (msg.opts && msg.opts.level) || 'master';
  ponderOn = true;
  ponderNodes = 0; ponderMs = 0;
  var token = ponderToken;
  setTimeout(function () { ponderTick(token, 4, Date.now(), 0); }, 0);
}

self.onmessage = function (ev) {
  var msg = ev.data || {};
  // 除了「开始后台思考」本身，任何消息都先把后台思考停掉：
  // 局面已经变了，再想下去既没用又会挡住这条线程。
  if (msg.type !== 'ponder') stopPonder();
  switch (msg.type) {
    case 'init':
      // 主线程会把一块 SharedArrayBuffer 发给每个 Worker，大家共用一张置换表 ——
      // 这是并行搜索唯一的互相加速通道。没有它就是 N 个线程各做各的重复劳动。
      smpIndex = msg.smp || 0;
      if (msg.ttBuffer) {
        engine = new GomokuEngine.Engine({ ttBuffer: msg.ttBuffer });
        useSize(GomokuCore.SIZE);
      }
      postMessage({ type: 'ready', book: bookMeta(), smp: smpIndex });
      break;

    case 'size':
      useSize(msg.size);
      postMessage({ type: 'ready', book: bookMeta() });
      break;

    case 'reset':
      engine.reset();
      break;

    case 'ponder':
      startPonder(msg);
      break;

    case 'move': {
      // 每次都从着法历史重建局面：主线程和 worker 之间只传一个数组，
      // 不必同步整个棋盘状态，也就不会出现两边不一致的 bug。
      if (msg.size && msg.size !== GomokuCore.SIZE) useSize(msg.size);
      board.reset();
      for (var i = 0; i < msg.history.length; i++) {
        board.put(msg.history[i], i % 2 === 0 ? GomokuCore.BLACK : GomokuCore.WHITE);
      }
      var o = msg.opts || {};
      // 副线程从更深处起跑，走出和主线程不一样的路（见 engine.js 里 startDepth 的说明）
      if (smpIndex > 0) {
        var o2 = {};
        for (var kk in o) if (Object.prototype.hasOwnProperty.call(o, kk)) o2[kk] = o[kk];
        o2.startDepth = 2 + 2 * smpIndex;
        o2.trace = false;                 // 副线程的思维链没人看，别白花开销
        o = o2;
      }
      var r = engine.bestMove(board, msg.role, o);
      postMessage({
        type: 'move', id: msg.id,
        move: r.move, source: r.source, note: r.note, score: r.score,
        depth: r.depth, nodes: r.nodes, timeMs: r.timeMs,
        // 思维链和分阶段计时要一起回传，否则主线程那边的日志是空的
        phase: r.phase, trace: r.trace,
        // 这一手之前后台白捡了多少思考量，用来量化 pondering 到底值不值
        ponderNodes: ponderNodes, ponderMs: ponderMs
      });
      ponderNodes = 0; ponderMs = 0;
      break;
    }
  }
};
