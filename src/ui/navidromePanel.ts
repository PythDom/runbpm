import { safeStorage } from '../services/spotify';
import { makeCredentials, SubsonicClient, type SubsonicCredentials } from '../services/subsonic';

const KEY = 'runbpm.navidrome';
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface NavidromePanelHooks {
  onConnectionChange(): void;
  onImport(): void;
  onStopImport(): void;
}

/**
 * Partie « Navidrome / Subsonic » de la carte Streaming : connexion au serveur et import de la
 * bibliothèque. Le mot de passe n'est jamais conservé : seul le jeton md5(mot de passe + sel) l'est.
 */
export class NavidromePanel {
  private readonly store = safeStorage(() => localStorage);
  private server?: { name: string; version?: string };
  private status = '';
  private statusIsError = false;
  private importing?: { text: string; done: number; total: number };
  private clientImpl?: SubsonicClient;
  /** Saisie en cours, conservée si la connexion échoue. */
  private draft?: { url: string; user: string };

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: NavidromePanelHooks,
  ) {
    root.addEventListener('click', (ev) => {
      const action = (ev.target as HTMLElement).closest<HTMLElement>('[data-nd]')?.dataset.nd;
      if (action === 'connect') void this.connect();
      else if (action === 'logout') this.disconnect();
      else if (action === 'import') this.hooks.onImport();
      else if (action === 'stop') this.hooks.onStopImport();
    });
    root.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter' && (ev.target as HTMLElement).matches('input')) void this.connect();
    });
  }

  get connected(): boolean {
    return this.server !== undefined && this.clientImpl !== undefined;
  }

  get client(): SubsonicClient | undefined {
    return this.connected ? this.clientImpl : undefined;
  }

  /** Reconnexion automatique avec le jeton mémorisé. */
  async init(): Promise<void> {
    const creds = this.saved();
    if (creds) await this.tryClient(new SubsonicClient(creds), false);
    this.render();
  }

  setImportProgress(p: { text: string; done: number; total: number } | undefined, message?: string, isError = false): void {
    this.importing = p;
    if (message !== undefined) this.setStatus(message, isError);
    this.render();
  }

  // ---------- interne ----------

  private saved(): SubsonicCredentials | undefined {
    try {
      const raw = this.store.getItem(KEY);
      return raw ? (JSON.parse(raw) as SubsonicCredentials) : undefined;
    } catch {
      return undefined;
    }
  }

  private async connect(): Promise<void> {
    const val = (id: string) => this.root.querySelector<HTMLInputElement>(`#${id}`)?.value ?? '';
    if (!val('nd-url') || !val('nd-user')) {
      this.setStatus('Renseignez l’adresse du serveur et l’utilisateur.', true);
      this.render();
      return;
    }
    this.draft = { url: val('nd-url'), user: val('nd-user') };
    const creds = makeCredentials(val('nd-url'), val('nd-user'), val('nd-password'));
    this.setStatus('Connexion…');
    this.render();
    if (await this.tryClient(new SubsonicClient(creds), true)) this.store.setItem(KEY, JSON.stringify(creds));
    this.render();
  }

  private async tryClient(client: SubsonicClient, userInitiated: boolean): Promise<boolean> {
    try {
      const info = await client.ping();
      this.server = { name: info.serverName, version: info.version };
      this.clientImpl = client;
      this.setStatus('');
      this.hooks.onConnectionChange();
      return true;
    } catch (e) {
      this.server = undefined;
      this.clientImpl = undefined;
      const mixed = window.location.protocol === 'https:' && client.creds.url.startsWith('http:');
      this.setStatus(
        mixed
          ? 'Cette page est en HTTPS et le serveur en HTTP : le navigateur bloque la connexion. Ouvrez RunBPM en local (http://127.0.0.1) ou servez Navidrome en HTTPS.'
          : (userInitiated ? '' : 'Reconnexion impossible : ') + (e as Error).message,
        true,
      );
      return false;
    }
  }

  private disconnect(): void {
    this.store.removeItem(KEY);
    this.server = undefined;
    this.clientImpl = undefined;
    this.setStatus('');
    this.render();
    this.hooks.onConnectionChange();
  }

  private setStatus(msg: string, isError = false): void {
    this.status = msg;
    this.statusIsError = isError;
  }

  render(): void {
    const status = this.status
      ? `<p class="summary ${this.statusIsError ? 'error-text' : 'muted'}">${esc(this.status)}</p>`
      : '';
    if (!this.connected) {
      const saved = this.draft ?? this.saved();
      this.root.innerHTML = `
        <p class="muted small">Lecture dans RunBPM depuis votre serveur, <strong>avec ajustement du tempo</strong>.</p>
        <label>Adresse du serveur
          <input type="text" id="nd-url" value="${esc(saved?.url ?? '')}" placeholder="http://192.168.1.10:4533" autocomplete="url" spellcheck="false" />
        </label>
        <div class="grid2">
          <label>Utilisateur
            <input type="text" id="nd-user" value="${esc(saved?.user ?? '')}" autocomplete="username" spellcheck="false" />
          </label>
          <label>Mot de passe
            <input type="password" id="nd-password" autocomplete="current-password" />
          </label>
        </div>
        <div class="row"><button type="button" class="primary" data-nd="connect">Se connecter</button></div>
        <p class="muted small">Le mot de passe n’est pas conservé : seul un jeton dérivé l’est, dans ce navigateur.</p>
        ${status}`;
      return;
    }
    const creds = this.clientImpl!.creds;
    const importBlock = this.importing
      ? `<div class="row"><progress max="${Math.max(1, this.importing.total)}" value="${this.importing.done}"></progress>
           <button type="button" data-nd="stop">Arrêter</button></div>
         <p class="small muted ellipsis">${esc(this.importing.text)}</p>`
      : `<div class="row"><button type="button" class="primary" data-nd="import">Importer la bibliothèque du serveur</button></div>`;
    this.root.innerHTML = `
      <p class="summary">Connecté à <strong>${esc(this.server!.name)}</strong>${this.server!.version ? ` ${esc(this.server!.version)}` : ''}
        (${esc(creds.user)}) <button type="button" class="link danger" data-nd="logout">Se déconnecter</button></p>
      <p class="muted small ellipsis">${esc(creds.url)}</p>
      ${importBlock}
      <p class="muted small">BPM des tags si disponible (option de la carte Musique), sinon mesuré en lisant un extrait de chaque morceau.</p>
      ${status}`;
  }
}
