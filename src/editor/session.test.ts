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
