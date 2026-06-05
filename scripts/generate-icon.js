// Generate traffic light icon using pure Node.js (PNG wrapped in ICO)
// No external dependencies required

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });

function createPNG(width, height, drawFn) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const [r, g, b, a] = drawFn(x, y, width, height);
      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = a;
    }
  }

  // PNG format: signature + IHDR + IDAT + IEND
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = createIHDR(width, height);
  const idat = createIDAT(width, height, rgba);
  const iend = createIEND();

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crcData = Buffer.concat([typeBuffer, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcData));
  return Buffer.concat([length, typeBuffer, data, crcBuf]);
}

function createIHDR(width, height) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;  // bit depth
  data[9] = 6;  // color type (RGBA)
  data[10] = 0; // compression
  data[11] = 0; // filter
  data[12] = 0; // interlace
  return createChunk('IHDR', data);
}

function createIDAT(width, height, rgba) {
  // Add filter byte (0 = None) before each row
  const filtered = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    filtered[y * (width * 4 + 1)] = 0; // filter byte
    rgba.copy(filtered, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(filtered);
  return createChunk('IDAT', compressed);
}

function createIEND() {
  return createChunk('IEND', Buffer.alloc(0));
}

function wrapAsICO(pngBuffers) {
  // ICO header
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);    // reserved
  header.writeUInt16LE(1, 2);    // type = ICO
  header.writeUInt16LE(pngBuffers.length, 4); // image count

  const dirEntries = [];
  let offset = 6 + pngBuffers.length * 16;

  for (const png of pngBuffers) {
    const entry = Buffer.alloc(16);
    entry[0] = 0;  // width (0 = 256+)
    entry[1] = 0;  // height (0 = 256+)
    entry[2] = 0;  // color count
    entry[3] = 0;  // reserved
    entry.writeUInt16LE(1, 4);    // color planes
    entry.writeUInt16LE(32, 6);   // bits per pixel
    entry.writeUInt32LE(png.length, 8);  // image size
    entry.writeUInt32LE(offset, 12);     // image offset
    dirEntries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...dirEntries, ...pngBuffers]);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function drawTrafficLight(x, y, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const margin = w * 0.1;
  const bodyX = margin;
  const bodyY = margin;
  const bodyW = w - margin * 2;
  const bodyH = h - margin * 2;
  const cornerR = w * 0.15;

  // Check if point is inside rounded rect
  function inRoundedRect(px, py) {
    const eps = 1;
    if (px < bodyX + eps || px > bodyX + bodyW - eps) return false;
    if (py < bodyY + eps || py > bodyY + bodyH - eps) return false;
    return true;
  }

  // Distance from center of circle
  function distCircle(px, py, ccx, ccy, r) {
    const dx = px - ccx;
    const dy = py - ccy;
    return Math.sqrt(dx * dx + dy * dy);
  }

  if (!inRoundedRect(x, y)) return [0, 0, 0, 0];

  // Body (dark gray)
  const lightR = bodyW * 0.32;
  const lightCenterX = cx;
  const spacing = bodyH * 0.06;

  const redCY = bodyY + lightR + spacing * 0.5;
  const yellowCY = redCY + lightR * 2 + spacing;
  const greenCY = yellowCY + lightR * 2 + spacing;

  // Check lights
  const distRed = distCircle(x, y, lightCenterX, redCY, lightR);
  const distYellow = distCircle(x, y, lightCenterX, yellowCY, lightR);
  const distGreen = distCircle(x, y, lightCenterX, greenCY, lightR);

  if (distRed <= lightR) {
    const t = 1 - distRed / lightR;
    return [
      lerp(180, 255, t),
      lerp(40, 70, t * 0.5),
      lerp(40, 70, t * 0.5),
      255
    ];
  }
  if (distYellow <= lightR) {
    const t = 1 - distYellow / lightR;
    return [
      lerp(200, 255, t),
      lerp(180, 220, t),
      lerp(20, 50, t * 0.3),
      255
    ];
  }
  if (distGreen <= lightR) {
    const t = 1 - distGreen / lightR;
    return [
      lerp(40, 70, t * 0.3),
      lerp(180, 255, t),
      lerp(40, 80, t * 0.5),
      255
    ];
  }

  // Body gradient (subtle)
  const t = (y - bodyY) / bodyH;
  const base = lerp(55, 40, t);
  return [base, base, base + 5, 255];
}

// Generate icons
const sizes = [256];
const pngs = sizes.map((s) => createPNG(s, s, drawTrafficLight));

// ICO file
const ico = wrapAsICO(pngs);
fs.writeFileSync(path.join(ASSETS_DIR, 'icon.ico'), ico);
console.log(`icon.ico (${ico.length} bytes)`);

// Tray icons (16x16 colored versions)
const colors = {
  'tray-icon-red.ico': (x, y, w, h) => {
    const cx = w / 2, cy = h / 2, r = w * 0.38;
    const dx = x - cx, dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > r) return [0, 0, 0, 0];
    const t = 1 - dist / r;
    return [lerp(150, 255, t), lerp(20, 60, t * 0.3), lerp(20, 40, t * 0.2), 255];
  },
  'tray-icon-yellow.ico': (x, y, w, h) => {
    const cx = w / 2, cy = h / 2, r = w * 0.38;
    const dx = x - cx, dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > r) return [0, 0, 0, 0];
    const t = 1 - dist / r;
    return [lerp(200, 255, t), lerp(180, 220, t), lerp(20, 40, t * 0.2), 255];
  },
  'tray-icon-green.ico': (x, y, w, h) => {
    const cx = w / 2, cy = h / 2, r = w * 0.38;
    const dx = x - cx, dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > r) return [0, 0, 0, 0];
    const t = 1 - dist / r;
    return [lerp(20, 60, t * 0.3), lerp(150, 255, t), lerp(20, 60, t * 0.3), 255];
  },
};

for (const [name, drawFn] of Object.entries(colors)) {
  const png = createPNG(16, 16, drawFn);
  const ico = wrapAsICO([png]);
  fs.writeFileSync(path.join(ASSETS_DIR, name), ico);
  console.log(`${name} (${ico.length} bytes)`);
}
