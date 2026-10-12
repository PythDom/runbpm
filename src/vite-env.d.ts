/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Adresse proposée par défaut pour la base partagée (ex. https://moi.pythonanywhere.com). */
  readonly VITE_RUNBPM_SERVER?: string;
  /** Adresse proposée par défaut pour le serveur Navidrome. */
  readonly VITE_NAVIDROME_URL?: string;
}
