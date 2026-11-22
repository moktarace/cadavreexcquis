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
const BANNER = 44;
const GAME_NAME = 'Cadavre Exquis';
const GAME_TAGLINE = 'Une histoire dessinée à plusieurs';
const GAME_URL = 'moktarace.github.io/cadavreexcquis';
const FONT = "'Nunito', ui-rounded, 'SF Pro Rounded', system-ui, sans-serif";

function fit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/** Bandeau sous la planche: ne recouvre aucune case. */
function drawBanner(ctx: CanvasRenderingContext2D, width: number, top: number, themeText?: string) {
  ctx.fillStyle = '#ede5ff';
  ctx.fillRect(0, top, width, BANNER);
  ctx.fillStyle = '#3b2a63';
  ctx.fillRect(0, top, width, 2);
  ctx.textBaseline = 'middle';
  const inner = width - 2 * MARGIN;

  ctx.font = `800 12px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.fillStyle = '#6a4cb5';
  ctx.fillText(GAME_URL, width - MARGIN, top + 16);
  const urlWidth = ctx.measureText(GAME_URL).width;

  ctx.textAlign = 'left';
  ctx.font = `900 14px ${FONT}`;
  ctx.fillStyle = '#3b2a63';
  ctx.fillText(GAME_NAME, MARGIN, top + 16);
  const nameWidth = ctx.measureText(GAME_NAME).width;
  ctx.font = `700 12px ${FONT}`;
  const tagWidth = ctx.measureText(GAME_TAGLINE).width;
  if (nameWidth + 12 + tagWidth + 16 + urlWidth <= inner) {
    ctx.fillStyle = '#6a4cb5';
    ctx.fillText(GAME_TAGLINE, MARGIN + nameWidth + 12, top + 16);
  }

  if (themeText) {
    ctx.font = `700 12px ${FONT}`;
    ctx.fillStyle = '#3b2a63';
    ctx.fillText(fit(ctx, `Thème : ${themeText}`, inner), MARGIN, top + 33);
  }
}

/** Planche 2×2 à la résolution réelle des cases (320×240), sans agrandissement, suivie du bandeau de signature. */
async function yonkomaPng(cards: readonly Card[], themeText?: string): Promise<Blob> {
  const images = await Promise.all(cards.map((c) => loadImage(c.previewUrl)));
  const canvas = document.createElement('canvas');
  canvas.width = MARGIN + 2 * (WIDTH + MARGIN);
  canvas.height = MARGIN + 2 * (HEIGHT + CAPTION + MARGIN) + BANNER;
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
  drawBanner(ctx, canvas.width, canvas.height - BANNER, themeText);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Export PNG impossible sur ce navigateur');
  return blob;
}

export async function exportYonkoma(cards: readonly Card[], themeText?: string) {
  download(await yonkomaPng(cards, themeText), 'case-ludique-yonkoma.png', 'image/png');
}

export async function shareYonkoma(cards: readonly Card[], themeText?: string) {
  const file = new File([await yonkomaPng(cards, themeText)], 'case-ludique-yonkoma.png', { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'Cadavre Exquis' });
  else await exportYonkoma(cards, themeText);
}
