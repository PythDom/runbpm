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

/**
 * Filtre « accept » d'un champ fichier. Dans l'application Android, le sélecteur traduit les
 * extensions en types MIME : celles qu'Android ne connaît pas (.gpx, .fit, .tcx…) disparaissent du
 * filtre, et les fichiers correspondants deviennent impossibles à choisir. On n'y filtre donc pas :
 * le format est reconnu au contenu après le choix.
 */
export function fileAccept(extensions: string): string {
  return isNativeApp ? '' : extensions;
}

/** Retire les filtres d'extensions des champs fichiers déjà présents dans la page (application Android). */
export function relaxFileInputs(root: ParentNode = document): void {
  if (!isNativeApp) return;
  for (const input of root.querySelectorAll<HTMLInputElement>('input[type="file"][accept]')) {
    // Les filtres par type (audio/*) fonctionnent : on ne retire que les extensions.
    const kept = input.accept.split(',').filter((t) => t.includes('/'));
    if (kept.length) input.accept = kept.join(',');
    else input.removeAttribute('accept');
  }
}
