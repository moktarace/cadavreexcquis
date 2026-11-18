import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import './ui/tokens.css';
import './ui/base.css';
import './ui/components.css';
import './ui/screens.css';
import './editor/editor.css';

if (import.meta.env.PROD) registerSW({ immediate: true });

// Clic sur une notification: le service worker nous demande d'ouvrir la case ou l'histoire exacte.
navigator.serviceWorker?.addEventListener('message', (event) => {
  const url = event.data?.type === 'navigate' ? String(event.data.url) : null;
  if (!url?.startsWith('/') || url.startsWith('//')) return;
  const hash = url.includes('#') ? url.slice(url.indexOf('#')) : '#/';
  window.location.hash = hash;
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
