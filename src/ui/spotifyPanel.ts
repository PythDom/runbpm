import type { Song } from '../core/library';
import type { Playlist } from '../core/playlist';
import { pickBestTrack, searchQuery } from '../core/spotifyMatch';
import { safeStorage, SpotifyApi, SpotifyAuth } from '../services/spotify';
import type { SyncSource } from './companion';

const KEY_NOT_FOUND = 'runbpm.spotify.notFound';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface SpotifyPanelHooks {
  /** Connexion ou déconnexion. */
  onConnectionChange(): void;
  /** Appelé juste avant de quitter la page pour se connecter (sauvegarde de l'état). */
  beforeRedirect(): void;
}

/**
 * Partie « Spotify » de la carte Streaming : configuration du Client ID et connexion.
 * Fournit aussi la recherche des morceaux, la création de playlist et l'état du lecteur Spotify.
 */
export class SpotifyPanel {
  readonly auth = new SpotifyAuth(
    safeStorage(() => localStorage),
    safeStorage(() => sessionStorage),
  );
  readonly api = new SpotifyApi(this.auth);
  private readonly store = safeStorage(() => localStorage);
  private user?: { id: string; name: string };
  private status = '';
  private statusIsError = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: SpotifyPanelHooks,
  ) {
    root.addEventListener('click', (ev) => this.onClick(ev));
  }

  get connected(): boolean {
    return this.auth.loggedIn && this.user !== undefined;
  }

  /** Source de synchronisation du métronome : morceau et position joués par Spotify. */
  get syncSource(): SyncSource | undefined {
    return this.connected ? () => this.api.playbackState() : undefined;
  }

  /** Traite un éventuel retour de connexion, puis affiche la carte. */
  async init(loc: Location = window.location): Promise<void> {
    this.render();
    try {
      if (await this.auth.handleRedirect(loc.search, SpotifyAuth.redirectUri(loc))) {
        history.replaceState(null, '', loc.pathname + loc.hash);
      }
    } catch (e) {
      history.replaceState(null, '', loc.pathname + loc.hash);
      this.setStatus((e as Error).message, true);
    }
    if (this.auth.loggedIn) {
      try {
        this.user = await this.api.me();
        this.setStatus('');
      } catch (e) {
        this.setStatus((e as Error).message, true);
      }
      this.hooks.onConnectionChange();
    }
    this.render();
  }

  /** Morceaux déjà cherchés sans succès sur Spotify (exclus des playlists Spotify). */
  notFound(): Set<string> {
    try {
      return new Set(JSON.parse(this.store.getItem(KEY_NOT_FOUND) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  }

  /**
   * Cherche chaque morceau sur Spotify et lui associe l'identifiant trouvé, ou le marque comme
   * introuvable. Renvoie le nombre de morceaux trouvés.
   */
  async linkSongs(songs: Song[], onProgress: (done: number, total: number) => void): Promise<number> {
    const notFound = this.notFound();
    let found = 0;
    try {
      for (let i = 0; i < songs.length; i++) {
        const song = songs[i];
        const best = pickBestTrack(song, await this.api.searchTracks(searchQuery(song), 10));
        if (best) {
          song.spotifyUri = best.uri;
          found++;
        } else {
          notFound.add(song.id);
        }
        onProgress(i + 1, songs.length);
      }
    } finally {
      this.store.setItem(KEY_NOT_FOUND, JSON.stringify([...notFound]));
    }
    return found;
  }

  /** Crée la playlist dans le compte (tous les morceaux doivent être liés). */
  async createPlaylist(playlist: Playlist, name: string, description: string): Promise<string> {
    const uris = playlist.entries.map((e) => e.song.spotifyUri);
    if (uris.some((u) => !u)) throw new Error('Certains morceaux ne sont pas liés à Spotify.');
    return (await this.api.createPlaylist(name, description, uris as string[])).url;
  }

  // ---------- interne ----------

  private disconnect(): void {
    this.auth.logout();
    this.user = undefined;
    this.setStatus('');
    this.render();
    this.hooks.onConnectionChange();
  }

  private async login(): Promise<void> {
    const input = this.root.querySelector<HTMLInputElement>('#sp-client')!;
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

  private setStatus(msg: string, isError = false): void {
    this.status = msg;
    this.statusIsError = isError;
  }

  private onClick(ev: Event): void {
    const target = ev.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-sp]')?.dataset.sp;
    if (action === 'login') void this.login();
    else if (action === 'logout') this.disconnect();
    else if (action === 'copy') {
      void navigator.clipboard?.writeText(SpotifyAuth.redirectUri(window.location)).then(() => (target.textContent = 'Copié'));
    }
  }

  render(): void {
    const status = this.status
      ? `<p class="summary ${this.statusIsError ? 'error-text' : 'muted'}">${esc(this.status)}</p>`
      : '';
    if (this.connected) {
      this.root.innerHTML = `
        <p class="summary">Connecté : <strong>${esc(this.user!.name)}</strong>
          <button type="button" class="link danger" data-sp="logout">Se déconnecter</button></p>
        <p class="muted small">La playlist ne retient que des morceaux disponibles sur Spotify.
          Pendant la course, le métronome suit le morceau que joue l’application Spotify.</p>
        ${status}`;
      return;
    }
    const redirect = SpotifyAuth.redirectUri(window.location);
    const fixed = redirect.replace('//localhost', '//127.0.0.1');
    const localhostWarning =
      window.location.hostname === 'localhost'
        ? `<p class="summary error-text">Spotify refuse « localhost » : ouvrez l’application via <a href="${esc(fixed)}">${esc(fixed)}</a>.</p>`
        : '';
    this.root.innerHTML = `
      <p class="muted small">Compte <strong>Premium</strong> requis (règle Spotify pour les applications en mode développement).</p>
      <details ${this.auth.clientId ? '' : 'open'}>
        <summary>Configurer (une seule fois)</summary>
        <ol class="steps small">
          <li>Créez une application sur <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a> (cochez <em>Web API</em>).</li>
          <li>Déclarez cette adresse de redirection :
            <span class="copy-row"><code>${esc(redirect)}</code><button type="button" data-sp="copy">Copier</button></span></li>
          <li>Dans <em>User Management</em>, ajoutez votre compte Spotify (5 comptes maximum).</li>
          <li>Collez le <em>Client ID</em> ci-dessous.</li>
        </ol>
      </details>
      ${localhostWarning}
      <label>Client ID
        <input type="text" id="sp-client" value="${esc(this.auth.clientId)}" autocomplete="off" spellcheck="false" placeholder="32 caractères" />
      </label>
      <div class="row"><button type="button" class="primary" data-sp="login">Se connecter à Spotify</button></div>
      ${status}`;
  }
}
