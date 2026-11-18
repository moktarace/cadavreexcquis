import { indexedToRgba } from './render';
import type { Card } from '../domain/cards';
import { HEIGHT, WIDTH } from './palette';
import type { Project } from './project';

/** PNG 320×240 envoyé au serveur à la publication. */
export async function previewPng(project: Project): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const rgba = indexedToRgba(project.pixels);
  canvas.getContext('2d')!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, WIDTH, HEIGHT), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Export PNG impossible sur ce navigateur');
  return new Uint8Array(await blob.arrayBuffer());
}

function download(data: BlobPart, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image introuvable'));
    img.src = url;
  });
}

const MARGIN = 8;
const CAPTION = 22;

/** Planche 2×2 à la résolution réelle des cases (320×240), sans agrandissement. */
async function yonkomaPng(cards: readonly Card[]): Promise<Blob> {
  const images = await Promise.all(cards.map((c) => loadImage(c.previewUrl)));
  const canvas = document.createElement('canvas');
  canvas.width = MARGIN + 2 * (WIDTH + MARGIN);
  canvas.height = MARGIN + 2 * (HEIGHT + CAPTION + MARGIN);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff8e7';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.font = '13px sans-serif';
  ctx.textBaseline = 'middle';
  images.forEach((img, i) => {
    const x = MARGIN + (i % 2) * (WIDTH + MARGIN);
    const y = MARGIN + Math.floor(i / 2) * (HEIGHT + CAPTION + MARGIN);
    ctx.fillStyle = '#fff';
    ctx.fillRect(x, y, WIDTH, HEIGHT);
    ctx.drawImage(img, x, y, WIDTH, HEIGHT);
    ctx.strokeStyle = '#1b1b2f';
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 1, y - 1, WIDTH + 2, HEIGHT + 2);
    ctx.fillStyle = '#1b1b2f';
    ctx.fillText(`${cards[i].caseNumber} · ${cards[i].authorName}`, x, y + HEIGHT + CAPTION / 2 + 2);
  });
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Export PNG impossible sur ce navigateur');
  return blob;
}

export async function exportYonkoma(cards: readonly Card[]) {
  download(await yonkomaPng(cards), 'case-ludique-yonkoma.png', 'image/png');
}

export async function shareYonkoma(cards: readonly Card[]) {
  const file = new File([await yonkomaPng(cards)], 'case-ludique-yonkoma.png', { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'Cadavre Exquis' });
  else await exportYonkoma(cards);
}
