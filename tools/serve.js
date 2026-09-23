/* serve.js — 零依赖静态服务器 + Rapfi 引擎桥
 *
 * 三件事：
 *   1. 发网页（带 COOP/COEP，好让 SharedArrayBuffer 可用）
 *   2. 收对局日志（POST /log）
 *   3. 把浏览器和本机的 Rapfi 进程接起来（/engine/*）
 *
 * 关于第 3 点的关键设计：**一局棋 = 一个常驻的 Rapfi 进程**。
 * 不这么做的话，Rapfi 自带的后台思考（INFO PONDERING 1）和置换表就全白费了 ——
 * 它靠的正是「上一手想到的东西这一手还在」。所以会话按 gid 保存，
 * 整局都用 TURN 增量推进，只有在对不上（悔棋、复盘跳转）时才 BOARD 重置。
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Rapfi, pickExe, ENGINE_DIR } = require('./rapfi.js');
const { Prepare } = require('./prepare.js');

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.argv[2] || process.env.PORT || '8080', 10);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

// 对局日志落在这里，一局一个文件。分析完用 `npm run logs -- --clear` 清掉。
// 日志目录可以被环境变量改掉。**端到端测试必须改**：它会 POST 几局假棋局
// 去验证胜负回灌，那些文件落进真 logs/ 就成了混在实战数据里的伪造败局
// （踩过：两个 e2e-*.json 混进去，事后分析对局时才发现）。
const LOGDIR = process.env.RAPFI_LOG_DIR || path.join(ROOT, 'logs');

/**
 * 异常同时打到控制台和 logs/server.log。
 * 控制台滚过去就没了，而这些行（慢手、会话异常、非法着法）正是事后唯一能查的东西。
 */
function note(line) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(line);
  try {
    fs.mkdirSync(LOGDIR, { recursive: true });
    fs.appendFileSync(path.join(LOGDIR, 'server.log'), t + '  ' + line + '\n');
  } catch (e) { /* 写不进去也不能影响下棋 */ }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

/* ---------------- Rapfi 会话 ---------------- */

const RAPFI_EXE = pickExe(ENGINE_DIR);
/* ---- 算力怎么切（全部可用环境变量覆盖）----
 *
 * 线程收益实测（12 路 / 6 秒烧满 / tools/thread-curve.js）：
 *
 *     线程    1     2     4     8    12    24
 *     层数  27.3  28.9  28.9  29.9  30.5  30.8
 *
 * 12 核之后基本白给（12→24 只多 0.3 层）。而「预备」的瓶颈是**能备完几条**，
 * 不是每条多深 —— 串行时 12 秒窗口只备完 2.4 条，命中率被卡在 70.8%。
 * 所以默认把 24 核切成：主引擎 8 线程 + 2 个预备引擎各 8 线程。
 * 主引擎因此少 0.9 层（29.9 vs 30.8），换来预备条数翻倍、且每条能吃满整个窗口。
 *
 *   RAPFI_THREADS       主引擎线程数（默认 8）
 *   RAPFI_PREP_ENGINES  预备引擎个数（默认 2，设 0 = 关掉预备）
 *   RAPFI_PREP_THREADS  每个预备引擎的线程数（默认 8）
 *
 * 机器核少的话按比例调小，别让总线程数超过物理核数 —— 超了会互相抢，
 * 正式出手和预备一起变慢。
 */
const CPUS = os.cpus().length;
// Gomocup 协议的规则位：0 自由 / 1 标准(恰好五) / 4 连珠(黑有禁手)。
// 界面每手都带过来，改了就重建会话。
const { swindle } = require('./swindle.js');
// 绝境搏命：算出必输之后，把剩下的预算花在「让对手走错」上。
// 只在被证明必输时才激活，其余时候完全不介入。详见 swindle.js 顶部。
const SWINDLE_ON = process.env.RAPFI_SWINDLE !== '0';

const { Memo } = require('./memo.js');
// 实战记忆库：引擎算过的每一手都存下来，连同它后来赢没赢。
// 同一个对手反复走同一套开局时，这里直接 0ms 给答案；
// 而走输过的线路会被拒绝，强制换招。详见 memo.js 顶部。
// 落盘位置可以用环境变量改掉 —— 端到端测试要用一份临时库，
// 不能往用户真正在积累的那份里写测试数据。
const memo = new Memo(process.env.RAPFI_MEMO_FILE || path.join(ROOT, 'data', 'memo.json'),
  // 落盘间隔可调：端到端测试要在几秒内看到文件变化，实战下拉长更划算
  { saveDelay: parseInt(process.env.RAPFI_MEMO_SAVE_MS || '15000', 10) });
const MEMO_ON = process.env.RAPFI_MEMO !== '0';

/*
 * 空闲复查：输了一局之后，把那些局面用远超实战的预算重算一遍。
 *
 * **胜负只指路，不判案。** 输棋说明「这条线值得再看看」，但它不能直接决定
 * 哪一手对 —— 对手水平高低完全不可控，正着也可能输给高手，劣着也可能赢过菜鸟。
 * 所以这里做的是：把算力挪到有线索的局面上，让 30 秒的深搜自己下结论。
 *
 * 只在**真正空闲**时跑：一有请求就立刻停手并让出 CPU。实战里任何一次
 * 抢资源都可能变成一次超时，而超时是会直接输棋的。
 */
const REVIEW_ON = process.env.RAPFI_REVIEW !== '0';
const REVIEW_IDLE_MS = parseInt(process.env.RAPFI_REVIEW_IDLE_MS || '60000', 10);
const REVIEW_MS = parseInt(process.env.RAPFI_REVIEW_MS || '30000', 10);
// 延迟取值：THREADS 在这一段之后才声明（这块是插在文件前部的）
const reviewThreads = () => parseInt(process.env.RAPFI_REVIEW_THREADS || '0', 10) || THREADS;

const review = { eng: null, busy: false, gen: 0, last: Date.now(), size: 0, rule: -1, done: 0 };

/** 任何一次请求都算「有人在用」：停掉复查，把机器让出来。 */
function touchActivity() {
  review.last = Date.now();
  if (review.busy || review.eng) {
    review.gen++;                       // 让正在跑的那条作废
    try { if (review.eng) review.eng.stopThinking(); } catch (e) {}
  }
}

function stopReviewEngine() {
  if (!review.eng) return;
  try { review.eng.stop(); } catch (e) {}
  review.eng = null;
  review.size = 0; review.rule = -1;
}

async function reviewTick() {
  if (!REVIEW_ON || review.busy) return;
  if (Date.now() - review.last < REVIEW_IDLE_MS) { stopReviewEngine(); return; }
  const job = memo.peekReview();
  if (!job) { stopReviewEngine(); return; }

  // **对局会话要先收掉。** 一局下完后会话会一直留着（要等下一局开始才换），
  // 原先这里写「还有会话就不碰」，结果复查永远等不到机会启动。
  // 闲置这么久了，那 3 个引擎进程本来也该让出来 ——
  // 下一局开始时 newGid() 会预热，创建开销被吸收掉。
  if (sessions.size) {
    note(`[复查] 空闲 ${Math.round((Date.now() - review.last) / 1000)} 秒，先收掉 ${sessions.size} 个对局会话`);
    for (const [k, old] of sessions) { stopSession(old); sessions.delete(k); }
  }

  review.busy = true;
  const gen = review.gen;
  try {
    if (!review.eng || review.size !== job.size || review.rule !== job.rule) {
      stopReviewEngine();
      review.eng = new Rapfi({ threads: reviewThreads(), rule: job.rule | 0, matchSpread: 0 });
      await review.eng.start();
      await review.eng.newGame(job.size);
      review.size = job.size; review.rule = job.rule | 0;
      note(`[复查] 起引擎（${reviewThreads()} 线程，每个局面 ${REVIEW_MS}ms，队列还有 ${memo.reviewCount()} 个）`);
    }
    if (gen !== review.gen) return;     // 起引擎那会儿来请求了
    const r = await review.eng.think(job.moves, REVIEW_MS);
    if (gen !== review.gen) {
      note('[复查] 被对局打断，这条留到下次');
      return;
    }
    memo.record(job.size, job.rule, job.moves, r, REVIEW_MS);
    memo.doneReview(job.key);
    review.done++;
    note(`[复查] ${job.moves.length} 手的局面 -> ${r.x},${r.y}（${r.depth} 层 / ${r.ms}ms）` +
         `，队列还剩 ${memo.reviewCount()} 个`);
  } catch (e) {
    note('[复查] 失败：' + (e && e.message));
    stopReviewEngine();
  } finally {
    review.busy = false;
  }
}

const reviewTimer = setInterval(() => { reviewTick(); }, 5000);
if (reviewTimer.unref) reviewTimer.unref();

const RULE_NAME = { 0: '无禁手', 1: '标准', 4: '有禁手(连珠)' };
const THREADS = parseInt(process.env.RAPFI_THREADS || '0', 10) || Math.max(1, Math.min(8, CPUS));
const PREP_ENGINES = parseInt(process.env.RAPFI_PREP_ENGINES != null ? process.env.RAPFI_PREP_ENGINES : '2', 10);
const PREP_THREADS = parseInt(process.env.RAPFI_PREP_THREADS || '0', 10) || THREADS;
const IDLE_MS = 15 * 60 * 1000;

const sessions = new Map();   // gid -> {eng, size, busy:Promise, touched}
const starting = new Map();   // gid -> 正在创建中的会话 Promise（见 getSession）
const logSeq = new Map();     // 对局日志 id -> 收到过的最大 seq（丢弃晚到的旧快照，见 /log）
const logIngested = new Map(); // 对局日志 id -> 已回灌进记忆库的结果（同一结果只回灌一次）

/** 一个会话有一个主引擎和若干预备引擎，收的时候一个都不能漏 —— 
 *  漏掉的就是孤儿进程，每个占着一堆线程跑到服务器重启（踩过）。 */
function stopSession(s) {
  // 先作废预备，再关进程：否则正在跑的那条预备会往已经关掉的进程上发命令，
  // server.log 里就是「预备出错: Cannot read properties of null (reading 'stdin')」。
  try { if (s.prep) s.prep.stop(); } catch (e) {}
  try { s.eng.stop(); } catch (e) {}
  for (const pe of (s.prepEngs || [])) { try { pe.stop(); } catch (e) {} }
}

function reap() {
  const now = Date.now();
  for (const [gid, s] of sessions) {
    if (now - s.touched > IDLE_MS) {
      // 闲置回收以前是静默的 —— server.log 里出现过"新建了却没有对应的关闭"，
      // 就是被它悄悄收走的，当时看着像漏了一条。
      note(`[会话] 闲置 ${Math.round((now - s.touched) / 60000)} 分钟，回收 ${gid}`);
      stopSession(s); sessions.delete(gid);
    }
  }
}
setInterval(reap, 60000).unref();

/**
 * 事件循环卡顿监控。
 *
 * 实战出现过「服务端自报 1.5 秒、浏览器等了 27 秒」——中间 25.5 秒完全是空的。
 * 计时是在请求处理函数里开始的，所以**如果事件循环在此之前就被堵住，计时看不见**。
 * 这个定时器量的就是那一段：它本该每 250ms 醒一次，醒晚了多少就是堵了多久。
 *
 * Windows 控制台的「快速编辑」模式是个常见元凶 —— 在窗口里拖选文字会让
 * 进程在下一次 stdout 写入时整个挂起，直到你按回车或点一下。
 */
let _tick = Date.now();
setInterval(() => {
  const now = Date.now();
  const lag = now - _tick - 250;
  _tick = now;
  if (lag > 500) note(`[卡顿] 服务器事件循环被堵了 ${lag}ms —— 这段时间里所有请求都在排队`);
}, 250).unref();

/** 真正把一个会话建起来：起进程、开局、预热权重 */
async function createSession(size, rule) {
  // matchSpread 打开 Rapfi 自带的自适应用时。不给它比赛总时限的话，
  // 它每一手都会把 TIMEOUT_TURN 烧满（timecontrol.cpp 里 ampleMatchTime 恒为 true，
  // 整套「着法稳定就提前收手」的逻辑压根不执行）——
  // 那正是「开局就长思考，一直长思考」的来由。
  // 实测 12 路自对弈 20 手、上限 6 秒：关掉平均 1723ms，开到 21 平均 953ms，深度还高一点。
  const eng = new Rapfi({
    threads: THREADS, pondering: true, showDetail: true, rule: rule | 0,
    matchSpread: parseFloat(process.env.RAPFI_MATCH_SPREAD || '21')
  });
  await eng.start();
  await eng.newGame(size);
  // 先空烧一次极短的搜索：NNUE 权重（10MB lz4）是**第一次搜索时**才解压加载的，
  // 不预热的话那 300 多毫秒会算进本局第一手，实测让第一手超出预算。
  // 预热会让引擎在内部棋盘上真的落一子，所以紧接着要 RESTART 清盘 ——
  // 否则本局第一手若是我方先行（BEGIN），就成了在非空盘上重开一局，引擎不回话。
  try { await eng.think([], 50); eng.restart(); } catch (e) { /* 预热失败不影响下棋 */ }

  // 预备引擎：独立进程，和主引擎互不干扰。
  // 独立进程还顺带消掉了一类事故 —— 同一个进程上并发跑两个搜索会让协议串线，
  // 实测能把 Rapfi 打崩（退出码 0xC0000374 堆损坏）。
  const prepEngs = [];
  for (let i = 0; i < PREP_ENGINES; i++) {
    const pe = new Rapfi({ threads: PREP_THREADS, pondering: false, showDetail: true,
                           rule: rule | 0, matchSpread: 0 });
    await pe.start();
    await pe.newGame(size);
    try { await pe.think([], 50); pe.restart(); } catch (e) { /* 预热失败不影响下棋 */ }
    prepEngs.push(pe);
  }
  // 宽度由界面每手带过来（0 = 关闭）
  // **把预备的活动量记下来。** 实战观察到「手机上操作时风扇更响，电脑上却很轻」——
  // 风扇声就是预备引擎在干活。两种用法下预备到底跑了多久、备完几条，
  // 只有记下来才能比。如果电脑那边明显更少，那说明浏览器标签页被限流、
  // 连 /engine/ponder 都发得稀稀拉拉 —— 那会是「后台冻结」那个推断的旁证。
  const prep = new Prepare(prepEngs.length ? prepEngs : eng, {
    width: 0,
    onLog: line => note('[预备] ' + line),
    // **预备的成果也要进记忆库。** 它和主搜索是同一种东西 —— 真的搜了 20 多层。
    // 每轮备的几条里只有一条会被对手走中，其余几条扔掉太亏：
    // 下一局对手走到那儿就是 0ms 直出。
    onPrepared: (line, r, budget) => {
      if (MEMO_ON) memo.record(size, rule | 0, line, r, budget);
    }
  });
  return { eng, prepEngs, size, rule: rule | 0, prep, busy: Promise.resolve(), touched: Date.now() };
}

/**
 * 取（必要时新建）一个会话。
 *
 * **同一个 gid 的并发请求必须共用同一次创建。** 界面在棋谱库命中后会发
 * /engine/ponder 预热，开局连着命中五手就是五个请求挤在一起；而建一个会话要
 * 起进程 + 解压 10MB 权重，约一秒。原先每个请求各查一次 sessions、都发现
 * 「还没有」，于是各起一个 Rapfi，最后只有最后一个进了表，前面几个成了
 * 收不掉的孤儿进程 —— 实测一局棋残留 10 个，每个 24 线程，一直抢 CPU
 * 到服务器重启为止（而且会把所有用时测量带偏）。
 * 所以创建过程登记在 starting 里，后来的请求等它，不再另起一个。
 */
async function getSession(gid, size, rule) {
  rule = rule | 0;
  for (;;) {
    const s = sessions.get(gid);
    if (s && s.size === size && s.rule === rule) { s.touched = Date.now(); return s; }
    // **规则也得比。** RULE 只在 START 之后发一次，改规则必须重开进程；
    // 而禁手与否会改变每一个局面的评估（12 路开局实测 -419 vs -130），
    // 沿用旧会话等于按错的规则下完整局。
    if (s) { stopSession(s); sessions.delete(gid); }   // 换了棋盘尺寸或规则，重建

    const inflight = starting.get(gid);
    if (inflight) {
      // 已经有人在建了，等它。失败也不要紧 —— 回到循环由本次请求自己重建。
      await inflight.catch(() => {});
      continue;
    }
    const p = createSession(size, rule);
    starting.set(gid, p);
    try {
      const ns = await p;
      sessions.set(gid, ns);
      // 正常路径以前是全静默的，于是没法判断清理到底在不在工作 ——
      // 用户只看到兜底那一行，以为只清了一次。建和关都打出来。
      note(`[会话] 新建 ${gid}（${size} 路 · ${RULE_NAME[rule] || 'RULE ' + rule} ` +
        `· 主引擎 ${THREADS} 线程 + ${PREP_ENGINES} 个预备各 ${PREP_THREADS} 线程）`);
      // **同一时刻只有一盘棋。** 旧会话留着只会白占 CPU ——
      // 一个会话是 3 个引擎进程，连打五局又没正常关掉（刷新页面就会这样），
      // 就是 15 个进程、上百个线程在 24 核上抢，每一手都被拖慢。
      // 原先靠 15 分钟的闲置回收，太晚了。这里直接封顶：新的建好就关掉其它。
      for (const [k, old] of sessions) {
        if (k === gid) continue;
        note(`[会话] 关掉旧会话 ${k}（同一时刻只留一盘棋）`);
        stopSession(old);
        sessions.delete(k);
      }
      return ns;
    } finally {
      starting.delete(gid);
    }
  }
}

/** 同一个会话的请求必须排队：协议是一问一答的，并发发命令会串线 */
function serialize(s, fn) {
  const next = s.busy.then(fn, fn);
  s.busy = next.then(() => {}, () => {});
  return next;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 8e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const sendJSON = (res, code, obj) =>
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS))
     .end(JSON.stringify(obj));

/* ---------------- 请求处理 ---------------- */

const srv = http.createServer(async (req, res) => {
  // **任何一次请求都先把复查停掉。** 哪怕只是取个静态文件，也说明人回来了 ——
  // 实战里被复查抢走 CPU 的一手就可能超时，而超时是直接输棋的。
  touchActivity();
  let rel = decodeURIComponent(req.url.split('?')[0]);

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS).end(); return; }

  // ---- 引擎桥 ----
  if (rel === '/engine/memo') { sendJSON(res, 200, memo.stats()); return; }

  if (rel === '/engine/info') {
    sendJSON(res, 200, {
      available: !!RAPFI_EXE,
      exe: RAPFI_EXE,
      threads: THREADS,
      prepEngines: PREP_ENGINES,
      prepThreads: PREP_THREADS,
      cpus: CPUS,
      sessions: sessions.size,
      // 排查用：当前预备了对手的哪几手、缓存里攒了多少条。
      // 少了这个，「命中却很慢」这类问题只能靠猜哪一手会命中。
      prepare: [...sessions.entries()].map(([gid, x]) => ({
        gid,
        stat: x.prep && x.prep.stat,
        cands: x.prep ? x.prep.lastCands : [],
        cached: x.prep ? x.prep.cache.size : 0,
        doneThisTurn: x.prep ? x.prep.doneThisTurn : 0
      }))
    });
    return;
  }

  if (rel === '/engine/move' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      if (!RAPFI_EXE) return sendJSON(res, 503, { error: 'engines/rapfi 下没有引擎可执行文件' });
      const size = b.size | 0, ms = b.ms | 0, rule = b.rule | 0;
      const moves = Array.isArray(b.moves) ? b.moves : [];
      if (size < 5 || size > 22) return sendJSON(res, 400, { error: '不支持的棋盘尺寸 ' + size });
      // **每一步都计时。** 实战出现过「日志写 3.4 秒、人等了 15 秒」这种事，
      // 而当时服务端什么都没记，只能靠猜。现在把拆解一并带回去写进日志。
      const t0 = Date.now();
      const gid = String(b.gid || 'default');

      // **记忆库排在建会话之前。** 命中记忆这一手不需要引擎参与，
      // 而冷启动一个会话要起 3 个进程、解压 10MB 权重，实测 2.2 秒 ——
      // 让一个「0ms 直出」的答案去等它是纯亏（端到端测试量到过 2179ms）。
      //
      // 它跨对局，而预备缓存只活在本局。
      let mem = MEMO_ON ? memo.lookup(size, rule, moves, ms) : null;
      // **必输局面不走捷径。** 记忆库/预备缓存里存的是引擎的「最长抵抗」，
      // 直接交出去等于绕过了绝境搏命 —— 而对手是人的时候，该最大化的是他走错的机会。
      // 这种局面交给现场搜索 + 搏命，那 6 秒预算本来也是白扔的。
      const swindleOn = SWINDLE_ON && b.swindle !== false;
      if (mem && swindleOn && mem.mate < 0) mem = null;

      // 棋谱库的候选和记忆库的结论撞车时，**谁的分析深听谁的**。
      // 浏览器查库、服务端裁决 —— 库在浏览器那边（data/book*.js），
      // 搬到服务端要连带改构建和缓存，而这道关卡只要知道两边各算了多久。
      if (b.book && Array.isArray(b.book) && b.book.length === 2) {
        const bx = b.book[0] | 0, by = b.book[1] | 0;
        const bookMs = b.bookMs | 0, bookDepth = b.bookDepth | 0;
        const memBeats = mem && mem.x != null && (bx !== mem.x || by !== mem.y) &&
                         (mem.b || 0) > Math.max(bookMs, 1) * 1.5;
        if (memBeats) {
          note('[记忆] 棋谱库给 ' + bx + ',' + by + '（' + bookDepth + ' 层 / ' + bookMs + 'ms），' +
               '记忆库算得更深：' + mem.x + ',' + mem.y + '（' + mem.d + ' 层 / 预算 ' + mem.b + 'ms），用记忆库的');
        } else {
          sendJSON(res, 200, {
            x: bx, y: by, ms: 0, source: 'book', bookNote: String(b.bookNote || ''),
            depth: 0, eval: null, evalText: '', mate: 0, nodes: 0,
            incremental: false, afterPonder: false,
            timing: { session: 0, queue: 0, think: 0, total: Date.now() - t0,
                      book: true, sessions: sessions.size,
                      engines: sessions.size * (1 + PREP_ENGINES) }
          });
          return;
        }
      }

      if (mem && mem.x != null) {
        const warm = sessions.get(gid);
        const live = warm && warm.size === size && warm.rule === rule;
        // 会话已经在了就同步收掉预备（和预备命中那条路一样，防协议串线）；
        // 还没建就丢到后台去建 —— 下一手要用，但这一手不必等。
        if (live) warm.prep.stop();
        else getSession(gid, size, rule).then(ns => ns.prep.stop(), () => {});
        note('[记忆] 命中 ' + mem.x + ',' + mem.y + ' —— 当时 ' + mem.d + ' 层 / ' + mem.ms +
          'ms（预算 ' + mem.b + 'ms），战绩 ' + mem.w + ' 胜 ' + mem.l + ' 负，这手省下 ' + ms + 'ms');
        sendJSON(res, 200, {
          x: mem.x, y: mem.y, ms: 0, source: 'memo',
          depth: mem.d, eval: mem.ev, evalText: String(mem.ev), mate: mem.mate,
          nodes: 0, incremental: false, afterPonder: false,
          memoMs: mem.ms, memoDepth: mem.d, memoW: mem.w, memoL: mem.l,
          timing: {
            session: 0, queue: 0, think: 0, total: Date.now() - t0,
            memo: true, memoMs: mem.ms, memoTrust: Math.round(mem.trust * 100),
            sessions: sessions.size, engines: sessions.size * (1 + PREP_ENGINES)
          }
        });
        return;
      }

      const s = await getSession(gid, size, rule);
      const tSession = Date.now() - t0;
      // 用时风格由界面每手带过来（同一会话的请求是串行的，直接改属性是安全的）
      if (b.pace != null && isFinite(b.pace)) s.eng.matchSpread = Math.max(0, b.pace);

      // **先查预备缓存。** 命中就是 0ms —— 对手思考的那十几秒里，
      // 我们已经把这一手算好了。取消预备放到后台去做，别让它拖慢这次回答。
      let ready = s.prep.get(moves);
      // **验一下这手还能不能下。** 预备的结果是提前算的，万一和当前局面对不上，
      // 发出去就是一手非法着法 —— 而界面拿到非法着法会静默放弃，整手 AI 就没了。
      // 实战抓到过两次，其中一局因此输掉（第 24 手日志写 C10、棋盘上是 B10）。
      if (ready && moves.some(m => m[0] === ready.x && m[1] === ready.y)) {
        note(`[预备] 缓存里的 ${ready.x},${ready.y} 已经有子了，丢掉这条改为现场搜索`);
        ready = null;
      }
      if (ready && swindleOn && ready.mate < 0) ready = null;     // 同上：必输局面要搏命
      if (ready) {
        // 字段要和未命中那条保持一致，否则日志里出现 undefined，
        // 排查时得先分辨"是没这个字段"还是"值真的是 0"。
        const timing = {
          session: tSession,
          queue: 0,                    // 命中不排队
          think: 0,                    // 命中不搜索 —— 答案早算好了
          total: Date.now() - t0,
          prepared: true,
          preparedMs: ready.ms,        // 这条当时算了多久
          sessions: sessions.size,
          engines: sessions.size * (1 + PREP_ENGINES)
        };
        // 命中也要等预备停干净再回话。实测取消只花 ~28ms，
        // 拿这 28ms 换掉一整类协议串线的竞态（第一版不等，把引擎打崩过）。
        s.prep.stop();
        sendJSON(res, 200, Object.assign({}, ready, { ms: 0, preparedMs: ready.ms, timing }));
        return;
      }
      // 没命中：必须先把预备停干净，否则协议会串线
      s.prep.stop();
      const tStop = Date.now();
      // 建会话、排队已经花掉的时间要从预算里扣 —— selThink 是用户读秒里的硬上限，
      // 和 rapfi.js 扣掉收后台思考的时间是同一个道理。以前这段不扣，
      // 冷启动那一手必然超限（server.log 里 [慢手] 的「建会话 2296ms」就是它）。
      const thinkMs = Math.max(500, ms - (tStop - t0));
      let engineRes = null;       // 引擎自己的结论（搏命可能会换掉这一手）
      const r = await serialize(s, async () => {
        const first = engineRes = await s.eng.think(moves, thinkMs);
        // **只有被证明必输才搏命。** 这时候引擎会立刻收手（实战日志里
        // 第 8 手之后每手只想 50~250ms），6 秒预算剩下的全是白扔的。
        // 它按「最长抵抗」选棋 —— 那个目标对着另一个引擎才对，对手是人的时候，
        // 该最大化的是他走错的机会。
        if (!swindleOn || !(first.mate < 0)) return first;
        const sw = await swindle(s.eng, moves, first, {
          deadline: t0 + ms,          // 这条线一步都不许越过
          width: 5,
          onLog: line => note('[搏命] ' + line)
        });
        if (!sw) return first;
        if (sw.x === first.x && sw.y === first.y) {
          note('[搏命] 试了 ' + sw.tried + ' 个候选，引擎原来那手就是最难被走对的');
          return Object.assign(first, { swindle: { tried: sw.tried, kept: true, lines: sw.lines } });
        }
        note('[搏命] ' + first.x + ',' + first.y + '（被杀 ' + (-first.mate) + ' 步）' +
             ' -> ' + sw.x + ',' + sw.y + '，' + sw.picked.reason +
             '（试了 ' + sw.tried + ' 个候选）');
        const proved = sw.picked.survive !== Infinity;
        return Object.assign({}, first, {
          x: sw.x, y: sw.y,
          // 换了一手就不能再报原来那手的 mate —— 日志里的分数是照这个算的
          mate: proved ? -sw.picked.survive : 0,
          eval: proved ? first.eval : null,
          evalText: proved ? first.evalText : '',
          swindle: { tried: sw.tried, kept: false, reason: sw.picked.reason,
                     from: first.x + ',' + first.y, lines: sw.lines }
        });
      });
      // 真算过的才记。命中记忆那条路不会走到这里，免得把 hits 刷虚。
      // **记引擎自己的结论，不记搏命换上的那一手**：换手后的结果带着 mate=0 和
      // 原搜索的深度，存进去就成了一条「高质量、不输」的假记忆，下次直接 0ms 交出去，
      // 连搏命都不再触发。记原结论的话 mate<0 还在，下次照样走搜索 + 搏命。
      // 预算记**名义值**（6000 就是 6000），不记扣完之后的 thinkMs：
      //   · 记忆库按预算排序，平时扣掉的那几毫秒不能变成排序依据；
      //   · 冷启动那一手扣得多，照实记的话这条记忆以后永远查不中（need = 0.8 × 预算），
      //     test-memo-e2e 就是这么挂的。它实际搜得浅不浅，质量分（层数 / 用时）已经如实反映了。
      if (MEMO_ON && engineRes) memo.record(size, rule, moves, engineRes, ms);
      r.timing = {
        session: tSession,                       // 建/取会话花了多久（首手会起 3 个引擎）
        queue: tStop - t0 - tSession,            // 排队和收预备
        think: Date.now() - tStop,               // 真正搜索
        total: Date.now() - t0,                  // 服务端一共花了多久
        sessions: sessions.size,                 // 此刻还活着几个会话
        engines: sessions.size * (1 + PREP_ENGINES)   // 折合几个引擎进程
      };
      // 慢手直接在服务器控制台喊一声，不用等用户来报
      if (r.timing.total > ms) {
        note(`[慢手] 共 ${r.timing.total}ms > 上限 ${ms}ms ——` +
          ` 建会话 ${r.timing.session}ms · 排队 ${r.timing.queue}ms · 搜索 ${r.timing.think}ms` +
          ` · 活着 ${r.timing.sessions} 个会话/${r.timing.engines} 个引擎进程`);
      }
      sendJSON(res, 200, r);
    } catch (e) {
      sendJSON(res, 500, { error: String(e && e.message || e) });
    }
    return;
  }

  // 超前思考：我们落子后，浏览器喊这一声，服务端就去**预测对手的前几手应手，
  // 并把我们的答复逐条算好存进缓存**。对手真落子时命中就 0ms 直出。
  //
  // 旧做法（在对手要走的局面上空转、指望热置换表）实测是净负收益：
  // 慢 23%、浅 4.2 层，见 prepare.js 顶部的注释。
  if (rel === '/engine/ponder' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      if (!RAPFI_EXE) return sendJSON(res, 503, { error: '没有引擎' });
      const size = b.size | 0;
      const moves = Array.isArray(b.moves) ? b.moves : [];
      if (size < 5 || size > 22) return sendJSON(res, 400, { error: '尺寸 ' + size });
      const s = await getSession(String(b.gid || 'default'), size, b.rule | 0);
      // 宽度 = 预备对手的前几手。界面上的「超前思考」档位直接传过来。
      if (b.width != null && isFinite(b.width)) s.prep.width = Math.max(0, Math.min(8, b.width | 0));
      if (b.ms != null && isFinite(b.ms)) s.prep.perMoveMs = Math.max(500, b.ms | 0);
      // 不放进 serialize：它是「发起就返回」的，不能占住那条队列
      s.prep.start(moves);
      sendJSON(res, 200, { ok: true, width: s.prep.width });
    } catch (e) {
      sendJSON(res, 500, { error: String(e && e.message || e) });
    }
    return;
  }

  if (rel === '/engine/end' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const s = sessions.get(String(b.gid || 'default'));
      const gid = String(b.gid || 'default');
      if (s) { stopSession(s); sessions.delete(gid); note(`[会话] 正常关闭 ${gid}，剩 ${sessions.size} 个`); }
      // 正在创建中的那一份也要收掉：不然它建完会重新落进 sessions，
      // 变成一局结束后还留着一个 24 线程的进程。
      const pending = starting.get(gid);
      if (pending) {
        starting.delete(gid);
        pending.then(ns => { stopSession(ns); }, () => {});
      }
    } catch (e) {}
    sendJSON(res, 200, { ok: true });
    return;
  }

  // ---- 对局日志 ----
  // 允许跨源：这样即使页面是双击 index.html（file://）打开的，
  // 只要这个服务器在另一个终端里跑着，日志照样自动落盘 ——
  // 否则用户就得点「导出日志」下载再手动拖进 logs/，那是完全没必要的麻烦事。
  if (rel === '/log') {
    if (req.method !== 'POST') { res.writeHead(405, CORS).end(); return; }
    try {
      const g = await readBody(req);
      const id = String(g.id || Date.now()).replace(/[^\w.-]/g, '');
      // **晚到的旧快照不许覆盖新的。** 每手都整份上报，对手落子和 AI 应手常常只隔
      // 几十毫秒，两个 POST 同时在路上，到达顺序不保证。以前谁后到写谁 ——
      // 丢过最后一手，也丢过胜负（35 局里 5 局 AI 成五却记成「未完」）。
      // 浏览器每次上报带递增的 seq（log.js 的 flush），这里只收比见过的更新的。
      const seq = typeof g.seq === 'number' ? g.seq : 0;
      if (seq && seq <= (logSeq.get(id) || 0)) { sendJSON(res, 200, { ok: true, stale: true }); return; }
      if (seq) logSeq.set(id, seq);
      fs.mkdirSync(LOGDIR, { recursive: true });
      fs.writeFileSync(path.join(LOGDIR, id + '.json'), JSON.stringify(g));
      // **胜负要回灌进记忆库。** 只有这里知道这局最后赢没赢 ——
      // 没有这一步，记忆库就只会把「引擎当时怎么想」固化下来，
      // 包括那条被对手破掉的线（实战为此输过一局）。
      // 同一局、同一个结果只回灌一次：分出胜负之后还会有上报（回填 played 之类），
      // 每次都 ingest 的话胜负会被重复计数、复查队列也会重复排。
      if (MEMO_ON && g.result && logIngested.get(id) !== g.result) {
        logIngested.set(id, g.result);
        try {
          const rr = memo.ingest(g, g.rule | 0);
          if (rr && rr.marks.length) {
            const st = memo.stats();
            note('[记忆] ' + rr.result + ' —— ' + rr.marks.map(m =>
              '第 ' + m.ply + ' 手 ' + m.label + ' 记' + (m.field === 'w' ? '胜' : '负')).join('、') +
              '（库里 ' + st.positions + ' 个局面 / ' + st.moves + ' 手' +
              (rr.queued ? '，' + rr.queued + ' 个局面排进复查' : '') + '）');
          }
        } catch (e) { note('[记忆] 回灌失败：' + e.message); }
      }
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 400, { ok: false });
    }
    return;
  }

  // ---- 静态文件 ----
  if (rel === '/') rel = '/index.html';
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 ' + rel); return; }
    // **网页文件一律不缓存。** 改完代码忘了强制刷新，浏览器会静默用旧的 js ——
    // 实战坑过一次：用户跑了一个多小时改之前的版本，日志里少了一半字段，
    // 我还差点去怪他没重启。本地服务器没有带宽问题，不缓存的代价是零。
    const ext = path.extname(file).toLowerCase();
    const noCache = ext === '.html' || ext === '.js' || ext === '.css';
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-store, must-revalidate' : 'no-cache',
      // 这两个头是 SharedArrayBuffer 的准入条件（「跨源隔离」）。
      // 没有它们 SharedArrayBuffer 用不了，多线程各搜各的、无法共享置换表，
      // 并行搜索就完全失去意义 —— ui.js 会检测到并自动退回单线程。
      // 代价是本页面不能再嵌入任何未声明 CORP 的跨源资源；本项目零外部依赖，无影响。
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    });
    res.end(buf);
  });
});

// Node 默认 5 秒就关掉空闲连接。对局时浏览器的空闲期是「等对手落子、再把他的着法
// 录进来」，二三十秒很正常 —— 连接被关掉后客户端若正好复用它，
// 拿到的就是 ECONNRESET（实测 e2e-timing.js 每局必中）。放宽到 2 分钟。
// headersTimeout 必须大于 keepAliveTimeout，否则 Node 会拿它当上限。
srv.keepAliveTimeout = 120000;
srv.headersTimeout   = 125000;

srv.listen(PORT, () => {
  console.log(`五子棋已启动 -> http://localhost:${PORT}/`);
  console.log(`对局日志会写进 ${path.relative(ROOT, LOGDIR)}/ （npm run logs 查看）`);
  console.log('已发送 COOP/COEP 响应头：SharedArrayBuffer 可用，并行搜索会自动启用');
  if (RAPFI_EXE) {
    console.log(`Rapfi 内核已就绪：${RAPFI_EXE}`);
    console.log(`算力切分：主引擎 ${THREADS} 线程 + ${PREP_ENGINES} 个预备引擎各 ${PREP_THREADS} 线程` +
                ` = ${THREADS + PREP_ENGINES * PREP_THREADS} / ${CPUS} 核` +
                (THREADS + PREP_ENGINES * PREP_THREADS > CPUS ? '  ⚠ 超过物理核数，会互相抢' : ''));
    console.log(`（改这三个：RAPFI_THREADS / RAPFI_PREP_ENGINES / RAPFI_PREP_THREADS）`);
  }
  else console.log('未找到 Rapfi（engines/rapfi/），网页会退回自研 JS 引擎');
  console.log('（Ctrl+C 退出）');
});

process.on('SIGINT', () => {
  // **退出前把记忆库同步写完。** 对局中的落盘是攒 15 秒异步写的，
  // 不在这儿补一刀的话，最后十几秒记下来的东西会跟着进程一起没。
  try { memo.save(true); } catch (e) {}
  for (const s of sessions.values()) stopSession(s);
  process.exit(0);
});
