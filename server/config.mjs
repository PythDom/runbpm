// Configuration du serveur RunBPM : variables d'environnement, sinon runbpm.config.json.
//   NAVIDROME_URL  adresse du serveur Navidrome qui authentifie les utilisateurs (obligatoire
//                  pour la base partagée), ex. http://192.168.129.34:4533
//   RUNBPM_DATA    fichier de la base partagée (défaut : data/runbpm-db.json)
//   PORT, HOST     écoute du serveur autonome (défaut : 8080, 0.0.0.0)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadConfig(root = process.cwd()) {
  let file = {};
  try {
    file = JSON.parse(readFileSync(resolve(root, 'runbpm.config.json'), 'utf8'));
  } catch {
    /* pas de fichier de configuration */
  }
  return {
    navidromeUrl: process.env.NAVIDROME_URL || file.navidromeUrl || undefined,
    dataFile: resolve(root, process.env.RUNBPM_DATA || file.dataFile || 'data/runbpm-db.json'),
    port: Number(process.env.PORT || file.port || 8080),
    host: process.env.HOST || file.host || '0.0.0.0',
  };
}
