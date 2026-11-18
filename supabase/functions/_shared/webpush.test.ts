import { createECDH, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { buildMessage } from './messages.ts';

const require = createRequire(import.meta.url);
const webpush: any = require('web-push');
const ece: any = require('http_ece');

describe('chiffrement Web Push (bibliothèque réellement utilisée par la fonction)', () => {
  it('produit une requête VAPID dont le contenu se déchiffre avec la clé de l’abonné', () => {
    const vapid = webpush.generateVAPIDKeys();
    // Abonné simulé: clé P-256 et secret d'authentification, comme ceux fournis par le navigateur
    const browser = createECDH('prime256v1');
    browser.generateKeys();
    const authSecret = randomBytes(16);
    const subscription = {
      endpoint: 'https://push.example/abc',
      keys: {
        p256dh: browser.getPublicKey().toString('base64url'),
        auth: authSecret.toString('base64url'),
      },
    };
    const message = buildMessage('continuation', 3, { url: '/#/case/xyz' });

    const request = webpush.generateRequestDetails(subscription, JSON.stringify(message), {
      vapidDetails: { subject: 'mailto:test@example.com', publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      TTL: 3600,
    });

    expect(request.endpoint).toBe('https://push.example/abc');
    expect(request.headers['Content-Encoding']).toBe('aes128gcm');
    expect(request.headers.TTL).toBe(3600);
    expect(request.headers.Authorization).toMatch(/^vapid t=.+, k=/);
    expect(request.headers.Authorization).toContain(vapid.publicKey);

    const plain = ece.decrypt(request.body, { version: 'aes128gcm', privateKey: browser, authSecret: authSecret });
    expect(JSON.parse(plain.toString())).toEqual(message);
  });
});
