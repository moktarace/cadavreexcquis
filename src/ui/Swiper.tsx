import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

interface SwiperProps {
  count: number;
  index: number;
  onIndexChange: (index: number) => void;
  label: string;
  children: ReactNode;
}

/** Feuilletage horizontal natif (défilement + accroche); `index` pilote aussi les boutons et le clavier. */
export function Swiper({ count, index, onIndexChange, label, children }: SwiperProps) {
  const ref = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  const target = useRef<number | null>(null);

  const position = () => {
    const el = ref.current!;
    return el.clientWidth ? Math.round(el.scrollLeft / el.clientWidth) : 0;
  };

  useEffect(() => {
    const el = ref.current!;
    if (position() === index) {
      placed.current = true;
      return;
    }
    target.current = index;
    el.scrollTo({ left: index * el.clientWidth, behavior: placed.current ? 'smooth' : 'instant' });
    placed.current = true;
    const release = setTimeout(() => (target.current = null), 700);
    return () => clearTimeout(release);
  }, [index]);

  const onScroll = () => {
    const i = position();
    if (target.current !== null) {
      if (i === target.current) target.current = null;
      return;
    }
    if (i !== index) onIndexChange(i);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' && index < count - 1) onIndexChange(index + 1);
    else if (e.key === 'ArrowLeft' && index > 0) onIndexChange(index - 1);
  };

  return (
    <div ref={ref} className="swiper" role="group" aria-roledescription="carrousel" aria-label={label} tabIndex={0} onScroll={onScroll} onKeyDown={onKey}>
      {children}
    </div>
  );
}
