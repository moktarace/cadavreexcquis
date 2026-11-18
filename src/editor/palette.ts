/** Dessin 320×240, six couleurs (palette du format Flipnote Studio 3D), jamais agrandi à l'export. */
export const WIDTH = 320;
export const HEIGHT = 240;
export const PIXELS = WIDTH * HEIGHT;

export interface PaletteColor {
  id: 'white' | 'black' | 'red' | 'yellow' | 'green' | 'blue';
  label: string;
  hex: string;
  rgb: readonly [number, number, number];
}

export const PALETTE: readonly PaletteColor[] = [
  { id: 'white', label: 'Blanc', hex: '#ffffff', rgb: [0xff, 0xff, 0xff] },
  { id: 'black', label: 'Noir', hex: '#141414', rgb: [0x14, 0x14, 0x14] },
  { id: 'red', label: 'Rouge', hex: '#ff1717', rgb: [0xff, 0x17, 0x17] },
  { id: 'yellow', label: 'Jaune', hex: '#ffe600', rgb: [0xff, 0xe6, 0x00] },
  { id: 'green', label: 'Vert', hex: '#008232', rgb: [0x00, 0x82, 0x32] },
  { id: 'blue', label: 'Bleu', hex: '#06aeff', rgb: [0x06, 0xae, 0xff] },
];
