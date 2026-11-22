import { PixelIcon } from './PixelIcon';

const PIECES = Array.from({ length: 14 }, (_, i) => ({
  left: ((i * 37) % 100) + (i % 2) * 2,
  delay: (i % 7) * 0.12,
  duration: 1.8 + (i % 5) * 0.25,
  size: i % 3 === 0 ? 18 : 12,
  drift: (i % 2 ? 1 : -1) * (10 + (i % 4) * 6),
}));

/** Quelques étoiles en pixel art qui retombent une fois; masquées si l'animation est réduite. */
export function Confetti() {
  return (
    <div className="confetti" aria-hidden="true">
      {PIECES.map((p, i) => (
        <span
          key={i}
          className="confetti__piece"
          style={{ left: `${p.left}%`, animationDelay: `${p.delay}s`, animationDuration: `${p.duration}s`, ['--drift' as string]: `${p.drift}px` }}
        >
          <PixelIcon name="star" size={p.size} />
        </span>
      ))}
    </div>
  );
}
