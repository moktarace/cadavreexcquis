import { describe, expect, it } from 'vitest';
import { internalPath, parsePush, pushSupport, urlBase64ToBytes, type PushEnv } from './logic';

describe('lecture d’une notification reçue', () => {
  it('accepte un message valide', () => {
    const d = parsePush(JSON.stringify({ title: 'T', body: 'B', url: '/#/case/a', tag: 'x' }));
    expect(d).toEqual({ title: 'T', body: 'B', url: '/#/case/a', tag: 'x' });
  });

  it('n’affiche rien si le contenu est illisible ou incomplet', () => {
    expect(parsePush(null)).toBeNull();
    expect(parsePush('pas du json')).toBeNull();
    expect(parsePush('{"title":1}')).toBeNull();
    expect(parsePush('{"title":"T"}')).toBeNull();
  });

  it('neutralise les URL externes', () => {
    expect(parsePush('{"title":"T","body":"B","url":"https://evil.example"}')?.url).toBe('/');
    expect(internalPath('//evil.example/x')).toBe('/');
    expect(internalPath('/#/story/z')).toBe('/#/story/z');
  });

  it('borne la taille des textes', () => {
    const d = parsePush(JSON.stringify({ title: 'a'.repeat(500), body: 'b'.repeat(500) }))!;
    expect(d.title.length).toBe(80);
    expect(d.body.length).toBe(240);
  });
});

describe('clé VAPID', () => {
  it('décode le base64url sans remplissage', () => {
    expect(Array.from(urlBase64ToBytes('AQID'))).toEqual([1, 2, 3]);
    expect(Array.from(urlBase64ToBytes('_-8'))).toEqual([0xff, 0xef]);
  });
});

describe('prise en charge des notifications', () => {
  const ok: PushEnv = { hasServiceWorker: true, hasPushManager: true, hasNotification: true, isSecureContext: true, isIos: false, standalone: false };

  it('accepte un navigateur complet', () => {
    expect(pushSupport(ok)).toEqual({ ok: true });
  });

  it('exige l’installation sur iOS, même si les API existent', () => {
    expect(pushSupport({ ...ok, isIos: true, standalone: false })).toEqual({ ok: false, reason: 'ios-not-installed' });
    expect(pushSupport({ ...ok, isIos: true, standalone: true })).toEqual({ ok: true });
  });

  it('refuse quand une API manque (aucune simulation)', () => {
    expect(pushSupport({ ...ok, hasPushManager: false })).toEqual({ ok: false, reason: 'unsupported' });
    expect(pushSupport({ ...ok, hasNotification: false })).toEqual({ ok: false, reason: 'unsupported' });
    expect(pushSupport({ ...ok, hasServiceWorker: false })).toEqual({ ok: false, reason: 'no-service-worker' });
    expect(pushSupport({ ...ok, isSecureContext: false })).toEqual({ ok: false, reason: 'insecure' });
  });
});
