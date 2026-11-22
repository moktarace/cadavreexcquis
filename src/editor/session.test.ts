import { describe, expect, it } from 'vitest';
import { EditorSession, closesDrawerOnDraw } from './session';
import { WIDTH } from './palette';

const px = (s: EditorSession, x: number, y: number) => s.project.pixels[y * WIDTH + x];

function draw(s: EditorSession, from: [number, number], to: [number, number]) {
  s.pointerDown(from[0], from[1], 1);
  s.pointerMove(to[0], to[1], 1);
  s.pointerUp();
}

describe('dessin', () => {
  it('commit un trait en une seule entrée d’historique', () => {
    const s = new EditorSession();
    s.update({ pen: { size: 1, shape: 'round', texture: 'solid' } });
    draw(s, [10, 10], [40, 10]);
    expect(px(s, 25, 10)).toBe(1);
    s.undo();
    expect(px(s, 25, 10)).toBe(0);
    expect(s.canUndo).toBe(false);
    s.redo();
    expect(px(s, 25, 10)).toBe(1);
  });

  it('affiche le trait en cours avant de le valider', () => {
    const s = new EditorSession();
    s.pointerDown(10, 10);
    s.pointerMove(30, 10);
    expect(s.current().pixels[10 * WIDTH + 20]).toBe(1);
    expect(px(s, 20, 10)).toBe(0);
    s.pointerUp();
    expect(px(s, 20, 10)).toBe(1);
  });

  it('abandonne un trait annulé par un second doigt sans rien écrire', () => {
    const s = new EditorSession();
    s.pointerDown(10, 10);
    s.pointerMove(30, 10);
    s.pointerCancel();
    expect(px(s, 20, 10)).toBe(0);
    expect(s.canUndo).toBe(false);
  });

  it('dessine avec la couleur choisie', () => {
    const s = new EditorSession();
    s.update({ color: 2 });
    draw(s, [5, 5], [20, 5]);
    expect(px(s, 10, 5)).toBe(2);
  });

  it('efface avec la gomme', () => {
    const s = new EditorSession();
    s.update({ pen: { size: 3, shape: 'square', texture: 'solid' } });
    draw(s, [10, 10], [50, 10]);
    s.setTool('eraser');
    s.update({ eraserSize: 4 });
    draw(s, [10, 10], [50, 10]);
    expect(px(s, 30, 10)).toBe(0);
  });

  it('remplit avec la couleur choisie', () => {
    const s = new EditorSession();
    s.update({ color: 5 });
    s.setTool('fill');
    s.pointerDown(100, 100);
    s.pointerUp();
    expect(px(s, 100, 100)).toBe(5);
    expect(px(s, 0, 0)).toBe(5);
  });

  it('ne sort pas de la grille', () => {
    const s = new EditorSession();
    s.pointerDown(-10, -10);
    s.pointerMove(400, 300);
    s.pointerUp();
    expect(s.project.pixels).toHaveLength(320 * 240);
  });
});

describe('sélection, déplacement, copier-coller', () => {
  function drawBlock(s: EditorSession) {
    s.update({ pen: { size: 5, shape: 'square', texture: 'solid' } });
    draw(s, [20, 20], [20, 20]);
  }

  it('déplace une sélection rectangulaire et valide en une seule annulation', () => {
    const s = new EditorSession();
    drawBlock(s);
    s.setTool('rect');
    draw(s, [10, 10], [40, 40]);
    expect(s.selection).not.toBeNull();
    s.setTool('move');
    draw(s, [25, 25], [75, 45]); // décalage (+50, +20)
    expect(s.floating).not.toBeNull();
    expect(s.current().pixels[20 * WIDTH + 20]).toBe(0);
    expect(s.current().pixels[40 * WIDTH + 70]).toBe(1);
    s.commitFloating();
    expect(px(s, 70, 40)).toBe(1);
    expect(px(s, 20, 20)).toBe(0);
    s.undo();
    expect(px(s, 20, 20)).toBe(1);
    expect(px(s, 70, 40)).toBe(0);
  });

  it('annuler pendant le déplacement restaure le dessin', () => {
    const s = new EditorSession();
    drawBlock(s);
    s.setTool('move');
    draw(s, [5, 5], [25, 25]);
    s.undo();
    expect(s.floating).toBeNull();
    expect(px(s, 20, 20)).toBe(1);
  });

  it('copie, colle puis valide', () => {
    const s = new EditorSession();
    drawBlock(s);
    s.setTool('rect');
    draw(s, [10, 10], [40, 40]);
    s.copy();
    s.paste();
    expect(s.tool).toBe('move');
    expect(s.floating).not.toBeNull();
    s.commitFloating();
    expect(px(s, 20, 20)).toBe(1);
    expect(px(s, 28, 28)).toBe(1);
  });

  it('coupe puis colle ailleurs', () => {
    const s = new EditorSession();
    drawBlock(s);
    s.setTool('lasso');
    s.pointerDown(10, 10);
    s.pointerMove(40, 10);
    s.pointerMove(40, 40);
    s.pointerMove(10, 40);
    s.pointerUp();
    s.cut();
    expect(px(s, 20, 20)).toBe(0);
    s.paste();
    s.commitFloating();
    expect(px(s, 28, 28)).toBe(1);
  });

  it('valide automatiquement la sélection flottante en changeant d’outil', () => {
    const s = new EditorSession();
    drawBlock(s);
    s.setTool('move');
    draw(s, [5, 5], [35, 5]);
    s.setTool('pen');
    expect(s.floating).toBeNull();
    expect(px(s, 50, 20)).toBe(1);
  });

  it('supprime le contenu de la sélection', () => {
    const s = new EditorSession();
    drawBlock(s);
    s.setTool('rect');
    draw(s, [10, 10], [40, 40]);
    s.deleteSelection();
    expect(px(s, 20, 20)).toBe(0);
  });
});

describe('transformations de sélection', () => {
  function asymmetric(s: EditorSession) {
    // Trois pixels formant un « L »: (10,10) (11,10) (10,11)
    s.update({ pen: { size: 1, shape: 'square', texture: 'solid' } });
    for (const [x, y] of [[10, 10], [11, 10], [10, 11]]) draw(s, [x, y], [x, y]);
  }

  it('retourne horizontalement la sélection, validée en une seule annulation', () => {
    const s = new EditorSession();
    asymmetric(s);
    s.setTool('rect');
    draw(s, [10, 10], [11, 11]);
    s.flip('h');
    s.commitFloating();
    expect([px(s, 10, 10), px(s, 11, 10), px(s, 10, 11), px(s, 11, 11)]).toEqual([1, 1, 0, 1]);
    s.undo();
    expect([px(s, 10, 10), px(s, 11, 10), px(s, 10, 11), px(s, 11, 11)]).toEqual([1, 1, 1, 0]);
  });

  it('retourne verticalement', () => {
    const s = new EditorSession();
    asymmetric(s);
    s.setTool('rect');
    draw(s, [10, 10], [11, 11]);
    s.flip('v');
    s.commitFloating();
    expect([px(s, 10, 10), px(s, 11, 10), px(s, 10, 11), px(s, 11, 11)]).toEqual([1, 0, 1, 1]);
  });

  it('tourne d’un quart de tour dans le sens horaire', () => {
    const s = new EditorSession();
    asymmetric(s);
    s.setTool('rect');
    draw(s, [10, 10], [11, 11]);
    s.rotate();
    s.commitFloating();
    // (x,y)=(0,0),(1,0),(0,1) → (1,0),(1,1),(0,0) dans la boîte 2×2 d'origine (10,10)
    expect([px(s, 10, 10), px(s, 11, 10), px(s, 10, 11), px(s, 11, 11)]).toEqual([1, 1, 0, 1]);
  });

  it('quatre quarts de tour redonnent le dessin d’origine', () => {
    const s = new EditorSession();
    asymmetric(s);
    s.setTool('rect');
    draw(s, [9, 9], [13, 13]);
    for (let i = 0; i < 4; i++) s.rotate();
    s.commitFloating();
    expect([px(s, 10, 10), px(s, 11, 10), px(s, 10, 11)]).toEqual([1, 1, 1]);
    expect(px(s, 11, 11)).toBe(0);
  });

  it('transforme tout le dessin quand rien n’est sélectionné', () => {
    const s = new EditorSession();
    s.update({ pen: { size: 1, shape: 'square', texture: 'solid' } });
    draw(s, [0, 0], [0, 0]);
    s.flip('h');
    s.commitFloating();
    expect(px(s, 0, 0)).toBe(0);
    expect(px(s, 319, 0)).toBe(1);
  });
});

describe('cycle de vie', () => {
  it('termine proprement un trait lors d’un passage en arrière-plan', () => {
    const s = new EditorSession();
    s.pointerDown(10, 10);
    s.pointerMove(30, 10);
    s.flush();
    expect(px(s, 20, 10)).toBe(1);
  });
});

describe('tiroir d’outils', () => {
  it('se referme quand on dessine au stylo ou à la gomme, pas avec les outils de sélection', () => {
    expect(closesDrawerOnDraw('pen')).toBe(true);
    expect(closesDrawerOnDraw('eraser')).toBe(true);
    for (const tool of ['fill', 'rect', 'lasso', 'move', 'hand'] as const) expect(closesDrawerOnDraw(tool)).toBe(false);
  });
});

describe('tampons', () => {
  const cell = (s: EditorSession, x: number, y: number) => s.current().pixels[y * WIDTH + x];

  it('place l’aperçu au centre sans toucher au dessin avant validation', () => {
    const s = new EditorSession();
    expect(s.beginStamp('heart')).toBe(true);
    expect(s.tool).toBe('stamp');
    expect(s.floating?.stamp?.id).toBe('heart');
    expect(s.project.pixels.some((p) => p !== 0)).toBe(false);
    expect(s.current().pixels.some((p) => p !== 0)).toBe(true);
    expect(s.canUndo).toBe(true);
  });

  it('refuse un tampon inconnu', () => {
    expect(new EditorSession().beginStamp('nimporte')).toBe(false);
  });

  it('se déplace au stylet: dans le tampon on le tire, à côté il saute sous le pointeur', () => {
    const s = new EditorSession();
    s.beginStamp('bolt', 2);
    const f = s.floating!;
    const left = f.content.x;
    const top = f.content.y;
    s.pointerDown(left + 4, top + 4);
    s.pointerMove(left + 14, top + 24);
    s.pointerUp();
    expect(s.floating!.dx).toBe(10);
    expect(s.floating!.dy).toBe(20);

    s.pointerDown(300, 220);
    s.pointerUp();
    const w = s.floating!.content.w;
    const h = s.floating!.content.h;
    expect(s.floating!.content.x + s.floating!.dx + w / 2).toBeCloseTo(300, 0);
    expect(s.floating!.content.y + s.floating!.dy + h / 2).toBeCloseTo(220, 0);
  });

  it('se fusionne dans l’image à la validation: pixels de palette, une seule entrée d’historique', () => {
    const s = new EditorSession();
    s.beginStamp('heart', 1);
    const f = s.floating!;
    const spot = f.content.x + 2;
    s.commitFloating();
    expect(s.floating).toBeNull();
    expect(s.project.stamps).toBe(1);
    const painted = [...s.project.pixels].filter((p) => p !== 0);
    expect(painted.length).toBeGreaterThan(40);
    expect(painted.every((p) => p >= 0 && p <= 5)).toBe(true);
    expect(s.project.pixels.length).toBe(320 * 240);
    expect(spot).toBeGreaterThan(0);
    s.undo();
    expect(s.project.pixels.some((p) => p !== 0)).toBe(false);
    expect(s.project.stamps ?? 0).toBe(0);
    s.redo();
    expect(s.project.stamps).toBe(1);
    expect([...s.project.pixels].filter((p) => p !== 0)).toEqual(painted);
  });

  it('le blanc d’un tampon recouvre le dessin, le transparent le laisse intact', () => {
    const s = new EditorSession();
    s.update({ pen: { size: 5, shape: 'round', texture: 'solid' } });
    draw(s, [10, 120], [310, 120]);
    expect(cell(s, 160, 120)).toBe(1);
    s.beginStamp('ghost', 1);
    const f = s.floating!;
    s.commitFloating();
    // le fantôme est blanc au milieu du corps: l'encre dessous disparaît; hors du tampon elle reste
    const cx = f.content.x + Math.floor(f.content.w / 2);
    const cy = f.content.y + 8;
    expect(s.project.pixels[cy * WIDTH + cx]).toBe(0);
    expect(cell(s, 12, 120)).toBe(1);
  });

  it('annuler pendant le placement abandonne le tampon sans rien changer', () => {
    const s = new EditorSession();
    s.beginStamp('star');
    s.undo();
    expect(s.floating).toBeNull();
    expect(s.canUndo).toBe(false);
    expect(s.stampsPlaced).toBe(0);
  });

  it('limite à trois tampons par case sans empêcher de dessiner, et annuler en libère un', () => {
    const s = new EditorSession();
    for (let i = 0; i < 3; i++) {
      expect(s.beginStamp('star', 1)).toBe(true);
      s.commitFloating();
    }
    expect(s.stampsPlaced).toBe(3);
    expect(s.canStamp).toBe(false);
    expect(s.beginStamp('star')).toBe(false);
    s.setTool('pen');
    draw(s, [5, 5], [50, 5]);
    expect(s.project.pixels[5 * WIDTH + 20]).toBe(1);
    expect(s.stampsPlaced).toBe(3);
    s.undo();
    s.undo();
    expect(s.stampsPlaced).toBe(2);
    expect(s.canStamp).toBe(true);
  });

  it('la limite est un réglage', () => {
    const s = new EditorSession();
    s.maxStamps = 1;
    s.beginStamp('star');
    s.commitFloating();
    expect(s.beginStamp('star')).toBe(false);
  });

  it('change de taille par multiples entiers en gardant son centre', () => {
    const s = new EditorSession();
    s.beginStamp('crown', 2);
    const f = s.floating!;
    const cx = f.content.x + f.content.w / 2;
    const w2 = f.content.w;
    s.setStampScale(4);
    expect(s.floating!.content.w).toBe(w2 * 2);
    expect(s.floating!.content.x + s.floating!.content.w / 2).toBeCloseTo(cx, 0);
    s.setStampScale(7);
    expect(s.floating!.stamp!.scale).toBe(4);
    s.commitFloating();
    expect([...s.project.pixels].every((p) => p <= 5)).toBe(true);
  });

  it('dessiner au stylo pendant un placement le valide comme le fait déjà le déplacement', () => {
    const s = new EditorSession();
    s.beginStamp('heart', 1);
    s.setTool('pen');
    s.pointerDown(5, 5);
    s.pointerUp();
    expect(s.floating).toBeNull();
    expect(s.project.stamps).toBe(1);
  });

  it('un tampon peut dépasser le bord sans erreur: la partie hors image est ignorée', () => {
    const s = new EditorSession();
    s.beginStamp('speed', 4);
    s.pointerDown(0, 0);
    s.pointerUp();
    expect(() => s.commitFloating()).not.toThrow();
    expect(s.project.pixels.length).toBe(320 * 240);
  });
});

describe('réactivité', () => {
  it('déplacer un tampon reste aussi léger qu’un trait: 300 déplacements en moins d’une demi-seconde', () => {
    const s = new EditorSession();
    s.beginStamp('explosion', 4);
    s.pointerDown(160, 120);
    const start = performance.now();
    for (let i = 0; i < 300; i++) {
      s.pointerMove(160 + (i % 50), 120 + (i % 30));
      s.current();
    }
    s.pointerUp();
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('le trait au stylo ne coûte rien de plus quand des tampons ont été posés', () => {
    const s = new EditorSession();
    s.beginStamp('star');
    s.commitFloating();
    s.setTool('pen');
    s.pointerDown(10, 10, 0.6);
    for (let i = 0; i < 200; i++) s.pointerMove(10 + i, 10 + (i % 7), 0.6);
    s.pointerUp();
    expect(s.project.stamps).toBe(1);
    expect(s.project.pixels[10 * WIDTH + 60]).toBe(1);
  });
});
