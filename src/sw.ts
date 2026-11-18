/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { internalPath, parsePush } from './push/logic';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL(`${import.meta.env.BASE_URL}index.html`)));

clientsClaim();
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

// Une notification illisible n'affiche jamais rien (et n'est jamais simulée).
self.addEventListener('push', (event) => {
  const data = parsePush(event.data?.text());
  if (!data) return;
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: `${import.meta.env.BASE_URL}icons/icon-192.png`,
      badge: `${import.meta.env.BASE_URL}icons/icon-192.png`,
      data: { url: data.url },
    }),
  );
});

// Au clic: on ramène une fenêtre existante vers la case ou l'histoire exacte, sinon on ouvre l'application.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = internalPath(event.notification.data?.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows[0];
      if (existing) {
        await existing.focus();
        existing.postMessage({ type: 'navigate', url });
        return;
      }
      // Les liens des notifications partent de la racine du site: on les rattache au sous-chemin de l'application.
      await self.clients.openWindow(new URL(url.replace(/^\//, ''), self.registration.scope).href);
    })(),
  );
});
