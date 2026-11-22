import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PALETTE } from '../editor/palette';
import {
  BASE_STICKER_IDS, REWARD_CONFIG, STICKERS, TRANSPARENT, parseArt, scaleSprite, stickerById, syncSql, unlockCondition, unlockedSet,
} from './stickers';

describe('catalogue des tampons', () => {
  it('offre six tampons dès le départ', () => {
    expect(BASE_STICKER_IDS).toEqual(['heart', 'tear', 'star', 'crown', 'impact', 'bolt']);
    expect(unlockedSet([]).size).toBe(6);
  });

  it('propose les huit récompenses aux bons seuils', () => {
    const rule = (id: string) => `${stickerById(id)?.family}:${stickerById(id)?.threshold}`;
    expect(['explosion', 'speed', 'smoke', 'ghost'].map(rule)).toEqual(['collective:1', 'collective:3', 'collective:5', 'collective:10']);
    expect(['mustache', 'glasses', 'hat', 'mask'].map(rule)).toEqual(['inspired:1', 'inspired:3', 'inspired:5', 'inspired:10']);
  });

  it('ne débloque que ce que le serveur a débloqué', () => {
    const set = unlockedSet(['explosion']);
    expect(set.has('explosion')).toBe(true);
    expect(set.has('ghost')).toBe(false);
  });

  it('décrit chaque condition de déblocage', () => {
    expect(unlockCondition(stickerById('speed')!)).toBe('Termine 3 histoires à plusieurs');
    expect(unlockCondition(stickerById('mustache')!)).toBe('1 histoire née de tes premières cases');
  });

  it('applique les mêmes seuils que la migration (0010_rewards.sql)', () => {
    const sql = readFileSync(new URL('../../supabase/migrations/0010_rewards.sql', import.meta.url), 'utf8');
    const seeded = [...sql.matchAll(/\('(\w+)', '(collective|inspired)', (\d+)\)/g)].map((m) => `${m[1]}:${m[2]}:${m[3]}`).sort();
    const config = STICKERS.filter((s) => s.family !== 'base').map((s) => `${s.id}:${s.family}:${s.threshold}`).sort();
    expect(seeded).toEqual(config);
    expect(sql).toContain(`default '{${REWARD_CONFIG.inspiredMilestones.join(',')}}'`);
    expect(syncSql()).toContain('sync_reward_rules');
  });
});

describe('pixel art des tampons', () => {
  it.each(STICKERS.map((s) => [s.id, s] as const))('« %s » est lisible, dans la palette et à la taille d’un jeton', (_, s) => {
    const sprite = parseArt(s.art);
    const opaque = [...sprite.pixels].filter((p) => p !== TRANSPARENT);
    expect(sprite.w).toBe(16);
    expect(sprite.h).toBeLessThanOrEqual(16);
    expect(opaque.length).toBeGreaterThan(20);
    // petit jeton: jamais une scène entière
    expect(opaque.length).toBeLessThanOrEqual(16 * 16 * 0.8);
    expect(opaque.every((p) => p < PALETTE.length)).toBe(true);
    // silhouette bien dessinée: le contour est tracé en noir, sauf pour les tampons de vitesse
    expect(opaque.some((p) => p === 1)).toBe(true);
  });

  it('refuse un dessin mal formé', () => {
    expect(() => parseArt(['kk', 'k'])).toThrow(/largeur/);
    expect(() => parseArt(['kx'])).toThrow(/inconnue/);
  });

  it('agrandit par pixels entiers, sans flou ni nouvelle couleur', () => {
    const base = parseArt(['k.', '.r']);
    const big = scaleSprite(base, 3);
    expect(big.w).toBe(6);
    expect(big.h).toBe(6);
    expect(new Set(big.pixels)).toEqual(new Set([1, 2, TRANSPARENT]));
    expect(big.pixels[0]).toBe(1);
    expect(big.pixels[3]).toBe(TRANSPARENT);
    expect(big.pixels[5 * 6 + 5]).toBe(2);
    expect(() => scaleSprite(base, 1.5)).toThrow();
  });
});
