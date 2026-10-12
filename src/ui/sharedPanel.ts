import { safeStorage } from '../services/spotify';
import { normalizeServerUrl, SharedDb } from '../services/sharedDb';

const KEY = 'runbpm.shared';
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface SharedConfig {
  url: string;
  code: string;
}

/**
 * Réglage de la base partagée (carte Streaming, sous Navidrome) : adresse du serveur et code d'accès.
 * Le code est vérifié avant d'être conservé dans l'appareil.
 */
export class SharedPanel {
  private readonly store = safeStorage(() => localStorage);
  private config?: SharedConfig;
  private info = '';
  private isError = false;
  private busy = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly onChange: () => void,
  ) {
    try {
      const raw = this.store.getItem(KEY);
      this.config = raw ? (JSON.parse(raw) as SharedConfig) : undefined;
    } catch {
      this.config = undefined;
    }
    root.addEventListener('click', (ev) => {
      const action = (ev.target as HTMLElement).closest<HTMLElement>('[data-sh]')?.dataset.sh;
      if (action === 'connect') void this.connect();
      else if (action === 'forget') this.forget();
    });
    root.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter' && (ev.target as HTMLElement).matches('input')) void this.connect();
    });
    this.render();
  }

  /** Client de la base, si elle est configurée. */
  db(): SharedDb | undefined {
    return this.config ? new SharedDb(this.config.url, this.config.code) : undefined;
  }

  setInfo(text: string, isError = false): void {
    this.info = text;
    this.isError = isError;
    this.render();
  }

  private async connect(): Promise<void> {
    if (this.busy) return;
    const val = (id: string) => this.root.querySelector<HTMLInputElement>(`#${id}`)?.value.trim() ?? '';
    const url = normalizeServerUrl(val('sh-url'));
    const code = val('sh-code');
    if (!url || !code.includes(':')) {
      this.setInfo('Renseignez l’adresse du serveur et le code d’accès (de la forme nom:secret).', true);
      return;
    }
    this.busy = true;
    this.setInfo('Vérification…');
    try {
      if (!(await SharedDb.health(url))) throw new Error(`Aucune base RunBPM à l’adresse ${url}.`);
      await new SharedDb(url, code).whoami();
      this.config = { url, code };
      this.store.setItem(KEY, JSON.stringify(this.config));
      this.info = '';
      this.onChange();
    } catch (e) {
      this.setInfo((e as Error).message, true);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private forget(): void {
    this.store.removeItem(KEY);
    this.config = undefined;
    this.info = '';
    this.render();
    this.onChange();
  }

  render(): void {
    const info = this.info ? `<p class="small ${this.isError ? 'error-text' : 'muted'}" id="sh-info">${esc(this.info)}</p>` : '';
    if (this.config) {
      const host = this.config.url.replace(/^https?:\/\//, '');
      this.root.innerHTML = `
        <p class="small"><strong>Base partagée</strong> : ${esc(this.config.code.split(':')[0])} sur ${esc(host)}
          <button type="button" class="link" data-sh="forget">Changer</button></p>
        ${info}`;
      return;
    }
    const url = this.root.querySelector<HTMLInputElement>('#sh-url')?.value ?? import.meta.env.VITE_RUNBPM_SERVER ?? '';
    this.root.innerHTML = `
      <details ${this.info ? 'open' : ''}>
        <summary>Base partagée des BPM (facultatif)</summary>
        <p class="muted small">Les BPM mesurés une fois servent à tous les utilisateurs et appareils ; chacun y garde ses
          morceaux cochés. Demandez un code d’accès à l’administrateur de la base.</p>
        <label>Adresse du serveur
          <input type="text" id="sh-url" value="${esc(url)}" placeholder="https://moi.pythonanywhere.com" autocomplete="url" spellcheck="false" />
        </label>
        <label>Code d’accès
          <input type="password" id="sh-code" placeholder="nom:secret" autocomplete="off" spellcheck="false" />
        </label>
        <div class="row"><button type="button" data-sh="connect">Utiliser cette base</button></div>
        ${info}
      </details>`;
  }
}
