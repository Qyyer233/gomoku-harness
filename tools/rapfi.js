/*
 * rapfi.js — Rapfi 引擎进程驱动（Gomocup / Yixin 协议）
 *
 * 这是我们和 Rapfi 之间唯一的接口。上层（HTTP 桥、验证对局、棋谱库生成）
 * 都只依赖这个类，不直接碰协议。
 *
 * 几个必须守住的协议细节（都写在 Rapfi/command/gomocup.cpp 里）：
 *
 * 1. **引擎在思考时会丢弃除 STOP/END 之外的一切命令**
 *    （`else if (thinking) return false;`）。所以发命令前必须确认它不在思考。
 *
 * 2. **后台思考是引擎自带的**：`INFO PONDERING 1` 打开之后，它每输出一手就
 *    立刻在新局面上继续算；下一条 TURN 到达时先停思考再开搜，置换表已经热了。
 *    这意味着我们**不需要**给 Rapfi 重写一套超前思考 —— 但前提是
 *    **进程要跨整局存活**，而且要用 TURN 增量推进，不能每手都 BOARD 重置。
 *    这是本文件里 play() 要做增量判断的全部理由。
 *
 * 3. 坐标用 Piskvork 的 `x,y`（config.toml 里 coord_conversion_mode = "none"）。
 *    落子两个方向都用同一套 (x, y)，所以对局不会错。
 *    但**它打印的 PV 标签和我们的行号方向相反**（实测：同一点 (6,0)，
 *    Rapfi 叫 `G1`，我们叫 `G12`），直接显示会误导人 —— 见下面的 labelToXY。
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ENGINE_DIR = path.join(__dirname, '..', 'engines', 'rapfi');

/** 按本机 CPU 支持的指令集挑最快的一个可执行文件 */
function pickExe(dir) {
  const order = [
    'pbrain-rapfi-windows-avx512vnni.exe',
    'pbrain-rapfi-windows-avxvnni.exe',
    'pbrain-rapfi-windows-avx512.exe',
    'pbrain-rapfi-windows-avx2.exe',
    'pbrain-rapfi-windows-sse.exe'
  ];
  for (const n of order) if (fs.existsSync(path.join(dir, n))) return n;
  return null;
}

class Rapfi {
  constructor(opts) {
    opts = opts || {};
    this.dir      = opts.dir || ENGINE_DIR;
    this.exe      = opts.exe || pickExe(this.dir);
    this.threads  = opts.threads || 0;        // 0 = 交给 config.toml
    this.pondering = opts.pondering !== false;
    this.maxMemory = opts.maxMemory || 1024 * 1024 * 1024;
    this.showDetail = opts.showDetail ? 1 : 0;
    this.nnue     = opts.nnue !== false;      // false = 用不带 NNUE 的配置跑（做对照用）
    this.config   = opts.config || null;      // 指定别的 config.toml
    this.rule     = opts.rule == null ? 0 : opts.rule;   // 0 = 自由规则
    // 合成比赛总时限 = 单手预算 × matchSpread，用来激活 Rapfi 的自适应用时。
    // 0 = 关掉（那样每手都会烧满预算）。详见 _think 里的注释。
    this.matchSpread = opts.matchSpread == null ? 12 : opts.matchSpread;

    this.proc = null;
    this.size = 0;
    this.moves = [];        // 已经同步给引擎的着法（[x,y] 数组，从第一手起）
    this.about = '';
    this.lastInfo = [];     // 最近一次搜索的 MESSAGE 行，给日志用
    this.nnueActive = null; // 本局 NNUE 是否真的启用了
    this.weightFile = null;

    this._ponder = null;    // 我们主动发起的后台思考（见 startPonder）
    // 引擎内部棋盘是否已经和 this.moves 对不上。**后台思考一定会把它弄脏**：
    // 协议里引擎输出着法就等于在它自己的棋盘上落子，而我们这边的 this.moves
    // 是还原过的。脏了之后若还走增量 TURN，那颗子会被当成对方的棋，
    // 连「轮到谁」都跟着反过来 —— 实战为此输掉过一整局。
    this._boardDirty = false;
    this._buf = '';
    this._waiters = [];     // {match, resolve, reject, timer}
    this._dead = null;
  }

  /* ---------- 进程生命周期 ---------- */

  async start() {
    if (!this.exe) throw new Error('engines/rapfi 下没找到 Rapfi 可执行文件');
    const args = [];
    if (this.config) args.push('--config=' + this.config);
    this.proc = spawn(path.join(this.dir, this.exe), args, { cwd: this.dir });
    this.proc.stdout.on('data', d => this._onData(String(d)));
    this.proc.stderr.on('data', () => {});
    this.proc.on('exit', (code) => {
      this._dead = new Error('Rapfi 进程已退出 (code=' + code + ')');
      for (const w of this._waiters.splice(0)) { clearTimeout(w.timer); w.reject(this._dead); }
    });
    this.proc.on('error', e => {
      this._dead = e;
      for (const w of this._waiters.splice(0)) { clearTimeout(w.timer); w.reject(e); }
    });
    this.about = await this._ask('ABOUT', l => l.startsWith('name='), 10000);
    return this.about;
  }

  stop() {
    if (!this.proc) return;
    try { this.proc.stdin.write('END\n'); } catch (e) {}
    const p = this.proc;
    this.proc = null;
    setTimeout(() => { try { p.kill(); } catch (e) {} }, 300).unref();
  }

  /* ---------- 底层收发 ---------- */

  _onData(chunk) {
    this._buf += chunk;
    let i;
    while ((i = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, i).replace(/\r$/, '');
      this._buf = this._buf.slice(i + 1);
      this._onLine(line);
    }
  }

  _onLine(line) {
    if (/^MESSAGE /.test(line)) {
      const m = line.slice(8);
      this.lastInfo.push(m);
      if (this.lastInfo.length > 200) this.lastInfo.shift();
      // 记下这一局到底有没有用上 NNUE，以及用的是哪份权重
      if (/disabled: no compatible weight config/.test(m)) this.nnueActive = false;
      const w = m.match(/load weight from (.+)$/);
      if (w) { this.nnueActive = true; this.weightFile = path.basename(w[1].trim()); }
      return;
    }
    if (/^(DEBUG|UNKNOWN) /.test(line)) return;
    for (let k = 0; k < this._waiters.length; k++) {
      if (this._waiters[k].match(line)) {
        const w = this._waiters.splice(k, 1)[0];
        clearTimeout(w.timer);
        w.resolve(line);
        return;
      }
    }
  }

  _send(cmd) {
    if (this._dead) throw this._dead;
    this.proc.stdin.write(cmd + '\n');
  }

  _wait(match, timeoutMs, what) {
    return new Promise((resolve, reject) => {
      if (this._dead) return reject(this._dead);
      const w = { match, resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        const k = this._waiters.indexOf(w);
        if (k >= 0) this._waiters.splice(k, 1);
        reject(new Error('等 ' + what + ' 超时（' + timeoutMs + 'ms）'));
      }, timeoutMs);
      this._waiters.push(w);
    });
  }

  _ask(cmd, match, timeoutMs) {
    const p = this._wait(match, timeoutMs, cmd);
    this._send(cmd);
    return p;
  }

  /* ---------- 对局 ---------- */

  /** 开新局。size 是路数。 */
  async newGame(size, opts) {
    opts = opts || {};
    this.size = size;
    this.moves = [];
    this._boardDirty = false;
    this.nnueActive = null;
    this.weightFile = null;

    const r = await this._ask('START ' + size, l => /^(OK|ERROR)/.test(l), 30000);
    if (!/^OK/.test(r)) throw new Error(size + ' 路开局被拒：' + r);

    this._send('INFO RULE ' + this.rule);
    this._send('INFO MAX_MEMORY ' + this.maxMemory);
    if (this.threads > 0) this._send('INFO THREAD_NUM ' + this.threads);
    this._send('INFO PONDERING ' + (this.pondering ? 1 : 0));
    this._send('INFO SHOW_DETAIL ' + this.showDetail);
    if (opts.timeoutMatch != null) this._send('INFO TIMEOUT_MATCH ' + opts.timeoutMatch);
    if (opts.maxNodes) this._send('INFO MAX_NODE ' + opts.maxNodes);
  }

  /**
   * 让引擎在给定局面下走一手。
   * `moves` 是**整局**着法（[x,y]，从第一手起），轮到引擎走。
   *
   * 只要新局面正好是上次同步过的局面再加对手一手，就用 TURN 增量推进 ——
   * 这样引擎的置换表和后台思考成果才留得住。否则才用 BOARD 整盘重置。
   */
  async think(moves, budgetMs) {
    // **收掉后台思考也要计时。** endPonder 要发 STOP 再等引擎真的吐出一手，
    // 24 线程下实测要几百毫秒。以前这段在 _think 的 t0 之前，等于白送出去的时间 ——
    // 「充分」档下 6000ms 的上限跑出 6220ms，差的就是它。
    const t0 = Date.now();
    await this.endPonder();
    const stopMs = Date.now() - t0;
    const r = await this._think(moves, Math.max(50, (budgetMs | 0) - stopMs));
    // 返回的 ms 也要含上这段，否则日志里的用时比用户真等的短一截
    r.ms += stopMs;
    r.ponderStopMs = stopMs;
    return r;
  }

  /**
   * 主动发起后台思考。
   *
   * Rapfi 自带的常驻思考（INFO PONDERING 1）只在**它自己出手之后**才启动。
   * 可我们开局是查棋谱库直出的，Rapfi 根本没参与，于是对手思考的那十几二十秒
   * 就白白浪费了 —— 而实战里这段空闲比 AI 自己的思考时间还长。
   * 所以库命中之后由我们显式喊一声，让它在「我们已经落子、等对手应手」的局面上先算着。
   *
   * 结果不要，要的只是热置换表。下一次 think() 会先 STOP 它。
   * 注意 BOARD 不清置换表（只有 START / 换规则才清），所以即便下一手因为
   * 对手走了别的而需要整盘重置，烘热的东西照样留得住。
   */
  startPonder(moves, maxMs) {
    if (this._ponder || !this.size) return;
    // **不能让后台思考动 this.moves。** `_think` 结束时会把「局面 + 引擎给出的那一手」
    // 记成当前进度，可后台思考猜的那一手对手多半不会走 —— 于是下一次真求着时
    // 增量判断必然失败，每手都退化成 BOARD 整盘重置。
    // 实战日志里每一手都标着「局面重置」就是这么来的。
    const keep = this.moves;
    // 从这一刻起引擎的棋盘就可能和我们对不上了（它会在后台真的落一子）。
    // 标记在**发起时**而不是结束时：中途出错、超时、进程重启都一样不可信。
    this._boardDirty = true;
    this._ponder = this._think(moves, maxMs || 600000)
      // **还原 this.moves 的同时必须重新标脏。** 后台思考自己也走 _think，
      // 而 _think 结尾会把 _boardDirty 清掉（它认为棋盘已对齐）—— 可我们紧接着
      // 就把 this.moves 退回到后台思考之前的值，两边立刻又对不上了。
      // 少了这一行，整个脏标记形同虚设（第一版补丁就栽在这里）。
      .then(() => { this.moves = keep; this._boardDirty = true; },
            () => { this.moves = keep; this._boardDirty = true; });
  }

  /**
   * 清空棋盘但保留已加载的权重和置换表。
   * 预热之后必须调一次 —— 预热搜索会让引擎在内部棋盘上真的落一子。
   */
  restart() {
    this._send('RESTART');
    this.moves = [];
    this._boardDirty = false;   // RESTART 把引擎棋盘也清了，两边重新对齐
  }

  /** 收掉后台思考并等它真的停下来（协议是一问一答的，不等会串线） */
  async endPonder() {
    if (!this._ponder) return;
    this.stopThinking();
    const p = this._ponder;
    this._ponder = null;
    await p;
  }

  async _think(moves, budgetMs) {
    if (!this.size) throw new Error('还没 START');
    const ms = Math.max(50, budgetMs | 0);
    this.lastInfo = [];
    // **留够收尾余量。** 发 STOP 之后 Rapfi 不是立刻回话：24 条线程要停下来、
    // 汇总结果、打印 PV，实测这段要 ~500ms。原先只留 120ms，于是「充分」档
    // （每手想满）下 119 手里超限 3 次，最大超出 380ms。
    // 余量按预算的 10% 给，夹在 200~800ms；短预算再按 40% 封顶，免得预热那种
    // 50ms 的调用被砍没。
    const reserve = Math.min(
      Math.min(Math.max(Math.round(ms * 0.10), 200), 800),
      Math.floor(ms * 0.4)
    );
    const turnMs = Math.max(20, ms - reserve);
    this._send('INFO TIMEOUT_TURN ' + turnMs);
    // **只给 TIMEOUT_TURN 的话，Rapfi 每一手都会把预算烧满。**
    // 原因在 search/timecontrol.cpp：matchTime==0 时 matchTimeLeft 被设成无穷大，
    // 于是 ampleMatchTime 恒为 true，而 checkStop 在那个分支里直接
    // `return elapsed() >= optimum()` —— 着法稳定性、评分波动、延长/缩短
    // 那一整套自适应逻辑全在 !ampleMatchTime 分支里，根本不执行。
    //
    // 所以这里**合成一个比赛总时限**把它激活。我们其实是每手一个时钟
    // （实战是 15 秒读秒），这个值不是真实剩余时间，
    // 而是一个调节旋钮：matchSpread 越小，基线用时越短。
    //
    // **两个分支都必须发。** 只在 matchSpread>0 时发的话，上一次设的总时限会残留 ——
    // 实测：预热用 50ms 预算设下 TIMEOUT_MATCH=1050，随后切到「每手想满」却不覆盖它，
    // 于是引擎以为整局只剩 1 秒，6 秒预算的一手只用了 52ms。
    // 试过给后台思考单独关掉自适应用时（spread=0），**实测更差**：
    // 3 子局面 8 秒窗口，沿用 matchSpread 烧 237 核秒，关掉只烧 76 核秒。
    // 所以后台思考和正式出手用同一套用时策略，别再改了。
    if (this.matchSpread > 0) {
      const left = Math.round(turnMs * this.matchSpread);
      this._send('INFO TIMEOUT_MATCH ' + left);
      this._send('INFO TIME_LEFT ' + left);
    } else {
      // 0 = 关掉自适应，明确告诉它比赛时间无限（2147483647 是协议里的「无限」）
      this._send('INFO TIMEOUT_MATCH 0');
      this._send('INFO TIME_LEFT 2147483647');
    }

    const prev = this.moves;
    const afterPonder = this._boardDirty;   // 供界面区分「正常重置」和「异常重置」
    // 棋盘脏了就只能整盘重置。代价几乎为零：BOARD **不清置换表**
    //（只有 START / 换规则才清），后台思考烘热的东西照样留得住。
    const incremental = !this._boardDirty &&
      moves.length === prev.length + 1 &&
      prev.every((m, i) => m[0] === moves[i][0] && m[1] === moves[i][1]);

    const t0 = Date.now();
    const isMove = l => /^\d+,\d+$/.test(l);
    // 引擎最慢也该在预算 + 启动/落盘余量内回话；超过就是真出问题了
    const guard = ms + 20000;

    // **硬性掐表。** Rapfi 的时限是软的：它只在每层迭代之间检查时间，
    // 一层开始时还剩 800ms、而这一层要跑 1500ms，它就会冲过去 700ms。
    // 实战日志里 6000ms 的上限跑出 6262ms 就是这么来的
    // （`turn_time_reserved` 只是把目标往前挪，挡不住一层的超出）。
    //
    // 实战是 15 秒读秒，读完着法还要落子 —— 超时就是输棋，
    // 所以这里到点直接发 STOP，Rapfi 会立刻交出当前最优手。
    // 掐在 turnMs（= 预算 - 收尾余量）上，这样即便 Rapfi 自己的软时限没拦住，
    // STOP 发出后还有整段 reserve 供它收尾，总时长仍在预算内。
    // 只在预算够长时才武装：预算极短（比如预热那次 50ms）时，STOP 可能在引擎
    // 还没真正进入搜索时就到达，撞出竞态让它既不搜也不回话（实测会卡死到超时）。
    // 短预算本来也不会超限，不需要这道保险。
    const hardStop = ms >= 500 ? setTimeout(() => {
      try { this._send('STOP'); } catch (e) {}
    }, turnMs) : null;

    let line;
    try {
    // BEGIN 只在**引擎自己也还没落过子**时才合法。预热搜索会让它在内部棋盘上
    // 真的落一手，这之后再发 BEGIN 就是在非空盘上重开一局 —— 实测引擎直接不回话。
    // 所以引擎已有落子记录时，空局面也走 BOARD 那条路（发 BOARD + DONE，零颗子）。
    if (moves.length === 0 && this.moves.length === 0 && !this._boardDirty) {
      line = await this._ask('BEGIN', isMove, guard);
    } else if (incremental) {
      const last = moves[moves.length - 1];
      line = await this._ask('TURN ' + last[0] + ',' + last[1], isMove, guard);
    } else {
      const p = this._wait(isMove, guard, 'BOARD 之后的着法');
      this._send('BOARD');
      // 1 = 该走的一方（也就是引擎自己）的子，2 = 对手的子
      const mine = moves.length % 2;          // moves.length 手之后轮到谁，谁就是 1
      for (let i = 0; i < moves.length; i++)
        this._send(moves[i][0] + ',' + moves[i][1] + ',' + (i % 2 === mine ? 1 : 2));
      this._send('DONE');
      line = await p;
    }

    const xy = line.split(',');
    const mv = [parseInt(xy[0], 10), parseInt(xy[1], 10)];
    this.moves = moves.concat([mv]);
    // BEGIN / TURN / BOARD 都已把引擎棋盘对齐到 moves，再加上它刚落的这一子
    this._boardDirty = false;
    const info = parseInfo(this.lastInfo);
    return {
      x: mv[0], y: mv[1],
      ms: Date.now() - t0,
      incremental: incremental || moves.length === 0,
      afterPonder,
      depth: info.depth, seldepth: info.seldepth,
      eval: info.eval, evalText: info.evalText, mate: info.mate,
      nodes: info.nodes, speed: info.speed, engineMs: info.engineMs, pv: info.pv, pvXY: info.pvXY,
      lines: this.lastInfo.filter(l => /\bDepth \d+/.test(l)),
      nnue: this.nnueActive,
      weight: this.weightFile
    };
    } finally {
      if (hardStop) clearTimeout(hardStop);
    }
  }

  /**
   * 多着法分析：返回该局面下排名前 multiPV 的着法。造开局库用。
   *
   * 用 YXBOARD 摆局面（它**不触发搜索**，和 BOARD 不一样），再发 YXNBEST n。
   * 引擎会边搜边吐 `(k) 分数 | 深度-选择深度 | PV` 这样的行，最后照常给出着法。
   *
   * 注意各档候选会随着搜索加深被逐个淘汰 —— 深层可能只剩 (1) 一条。
   * **必须取同一层里的那一批**：早期版本按「每档最后一次出现」取，结果
   * 第 17 层的 (2) 和第 16 层的 (4) 撞成了同一个点，候选表里出现重复。
   * 同一次迭代的各档共享 Depth 的第一个数字，所以按它分组，取层数最深的那组。
   */
  async analyse(moves, budgetMs, multiPV) {
    await this.endPonder();          // 不然两个等待者会抢同一行输出
    if (!this.size) throw new Error('还没 START');
    const n = Math.max(1, multiPV | 0);
    const ms = Math.max(50, budgetMs | 0);
    this.lastInfo = [];
    this._send('INFO TIMEOUT_TURN ' + ms);

    const t0 = Date.now();
    const isMove = l => /^\d+,\d+$/.test(l);
    const p = this._wait(isMove, ms + 20000, 'YXNBEST 之后的着法');
    this._send('YXBOARD');
    const mine = moves.length % 2;
    for (let i = 0; i < moves.length; i++)
      this._send(moves[i][0] + ',' + moves[i][1] + ',' + (i % 2 === mine ? 1 : 2));
    this._send('DONE');
    this._send('YXNBEST ' + n);
    const line = await p;

    const xy = line.split(',').map(Number);
    this.moves = moves.concat([xy]);
    // YXNBEST 之后引擎内部棋盘上有没有落下这一子，协议没有保证。
    // 下一次 think 若按增量 TURN 推进而引擎盘上其实少一子（或多一子），
    // 就是「引擎换了个颜色思考」那种事故（实战为此输掉过一局，见 _boardDirty 的注释）。标脏 = 下一次走 BOARD，
    // 代价几乎为零（BOARD 不清置换表）。
    this._boardDirty = true;

    const byDepth = new Map();       // 层数 -> 该层报出的各档候选
    for (const l of this.lastInfo) {
      const m = /^\((\d+)\)\s*([+-]?(?:M\d+|\d+))\s*\|\s*(\d+)-(\d+)\s*\|\s*(.+)$/.exec(l);
      if (!m) continue;
      const pv = m[5].trim().split(/\s+/);
      const mate = /^([+-]?)M(\d+)$/.exec(m[2]);
      const d = +m[3];
      if (!byDepth.has(d)) byDepth.set(d, new Map());
      byDepth.get(d).set(+m[1], {
        rank: +m[1],
        eval: mate ? null : parseInt(m[2], 10),
        mate: mate ? (mate[1] === '-' ? -1 : 1) * +mate[2] : 0,
        depth: d, seldepth: +m[4],
        pv, xy: labelToXY(pv[0])
      });
    }
    // 取「候选最全的那一层里最深的那一层」。
    // 不能只取最深的一层：深层里各档会被逐个淘汰，最后一层常常只剩 (1) 一条，
    // 于是造库时根本展不开分支（实测 width=2 只展出 1 个子局面）。
    let widest = 0;
    for (const group of byDepth.values()) widest = Math.max(widest, group.size);
    let deepest = null;
    for (const [d, group] of byDepth)
      if (group.size === widest && (!deepest || d > deepest[0])) deepest = [d, group];
    const seen = new Set();
    const cands = deepest
      ? [...deepest[1].values()].sort((a, b) => a.rank - b.rank).filter(c => {
          if (!c.xy) return false;
          const k = c.xy[0] + ',' + c.xy[1];
          if (seen.has(k)) return false;         // 同一层里本不该重复，防御性去重
          seen.add(k);
          return true;
        })
      : [];
    const info = parseInfo(this.lastInfo);
    // YXNBEST 只报一档时不会打 `(1)` 行，用主搜索结果兜底
    if (!cands.length) cands.push({
      rank: 1, eval: info.eval, mate: info.mate,
      depth: info.depth, seldepth: info.seldepth,
      pv: info.pv, xy: [xy[0], xy[1]]
    });
    // **引擎最终吐出的那一手才是权威**：最深的那批 (k) 行可能来自一次没搜完就
    // 被时限打断的迭代，它的 (1) 和最终着法可以不一致（实测见过）。
    // 所以把最终着法挪到第一位，没在候选里就补进去。
    const at = cands.findIndex(c => c.xy[0] === xy[0] && c.xy[1] === xy[1]);
    if (at > 0) cands.unshift(cands.splice(at, 1)[0]);
    else if (at < 0) cands.unshift({
      rank: 0, eval: info.eval, mate: info.mate,
      depth: info.depth, seldepth: info.seldepth,
      pv: info.pv, xy: [xy[0], xy[1]]
    });
    return {
      move: xy, ms: Date.now() - t0, cands,
      depth: info.depth, nodes: info.nodes,
      nnue: this.nnueActive, weight: this.weightFile
    };
  }

  /** 打断当前思考（后台思考也算）。 */
  stopThinking() { try { this._send('STOP'); } catch (e) {} }
}

/**
 * 解析 Rapfi 在 SHOW_DETAIL 下吐出的思维链。
 * 典型两种行：
 *   Depth 29-21 | Eval +M25 | Time 1972ms | F6 F5 H7 I7 ...
 *   Speed 1498K | Depth 29-21 | Eval +M25 | Node 2955K | Time 1972ms
 * 「+M25」是 25 步杀；普通分是整数。
 */
function parseInfo(lines) {
  // engineMs = 引擎自报的搜索用时。和我们量的墙钟时间分开记：两者一旦对不上，
  // 差额就是「引擎早算完了，但 Node 的事件循环被堵住、没及时把答案读出来」——
  // vs-js.js 里 js.bestMove() 是同步阻塞的，正是这种情况。量时间前先看这两个数对不对得上。
  const out = { depth: 0, seldepth: 0, eval: null, evalText: '', mate: 0, nodes: 0, speed: 0, engineMs: 0, pv: [] };
  const num = s => {
    const m = /^(-?[\d.]+)([KMG])?$/.exec(s);
    if (!m) return 0;
    const mul = { K: 1e3, M: 1e6, G: 1e9 }[m[2]] || 1;
    return Math.round(parseFloat(m[1]) * mul);
  };
  for (const l of lines) {
    if (!/\bDepth \d+/.test(l)) continue;
    let m;
    if ((m = /Depth (\d+)-(\d+)/.exec(l))) { out.depth = +m[1]; out.seldepth = +m[2]; }
    if ((m = /Eval ([+-]?(?:M\d+|[\d.]+))/.exec(l))) {
      out.evalText = m[1];
      const mate = /^([+-])M(\d+)$/.exec(m[1]);
      if (mate) { out.mate = (mate[1] === '-' ? -1 : 1) * +mate[2]; out.eval = null; }
      else { out.mate = 0; out.eval = parseFloat(m[1]); }
    }
    if ((m = /Node ([\d.]+[KMG]?)/.exec(l))) out.nodes = num(m[1]);
    if ((m = /Speed ([\d.]+[KMG]?)/.exec(l))) out.speed = num(m[1]);
    if ((m = /Time (\d+)ms/.exec(l))) out.engineMs = +m[1];
    const pv = /\|\s*([A-Z]\d+(?:\s+[A-Z]\d+)*)\s*$/.exec(l);
    if (pv) out.pv = pv[1].split(/\s+/);
  }
  out.pvXY = out.pv.map(labelToXY);
  return out;
}

/**
 * Rapfi 的标签 -> (x, y)。
 *
 * **两边的行号方向是相反的**，这点实测钉死过：同一个点 (6,0)，
 * Rapfi 叫 `G1`（行号 = y+1，从上往下数），我们的 Core.pToLabel 叫 `G12`
 * （行号 = SIZE-y，从下往上数）。落子走的是 x,y 数字，两个方向都一致所以不会下错；
 * 但**它打印的 PV 标签不能直接显示给用户**，必须先转回 (x,y) 再用 Core.pToLabel 重排。
 * 注意这个换算不需要知道棋盘多大。
 */
function labelToXY(label) {
  const m = /^([A-Z])(\d+)$/.exec(label);
  if (!m) return null;
  return [m[1].charCodeAt(0) - 65, parseInt(m[2], 10) - 1];
}

module.exports = { Rapfi, pickExe, parseInfo, labelToXY, ENGINE_DIR };
