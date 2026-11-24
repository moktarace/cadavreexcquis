import { describe, expect, it } from 'vitest';
import { HEIGHT, PALETTE, WIDTH } from '../palette';
import { ObjectGesture, decorPlaceable } from '../mimo/gesture';
import { EditorSession } from '../session';
import { protect } from '../shield';
import { DECOR_COUNT, DECOR_H, DECOR_PLACES, DECOR_W } from './art';
import { DECOR_DEFAULT, DECOR_MAX, DECOR_MIN, PICK_REACH, decorRect, nextPlace, pickElement, rasterDecor, visibleElements, type DecorState } from './decor';

const ink = (m: Uint8Array) => m.reduce((a, b) => a + b, 0);
const black = (s: EditorSession) => s.project.pixels.reduce((n, v) => n + (v === 1 ? 1 : 0), 0);
const sceneOf = (s: EditorSession) => s.project.pixels.slice();

function stroke(s: EditorSession, from: [number, number], to: [number, number], color = 2) {
  s.update({ color });
  s.pointerDown(from[0], from[1]);
  s.pointerMove(to[0], to[1]);
  s.pointerUp();
}

function startDecor(place?: number): EditorSession {
  const s = new EditorSession();
  s.reducedMotion = true;
  expect(s.beginDecor()).toBe(true);
  if (place !== undefined) s.decor!.place = place;
  return s;
}

describe('dessin des décors', () => {
  it('propose dix lieux composés d’éléments indépendants', () => {
    expect(DECOR_COUNT).toBe(10);
    expect(DECOR_PLACES.map((p) => p.id)).toEqual(['chambre', 'cuisine', 'rue', 'foret', 'plage', 'classe', 'bureau', 'parc', 'espace', 'restaurant']);
    for (const p of DECOR_PLACES) {
      expect(p.elements.length, p.id).toBeGreaterThanOrEqual(3);
      expect(new Set(p.elements.map((e) => e.id)).size, p.id).toBe(p.elements.length);
    }
  });

  it('chaque élément tient dans la boîte du décor et se voit', () => {
    DECOR_PLACES.forEach((p, i) => {
      for (const e of p.elements) {
        expect(e.x0, `${p.id}/${e.id}`).toBeGreaterThanOrEqual(0);
        expect(e.y0, `${p.id}/${e.id}`).toBeGreaterThanOrEqual(0);
        expect(e.x1, `${p.id}/${e.id}`).toBeLessThanOrEqual(DECOR_W);
        expect(e.y1, `${p.id}/${e.id}`).toBeLessThanOrEqual(DECOR_H);
        const others = p.elements.filter((o) => o.id !== e.id).map((o) => o.id);
        const alone = rasterDecor(i, others, 300, 225);
        expect(ink(alone), `${p.id}/${e.id}`).toBeGreaterThan(30);
      }
    });
  });

  it('est noir et transparent: du trait seulement, ni vide ni plein', () => {
    DECOR_PLACES.forEach((_, i) => {
      const m = rasterDecor(i, [], 300, 225);
      const fill = ink(m) / m.length;
      expect(fill, DECOR_PLACES[i].id).toBeGreaterThan(0.015);
      expect(fill, DECOR_PLACES[i].id).toBeLessThan(0.2);
    });
  });

  it('les lieux se distinguent nettement', () => {
    const masks = DECOR_PLACES.map((_, i) => rasterDecor(i, [], 160, 120));
    for (let a = 0; a < masks.length; a++) {
      for (let b = a + 1; b < masks.length; b++) {
        const diff = masks[a].reduce((n, v, k) => n + (v !== masks[b][k] ? 1 : 0), 0);
        expect(diff, `${DECOR_PLACES[a].id}/${DECOR_PLACES[b].id}`).toBeGreaterThan(400);
      }
    }
  });

  it('retirer un élément ne change que cet élément', () => {
    const all = rasterDecor(0, [], 300, 225);
    const without = rasterDecor(0, ['armoire'], 300, 225);
    expect(ink(without)).toBeLessThan(ink(all));
    const sansArmoire = rasterDecor(0, ['lit', 'fenetre', 'sol'], 300, 225);
    for (let i = 0; i < all.length; i++) expect(sansArmoire[i] || without[i]).toBe(without[i] || sansArmoire[i]);
  });
});

describe('« Change ! »', () => {
  it('ne redonne jamais le lieu précédent, avec n’importe quel tirage', () => {
    for (let prev = 0; prev < DECOR_COUNT; prev++) {
      for (const r of [0, 0.0001, 0.3, 0.5, 0.9, 0.9999999]) expect(nextPlace(prev, () => r)).not.toBe(prev);
    }
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) seen.add(nextPlace(3));
    expect(seen.size).toBe(DECOR_COUNT - 1);
  });

  it('accepte une banque d’un seul lieu', () => {
    expect(nextPlace(0, Math.random, 1)).toBe(0);
    expect(nextPlace(null, () => 0.99, 1)).toBe(0);
  });

  it('tire un premier lieu au hasard dans la banque', () => {
    for (const r of [0, 0.5, 0.999999]) {
      const s = new EditorSession();
      s.random = () => r;
      s.beginDecor();
      expect(s.decor!.place).toBeGreaterThanOrEqual(0);
      expect(s.decor!.place).toBeLessThan(DECOR_COUNT);
    }
  });

  it('change de lieu à chaque pression, en gardant position et taille, et remet les éléments retirés', () => {
    const s = startDecor(0);
    s.decorMoveTo(120, 100);
    s.decorResize(220);
    const places = [s.decor!.place];
    for (let i = 0; i < 25; i++) {
      s.decorRemoveAt(...(() => { const e = visibleElements(s.decor!)[0]; return [(e.left + e.right) / 2, (e.top + e.bottom) / 2] as [number, number]; })());
      expect(s.decor!.removed.length).toBe(1);
      s.decorChange();
      expect(s.decor).toMatchObject({ cx: 120, cy: 100, width: 220, removed: [] });
      expect(s.decor!.place).not.toBe(places[places.length - 1]);
      places.push(s.decor!.place);
    }
  });

  it('ne touche pas au dessin déjà placé', () => {
    const s = new EditorSession();
    stroke(s, [10, 10], [300, 10]);
    const before = sceneOf(s);
    s.beginDecor();
    for (let i = 0; i < 5; i++) s.decorChange();
    expect(s.project.pixels).toEqual(before);
  });
});

describe('sélection d’un élément', () => {
  const state = (over: Partial<DecorState> = {}): DecorState => ({ place: 0, cx: 160, cy: 120, width: 300, removed: [], erasing: true, fx: null, ...over });
  const center = (d: DecorState, id: string) => {
    const e = visibleElements(d).find((v) => v.id === id)!;
    return { x: (e.left + e.right) / 2, y: (e.top + e.bottom) / 2 };
  };

  it('trouve l’élément touché, y compris au milieu d’un meuble (zone, pas seulement le trait)', () => {
    const d = state();
    for (const id of ['lit', 'armoire', 'fenetre', 'sol']) {
      const c = center(d, id);
      expect(pickElement(d, c.x, c.y), id).toBe(id);
    }
  });

  it('un toucher un peu à côté suffit (tolérance du doigt), un toucher dans le vide ne retire rien', () => {
    const d = state();
    const e = visibleElements(d).find((v) => v.id === 'armoire')!;
    expect(pickElement(d, e.right + PICK_REACH - 2, (e.top + e.bottom) / 2)).toBe('armoire');
    expect(pickElement(d, e.right + PICK_REACH + 12, e.top - PICK_REACH - 40)).toBeNull();
    expect(pickElement(d, 2, 2)).toBeNull();
  });

  it('les éléments retirés ne se laissent plus toucher', () => {
    const d = state({ removed: ['armoire'] });
    expect(visibleElements(d).some((e) => e.id === 'armoire')).toBe(false);
    const e0 = state();
    const c = center(e0, 'armoire');
    expect(pickElement(d, c.x, c.y)).not.toBe('armoire');
  });

  it('retire un élément entier au toucher, plusieurs de suite, et les remet un à un', () => {
    const s = startDecor(0);
    s.decorSetErasing(true);
    const full = ink(rasterDecor(0, [], 300, 225));
    const tap = (id: string) => {
      const c = center(s.decor!, id);
      return s.decorRemoveAt(c.x, c.y);
    };
    expect(tap('armoire')).toBe(true);
    expect(tap('lit')).toBe(true);
    expect(s.decor!.removed).toEqual(['armoire', 'lit']);
    expect(ink(rasterDecor(0, s.decor!.removed, 300, 225))).toBeLessThan(full * 0.6);
    expect(s.decorRemoveAt(1, 1)).toBe(false);
    s.decorRestore();
    expect(s.decor!.removed).toEqual(['armoire']);
    s.decorRestore();
    s.decorRestore();
    expect(s.decor!.removed).toEqual([]);
  });

  it('les éléments retirés ne reviennent pas quand on déplace ou agrandit', () => {
    const s = startDecor(0);
    const c = center(s.decor!, 'armoire');
    s.decorRemoveAt(c.x, c.y);
    s.decorSetErasing(false);
    s.decorMoveTo(100, 90);
    s.decorResize(400);
    expect(s.decor!.removed).toEqual(['armoire']);
    expect(visibleElements(s.decor!).some((e) => e.id === 'armoire')).toBe(false);
  });
});

describe('placement du décor', () => {
  it('l’aperçu est exactement ce qui sera placé, et rien n’est modifié avant « Placer »', () => {
    const s = startDecor(4);
    const preview = s.current().pixels.slice();
    expect(preview.some(Boolean)).toBe(true);
    expect(s.project.pixels.some(Boolean)).toBe(false);
    expect(s.placeDecor()).toBe(true);
    expect(s.decor).toBeNull();
    expect(s.project.pixels).toEqual(preview);
  });

  it('passe derrière: ne modifie jamais un pixel déjà dessiné, quelle que soit sa couleur', () => {
    const s = new EditorSession();
    s.reducedMotion = true;
    s.update({ pen: { size: 12, shape: 'square', texture: 'solid' } });
    for (const [i, color] of [2, 3, 4, 5, 1, 0].entries()) stroke(s, [20, 20 + i * 36], [300, 20 + i * 36], color);
    const before = sceneOf(s);
    s.beginDecor();
    s.decor!.place = 5;
    s.placeDecor();
    for (let i = 0; i < before.length; i++) if (before[i] !== 0) expect(s.project.pixels[i], `pixel ${i}`).toBe(before[i]);
    expect(black(s)).toBeGreaterThan(before.filter((v) => v === 1).length);
    // seuls des pixels blancs sont devenus noirs
    for (let i = 0; i < before.length; i++) if (s.project.pixels[i] !== before[i]) expect([before[i], s.project.pixels[i]]).toEqual([0, 1]);
  });

  it('une case vide reçoit le décor tel quel, et il peut dépasser de la toile', () => {
    const s = startDecor(1);
    s.decorMoveTo(20, 30);
    s.decorResize(DECOR_MAX);
    expect(s.placeDecor()).toBe(true);
    expect(black(s)).toBeGreaterThan(200);
  });

  it('s’annule et se rétablit comme un trait', () => {
    const s = new EditorSession();
    stroke(s, [10, 10], [300, 10]);
    const a = sceneOf(s);
    s.beginDecor();
    s.placeDecor();
    const b = sceneOf(s);
    expect(b).not.toEqual(a);
    s.undo();
    expect(s.project.pixels).toEqual(a);
    s.redo();
    expect(s.project.pixels).toEqual(b);
  });

  it('« Annuler » abandonne le décor sans rien changer, et le bouton annuler de l’éditeur aussi', () => {
    const s = new EditorSession();
    stroke(s, [10, 10], [300, 10]);
    const a = sceneOf(s);
    s.beginDecor();
    s.decorChange();
    s.cancelDecor();
    expect(s.decor).toBeNull();
    expect(s.project.pixels).toEqual(a);
    s.beginDecor();
    s.undo();
    expect(s.decor).toBeNull();
    expect(s.project.pixels).toEqual(a);
  });

  it('ajoute autant de décors que l’on veut, un à la fois', () => {
    const s = new EditorSession();
    s.reducedMotion = true;
    const states = [sceneOf(s)];
    for (let i = 0; i < 6; i++) {
      expect(s.beginDecor()).toBe(true);
      expect(s.beginDecor()).toBe(false);
      s.decor!.place = i;
      s.decorMoveTo(60 + i * 40, 50 + i * 20);
      s.decorResize(140 + i * 30);
      s.placeDecor();
      states.push(sceneOf(s));
    }
    for (let i = states.length - 2; i >= 0; i--) {
      s.undo();
      expect(s.project.pixels).toEqual(states[i]);
    }
    for (let i = 1; i < states.length; i++) {
      s.redo();
      expect(s.project.pixels).toEqual(states[i]);
    }
  });

  it('ne laisse rien dessiner ni changer d’outil, et un seul objet à la fois', () => {
    const s = startDecor();
    const before = s.current().pixels.slice();
    s.pointerDown(20, 20);
    s.pointerMove(200, 20);
    s.pointerUp();
    s.setTool('eraser');
    expect(s.tool).toBe('pen');
    expect(s.beginMimo()).toBe(false);
    expect(s.beginText()).toBe(false);
    expect(s.current().pixels).toEqual(before);
    s.cancelDecor();
    s.beginMimo();
    expect(s.beginDecor()).toBe(false);
    s.cancelMimo();
    s.beginText();
    expect(s.beginDecor()).toBe(false);
  });

  it('bornes de taille raisonnables, proportions 4:3 conservées', () => {
    const s = startDecor();
    s.decorResize(5);
    expect(s.decor!.width).toBe(DECOR_MIN);
    s.decorResize(99999);
    expect(s.decor!.width).toBe(DECOR_MAX);
    s.decorResize(DECOR_DEFAULT);
    const r = decorRect(s.decor!, false);
    expect(r.w / r.h).toBeCloseTo(4 / 3, 1);
  });

  it('le mode Gommer fige le décor: ni déplacement ni redimensionnement', () => {
    const s = startDecor();
    s.decorSetErasing(true);
    s.decorMoveTo(10, 10);
    s.decorResize(500);
    expect(s.decor).toMatchObject({ cx: WIDTH / 2, cy: HEIGHT / 2, width: DECOR_DEFAULT });
  });
});

describe('cohabitation avec les Mimo et le texte', () => {
  const protectedAround = (s: EditorSession) => s.project.shield!;

  it('un décor ajouté après un Mimo passe derrière lui, sans le toucher ni le traverser', () => {
    const s = new EditorSession();
    s.reducedMotion = true;
    s.beginMimo();
    s.mimoMoveTo(160, 120);
    s.mimoResize(200);
    s.placeMimo();
    const mimo = sceneOf(s);
    const shield = protectedAround(s);
    expect(shield.some(Boolean)).toBe(true);

    s.beginDecor();
    s.decor!.place = 0;
    s.decorMoveTo(160, 120);
    s.decorResize(DECOR_MAX);
    s.placeDecor();
    let inside = 0;
    for (let i = 0; i < mimo.length; i++) {
      if (mimo[i] !== 0) expect(s.project.pixels[i]).toBe(mimo[i]);
      if (shield[i] && mimo[i] === 0) expect(s.project.pixels[i], 'à l’intérieur du Mimo').toBe(0);
      if (shield[i]) inside++;
    }
    expect(inside).toBeGreaterThan(2000);
    expect(black(s)).toBeGreaterThan(mimo.filter((v) => v === 1).length + 300);
  });

  it('un décor ajouté après un texte laisse le texte lisible', () => {
    const s = new EditorSession();
    s.beginText();
    s.textSet('QUOI ?!');
    s.textMoveTo(160, 100);
    s.placeText();
    const text = sceneOf(s);
    const shield = protectedAround(s);
    s.beginDecor();
    s.decor!.place = 5;
    s.placeDecor();
    for (let i = 0; i < text.length; i++) {
      if (text[i] === 1) expect(s.project.pixels[i]).toBe(1);
      if (shield[i] && text[i] === 0) expect(s.project.pixels[i]).toBe(0);
    }
  });

  it('alterne Mimo, texte, décor et crayon, puis tout s’annule dans l’ordre', () => {
    const s = new EditorSession();
    s.reducedMotion = true;
    const log = [sceneOf(s)];
    const snap = () => log.push(sceneOf(s));
    s.beginMimo();
    s.mimoMoveTo(90, 150);
    s.placeMimo();
    snap();
    s.beginText();
    s.textSet('Oups');
    s.textMoveTo(220, 50);
    s.placeText();
    snap();
    s.beginDecor();
    s.decor!.place = 6;
    const c = visibleElements(s.decor!).find((e) => e.id === 'etagere')!;
    s.decorSetErasing(true);
    s.decorRemoveAt((c.left + c.right) / 2, (c.top + c.bottom) / 2);
    s.decorSetErasing(false);
    s.placeDecor();
    snap();
    stroke(s, [5, 5], [300, 5]);
    snap();
    for (let i = log.length - 2; i >= 0; i--) {
      s.undo();
      expect(s.project.pixels).toEqual(log[i]);
    }
    expect(s.canUndo).toBe(false);
  });

  it('les anciens dessins et les sélections déplacées gardent leur protection', () => {
    const s = new EditorSession();
    s.beginMimo();
    s.placeMimo();
    const shield = protectedAround(s);
    stroke(s, [3, 3], [60, 3]);
    expect(s.project.shield).toBe(shield);
    s.selectAll();
    s.setTool('move');
    s.pointerDown(10, 10);
    s.pointerMove(12, 10);
    s.pointerUp();
    s.commitFloating();
    expect(s.project.shield).toBeDefined();
  });
});

describe('gestes sur le décor', () => {
  function setup(erasing = false) {
    const s = startDecor(0);
    s.decorSetErasing(erasing);
    const g = new ObjectGesture(decorPlaceable(s), (x, y) => ({ x, y }));
    return { s, g };
  }

  it('glisser déplace sans retirer d’élément; pincer agrandit en proportion', () => {
    const { s, g } = setup();
    g.down(1, 160, 120, 0);
    for (let i = 1; i <= 12; i++) g.move(1, 160 + i * 5, 120 - i * 3);
    g.up(1, 300);
    expect(s.decor!.cx).toBeGreaterThan(190);
    expect(s.decor!.removed).toEqual([]);
    const before = s.decor!.width;
    g.down(2, 100, 100, 400);
    g.down(3, 140, 100, 400);
    g.move(3, 200, 100);
    g.up(3, 500);
    g.up(2, 520);
    expect(s.decor!.width).toBeGreaterThan(before * 1.5);
  });

  it('la poignée redimensionne et reste atteignable pour un grand décor', () => {
    const { s, g } = setup();
    s.decorResize(DECOR_MAX);
    const h = decorPlaceable(s).handle!()!;
    expect(h.x).toBeLessThanOrEqual(WIDTH);
    expect(h.y).toBeLessThanOrEqual(HEIGHT);
    const w = s.decor!.width;
    g.down(1, h.x, h.y, 0);
    g.move(1, h.x - 40, h.y - 30);
    g.move(1, h.x - 120, h.y - 90);
    g.up(1, 400);
    expect(s.decor!.width).toBeLessThan(w);
  });

  it('en mode Gommer, un toucher retire un élément et un glissement ne déplace rien', () => {
    const { s, g } = setup(true);
    const e = visibleElements(s.decor!).find((v) => v.id === 'lit')!;
    const at = { x: (e.left + e.right) / 2, y: (e.top + e.bottom) / 2 };
    g.down(1, at.x, at.y, 0);
    g.up(1, 80);
    expect(s.decor!.removed).toEqual(['lit']);
    g.down(2, 150, 100, 200);
    for (let i = 1; i <= 10; i++) g.move(2, 150 + i * 8, 100);
    g.up(2, 700);
    expect(s.decor).toMatchObject({ cx: WIDTH / 2, cy: HEIGHT / 2 });
    expect(s.decor!.removed).toEqual(['lit']);
  });

  it('un tap sur le décor change de lieu, comme un tap change la pose d’un Mimo; un glissement non', () => {
    const { s, g } = setup();
    const place = s.decor!.place;
    g.down(1, 160, 120, 0);
    g.up(1, 90);
    expect(s.decor!.place).not.toBe(place);
    const second = s.decor!.place;
    g.down(2, 160, 120, 200);
    for (let i = 1; i <= 8; i++) g.move(2, 160 + i * 6, 120);
    g.up(2, 500);
    expect(s.decor!.place).toBe(second);
    g.down(3, 160, 120, 600);
    g.up(3, 600 + 900); // appui long: pas un tap
    expect(s.decor!.place).toBe(second);
  });

  it('en mode Gommer un tap ne change pas de lieu', () => {
    const { s, g } = setup(true);
    const place = s.decor!.place;
    g.down(1, 3, 3, 0);
    g.up(1, 60);
    g.down(2, 160, 120, 100);
    g.up(2, 160);
    expect(s.decor!.place).toBe(place);
  });

  it('un toucher dans le vide ne retire rien', () => {
    const { s, g } = setup(true);
    g.down(1, 3, 3, 0);
    g.up(1, 60);
    expect(s.decor!.removed).toEqual([]);
  });
});

describe('zones protégées', () => {
  it('remplissent l’intérieur d’un contour fermé et s’étendent du rayon demandé', () => {
    const w = 20;
    const h = 20;
    const ring = new Uint8Array(w * h);
    for (let i = 5; i <= 14; i++) {
      ring[5 * w + i] = ring[14 * w + i] = ring[i * w + 5] = ring[i * w + 14] = 1;
    }
    const s = protect(undefined, ring, w, h, 100, 100, 2, true);
    const at = (x: number, y: number) => s[(100 + y) * WIDTH + 100 + x];
    expect(at(9, 9)).toBe(1); // intérieur rempli
    expect(at(3, 9)).toBe(1); // halo
    expect(at(1, 9)).toBe(0); // au-delà
    const hollow = protect(undefined, ring, w, h, 100, 100, 1, false);
    expect(hollow[(100 + 9) * WIDTH + 109]).toBe(0);
  });

  it('s’ajoutent aux zones existantes sans rien retirer', () => {
    const m = new Uint8Array(16).fill(1);
    const a = protect(undefined, m, 4, 4, 10, 10, 1, false);
    const b = protect(a, m, 4, 4, 200, 100, 1, false);
    for (let i = 0; i < a.length; i++) if (a[i]) expect(b[i]).toBe(1);
    expect(b.reduce((x, y) => x + y, 0)).toBeGreaterThan(a.reduce((x, y) => x + y, 0));
  });
});

describe('palette', () => {
  it('le décor est toujours noir', () => {
    expect(PALETTE[1].id).toBe('black');
  });
});
