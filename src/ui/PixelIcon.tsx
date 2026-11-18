import { MASCOT, MASCOT_COLORS, ICONS, type IconName, type Sprite } from './sprites';

interface PixelIconProps {
  name: IconName;
  /** Taille d'affichage en pixels CSS (multiple de 12 pour des pixels bien nets). */
  size?: number;
  /** Texte alternatif; sans lui l'icône est décorative. */
  label?: string;
  className?: string;
}

function rects(sprite: Sprite, color: (ch: string) => string | null) {
  const out: React.ReactElement[] = [];
  sprite.rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const fill = color(row[x]);
      if (!fill) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < row.length && row[x + run] === row[x]) run++;
      out.push(<rect key={`${x}-${y}`} x={x} y={y} width={run} height={1} fill={fill} />);
      x += run;
    }
  });
  return out;
}

export function PixelIcon({ name, size = 24, label, className }: PixelIconProps) {
  const s = ICONS[name];
  return (
    <svg
      className={`pixel-icon ${className ?? ''}`}
      width={size}
      height={size}
      viewBox={`0 0 ${s.w} ${s.h}`}
      shapeRendering="crispEdges"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {rects(s, (ch) => (ch === '#' ? 'currentColor' : ch === 'o' ? 'var(--icon-accent, currentColor)' : null))}
    </svg>
  );
}

/** Petite mascotte décorative (chat). */
export function Mascot({ size = 84, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={`mascot ${className ?? ''}`}
      width={size}
      height={(size * MASCOT.h) / MASCOT.w}
      viewBox={`0 0 ${MASCOT.w} ${MASCOT.h}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      {rects(MASCOT, (ch) => MASCOT_COLORS[ch] ?? null)}
    </svg>
  );
}
