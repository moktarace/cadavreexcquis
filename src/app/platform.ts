export function isIosDevice(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export interface PhoneSignals {
  /** Pointeur principal imprécis (doigt). */
  coarse: boolean;
  /** Le pointeur principal peut survoler (souris, trackpad). */
  canHover: boolean;
  maxTouchPoints: number;
  /** Plus petit côté de l'écran physique, en pixels CSS. */
  shortSide: number;
}

/** Un téléphone tactile: doigt comme pointeur principal ET petit écran. Un iPad (même en mode « ordinateur ») ou un PC ne l'est pas. */
export function isPhoneLike(s: PhoneSignals): boolean {
  return s.coarse && !s.canHover && s.maxTouchPoints > 0 && s.shortSide < 600;
}

export function isPhoneTouch(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return isPhoneLike({
    coarse: window.matchMedia('(pointer: coarse)').matches,
    canHover: window.matchMedia('(hover: hover)').matches,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    shortSide: Math.min(window.screen.width, window.screen.height),
  });
}
