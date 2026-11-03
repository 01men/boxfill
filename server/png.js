/**
 * 纯 Node PNG 解码（零依赖）。
 *
 * ── 为什么必须是 PNG，不是 JPEG ──────────────────────────────────────
 * JPEG 要解码就得引入解码库（jpeg-js / sharp），服务端立刻从"零依赖"变成
 * "依赖一个原生或半原生模块"，部署、跨平台、供应链都跟着变重。
 * 而 PNG 用的是 zlib——Node 自带 `node:zlib` 一行就能解开。
 *
 * 所以约束落在客户端：拍照/上传后一律经 canvas 重新编码成 PNG 再上传。
 * 多一次 canvas 编码换来服务端零依赖，这笔买卖很划算。
 *
 * ── 覆盖范围 ────────────────────────────────────────────────────────
 * 支持：灰度 / RGB / 索引色 / 带透明通道，位深 1/2/4/8/16。
 * 不支持：Adam7 隔行扫描（手机相机几乎不会产生，真出现了明确报错而不是解错）。
 *
 * 输出统一为 detectBoxes 认识的 {data, width, height}，data 是 RGBA。
 */

import { inflateSync } from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class PngError extends Error {
  constructor(msg, hint) {
    super(msg);
    this.name = 'PngError';
    this.hint = hint || null;
  }
}

/** CRC32：PNG 每个 chunk 的尾部都带一个，用于确认块没在传输中损坏 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 每种颜色类型在内存里的字节数（按位深展开后的） */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * 解码 PNG → { data, width, height }（data 为 RGBA 的 Uint8ClampedArray）
 * @param {Buffer|Uint8Array} buf PNG 字节
 */
export function decodePng(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 8 || !b.subarray(0, 8).equals(PNG_SIG)) {
    throw new PngError('不是合法的 PNG', '请用 canvas.toBlob(blob, "image/png") 编码后上传');
  }

  let p = 8;
  let ihdr = null;
  let palette = null;
  let transparency = null;
  const idat = [];

  while (p + 8 <= b.length) {
    const len = b.readUInt32BE(p);
    const type = b.toString('ascii', p + 4, p + 8);
    const dataStart = p + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > b.length) throw new PngError(`PNG 在 ${type} 块处被截断`, '图片可能上传不完整');

    const chunk = b.subarray(p + 4, dataEnd);
    const expect = b.readUInt32BE(dataEnd);
    if (crc32(chunk) !== expect) {
      throw new PngError(`PNG 的 ${type} 块校验失败`, '图片在传输中损坏，请重传');
    }

    if (type === 'IHDR') {
      ihdr = {
        width: b.readUInt32BE(dataStart),
        height: b.readUInt32BE(dataStart + 4),
        bitDepth: b[dataStart + 8],
        colorType: b[dataStart + 9],
        compression: b[dataStart + 10],
        filter: b[dataStart + 11],
        interlace: b[dataStart + 12],
      };
    } else if (type === 'PLTE') {
      palette = b.subarray(dataStart, dataEnd);
    } else if (type === 'tRNS') {
      transparency = b.subarray(dataStart, dataEnd);
    } else if (type === 'IDAT') {
      idat.push(b.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    p = dataEnd + 4;
  }

  if (!ihdr) throw new PngError('PNG 缺少 IHDR 块');
  if (ihdr.interlace) {
    throw new PngError(
      '不支持隔行扫描（Adam7）的 PNG',
      '用 canvas 重编码即可：ctx.drawImage 后 toBlob("image/png")',
    );
  }
  if (!idat.length) throw new PngError('PNG 没有像素数据（IDAT 为空）');
  if (!(CHANNELS[ihdr.colorType] != null)) {
    throw new PngError(`未知的颜色类型 ${ihdr.colorType}`);
  }

  const { width, height, bitDepth, colorType } = ihdr;
  if (!(width > 0 && height > 0)) throw new PngError('PNG 尺寸非法');
  if (width * height > 40e6) {
    throw new PngError(
      `图片过大（${width}×${height}）`,
      '上传前先缩到 1600px 以内，识别精度不受影响',
    );
  }

  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch (err) {
    throw new PngError(`PNG 解压失败：${err.message}`, '文件可能不是标准 PNG');
  }

  const channels = CHANNELS[colorType];
  const bpp = Math.ceil((channels * bitDepth) / 8);           // 每像素占的整字节数
  const rowBytes = Math.ceil((channels * bitDepth * width) / 8);
  if (raw.length < height * (rowBytes + 1)) {
    throw new PngError('PNG 像素数据长度不足', '文件可能被截断');
  }

  const out = unfilter(raw, width, height, rowBytes, bpp);
  return toRgba(out, width, height, bitDepth, colorType, palette, transparency);
}

/** 逐行还原 PNG 的 5 种过滤器（None/Sub/Up/Average/Paeth） */
function unfilter(raw, width, height, rowBytes, bpp) {
  const out = Buffer.alloc(rowBytes * height);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const rowStart = y * rowBytes;
    const prevStart = (y - 1) * rowBytes;

    for (let x = 0; x < rowBytes; x++) {
      const cur = raw[src++];
      const a = x >= bpp ? out[rowStart + x - bpp] : 0;          // 左邻
      const b = y > 0 ? out[prevStart + x] : 0;                 // 上邻
      const c = x >= bpp && y > 0 ? out[prevStart + x - bpp] : 0; // 左上
      let v;
      switch (filter) {
        case 0: v = cur; break;
        case 1: v = cur + a; break;
        case 2: v = cur + b; break;
        case 3: v = cur + ((a + b) >> 1); break;
        case 4: v = cur + paeth(a, b, c); break;
        default: throw new PngError(`未知的行过滤器 ${filter}`);
      }
      out[rowStart + x] = v & 0xff;
    }
  }
  return out;
}

/** Paeth 预测器：PNG 规范里用来在左/上/左上三个邻居里挑最接近的一个 */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** 任意颜色类型/位深 → RGBA；detectBoxes 的 `detectBoxes` 只认这一种 */
function toRgba(buf, width, height, bitDepth, colorType, palette, transparency) {
  const out = new Uint8ClampedArray(width * height * 4);
  const rowBytes = Math.ceil((CHANNELS[colorType] * bitDepth * width) / 8);
  const channels = CHANNELS[colorType];

  // 16bit 取高字节：8bit 精度对识别已经绰绰有余
  const sample = (row, index) => {
    if (bitDepth === 16) return buf[row * rowBytes + index * 2];
    if (bitDepth === 8) return buf[row * rowBytes + index];
    // 1/2/4bit：打包在一个字节里，按位取
    const bitPos = index * bitDepth;
    const byte = buf[row * rowBytes + (bitPos >> 3)];
    const shift = 8 - bitDepth - (bitPos & 7);
    const max = (1 << bitDepth) - 1;
    return Math.round(((byte >> shift) & max) * 255 / max);
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = x * channels;
      const o = (y * width + x) * 4;
      if (colorType === 0 || colorType === 4) {
        const g = sample(y, i);
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = colorType === 4 ? sample(y, i + 1) : 255;
      } else if (colorType === 2 || colorType === 6) {
        out[o] = sample(y, i);
        out[o + 1] = sample(y, i + 1);
        out[o + 2] = sample(y, i + 2);
        out[o + 3] = colorType === 6 ? sample(y, i + 3) : 255;
      } else {
        // 索引色：查调色板
        const idx = sample(y, i);
        out[o] = palette ? palette[idx * 3] : 0;
        out[o + 1] = palette ? palette[idx * 3 + 1] : 0;
        out[o + 2] = palette ? palette[idx * 3 + 2] : 0;
        // tRNS 里没出现的索引才透明；缺 tRNS 的话索引色一律按不透明处理
        out[o + 3] = transparency && idx < transparency.length ? transparency[idx] : 255;
      }
    }
  }
  return { data: out, width, height };
}

/** 校验上传字节确实是 PNG —— HTTP 入口用它挡掉非图片请求 */
export function looksLikePng(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  return b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG);
}