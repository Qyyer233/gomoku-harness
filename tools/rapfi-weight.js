/*
 * rapfi-weight.js — 读/改 Rapfi NNUE 权重文件的头部
 *
 * 为什么需要这个：
 *   Rapfi 官方的自由规则权重 mix9svqfreestyle_bsmix 在文件头里写死了
 *   「适用棋盘尺寸 13~22 路」。我们打的 12 路刚好差一格，于是 12 路上
 *   NNUE 会被整个关掉、退回传统估值 —— 那是 Rapfi 大部分棋力的来源。
 *
 *   网络本身是全卷积的（同一份权重同时服务 13~22 路），尺寸清单更像是
 *   训练覆盖范围的声明而不是结构限制，所以「把 12 路加进清单」在技术上
 *   是可行的。但这是**我们自己加的声明，不是官方背书**，所以改完必须
 *   实测验证（tools/rapfi-verify.js），不能想当然。
 *
 * 文件格式（Rapfi/core/compressor.cpp + eval/weightloader.h）：
 *   整个文件是一个 LZ4 frame（blockLinked + contentChecksum + noBlockChecksum）。
 *   解压后的头 20 字节是：
 *     u32 magic           = 0xacd8cc6a
 *     u32 arch_hash       网络结构哈希，和引擎版本必须对上
 *     u32 rule_mask       1=自由 2=标准 4=连珠
 *     u32 boardsize_mask  第 i 位 = 支持 (i+1) 路
 *     u32 desc_len
 *
 *   运气好的是这 20 字节落在第一个块的**字面量**段里（未被压缩），
 *   所以改 boardsize_mask 只需在压缩流里改一个字节，不用重新压缩。
 *   但 frame 末尾的内容校验和（xxHash32）会因此失效，必须重算 ——
 *   于是这里实现了 LZ4 块解压和 xxHash32。
 *
 * 用法：
 *   node tools/rapfi-weight.js info  <权重文件>
 *   node tools/rapfi-weight.js patch <输入> <输出> --add-size 12
 */
'use strict';
const fs = require('fs');

/* ---------- xxHash32（LZ4 frame 的校验和算法） ---------- */
const P1 = 2654435761, P2 = 2246822519, P3 = 3266489917, P4 = 668265263, P5 = 374761393;
const mul = (a, b) => Math.imul(a, b) >>> 0;
const rotl = (x, r) => (((x << r) | (x >>> (32 - r)))) >>> 0;

function xxh32(buf, seed) {
  seed = seed >>> 0;
  const len = buf.length;
  let i = 0, h;
  if (len >= 16) {
    let v1 = (seed + P1 + P2) >>> 0, v2 = (seed + P2) >>> 0,
        v3 = seed >>> 0, v4 = (seed - P1) >>> 0;
    const limit = len - 16;
    do {
      v1 = mul(rotl((v1 + mul(buf.readUInt32LE(i), P2)) >>> 0, 13), P1); i += 4;
      v2 = mul(rotl((v2 + mul(buf.readUInt32LE(i), P2)) >>> 0, 13), P1); i += 4;
      v3 = mul(rotl((v3 + mul(buf.readUInt32LE(i), P2)) >>> 0, 13), P1); i += 4;
      v4 = mul(rotl((v4 + mul(buf.readUInt32LE(i), P2)) >>> 0, 13), P1); i += 4;
    } while (i <= limit);
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) >>> 0;
  } else {
    h = (seed + P5) >>> 0;
  }
  h = (h + len) >>> 0;
  while (i + 4 <= len) { h = mul(rotl((h + mul(buf.readUInt32LE(i), P3)) >>> 0, 17), P4); i += 4; }
  while (i < len)      { h = mul(rotl((h + mul(buf[i], P5)) >>> 0, 11), P1); i++; }
  h = (h ^ (h >>> 15)) >>> 0; h = mul(h, P2);
  h = (h ^ (h >>> 13)) >>> 0; h = mul(h, P3);
  h = (h ^ (h >>> 16)) >>> 0;
  return h >>> 0;
}

/* ---------- LZ4 块解压 ----------
 * 块之间是「链式」的（blockLinked）：后一块的回溯引用可以指到前一块的输出里，
 * 所以所有块解到同一个输出缓冲区，偏移直接对整个输出算即可。 */
function blockDecompress(src, sOff, sEnd, out, dOff) {
  let s = sOff, d = dOff;
  while (s < sEnd) {
    const token = src[s++];
    let lit = token >>> 4;
    if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255); }
    for (let i = 0; i < lit; i++) out[d++] = src[s++];
    if (s >= sEnd) break;                 // 最后一段序列只有字面量，没有匹配
    const offset = src[s] | (src[s + 1] << 8); s += 2;
    let mlen = token & 15;
    if (mlen === 15) { let b; do { b = src[s++]; mlen += b; } while (b === 255); }
    mlen += 4;                            // minmatch
    let m = d - offset;
    for (let i = 0; i < mlen; i++) out[d++] = out[m++];  // 允许重叠，必须逐字节
  }
  return d;
}

/** 解析 LZ4 frame */
function readFrame(buf) {
  if (buf.readUInt32LE(0) !== 0x184D2204) throw new Error('不是 LZ4 frame（magic 不对）');
  const flg = buf[4], bd = buf[5];
  const version       = flg >>> 6;
  const blockChecksum = (flg >>> 4) & 1;
  const contentSize   = (flg >>> 3) & 1;
  const contentCksum  = (flg >>> 2) & 1;
  const dictId        = flg & 1;
  if (version !== 1) throw new Error('LZ4 frame 版本不是 1');
  let p = 6;
  if (contentSize) p += 8;
  if (dictId) p += 4;
  p += 1;                                  // header checksum (HC)

  let cap = 1 << 26, out = Buffer.alloc(cap), d = 0;
  const blocks = [];
  for (;;) {
    const n = buf.readUInt32LE(p); p += 4;
    if (n === 0) break;                    // EndMark
    const uncompressed = (n & 0x80000000) !== 0;
    const size = n & 0x7fffffff;
    const start = p, end = p + size;
    // 一个块最多解出 4MB 上下，留足余量再解，省得中途越界
    while (d + (1 << 23) > cap) {
      cap *= 2;
      const bigger = Buffer.alloc(cap);
      out.copy(bigger, 0, 0, d);
      out = bigger;
    }
    blocks.push({ start, end, uncompressed });
    if (uncompressed) { buf.copy(out, d, start, end); d += size; }
    else d = blockDecompress(buf, start, end, out, d);
    p = end;
    if (blockChecksum) p += 4;
  }
  const dataEnd = p;                       // EndMark 之后，内容校验和之前
  const storedChecksum = contentCksum ? buf.readUInt32LE(p) : null;
  return {
    flg, bd, blockChecksum, contentCksum,
    blocks, dataEnd, storedChecksum,
    decompressed: out.subarray(0, d)
  };
}

/** 解压后的偏移 -> 压缩文件里的偏移。只对「落在字面量段里」的字节有效，否则返回 -1。 */
function locateLiteralByte(buf, blocks, targetOut) {
  let d = 0;
  for (const blk of blocks) {
    if (blk.uncompressed) {
      const size = blk.end - blk.start;
      if (targetOut >= d && targetOut < d + size) return blk.start + (targetOut - d);
      d += size;
      continue;
    }
    let s = blk.start;
    while (s < blk.end) {
      const token = buf[s++];
      let lit = token >>> 4;
      if (lit === 15) { let b; do { b = buf[s++]; lit += b; } while (b === 255); }
      if (targetOut >= d && targetOut < d + lit) return s + (targetOut - d);  // 命中字面量
      s += lit; d += lit;
      if (s >= blk.end) break;
      s += 2;                               // match offset
      let mlen = token & 15;
      if (mlen === 15) { let b; do { b = buf[s++]; mlen += b; } while (b === 255); }
      mlen += 4;
      if (targetOut >= d && targetOut < d + mlen) return -1;  // 落在匹配段里，改不了
      d += mlen;
    }
  }
  return -1;
}

const MAGIC = 0xacd8cc6a;
const RULES = { 1: '自由(freestyle)', 2: '标准(standard)', 4: '连珠(renju)' };

function parseHeader(dec) {
  const magic = dec.readUInt32LE(0);
  if (magic !== MAGIC) throw new Error('权重 magic 不对：0x' + magic.toString(16));
  const descLen = dec.readUInt32LE(16);
  return {
    magic,
    archHash: dec.readUInt32LE(4),
    ruleMask: dec.readUInt32LE(8),
    sizeMask: dec.readUInt32LE(12),
    descLen,
    desc: dec.subarray(20, 20 + descLen).toString('utf8')
  };
}
const hex8 = n => '0x' + (n >>> 0).toString(16).padStart(8, '0');
const sizesOf = m => { const a = []; for (let i = 0; i < 32; i++) if (m & (1 << i)) a.push(i + 1); return a; };
const rulesOf = m => Object.keys(RULES).filter(k => m & k).map(k => RULES[k]);

function info(file) {
  const buf = fs.readFileSync(file);
  const fr = readFrame(buf);
  const h = parseHeader(fr.decompressed);
  const calc = xxh32(fr.decompressed, 0);
  const s = sizesOf(h.sizeMask);
  console.log('文件        ' + file);
  console.log('压缩后      ' + buf.length.toLocaleString() + ' 字节');
  console.log('解压后      ' + fr.decompressed.length.toLocaleString() + ' 字节');
  console.log('arch_hash   ' + hex8(h.archHash));
  console.log('适用规则    ' + (rulesOf(h.ruleMask).join('、') || '(无)') + '  [' + hex8(h.ruleMask) + ']');
  console.log('适用尺寸    ' + (s.length ? s[0] + '~' + s[s.length - 1] + ' 路' : '(无)') + '  [' + hex8(h.sizeMask) + ']');
  console.log('描述        ' + h.desc.split('\n')[0]);
  console.log('内容校验和  存 ' + hex8(fr.storedChecksum) + '  算 ' + hex8(calc) + '  ' +
              (calc === fr.storedChecksum ? '一致 ✓（本工具的解压实现自证正确）' : '不一致 ✗'));
  return calc === fr.storedChecksum;
}

function patch(inFile, outFile, addSizes) {
  const buf = fs.readFileSync(inFile);
  const fr = readFrame(buf);
  const h = parseHeader(fr.decompressed);

  // 自证：解压实现必须能复现原文件的校验和，否则后面算出来的新校验和也不可信
  const base = xxh32(fr.decompressed, 0);
  if (base !== fr.storedChecksum)
    throw new Error('解压/校验和实现有问题：算出 ' + hex8(base) + '，文件里是 ' + hex8(fr.storedChecksum));
  console.log('自检通过：本工具解压出的内容校验和与原文件一致');

  let mask = h.sizeMask;
  for (const n of addSizes) mask |= (1 << (n - 1));
  if (mask === h.sizeMask) { console.log('尺寸清单无需改动'); return; }

  const out = Buffer.from(buf);
  for (let k = 0; k < 4; k++) {            // boardsize_mask 在解压后偏移 12，共 4 字节
    const oldByte = (h.sizeMask >>> (k * 8)) & 0xff;
    const newByte = (mask >>> (k * 8)) & 0xff;
    if (oldByte === newByte) continue;
    const at = locateLiteralByte(buf, fr.blocks, 12 + k);
    if (at < 0) throw new Error('解压后偏移 ' + (12 + k) + ' 不在字面量段里，无法原地改');
    if (out[at] !== oldByte)
      throw new Error('定位错了：文件 0x' + at.toString(16) + ' 处是 0x' + out[at].toString(16) +
                      '，期望 0x' + oldByte.toString(16));
    out[at] = newByte;
    console.log('  改字节 文件偏移 0x' + at.toString(16) + ': 0x' + oldByte.toString(16).padStart(2, '0') +
                ' -> 0x' + newByte.toString(16).padStart(2, '0'));
  }

  // 重新解压，确认权重体一字未动，再重算内容校验和
  const fr2 = readFrame(out);
  if (fr2.decompressed.length !== fr.decompressed.length) throw new Error('改完之后解压长度变了');
  let diff = 0, firstDiff = -1;
  for (let i = 0; i < fr.decompressed.length; i++)
    if (fr.decompressed[i] !== fr2.decompressed[i]) { diff++; if (firstDiff < 0) firstDiff = i; }
  if (diff > 4 || (diff && (firstDiff < 12 || firstDiff > 15)))
    throw new Error('改完之后有 ' + diff + ' 个字节不同（首个在偏移 ' + firstDiff + '），只应该改 boardsize_mask');
  const h2 = parseHeader(fr2.decompressed);
  if (h2.archHash !== h.archHash || h2.ruleMask !== h.ruleMask || h2.descLen !== h.descLen)
    throw new Error('头部其他字段被破坏了');

  const newCksum = xxh32(fr2.decompressed, 0);
  out.writeUInt32LE(newCksum, fr2.dataEnd);
  fs.writeFileSync(outFile, out);

  console.log('权重体一字未动：解压后 ' + fr.decompressed.length.toLocaleString() +
              ' 字节中只有 ' + diff + ' 个字节不同，全部属于 boardsize_mask');
  console.log('适用尺寸    ' + sizesOf(h.sizeMask).join(',') + ' -> ' + sizesOf(mask).join(',') + ' 路');
  console.log('新校验和    ' + hex8(newCksum));
  console.log('已写出      ' + outFile);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'info' && rest[0]) process.exit(info(rest[0]) ? 0 : 1);
else if (cmd === 'patch' && rest[1]) {
  const i = rest.indexOf('--add-size');
  const sizes = i < 0 ? [] : rest.slice(i + 1).map(Number).filter(n => n >= 5 && n <= 32);
  if (!sizes.length) { console.error('需要 --add-size <n> [n...]'); process.exit(1); }
  patch(rest[0], rest[1], sizes);
} else {
  console.log('用法：\n  node tools/rapfi-weight.js info  <权重>\n' +
              '  node tools/rapfi-weight.js patch <输入> <输出> --add-size 12');
  process.exit(1);
}
