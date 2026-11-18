import { useEffect, useState } from 'react';
import { isIosDevice, isStandalone } from './platform';

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

export function useInstall() {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null);
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPromptEvent(e as InstallPromptEvent);
    };
    const onInstalled = () => setPromptEvent(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const standalone = isStandalone();
  const isIos = isIosDevice();

  return {
    standalone,
    isIos,
    canPrompt: promptEvent !== null,
    install: async () => {
      await promptEvent?.prompt();
      setPromptEvent(null);
    },
  };
}
