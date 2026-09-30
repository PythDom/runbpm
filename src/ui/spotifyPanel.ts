import type { Song } from '../core/library';
import type { Playlist } from '../core/playlist';
import { pickBestTrack, searchQuery } from '../core/spotifyMatch';
import {
  safeStorage,
  SpotifyApi,
  SpotifyAuth,
  SpotifyRemote,
  SpotifyWebPlayer,
  WEB_PLAYER_TARGET,
  type SpotifyDevice,
} from '../services/spotify';
import type { RemotePlayback } from './player';

const KEY_TARGET = 'runbpm.spotify.target';
const KEY_NOT_FOUND = 'runbpm.spotify.notFound';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const $ = <T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string) => root.querySelector(sel) as T;

export interface SpotifyPanelHooks {
  /** Connexion, déconnexion ou changement d'appareil. */
  onConnectionChange(): void;
  getLibrary(): Song[];
  /** Des morceaux de la bibliothèque ont reçu un identifiant Spotify. */
  onLibraryChanged(): void;
  /** Appelé juste avant de quitter la page pour se connecter (sauvegarde de l'état). */
  beforeRedirect(): void;
}

/**
 * Carte « Spotify » : configuration du Client ID, connexion, choix de l'appareil de lecture,
 * liaison des morceaux de la bibliothèque et création de playlists.
 */
export class SpotifyPanel {
  readonly auth = new SpotifyAuth(
    safeStorage(() => localStorage),
    safeStorage(() => sessionStorage),
  );
  readonly api = new SpotifyApi(this.auth);
  private readonly webPlayer = new SpotifyWebPlayer(this.auth);
  private readonly store = safeStorage(() => localStorage);
  private user?: { id: string; name: string };
  private devices: SpotifyDevice[] = [];
  private status = '';
  private statusIsError = false;
  private linking?: { done: number; total: number; found: number; cancelled: boolean };
  private remoteImpl?: SpotifyRemote;

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: SpotifyPanelHooks,
  ) {
    root.addEventListener('click', (ev) => this.onClick(ev));
    root.addEventListener('change', (ev) => this.onChange(ev));
  }

  /** Vrai quand la lecture via Spotify est possible (connecté). */
  get connected(): boolean {
    return this.auth.loggedIn && this.user !== undefined;
  }

  get remote(): RemotePlayback | undefined {
    if (!this.connected) return undefined;
    this.remoteImpl ??= new SpotifyRemote(this.api, this.webPlayer, () => this.target);
    return this.remoteImpl;
  }

  /** Traite un éventuel retour de connexion, puis affiche la carte. */
  async init(loc: Location = window.location): Promise<void> {
    this.render();
    try {
      const redirectUri = SpotifyAuth.redirectUri(loc);
      if (await this.auth.handleRedirect(loc.search, redirectUri)) {
        history.replaceState(null, '', loc.pathname + loc.hash);
      }
    } catch (e) {
      history.replaceState(null, '', loc.pathname + loc.hash);
      this.setStatus((e as Error).message, true);
    }
    if (this.auth.loggedIn) await this.connect();
    else this.render();
  }

  /** Crée la playlist courante dans le compte Spotify (morceaux liés uniquement). */
  async exportPlaylist(playlist: Playlist, name: string, description: string): Promise<{ url: string; added: number; missing: number }> {
    const uris = playlist.entries.map((e) => e.song.spotifyUri).filter((u): u is string => !!u);
    if (uris.length === 0) throw new Error('Aucun morceau de cette playlist n’est lié à Spotify : utilisez « Lier la bibliothèque ».');
    const res = await this.api.createPlaylist(name, description, uris);
    return { url: res.url, added: uris.length, missing: playlist.entries.length - uris.length };
  }

  // ---------- interne ----------

  private get target(): string {
    return this.store.getItem(KEY_TARGET) || WEB_PLAYER_TARGET;
  }

  private async connect(): Promise<void> {
    try {
      this.user = await this.api.me();
      this.setStatus('');
      if (this.target === WEB_PLAYER_TARGET) this.prepareWebPlayer();
      void this.refreshDevices();
    } catch (e) {
      this.user = undefined;
      this.setStatus((e as Error).message, true);
    }
    this.render();
    this.hooks.onConnectionChange();
  }

  private prepareWebPlayer(): void {
    this.webPlayer.device().catch((e: Error) => {
      this.setStatus(`${e.message}. Choisissez plutôt un appareil (téléphone, ordinateur) où l’application Spotify est ouverte.`, true);
      this.render();
    });
  }

  private async refreshDevices(): Promise<void> {
    try {
      this.devices = (await this.api.devices()).filter((d) => d.name !== 'RunBPM');
    } catch (e) {
      this.setStatus((e as Error).message, true);
    }
    this.render();
  }

  private disconnect(): void {
    this.auth.logout();
    this.webPlayer.disconnect();
    this.user = undefined;
    this.remoteImpl = undefined;
    this.devices = [];
    this.setStatus('');
    this.render();
    this.hooks.onConnectionChange();
  }

  private async login(): Promise<void> {
    const input = $<HTMLInputElement>(this.root, '#sp-client');
    this.auth.clientId = input.value;
    try {
      const url = await this.auth.authorizeUrl(SpotifyAuth.redirectUri(window.location));
      this.hooks.beforeRedirect();
      window.location.assign(url);
    } catch (e) {
      this.setStatus((e as Error).message, true);
      this.render();
    }
  }

  private notFound(): Set<string> {
    try {
      return new Set(JSON.parse(this.store.getItem(KEY_NOT_FOUND) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  }

  private linkCandidates(): Song[] {
    const skip = this.notFound();
    // Les morceaux de démo sont fictifs : inutile de les chercher.
    return this.hooks.getLibrary().filter((s) => !s.spotifyUri && !s.id.startsWith('demo-') && !skip.has(s.id));
  }

  /** Recherche chaque morceau non lié et retient le résultat s'il correspond sans ambiguïté. */
  private async linkLibrary(): Promise<void> {
    const songs = this.linkCandidates();
    if (songs.length === 0) return;
    const notFound = this.notFound();
    this.linking = { done: 0, total: songs.length, found: 0, cancelled: false };
    this.setStatus('');
    this.render();
    try {
      for (const song of songs) {
        if (this.linking.cancelled) break;
        const best = pickBestTrack(song, await this.api.searchTracks(searchQuery(song), 10));
        if (best) {
          song.spotifyUri = best.uri;
          this.linking.found++;
        } else {
          notFound.add(song.id);
        }
        this.linking.done++;
        if (this.linking.done % 10 === 0) this.hooks.onLibraryChanged();
        this.render();
      }
      const { found, done } = this.linking;
      this.setStatus(`${found} morceau(x) trouvé(s) sur Spotify sur ${done} recherché(s).`);
    } catch (e) {
      this.setStatus((e as Error).message, true);
    } finally {
      this.store.setItem(KEY_NOT_FOUND, JSON.stringify([...notFound]));
      this.linking = undefined;
      this.hooks.onLibraryChanged();
      this.render();
    }
  }

  private setStatus(msg: string, isError = false): void {
    this.status = msg;
    this.statusIsError = isError;
  }

  private onClick(ev: Event): void {
    const action = (ev.target as HTMLElement).closest<HTMLElement>('[data-sp]')?.dataset.sp;
    if (action === 'login') void this.login();
    else if (action === 'logout') this.disconnect();
    else if (action === 'devices') void this.refreshDevices();
    else if (action === 'link') void this.linkLibrary();
    else if (action === 'cancel' && this.linking) this.linking.cancelled = true;
    else if (action === 'copy') {
      void navigator.clipboard?.writeText(SpotifyAuth.redirectUri(window.location)).then(() => {
        const btn = ev.target as HTMLElement;
        btn.textContent = 'Copié';
      });
    }
  }

  private onChange(ev: Event): void {
    const el = ev.target as HTMLSelectElement;
    if (el.id !== 'sp-target') return;
    this.store.setItem(KEY_TARGET, el.value);
    if (el.value === WEB_PLAYER_TARGET) this.prepareWebPlayer();
    this.hooks.onConnectionChange();
    this.render();
  }

  private render(): void {
    const library = this.hooks.getLibrary();
    const linked = library.filter((s) => s.spotifyUri).length;
    const status = this.status
      ? `<p class="summary ${this.statusIsError ? 'error-text' : 'muted'}">${esc(this.status)}</p>`
      : '';
    const intro = `<p class="muted small">Lire les morceaux depuis votre compte Spotify <strong>Premium</strong>.
      Spotify ne permet pas de modifier le tempo : pour ces morceaux, la playlist ne retient que ceux déjà au bon BPM.</p>`;

    if (!this.connected) {
      const redirect = SpotifyAuth.redirectUri(window.location);
      const localhostWarning =
        window.location.hostname === 'localhost'
          ? `<p class="summary error-text">Spotify refuse « localhost » : ouvrez l’application via
             <a href="${esc(redirect.replace('//localhost', '//127.0.0.1'))}">${esc(redirect.replace('//localhost', '//127.0.0.1'))}</a>.</p>`
          : '';
      this.root.innerHTML = `
        <h2><span class="step">4</span> Spotify <span class="muted small">(optionnel)</span></h2>
        ${intro}
        <details ${this.auth.clientId ? '' : 'open'}>
          <summary>Configurer (une seule fois)</summary>
          <ol class="steps small">
            <li>Créez une application sur <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a>
              (cochez <em>Web API</em> et <em>Web Playback SDK</em>).</li>
            <li>Déclarez cette adresse de redirection :
              <span class="copy-row"><code>${esc(redirect)}</code><button type="button" data-sp="copy">Copier</button></span></li>
            <li>Dans <em>User Management</em>, ajoutez le compte Spotify de chaque coureur (5 maximum).</li>
            <li>Collez le <em>Client ID</em> ci-dessous.</li>
          </ol>
        </details>
        ${localhostWarning}
        <label>Client ID
          <input type="text" id="sp-client" value="${esc(this.auth.clientId)}" autocomplete="off" spellcheck="false" placeholder="32 caractères" />
        </label>
        <div class="row"><button type="button" class="primary" data-sp="login">Se connecter à Spotify</button></div>
        ${status}`;
      return;
    }

    const target = this.target;
    const options = [
      `<option value="${WEB_PLAYER_TARGET}" ${target === WEB_PLAYER_TARGET ? 'selected' : ''}>Ce navigateur (lecteur intégré)</option>`,
      ...this.devices.map(
        (d) => `<option value="${esc(d.id)}" ${target === d.id ? 'selected' : ''}>${esc(d.name)} (${esc(d.type.toLowerCase())})</option>`,
      ),
    ];
    if (target !== WEB_PLAYER_TARGET && !this.devices.some((d) => d.id === target)) {
      options.push(`<option value="${esc(target)}" selected>Appareil précédent (introuvable)</option>`);
    }
    const toLink = this.linkCandidates().length;
    const linkBlock = this.linking
      ? `<div class="row"><progress max="${this.linking.total}" value="${this.linking.done}"></progress>
           <span class="small muted">${this.linking.done}/${this.linking.total}</span>
           <button type="button" data-sp="cancel">Arrêter</button></div>`
      : `<div class="row"><button type="button" data-sp="link" ${toLink === 0 ? 'disabled' : ''}>Lier la bibliothèque à Spotify${toLink ? ` (${toLink})` : ''}</button></div>`;

    this.root.innerHTML = `
      <h2><span class="step">4</span> Spotify <span class="muted small">(optionnel)</span></h2>
      <p class="summary">Connecté : <strong>${esc(this.user!.name)}</strong>
        <button type="button" class="link danger" data-sp="logout">Se déconnecter</button></p>
      <label>Lecture sur
        <span class="copy-row">
          <select id="sp-target">${options.join('')}</select>
          <button type="button" data-sp="devices" title="Actualiser la liste des appareils">Actualiser</button>
        </span>
      </label>
      <p class="muted small">Pour courir avec votre téléphone : ouvrez l’application Spotify dessus, puis choisissez-le ici.</p>
      <p class="summary"><strong>${linked}</strong> morceau(x) de la bibliothèque lié(s) à Spotify.</p>
      ${linkBlock}
      ${status}`;
  }
}
