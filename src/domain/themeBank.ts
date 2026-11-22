/**
 * Banque de thèmes: normalisation, détection de doublons et lecture des listes importées.
 * Le tirage lui-même (le « barillet ») est fait par le serveur; ce module sert à préparer et vérifier les titres.
 */

export const THEME_MIN = 3;
export const THEME_MAX = 60;

export type ThemeSource = 'original' | 'imported' | 'referee';

export const SOURCE_LABELS: Record<ThemeSource | 'generated', string> = {
  original: 'Titre original',
  imported: 'Liste importée (non vérifiée)',
  referee: 'Feuille de match (arbitre)',
  generated: 'Ancien générateur',
};

const STOP_WORDS = new Set(['le', 'la', 'les', 'l', 'un', 'une', 'des', 'de', 'du', 'd', 'et', 'a', 'au', 'aux', 'en', 'ce', 'cet', 'cette', 'ses', 'son', 'sa', 'mes', 'ma', 'mon']);

/**
 * Clé de comparaison: minuscules, sans accents ni ponctuation ni articles. Même calcul que `theme_key()` en SQL
 * (supabase/migrations/0011_theme_bank.sql); un jeu d'exemples commun le garantit.
 */
export function themeKey(text: string): string {
  const folded = text
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const words = folded.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const kept = words.filter((w) => !STOP_WORDS.has(w));
  return (kept.length ? kept : words).join(' ');
}

export interface Checked {
  ok: boolean;
  text: string;
  error?: string;
}

/** Espaces normalisés, longueur raisonnable, une seule ligne. */
export function checkThemeText(raw: string): Checked {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length < THEME_MIN) return { ok: false, text, error: 'Titre trop court.' };
  if (text.length > THEME_MAX) return { ok: false, text, error: `Titre trop long (${THEME_MAX} caractères au plus).` };
  if (!themeKey(text)) return { ok: false, text, error: 'Titre sans mot.' };
  return { ok: true, text };
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/** Variante trop proche: mots presque tous communs, ou quasi-identiques à une lettre ou deux près. */
export function areNearDuplicates(keyA: string, keyB: string): boolean {
  if (keyA === keyB) return true;
  const a = new Set(keyA.split(' '));
  const b = new Set(keyB.split(' '));
  const shared = [...a].filter((w) => b.has(w)).length;
  if (shared / (a.size + b.size - shared) >= 0.7) return true;
  return Math.min(keyA.length, keyB.length) >= 8 && levenshtein(keyA, keyB) <= 2;
}

export interface ImportItem {
  text: string;
  note?: string;
}

/** Texte libre (une ligne par thème, puces ou numéros tolérés) ou JSON (liste de titres, d'objets, ou { themes: [...] }). */
export function parseImport(raw: string): ImportItem[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const data = JSON.parse(trimmed);
    const list: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.themes) ? data.themes : [];
    return list
      .map((x): ImportItem | null => {
        if (typeof x === 'string') return { text: x };
        if (x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string') {
          const o = x as { text: string; note?: unknown };
          return { text: o.text, note: typeof o.note === 'string' ? o.note : undefined };
        }
        return null;
      })
      .filter((x): x is ImportItem => x !== null);
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•–]|\d+\s*[.)])\s*/, '').trim())
    .filter(Boolean)
    .map((text) => ({ text }));
}

export type ImportStatus = 'new' | 'duplicate' | 'similar' | 'invalid';

export interface ImportRow {
  text: string;
  note?: string;
  status: ImportStatus;
  /** Pourquoi ce titre est écarté, ou avec quel titre il se ressemble. */
  detail?: string;
}

/** Classe chaque titre d'une liste face à la banque et aux titres déjà vus dans la liste. */
export function analyzeImport(items: readonly ImportItem[], existing: readonly string[]): ImportRow[] {
  const known = existing.map((text) => ({ text, key: themeKey(text) }));
  const rows: ImportRow[] = [];
  for (const item of items) {
    const checked = checkThemeText(item.text);
    if (!checked.ok) {
      rows.push({ text: checked.text || item.text, note: item.note, status: 'invalid', detail: checked.error });
      continue;
    }
    const key = themeKey(checked.text);
    const same = known.find((k) => k.key === key);
    if (same) {
      rows.push({ text: checked.text, note: item.note, status: 'duplicate', detail: `Déjà présent : « ${same.text} »` });
      continue;
    }
    const close = known.find((k) => areNearDuplicates(k.key, key));
    rows.push({ text: checked.text, note: item.note, status: close ? 'similar' : 'new', detail: close ? `Ressemble à « ${close.text} »` : undefined });
    known.push({ text: checked.text, key });
  }
  return rows;
}
