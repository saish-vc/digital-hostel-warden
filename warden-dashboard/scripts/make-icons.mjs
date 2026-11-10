// Dev utility: generates the FCM notification icons into public/.
// Pure-node PNG rasterizer (no deps) — safe to re-run any time.
import zlib from 'zlib';
import fs from 'fs';

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** size x size RGBA PNG; pixelFn(x, y) -> [r, g, b, a] */
function png(size, pixelFn) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
/** signed distance: negative inside the circle */
const sdisc = (x, y, cx, cy, r) => Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) - r;
const cover = (x, y, cx, cy, r) => clamp01(-sdisc(x, y, cx, cy, r) + 0.5);
/** 1 inside a rounded rect, anti-aliased on its corners */
function roundedSquareAlpha(x, y, size, radius) {
  const cx2 = Math.min(x, size - 1 - x), cy2 = Math.min(y, size - 1 - y);
  if (cx2 >= radius || cy2 >= radius) return 1;
  const dx = radius - 0.5 - cx2, dy = radius - 0.5 - cy2;
  return clamp01(radius - Math.sqrt(dx * dx + dy * dy) + 0.5);
}

const WHITE = [255, 255, 255];
const RED = [220, 38, 38]; // tailwind red-600

// icon-192.png: emergency-red rounded square with a white bell silhouette.
const S = 192;
const icon = png(S, (x, y) => {
  const square = roundedSquareAlpha(x, y, S, 36);
  const dome = cover(x, y, 96, 116, 46) * (y <= 116 ? 1 : 0);
  const body = x >= 78 && x <= 113 && y >= 116 && y <= 140 ? 1 : 0;
  const dot = cover(x, y, 95.5, 152, 10);
  const shape = Math.min(1, dome + body + dot);
  const color = shape >= 0.5 ? WHITE : RED;
  return [color[0], color[1], color[2], Math.round(255 * square)];
});
fs.writeFileSync('public/icon-192.png', icon);

// badge-72.png: white bell silhouette on transparency (status-bar badge).
const B = 72;
const badge = png(B, (x, y) => {
  const dome = cover(x, y, 36, 42, 20) * (y <= 42 ? 1 : 0);
  const body = x >= 26 && x <= 45 && y >= 38 && y <= 54 ? 1 : 0;
  const dot = cover(x, y, 35.5, 62, 6);
  const a = Math.round(255 * Math.min(1, dome + body + dot));
  return [...WHITE, a];
});
fs.writeFileSync('public/badge-72.png', badge);

console.log('wrote public/icon-192.png and public/badge-72.png');
