import { useEffect, useMemo, useRef } from 'react';
import { PALETTE } from '../editor/palette';
import { TRANSPARENT, parseArt, type StickerDef } from '../domain/stickers';

/** Dessine un tampon en pixel art net (pas de lissage). `size` = pixels d'écran par pixel du tampon. */
export function StickerArt({ def, size = 3, locked = false, className = '' }: { def: StickerDef; size?: number; locked?: boolean; className?: string }) {
  const sprite = useMemo(() => parseArt(def.art), [def]);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = ref.current!.getContext('2d')!;
    ctx.clearRect(0, 0, sprite.w, sprite.h);
    for (let y = 0; y < sprite.h; y++) {
      for (let x = 0; x < sprite.w; x++) {
        const p = sprite.pixels[y * sprite.w + x];
        if (p === TRANSPARENT) continue;
        ctx.fillStyle = PALETTE[p].hex;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }, [sprite]);

  return (
    <canvas
      ref={ref}
      className={`sticker-art ${locked ? 'is-locked' : ''} ${className}`}
      width={sprite.w}
      height={sprite.h}
      style={{ width: sprite.w * size, height: sprite.h * size }}
      role="img"
      aria-label={locked ? `${def.name} (verrouillé)` : def.name}
    />
  );
}
