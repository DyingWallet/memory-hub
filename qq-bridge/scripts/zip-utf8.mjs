// 生成 ZIP 的最小实现（只用 Node 自带的 zlib），专门解决「中文文件名在 Windows 上解压乱码 / 解压失败」：
//   · 每个条目都设置通用标志位 bit 11（UTF-8 文件名）——macOS 自带的 zip（Info-ZIP 3.0）不设这个标志，
//     Windows 的「解压全部」/ Expand-Archive 就会按旧的 DOS 代码页解读，roles/小鲸鱼.md 变成乱码甚至非法字符；
//   · 记录 Unix 权限（例如 control-center.command 的可执行位），macOS / Linux 解压后照样能双击运行；
//   · Windows / macOS / Linux 生成的包完全一致，不再依赖系统的 zip / tar。
// 不支持 ZIP64（单文件、总大小都远小于 4GB，发布包约 2MB）。

import zlib from 'node:zlib';

function dosDateTime(date) {
  const d = new Date(date);
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * @param {{ name: string, data: Buffer, mtime?: Date|number, mode?: number }[]} entries name 用 / 分隔
 * @returns {Buffer}
 */
export function createZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(String(e.name).replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '');
    const crc = zlib.crc32(data) >>> 0;
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const { time, date } = dosDateTime(e.mtime ?? Date.now());
    const FLAGS = 0x0800; // bit 11：文件名是 UTF-8

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 解压所需版本 2.0
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const mode = (Number(e.mode) || 0o100644) & 0xffff;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // 生成方：Unix，2.0（让解压工具读 Unix 权限）
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(FLAGS, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE((mode << 16) >>> 0, 38); // 外部属性：高 16 位是 Unix 权限
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, end]);
}

/** 读回 ZIP 的中央目录（测试用）：[{ name, flags, method, crc, size, mode, data }]。 */
export function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('不是 ZIP');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const mode = buf.readUInt32LE(p + 38) >>> 16;
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(lho + 26);
    const lxlen = buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(lho + 30 + lnlen + lxlen, lho + 30 + lnlen + lxlen + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    out.push({ name, flags, method, crc, size, mode, data });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
