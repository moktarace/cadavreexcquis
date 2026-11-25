import { describe, expect, it } from 'vitest';
import { HEIGHT, WIDTH } from '../palette';
import { ObjectGesture, HANDLE_REACH, TAP_SLOP, mimoPlaceable, textPlaceable } from '../mimo/gesture';
import { EditorSession } from '../session';
import { glyphOf, hasGlyph, toFontText } from './font';
import { TEXT_DEFAULT, TEXT_MAX, TEXT_MAX_CHARS, TEXT_MIN, drawText, fitSize, limitText, rasterText, textRect, wrapText } from './text';
import { samePixels } from '../../testing/pixels';

const ink = (m: Uint8Array) => m.reduce((a, b) => a + b, 0);
const placed = (s: EditorSession) => s.project.pixels.reduce((n, v) => n + (v === 1 ? 1 : 0), 0);

function writeText(s: EditorSession, value: string, at?: { x: number; y: number; size?: number }) {
  expect(s.beginText()).toBe(true);
  s.textSet(value);
  if (at) s.textMoveTo(at.x, at.y);
  if (at?.size) s.textResize(at.size);
  expect(s.placeText()).toBe(true);
}

describe('police', () => {
  it('sait écrire lettres, chiffres, ponctuation et accents français', () => {
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,!?:;\'"-()/+=%&*«»…') expect(hasGlyph(ch), ch).toBe(true);
    for (const ch of 'ÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸ') expect(glyphOf(ch), ch).not.toBeNull();
  });

  it('garde majuscules et minuscules, accents compris, et développe les ligatures sans glyphe', () => {
    expect(toFontText('Été à la plage')).toBe('Été à la plage');
    expect(toFontText('cœur Œuvre Æ æ ß')).toBe('cœur OEuvre AE ae ss');
    expect(toFontText('l’été')).toBe("l'été");
  });

  it('sait écrire toutes les minuscules et leurs accents', () => {
    for (const ch of 'abcdefghijklmnopqrstuvwxyz') expect(hasGlyph(ch), ch).toBe(true);
    for (const ch of 'àâäçéèêëîïôöùûüÿœ') expect(glyphOf(ch), ch).not.toBeNull();
  });

  it('distingue les 62 lettres et chiffres, minuscules et majuscules comprises', () => {
    const seen = new Set<string>();
    for (const ch of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
      const { w, h, mask } = rasterText(ch, 40);
      seen.add(`${w}x${h}:${mask.join('')}`);
    }
    expect(seen.size).toBe(62);
  });

  it('les minuscules sont plus petites que les majuscules, avec jambages et hampes', () => {
    expect(rasterText('x', 40).h).toBeLessThan(rasterText('X', 40).h * 0.75);
    expect(rasterText('g', 40).h).toBeGreaterThan(rasterText('x', 40).h);
    expect(rasterText('h', 40).h).toBeGreaterThan(rasterText('x', 40).h);
  });

  it('ignore sans planter ce qu’elle ne sait pas dessiner', () => {
    expect(toFontText('A😀B\u0007C')).toBe('ABC');
    expect(rasterText('😀', 30).w).toBe(0);
  });

  it('dessine chaque lettre avec des pixels noirs, ni vide ni tout noir', () => {
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789?!&%ÀÉÇ') {
      const { w, h, mask } = rasterText(ch, 40);
      expect(w, ch).toBeGreaterThan(4);
      const fill = ink(mask) / (w * h);
      expect(fill, ch).toBeGreaterThan(0.12);
      if (ch !== 'I') expect(fill, ch).toBeLessThan(0.9);
    }
  });

  it('distingue toutes les capitales entre elles', () => {
    const seen = new Set<string>();
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
      const { mask } = rasterText(ch, 30);
      seen.add(`${mask.length}:${mask.join('')}`);
    }
    expect(seen.size).toBe(36);
  });
});

describe('mise en page', () => {
  it('respecte les retours à la ligne et centre les lignes', () => {
    expect(wrapText('un\ndeux', 9999)).toEqual(['un', 'deux']);
    expect(wrapText('a\n\nb', 9999)).toEqual(['a', '', 'b']);
  });

  it('revient à la ligne sans jamais dépasser de la toile', () => {
    const long = 'Une phrase assez longue pour qu’elle doive passer à la ligne plusieurs fois sans dépasser';
    for (const size of [12, 26, 40, 70]) {
      const { w } = rasterText(long, fitSize(long, size));
      expect(w).toBeLessThanOrEqual(WIDTH);
    }
    expect(wrapText(long, 600).length).toBeGreaterThan(1);
  });

  it('coupe un mot plus long que la ligne plutôt que de le laisser sortir', () => {
    const lines = wrapText('ANTICONSTITUTIONNELLEMENT', 300);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe('ANTICONSTITUTIONNELLEMENT');
    expect(wrapText('anticonstitutionnellement', 300).join('')).toBe('anticonstitutionnellement');
  });

  it('limite la saisie à 100 caractères', () => {
    expect(limitText('x'.repeat(250))).toHaveLength(TEXT_MAX_CHARS);
    expect([...limitText('é'.repeat(130))]).toHaveLength(TEXT_MAX_CHARS);
    expect(limitText('a\r\nb')).toBe('a\nb');
  });

  it('réduit la taille d’un texte trop grand plutôt que de le couper', () => {
    const value = 'QUOI ?!\nVRAIMENT ?\nOUI.\nNON.';
    const size = fitSize(value, TEXT_MAX);
    expect(size).toBeLessThan(TEXT_MAX);
    const r = rasterText(value, size);
    expect(r.w).toBeLessThanOrEqual(WIDTH);
    expect(r.h).toBeLessThanOrEqual(HEIGHT);
  });

  it('le texte reste lisible: de 10 px de haut à très grand', () => {
    for (const size of [TEXT_MIN, TEXT_DEFAULT, 60]) expect(rasterText('QUOI ?!', size).w).toBeGreaterThan(size);
  });
});

describe('placement du texte dans l’éditeur', () => {
  it('apparaît en noir sur la toile dès la saisie, sans toucher au dessin avant « Placer »', () => {
    const s = new EditorSession();
    s.beginText();
    expect(s.textReady).toBe(false);
    expect(s.placeText()).toBe(false);
    s.textSet('QUOI ?!');
    expect(s.textReady).toBe(true);
    expect(s.project.pixels.some(Boolean)).toBe(false);
    expect(s.current().pixels.some(Boolean)).toBe(true);
    expect(s.canUndo).toBe(true);
  });

  it('fusionne le texte en noir, identique à l’aperçu, sans fond ni cadre', () => {
    const s = new EditorSession();
    s.update({ color: 2 });
    s.beginText();
    s.textSet('QUOI ?!');
    const preview = s.current().pixels.slice();
    s.placeText();
    expect(s.text).toBeNull();
    samePixels(s.project.pixels, preview);
    const values = new Set(s.project.pixels);
    expect([...values].sort()).toEqual([0, 1]); // fond blanc intact, texte noir, aucune autre couleur
    const r = rasterText('QUOI ?!', TEXT_DEFAULT);
    expect(placed(s)).toBe(ink(r.mask));
  });

  it('reste entièrement dans la toile, même glissé hors des bords', () => {
    const s = new EditorSession();
    s.beginText();
    s.textSet('TEXTE EN BORD');
    for (const [x, y] of [[-500, -500], [9999, 9999], [-500, 9999], [9999, -500]] as const) {
      s.textMoveTo(x, y);
      const r = textRect(s.text!);
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.top).toBeGreaterThanOrEqual(0);
      expect(r.left + r.w).toBeLessThanOrEqual(WIDTH);
      expect(r.top + r.h).toBeLessThanOrEqual(HEIGHT);
    }
    s.textResize(500);
    s.placeText();
    const full = new Uint8Array(WIDTH * HEIGHT);
    drawText(full, { value: 'TEXTE EN BORD', cx: 0, cy: 0, size: 500 });
    expect(placed(s)).toBeGreaterThan(0);
  });

  it('se déplace et se redimensionne avec les proportions conservées', () => {
    const s = new EditorSession();
    s.beginText();
    s.textSet('OUPS');
    const before = rasterText('OUPS', TEXT_DEFAULT);
    s.textResize(52);
    const after = textRect(s.text!);
    expect(after.w / after.h).toBeCloseTo(before.w / before.h, 1);
    s.textMoveTo(100, 80);
    expect(s.text).toMatchObject({ cx: 100, cy: 80 });
  });

  it('accepte accents, ponctuation et plusieurs lignes', () => {
    const s = new EditorSession();
    writeText(s, 'Où ça ?\nÀ côté !');
    expect(placed(s)).toBeGreaterThan(300);
    const one = rasterText('Où ça ?', TEXT_DEFAULT);
    expect(rasterText('Où ça ?\nÀ côté !', TEXT_DEFAULT).h).toBeGreaterThan(one.h * 1.5);
  });

  it('s’abandonne avant placement sans rien changer', () => {
    const s = new EditorSession();
    s.pointerDown(10, 10);
    s.pointerMove(100, 10);
    s.pointerUp();
    const before = s.project.pixels.slice();
    s.beginText();
    s.textSet('RATÉ');
    s.cancelText();
    expect(s.text).toBeNull();
    samePixels(s.project.pixels, before);
    s.beginText();
    s.textSet('RATÉ');
    s.undo(); // « annuler » abandonne le texte en cours
    expect(s.text).toBeNull();
    samePixels(s.project.pixels, before);
  });

  it('s’annule et se rétablit comme un trait, et l’on peut en placer sans limite', () => {
    const s = new EditorSession();
    const states = [s.project.pixels.slice()];
    for (let i = 0; i < 8; i++) {
      writeText(s, `TEXTE ${i}`, { x: 60 + (i % 3) * 100, y: 30 + i * 25, size: 14 + i * 2 });
      states.push(s.project.pixels.slice());
    }
    for (let i = states.length - 2; i >= 0; i--) {
      s.undo();
      samePixels(s.project.pixels, states[i]);
    }
    for (let i = 1; i < states.length; i++) {
      s.redo();
      samePixels(s.project.pixels, states[i]);
    }
    expect(s.beginText()).toBe(true);
  });

  it('alterne librement Mimo, texte et dessin au crayon', () => {
    const s = new EditorSession();
    s.reducedMotion = true;
    const log: Uint8Array[] = [];
    const snap = () => log.push(s.project.pixels.slice());
    s.beginMimo();
    s.mimoMoveTo(90, 140);
    s.placeMimo();
    snap();
    writeText(s, 'QUOI ?!', { x: 200, y: 50 });
    snap();
    s.update({ color: 3 });
    s.pointerDown(5, 5);
    s.pointerMove(300, 5);
    s.pointerUp();
    snap();
    s.beginMimo();
    s.mimoMoveTo(230, 150);
    s.placeMimo();
    snap();
    writeText(s, 'ENCORE', { x: 100, y: 40 });
    snap();
    expect(s.project.pixels[5 * WIDTH + 150]).toBe(3);
    for (let i = log.length - 2; i >= 0; i--) {
      s.undo();
      samePixels(s.project.pixels, log[i]);
    }
    expect(s.beginMimo()).toBe(true);
  });

  it('ne laisse rien dessiner pendant la saisie, et un seul objet à la fois', () => {
    const s = new EditorSession();
    s.beginText();
    s.textSet('A');
    const before = s.current().pixels.slice();
    s.pointerDown(20, 20);
    s.pointerMove(200, 20);
    s.pointerUp();
    s.setTool('eraser');
    expect(s.tool).toBe('pen');
    expect(s.beginMimo()).toBe(false);
    expect(s.beginText()).toBe(false);
    samePixels(s.current().pixels, before);
    s.cancelText();
    s.beginMimo();
    expect(s.beginText()).toBe(false);
  });

  it('un Mimo placé reste lisible sous le texte posé à côté', () => {
    const s = new EditorSession();
    s.reducedMotion = true;
    s.beginMimo();
    s.mimoMoveTo(100, 150);
    s.placeMimo();
    const mimoOnly = placed(s);
    writeText(s, 'QUOI ?!', { x: 230, y: 60 });
    expect(placed(s)).toBeGreaterThan(mimoOnly + 100);
  });
});

describe('gestes sur le texte', () => {
  function setup() {
    const s = new EditorSession();
    s.beginText();
    s.textSet('QUOI ?!');
    let taps = 0;
    const g = new ObjectGesture(textPlaceable(s, () => taps++), (x, y) => ({ x, y }));
    return { s, g, taps: () => taps, rect: () => textRect(s.text!) };
  }

  it('glisser déplace sans changer la taille ni rouvrir la saisie', () => {
    const { s, g, taps } = setup();
    const size = s.text!.size;
    g.down(1, 160, 120, 0);
    for (let i = 1; i <= 15; i++) g.move(1, 160 + i * 4, 120 - i * 2);
    g.up(1, 300);
    expect(s.text!.cx).toBeGreaterThan(200);
    expect(s.text!.cy).toBeLessThan(100);
    expect(s.text!.size).toBe(size);
    expect(taps()).toBe(0);
  });

  it('un appui bref sur le texte rouvre la saisie', () => {
    const { g, taps } = setup();
    g.down(1, 160, 120, 0);
    g.up(1, 100);
    expect(taps()).toBe(1);
  });

  it('un pincement agrandit sans déplacer; la poignée aussi, à la souris', () => {
    const { s, g, rect } = setup();
    const c = { x: s.text!.cx, y: s.text!.cy };
    g.down(1, c.x - 15, c.y, 0);
    g.down(2, c.x + 15, c.y, 0);
    g.move(2, c.x + 45, c.y);
    g.up(2, 50);
    g.up(1, 60);
    expect(s.text!.size).toBeGreaterThan(TEXT_DEFAULT * 1.5);
    expect(s.text!.cx).toBe(c.x);

    const big = s.text!.size;
    const r = rect();
    const corner = { x: r.left + r.w, y: r.top + r.h };
    g.down(3, corner.x + 3, corner.y + 3, 100);
    g.move(3, corner.x + 3 + TAP_SLOP + 2, corner.y + 3 + TAP_SLOP + 2);
    g.move(3, corner.x - 30, corner.y - 20);
    g.up(3, 400);
    expect(s.text!.size).toBeLessThan(big);
    expect(HANDLE_REACH).toBeGreaterThan(8);
  });

  it('un texte vide ne capte aucun geste', () => {
    const s = new EditorSession();
    s.beginText();
    const g = new ObjectGesture(textPlaceable(s, () => {}), (x, y) => ({ x, y }));
    g.down(1, 160, 120, 0);
    expect(g.active).toBe(false);
  });

  it('les Mimo gardent leur geste de tap et profitent de la poignée', () => {
    const s = new EditorSession();
    s.reducedMotion = true;
    s.beginMimo();
    const g = new ObjectGesture(mimoPlaceable(s), (x, y) => ({ x, y }));
    g.down(1, 160, 120, 0);
    g.up(1, 100);
    expect(s.mimo!.spec.pose).toBe(1);
    const size = s.mimo!.size;
    g.down(2, 160 + size / 2, 120 + size / 2, 200);
    g.move(2, 160 + size / 2 + 40, 120 + size / 2 + 40);
    g.up(2, 500);
    expect(s.mimo!.size).toBeGreaterThan(size);
    expect(s.mimo!.spec.pose).toBe(1);
  });
});
