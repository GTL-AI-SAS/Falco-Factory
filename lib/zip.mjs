/** Dependency-free ZIP (DEFLATE) writer for small, trusted source files. */
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let i = 0; i < 8; i++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function stamp(date = new Date()) {
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  return { time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    day: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate() };
}
export function zipFiles(files, { date = new Date('2026-01-01T00:00:00Z'), maxFiles = 100 } = {}) {
  if (!(files instanceof Map) || files.size < 1 || files.size > Math.min(maxFiles, 65535)) throw new Error('Invalid ZIP file list.');
  const local = [], central = [];
  let offset = 0;
  const { time, day } = stamp(date);
  for (const [name, content] of files) {
    if (typeof name !== 'string' || name.length > 200 || !/^[a-zA-Z0-9_.-][a-zA-Z0-9_./ -]*$/.test(name) ||
        name.includes('..') || name.startsWith('/') || name.includes('//') ||
        name.split('/').some(part => part.startsWith(' ') || /[ .]$/.test(part))) throw new Error('Unsafe ZIP filename.');
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    if (data.byteLength > 2_000_000) throw new Error('ZIP source file exceeds 2 MB.');
    const compressed = deflateRawSync(data, { level: 8 });
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt16LE(time, 10); header.writeUInt16LE(day, 12);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x800, 8); dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(time, 12); dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(checksum, 16); dir.writeUInt32LE(compressed.length, 20); dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    local.push(header, nameBytes, compressed);
    central.push(dir, nameBytes);
    offset += header.length + nameBytes.length + compressed.length;
  }
  const centralBytes = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(centralBytes, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
