// Planche contact des Mimo (outil de relecture artistique): npm run mimo:sheet -- [chemin.png]
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { MIMO_DESIGNS, MIMO_EMOTIONS, MIMO_POSES } from '../src/editor/mimo/art';
import { rasterMimo } from '../src/editor/mimo/raster';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function png(w: number, h: number, gray: Uint8Array): Buffer {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = gray[y * w + x];
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8;
  head[9] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

interface Cell {
  design: number;
  emotion: number;
  pose: number;
}

function sheet(cells: Cell[][], size: number, gap = 6): { w: number; h: number; px: Uint8Array } {
  const cols = Math.max(...cells.map((r) => r.length));
  const w = cols * (size + gap) + gap;
  const h = cells.length * (size + gap) + gap;
  const px = new Uint8Array(w * h).fill(255);
  cells.forEach((row, r) =>
    row.forEach((spec, c) => {
      const { mask } = rasterMimo(spec, size, size);
      const ox = gap + c * (size + gap);
      const oy = gap + r * (size + gap);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (mask[y * size + x]) px[(oy + y) * w + ox + x] = 20;
    }),
  );
  return { w, h, px };
}

const out = process.argv.filter((a) => a.endsWith('.png'))[0] ?? '/tmp/mimo';
const base = out.replace(/\.png$/, '');
const size = Number(process.argv.find((a) => /^--size=\d+$/.test(a))?.slice(7) ?? 110);

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const files: Record<string, Cell[][]> = {
  designs: range(MIMO_DESIGNS).map((design) => range(MIMO_EMOTIONS).map((emotion) => ({ design, emotion, pose: 0 }))),
  poses: range(MIMO_DESIGNS).map((design) => range(MIMO_POSES).map((pose) => ({ design, emotion: 0, pose }))),
  mix: range(MIMO_DESIGNS).map((design) => range(MIMO_EMOTIONS).map((emotion) => ({ design, emotion, pose: (design + emotion) % MIMO_POSES }))),
};
for (const [name, cells] of Object.entries(files)) {
  const s = sheet(cells, size);
  writeFileSync(`${base}-${name}.png`, png(s.w, s.h, s.px));
  console.log(`${base}-${name}.png`);
}
