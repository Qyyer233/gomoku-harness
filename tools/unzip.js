/*
 * unzip.js — 最小可用的 ZIP 读取器（零依赖）
 *
 * 只做两件事：列出条目、取出某个条目的内容。用 Node 自带的 zlib.inflateRaw
 * 解 deflate，不引任何第三方包（这个项目一直是零依赖的）。
 *
 * 为什么不用 tar.exe / Expand-Archive：前者在这台机器上认不出 Gomocup 的包，
 * 后者报错没有可读信息。自己解反而能明确告诉你「包是坏的」还是「格式不支持」。
 *
 * 用法：
 *   const { open } = require('./unzip.js');
 *   const zip = open('a.zip');
 *   zip.entries.filter(e => e.name.endsWith('.psq'))
 *      .forEach(e => console.log(e.name, zip.read(e).length));
 */
'use strict';
const fs = require('fs');
const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;   // PK\5\6  中央目录结束记录
const SIG_CEN  = 0x02014b50;   // PK\1\2  中央目录项
const SIG_LOC  = 0x04034b50;   // PK\3\4  本地文件头

function open(file) {
  const buf = fs.readFileSync(file);

  // EOCD 在文件末尾，但后面可能跟着最多 64KB 的注释，所以要往回找
  let eocd = -1;
  const from = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0)
    throw new Error('不是完整的 ZIP：找不到中央目录结束记录（多半是下载被截断了）');

  const count  = buf.readUInt16LE(eocd + 10);
  const cenOff = buf.readUInt32LE(eocd + 16);
  if (cenOff === 0xffffffff)
    throw new Error('这是 ZIP64 格式，本工具不支持');

  const entries = [];
  let p = cenOff;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== SIG_CEN)
      throw new Error(`第 ${i} 个中央目录项的签名不对，文件可能损坏`);
    const method   = buf.readUInt16LE(p + 10);
    const crc32    = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size     = buf.readUInt32LE(p + 24);
    const nameLen  = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen   = buf.readUInt16LE(p + 32);
    const locOff   = buf.readUInt32LE(p + 42);
    const name     = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, crc32, compSize, size, locOff,
                   isDir: name.endsWith('/') });
    p += 46 + nameLen + extraLen + cmtLen;
  }

  /** 取出一个条目的内容（Buffer） */
  function read(entry) {
    const o = entry.locOff;
    if (buf.readUInt32LE(o) !== SIG_LOC) throw new Error(`${entry.name}: 本地文件头签名不对`);
    // 本地头里的名字/扩展字段长度可能和中央目录里的不同，必须按本地头来
    const nameLen  = buf.readUInt16LE(o + 26);
    const extraLen = buf.readUInt16LE(o + 28);
    const start = o + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + entry.compSize);
    if (entry.method === 0) return Buffer.from(raw);            // 未压缩
    if (entry.method === 8) return zlib.inflateRawSync(raw);    // deflate
    throw new Error(`${entry.name}: 不支持的压缩方式 ${entry.method}`);
  }

  return { entries, read, file };
}

module.exports = { open };

if (require.main === module) {
  const f = process.argv[2];
  if (!f) { console.log('用法：node tools/unzip.js <zip 文件> [列出前 N 个条目]'); process.exit(1); }
  const z = open(f);
  const n = parseInt(process.argv[3] || '15', 10);
  console.log(`${z.entries.length} 个条目`);
  const byExt = new Map();
  for (const e of z.entries) {
    if (e.isDir) continue;
    const ext = (e.name.match(/\.[^./]*$/) || ['(无)'])[0].toLowerCase();
    byExt.set(ext, (byExt.get(ext) || 0) + 1);
  }
  console.log('扩展名：' + [...byExt].sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}×${v}`).join('  '));
  const top = new Map();
  for (const e of z.entries) {
    const d = e.name.split('/')[0];
    top.set(d, (top.get(d) || 0) + 1);
  }
  console.log('顶层：');
  for (const [k, v] of [...top].sort((a, b) => b[1] - a[1]).slice(0, n))
    console.log(`  ${String(v).padStart(7)}  ${k}`);
}
