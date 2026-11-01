// Generates the extension icons (pink rounded square with a white heart) without any image libraries.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function icon(size) {
  const ss = 4; // supersampling
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const r = size * 0.22;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let bg = 0, heart = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const px = x + (sx + 0.5) / ss, py = y + (sy + 0.5) / ss;
        const dx = Math.max(r - px, 0, px - (size - r)), dy = Math.max(r - py, 0, py - (size - r));
        if (dx * dx + dy * dy <= r * r) bg++;
        const hx = (px / size - 0.5) * 2.6, hy = -(py / size - 0.54) * 2.6;
        const a = hx * hx + hy * hy - 1;
        if (a * a * a - hx * hx * hy * hy * hy <= 0) heart++;
      }
      const n = ss * ss, o = y * (size * 4 + 1) + 1 + x * 4;
      const h = heart / n;
      raw[o] = Math.round(214 + (255 - 214) * h);
      raw[o + 1] = Math.round(51 + (255 - 51) * h);
      raw[o + 2] = Math.round(108 + (255 - 108) * h);
      raw[o + 3] = Math.round((bg / n) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(root, 'extension', `icon${s}.png`), icon(s));
fs.writeFileSync(path.join(root, 'web', 'favicon.png'), icon(64));
console.log('icons written');
