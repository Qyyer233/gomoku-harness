/*
 * fetch-gomocup.js — 下载 Gomocup 历年比赛的对局记录
 *
 * 为什么要有这个：之前库里全是**自对弈**棋谱 —— 引擎跟自己下，
 * 学到的只有自己已经会的东西。Gomocup 是五子棋 AI 的世界赛，
 * 历年对局都公开，而且**自由规则组和我们的规则完全一致**，
 * 参赛的就是 Rapfi / Yixin / JAX 这些顶尖引擎。这是现成的轮子，没有理由不用。
 *
 * ⚠ 但要先知道一件事：Gomocup 只打 **15×15 和 20×20**，没有 12 路。
 *   开局理论不能跨尺寸搬 —— 12 路中心离边只有 5~6 格，15 路是 7 格，
 *   同一个棋形的价值完全不同。所以这些棋谱对 **15 路有用，对 12 路没用**。
 *   12 路只能靠 book-rapfi.js 自己算（好在 Rapfi 比任何人类都强）。
 *
 * 下载本身有个坑：服务器会在中途断流（实测 61MB 的包只传了 28MB 就断，
 * 而且 curl 不报错）。所以这里**必须核对 Content-Length 并断点续传**，
 * 否则拿到的是个解不开的半截 ZIP。
 *
 * 用法：
 *   node tools/fetch-gomocup.js 2025 2024 2023
 *   node tools/fetch-gomocup.js --list          # 只看有哪些年份可下
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const OUT_DIR = path.join(__dirname, '..', 'data', 'gomocup');
const url = y => `https://gomocup.org/static/tournaments/${y}/results/gomocup${y}results.zip`;

function head(u) {
  return new Promise((resolve, reject) => {
    https.request(u, { method: 'HEAD' }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return resolve(head(new URL(res.headers.location, u).toString()));
      resolve({ status: res.statusCode, size: parseInt(res.headers['content-length'] || '0', 10) });
    }).on('error', reject).end();
  });
}

/** 断点续传下载，直到本地大小和服务器一致为止 */
async function fetchOne(year, tries) {
  const u = url(year);
  const dst = path.join(OUT_DIR, `gomocup${year}.zip`);
  let info;
  try { info = await head(u); } catch (e) { console.log(`  ${year}  HEAD 失败：${e.message}`); return null; }
  if (info.status !== 200 || !info.size) { console.log(`  ${year}  服务器没有（HTTP ${info.status}）`); return null; }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  // **不要用 `curl -C -` 续传。** 这个服务器虽然声明 Accept-Ranges，实际却不认
  // Range 请求，于是 curl 把整个文件又追加了一遍 —— 28.8MB 的半截变成 90.6MB 的垃圾
  // （实测踩过）。所以每次都下整份到临时文件，大小对上了才搬到位。
  const tmp = dst + '.part';
  for (let i = 0; i < (tries || 5); i++) {
    if (fs.existsSync(dst) && fs.statSync(dst).size === info.size) break;
    process.stdout.write(`  ${year}  第 ${i + 1}/${tries || 5} 次，共 ` +
                         `${(info.size / 1e6).toFixed(1)}MB …\n`);
    try {
      fs.rmSync(tmp, { force: true });
      // --ssl-revoke-best-effort：这台机器连不上证书吊销服务器（证书链仍然校验）
      execFileSync('curl.exe',
        ['-sL', '--retry', '3', '--retry-connrefused', '--ssl-revoke-best-effort', '-o', tmp, u],
        { stdio: 'ignore' });
    } catch (e) { /* 下一轮重来 */ }
    const got = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
    if (got === info.size) { fs.rmSync(dst, { force: true }); fs.renameSync(tmp, dst); }
    else { console.log(`      只拿到 ${(got / 1e6).toFixed(1)}MB，重来`); fs.rmSync(tmp, { force: true }); }
  }
  const got = fs.existsSync(dst) ? fs.statSync(dst).size : 0;
  if (got !== info.size) {
    console.log(`  ${year}  ✗ 下不全：${got} / ${info.size}，已删除`);
    if (fs.existsSync(dst)) fs.unlinkSync(dst);
    return null;
  }
  // ZIP 的「中央目录结束记录」在文件末尾，有它才说明是完整包
  const fd = fs.openSync(dst, 'r');
  const tail = Buffer.alloc(Math.min(66000, got));
  fs.readSync(fd, tail, 0, tail.length, got - tail.length);
  fs.closeSync(fd);
  if (tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) < 0) {
    console.log(`  ${year}  ✗ 大小对了但找不到 ZIP 结束记录，文件是坏的`);
    return null;
  }
  console.log(`  ${year}  ✓ ${(got / 1e6).toFixed(1)}MB，完整`);
  return dst;
}

async function main() {
  const years = process.argv.slice(2).filter(a => /^\d{4}$/.test(a));
  if (process.argv.includes('--list') || !years.length) {
    console.log('探测有哪些年份可下（Gomocup 只有 15×15 和 20×20，没有 12 路）：');
    for (let y = 2026; y >= 2015; y--) {
      try {
        const i = await head(url(y));
        if (i.status === 200 && i.size) console.log(`  ${y}  ${(i.size / 1e6).toFixed(1)} MB`);
      } catch (e) { /* 跳过 */ }
    }
    console.log('\n用法：node tools/fetch-gomocup.js 2025 2024 2023');
    return;
  }
  console.log(`下载到 ${path.relative(path.join(__dirname, '..'), OUT_DIR)}/\n`);
  const ok = [];
  for (const y of years) { const f = await fetchOne(y); if (f) ok.push(y); }
  console.log(`\n完整下载 ${ok.length}/${years.length} 个：${ok.join(' ') || '（无）'}`);
  if (ok.length) console.log('下一步：node tools/import-gomocup.js  （解包并筛出自由规则对局）');
}

main().catch(e => { console.error(e); process.exit(1); });
