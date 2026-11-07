import type { Song } from '../core/library';
import { safeStorage } from '../services/spotify';
import type { SharedDb, SongListName } from '../services/sharedDb';

const STORAGE_KEYS: Record<SongListName, string> = { selection: 'runbpm.selection', excluded: 'runbpm.excluded' };

/** Clé de sélection d'un morceau : son identifiant Navidrome s'il en a un (partagé entre appareils). */
export const selectionKey = (s: Song): string => s.navidromeId ?? s.id;

/**
 * Liste de morceaux de l'utilisateur : cochés « pour courir » (`selection`) ou exclus des playlists
 * (`excluded`). Conservée dans ce navigateur et, quand la base partagée est disponible, sur le
 * serveur RunBPM (une liste par utilisateur).
 */
export class Selection {
  private readonly store = safeStorage(() => localStorage);
  private keys: Set<string>;
  private remote?: SharedDb;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly getLibrary: () => Song[],
    private readonly onSyncError: (message: string) => void = () => undefined,
    private readonly list: SongListName = 'selection',
  ) {
    let saved: string[] = [];
    try {
      saved = JSON.parse(this.store.getItem(STORAGE_KEYS[list]) ?? '[]') as string[];
    } catch {
      /* sélection illisible : on repart de zéro */
    }
    this.keys = new Set(Array.isArray(saved) ? saved : []);
  }

  get size(): number {
    return this.keys.size;
  }

  /** Un morceau coché avant d'être relié au serveur reste coché (clé locale ou Navidrome). */
  has(song: Song): boolean {
    return this.keys.has(selectionKey(song)) || this.keys.has(song.id);
  }

  set(songs: Song[], on: boolean): void {
    for (const s of songs) {
      this.keys.delete(s.id);
      if (on) this.keys.add(selectionKey(s));
      else this.keys.delete(selectionKey(s));
    }
    this.persist();
  }

  /** Nombre de morceaux de la bibliothèque cochés. */
  count(library: Song[]): number {
    return library.reduce((n, s) => n + (this.has(s) ? 1 : 0), 0);
  }

  /**
   * Rattache la sélection au serveur : celle du serveur fait foi pour les morceaux Navidrome ;
   * si elle est vide, la sélection locale y est envoyée.
   */
  async attach(remote: SharedDb | undefined): Promise<void> {
    this.remote = undefined;
    if (!remote) return;
    // Le serveur n'est retenu qu'une fois la liste lue (un serveur ancien peut ne pas la connaître).
    const server = await remote.list(this.list);
    this.remote = remote;
    // Les morceaux cochés avant leur lien au serveur passent sur la clé Navidrome.
    for (const s of this.getLibrary()) {
      if (s.navidromeId && this.keys.delete(s.id)) this.keys.add(s.navidromeId);
    }
    if (server.length === 0) {
      const local = this.serverKeys();
      if (local.length) await remote.saveList(this.list, local);
      this.saveLocal();
      return;
    }
    const nd = this.navidromeIds();
    this.keys = new Set([...[...this.keys].filter((k) => !nd.has(k)), ...server]);
    this.saveLocal();
  }

  detach(): void {
    clearTimeout(this.timer);
    this.remote = undefined;
  }

  private navidromeIds(): Set<string> {
    return new Set(this.getLibrary().map((s) => s.navidromeId).filter((x): x is string => !!x));
  }

  /**
   * Clés à garder sur le serveur : tout sauf les morceaux purement locaux (sans lien Navidrome),
   * y compris les morceaux cochés sur un autre appareil et absents de cette bibliothèque.
   */
  private serverKeys(): string[] {
    const localOnly = new Set(this.getLibrary().filter((s) => !s.navidromeId).map((s) => s.id));
    return [...this.keys].filter((k) => !localOnly.has(k));
  }

  private saveLocal(): void {
    this.store.setItem(STORAGE_KEYS[this.list], JSON.stringify([...this.keys]));
  }

  private persist(): void {
    this.saveLocal();
    const remote = this.remote;
    if (!remote) return;
    clearTimeout(this.timer);
    // Seules les clés Navidrome vont au serveur ; les morceaux purement locaux restent ici.
    this.timer = setTimeout(() => {
      remote.saveList(this.list, this.serverKeys()).catch((e: Error) => this.onSyncError(e.message));
    }, 600);
  }
}
