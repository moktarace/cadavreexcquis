import { HEIGHT, WIDTH } from '../editor/palette';
import { indexedToRgba } from '../editor/render';
import { SURVIVOR } from './config';

const MARGIN = 8;
const HEAD = 40;

/** Planche 4 × 4 des cases terminées, à la résolution réelle (320 × 240 par case), avec un bandeau titre. */
export async function survivorSheetPng(cases: readonly Uint8Array[], title: string): Promise<Blob> {
  const cols = 4;
  const rows = Math.ceil(SURVIVOR.totalCases / cols);
  const canvas = document.createElement('canvas');
  canvas.width = MARGIN + cols * (WIDTH + MARGIN);
  canvas.height = HEAD + MARGIN + rows * (HEIGHT + MARGIN);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff8e7';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#3b2a63';
  ctx.font = "900 20px 'Nunito', ui-rounded, system-ui, sans-serif";
  ctx.textBaseline = 'middle';
  ctx.fillText(title, MARGIN, HEAD / 2 + 2);
  const tile = document.createElement('canvas');
  tile.width = WIDTH;
  tile.height = HEIGHT;
  const tctx = tile.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  for (let i = 0; i < SURVIVOR.totalCases; i++) {
    const x = MARGIN + (i % cols) * (WIDTH + MARGIN);
    const y = HEAD + MARGIN + Math.floor(i / cols) * (HEIGHT + MARGIN);
    ctx.fillStyle = '#fff';
    ctx.fillRect(x, y, WIDTH, HEIGHT);
    if (cases[i]) {
      tctx.putImageData(new ImageData(indexedToRgba(cases[i]) as Uint8ClampedArray<ArrayBuffer>, WIDTH, HEIGHT), 0, 0);
      ctx.drawImage(tile, x, y);
    }
    ctx.strokeStyle = '#3b2a63';
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 1, y - 1, WIDTH + 2, HEIGHT + 2);
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Export PNG impossible sur ce navigateur');
  return blob;
}

export async function exportSurvivorPng(cases: readonly Uint8Array[], title: string) {
  const url = URL.createObjectURL(await survivorSheetPng(cases, title));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'survivor-bd.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
