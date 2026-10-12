import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * Pont vers l'application Android (Capacitor). Pendant une course, un service de premier plan
 * « lecture multimédia » empêche Android de suspendre l'application écran verrouillé, et l'écran
 * peut rester allumé. Sans effet dans un navigateur.
 */
interface RunSessionPlugin {
  start(options: { title: string; text: string; keepScreenOn: boolean }): Promise<void>;
  stop(): Promise<void>;
}

const RunSession = registerPlugin<RunSessionPlugin>('RunSession');

export const isNativeApp = Capacitor.isNativePlatform();

let active = false;
let lastKey = '';

/** Signale qu'une course est en cours (musique ou métronome) ou terminée. */
export function setRunActive(on: boolean, text = '', keepScreenOn = true): void {
  if (!isNativeApp) return;
  const key = `${on}|${keepScreenOn}`;
  if (key === lastKey) return;
  lastKey = key;
  if (on) {
    active = true;
    RunSession.start({ title: 'RunBPM : course en cours', text, keepScreenOn }).catch(() => undefined);
  } else if (active) {
    active = false;
    RunSession.stop().catch(() => undefined);
  }
}
