/**
 * 最小 ZIP 读写实现（仅用 Node 内置 zlib，不引入第三方依赖）
 *
 * 为什么自己写：备份包含浏览器配置目录（含二进制 SQLite/Cookie 文件），
 * 需要可控的流式打包与安全解压（防路径穿越），而项目不想为此引入依赖。
 *
 * 支持：deflate / store 两种方式；UTF-8 文件名；中央目录解析；
 *      解压时做路径校验，拒绝 ../ 与绝对路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const deflateRaw = promisify(zlib.deflateRaw);
const inflateRaw = promisify(zlib.inflateRaw);

/* ---------------- CRC32 ---------------- */

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  CRC_TABLE = t;
  return t;
}

export function crc32(buf) {
  const t = crcTable();
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ t[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/* ---------------- 时间转换（DOS 格式） ---------------- */

function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((Math.floor(d.getSeconds() / 2)) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/* ---------------- ZIP 写入 ---------------- */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

export class ZipWriter {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.fd = fs.openSync(file, 'w');
    this.offset = 0;      // 已写入字节数
    this.entries = [];    // 中央目录记录
    this.closed = false;
  }

  /** 判断某段数据是否值得压缩（已压缩过的二进制收益很低） */
  static worthCompressing(name, size) {
    if (size > 8 * 1024 * 1024) return true;               // 大文件压缩收益稳定
    if (/\.(json|txt|log|md|csv|xml|html|css|js|mjs)$/i.test(name)) return true;
    return false;
  }

  /**
   * 写入一个条目
   * @param {string} name ZIP 内路径（统一用 / 分隔）
   * @param {Buffer} data
   * @param {{compress?: boolean}} [opts]
   */
  async addBuffer(name, data, opts = {}) {
    if (this.closed) throw new Error('ZipWriter 已关闭');
    const entryName = String(name).replace(/\\/g, '/');
    const nameBuf = Buffer.from(entryName, 'utf8');
    const crc = crc32(data);
    const uncompSize = data.length;

    let compressed = data;
    let method = 0; // 0 = store
    if (opts.compress !== false) {
      const c = await deflateRaw(data, { level: 6 });
      // 压缩后更大就没必要
      if (c.length < data.length) {
        compressed = c;
        method = 8;
      }
    }

    const { time, date } = dosDateTime();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0x0800, 6);          // flags: UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(uncompSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);              // extra len

    const localOffset = this.offset;
    this.offset += this._write(local) + this._write(nameBuf) + this._write(compressed);

    this.entries.push({
      name: nameBuf, method, time, date, crc,
      compSize: compressed.length, uncompSize, localOffset,
    });
    return { name: entryName, size: uncompSize, compressed: compressed.length, method };
  }

  /** 从磁盘写入一个文件 */
  async addFile(name, diskPath) {
    const data = fs.readFileSync(diskPath);
    return this.addBuffer(name, data, { compress: ZipWriter.worthCompressing(name, data.length) });
  }

  _write(buf) {
    fs.writeSync(this.fd, buf, 0, buf.length);
    return buf.length;
  }

  /** 结束并写入中央目录 */
  close() {
    if (this.closed) return;
    const cdStart = this.offset;
    let cdSize = 0;
    for (const e of this.entries) {
      const rec = Buffer.alloc(46);
      rec.writeUInt32LE(SIG_CENTRAL, 0);
      rec.writeUInt16LE(20, 4);              // version made by
      rec.writeUInt16LE(20, 6);              // version needed
      rec.writeUInt16LE(0x0800, 8);          // flags
      rec.writeUInt16LE(e.method, 10);
      rec.writeUInt16LE(e.time, 12);
      rec.writeUInt16LE(e.date, 14);
      rec.writeUInt32LE(e.crc, 16);
      rec.writeUInt32LE(e.compSize, 20);
      rec.writeUInt32LE(e.uncompSize, 24);
      rec.writeUInt16LE(e.name.length, 28);
      rec.writeUInt16LE(0, 30);              // extra
      rec.writeUInt16LE(0, 32);              // comment
      rec.writeUInt16LE(0, 34);              // disk start
      rec.writeUInt16LE(0, 36);              // internal attrs
      rec.writeUInt32LE(0, 38);              // external attrs
      rec.writeUInt32LE(e.localOffset, 42);
      cdSize += this._write(rec) + this._write(e.name);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    this._write(eocd);

    fs.closeSync(this.fd);
    this.closed = true;
    return this.entries.length;
  }
}

/* ---------------- ZIP 读取 ---------------- */

/** 定位并解析中央目录 */
export function readZipIndex(file) {
  const stat = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  try {
    // EOCD 最少 22 字节，注释最长 65535 -> 从尾部回扫
    const scanLen = Math.min(stat.size, 22 + 65535);
    const tail = Buffer.alloc(scanLen);
    fs.readSync(fd, tail, 0, scanLen, stat.size - scanLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件（未找到中央目录）');

    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);

    if (cdSize === 0xffffffff) throw new Error('暂不支持 ZIP64 格式的备份文件');

    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);

    const entries = [];
    let p = 0;
    for (let i = 0; i < total; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) break;
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const compSize = cd.readUInt32LE(p + 20);
      const uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      entries.push({ name, method, crc, compSize, uncompSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries, total, fileSize: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

/** 读取并解压单个条目 */
export async function readZipEntry(file, entry) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(30);
    fs.readSync(fd, head, 0, 30, entry.localOffset);
    if (head.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`损坏的条目头：${entry.name}`);
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const dataStart = entry.localOffset + 30 + nameLen + extraLen;

    const raw = Buffer.alloc(entry.compSize);
    if (entry.compSize > 0) fs.readSync(fd, raw, 0, entry.compSize, dataStart);

    if (entry.method === 0) return raw;
    if (entry.method === 8) return await inflateRaw(raw);
    throw new Error(`不支持的压缩方式 ${entry.method}（${entry.name}）`);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 校验并规范化 ZIP 内部路径，防路径穿越
 * @returns {string|null} 安全相对路径（/ 分隔）；不安全则返回 null
 */
export function safeEntryPath(name) {
  if (!name) return null;
  const n = String(name).replace(/\\/g, '/');
  if (n.endsWith('/')) return null;                       // 目录项
  if (n.startsWith('/')) return null;                     // 绝对路径
  if (/^[a-zA-Z]:/.test(n)) return null;                  // Windows 盘符
  const parts = n.split('/');
  if (parts.some((p) => p === '..' || p === '.' || p === '')) return null;
  if (parts.some((p) => /[\0<>:"|?*]/.test(p))) return null; // 非法字符
  return parts.join('/');
}

/**
 * 解压到目标目录（带路径校验与条目白名单）
 * @param {string} file
 * @param {string} targetDir
 * @param {(entry:object)=>boolean} [filter]
 * @param {(info:{done:number,total:number,name:string})=>void} [onProgress]
 */
export async function extractZip(file, targetDir, filter, onProgress) {
  const { entries } = readZipIndex(file);
  const usable = entries.filter((e) => {
    const safe = safeEntryPath(e.name);
    if (!safe) return false;
    return filter ? filter({ ...e, safe }) : true;
  });

  let done = 0;
  for (const e of usable) {
    const safe = safeEntryPath(e.name);
    const out = path.join(targetDir, safe);
    // 双保险：确保最终路径仍在目标目录内
    const rel = path.relative(targetDir, out);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const data = await readZipEntry(file, e);
    fs.writeFileSync(out, data);
    done += 1;
    if (onProgress) onProgress({ done, total: usable.length, name: safe });
  }
  return { total: usable.length, extracted: done, skipped: entries.length - usable.length };
}
