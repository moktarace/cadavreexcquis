// Génère les icônes PNG (pixel-art, palette Cadavre Exquis) sans dépendance externe.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const COLORS = { ink: [59, 42, 99], paper: [255, 246, 220], red: [255, 143, 184], blue: [205, 184, 255], green: [98, 213, 140], yellow: [255, 216, 77] };

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, { padding }) {
  const rows = [];
  const grid = 16; // grille logique: chaque icône est un 4 cases en 16×16 pixels
  const inner = size * (1 - 2 * padding);
  const cell = inner / grid;
  const origin = size * padding;
  const panels = [COLORS.red, COLORS.blue, COLORS.green, COLORS.yellow];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      let color = COLORS.ink;
      const gx = Math.floor((x - origin) / cell);
      const gy = Math.floor((y - origin) / cell);
      if (gx >= 0 && gx < grid && gy >= 0 && gy < grid) {
        const border = gx % 8 === 0 || gx % 8 === 7 || gy % 8 === 0 || gy % 8 === 7;
        if (!border) color = gx % 8 === 1 || gy % 8 === 1 ? COLORS.paper : panels[(gy >> 3) * 2 + (gx >> 3)];
      }
      const o = 1 + x * 4;
      row[o] = color[0]; row[o + 1] = color[1]; row[o + 2] = color[2]; row[o + 3] = 255;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', png(192, { padding: 0.08 }));
writeFileSync('public/icons/icon-512.png', png(512, { padding: 0.08 }));
writeFileSync('public/icons/maskable-512.png', png(512, { padding: 0.2 })); // zone sûre maskable
writeFileSync('public/icons/apple-touch-icon.png', png(180, { padding: 0.08 }));

const svgCell = (x, y, c) => `<rect x="${x}" y="${y}" width="14" height="14" fill="${c}"/>`;
writeFileSync(
  'public/icons/icon.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges"><rect width="32" height="32" fill="#3b2a63"/>${svgCell(2, 2, '#ff8fb8')}${svgCell(16, 2, '#cdb8ff')}${svgCell(2, 16, '#62d58c')}${svgCell(16, 16, '#ffd84d')}</svg>\n`,
);
console.log('Icônes générées dans public/icons');
