import { formatDuration, type Song } from '../core/library';
import { normalizeName } from '../core/names';
import type { Selection } from './selection';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** Morceaux par page du tableau. */
const PAGE_SIZE = 50;
/**
 * En dessous de ce seuil de confiance (réglable dans les options), le BPM détecté est douteux : à
 * vérifier, et masqué par défaut (bibliothèque et playlists). Sur de la vraie musique, les confiances
 * vont de 20 à 80 % environ.
 */
export const DEFAULT_DOUBT_THRESHOLD = 0.8;
let doubtThreshold = DEFAULT_DOUBT_THRESHOLD;

export function setDoubtThreshold(value: number): void {
  doubtThreshold = Math.min(1, Math.max(0, value));
}

export function getDoubtThreshold(): number {
  return doubtThreshold;
}
/** En dessous, aucune pulsation nette : le morceau est écarté des playlists tant qu'il n'est pas corrigé. */
export const NO_PULSE = 0.05;

/**
 * BPM douteux : mesuré avec une pulsation peu nette. Un BPM corrigé à la main, lu dans les tags ou
 * importé n'a pas de confiance : il n'est jamais douteux.
 */
export const isDoubtful = (s: Song): boolean => s.confidence !== undefined && s.confidence < doubtThreshold;

const SOURCE_LABEL: Record<NonNullable<Song['bpmSource']>, string> = {
  tag: 'tag',
  analyse: 'analyse',
  import: 'import',
  manuel: 'corrigé',
};

export interface LibraryEdit {
  /** Morceau retiré de la bibliothèque. */
  removed?: Song;
  /** Morceau dont le BPM vient d'être corrigé. */
  edited?: Song;
  /** La sélection « course » a changé. */
  selection?: boolean;
}

/**
 * Tableau de la bibliothèque : recherche, filtres, sélection des morceaux pour courir,
 * correction du BPM (saisie, ×2, ÷2) et suppression.
 */
export class LibraryView {
  private query = '';
  private onlyDoubtful = false;
  private onlySelected = false;
  /** Page affichée (à partir de 0). */
  private page = 0;
  /** Note sous le titre (ex. état de la base partagée). */
  private note = '';

  constructor(
    private readonly root: HTMLElement,
    private readonly getLibrary: () => Song[],
    private readonly selection: Selection,
    private readonly onEdit: (edit: LibraryEdit) => void,
    /** Option « Masquer les morceaux douteux » (sauf avec le filtre « À vérifier seulement »). */
    private readonly hideDoubtful: () => boolean = () => false,
  ) {
    root.addEventListener('input', (ev) => {
      const el = ev.target as HTMLInputElement;
      if (el.id === 'lib-search') this.query = el.value;
      else if (el.id === 'lib-doubtful') this.onlyDoubtful = el.checked;
      else if (el.id === 'lib-selected') this.onlySelected = el.checked;
      else return;
      this.page = 0;
      this.renderRows();
    });
    root.addEventListener('change', (ev) => {
      const el = ev.target as HTMLInputElement;
      if (el.matches('input.sel')) {
        const song = this.find(el.dataset.id);
        if (song) this.select([song], el.checked);
        return;
      }
      if (el.id === 'lib-sel-all') {
        this.select(this.visible(), el.checked);
        return;
      }
      if (!el.matches('input.bpm-edit')) return;
      const song = this.find(el.dataset.id);
      const v = Number.parseFloat(el.value.replace(',', '.'));
      if (song && v >= 40 && v <= 260) this.setBpm(song, v);
      else if (song) el.value = String(song.bpm);
    });
    root.addEventListener('click', (ev) => {
      const nav = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-page]');
      if (nav) {
        const last = Math.max(0, Math.ceil(this.visible().length / PAGE_SIZE) - 1);
        const to = { first: 0, prev: this.page - 1, next: this.page + 1, last }[nav.dataset.page ?? ''] ?? this.page;
        this.page = Math.min(last, Math.max(0, to));
        this.renderRows();
        if (nav.closest('#lib-pages-bottom')) this.root.querySelector('.lib-table')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return;
      }
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
      const song = this.find(btn?.dataset.id);
      if (!btn || !song) return;
      if (btn.dataset.act === 'x2' && song.bpm * 2 <= 260) this.setBpm(song, song.bpm * 2);
      else if (btn.dataset.act === 'half' && song.bpm / 2 >= 40) this.setBpm(song, song.bpm / 2);
      else if (btn.dataset.act === 'del') {
        const lib = this.getLibrary();
        lib.splice(lib.indexOf(song), 1);
        this.onEdit({ removed: song });
        this.render();
      }
    });
  }

  setNote(note: string): void {
    this.note = note;
    const el = this.root.querySelector('#lib-note');
    if (el) el.textContent = note;
  }

  render(): void {
    const lib = this.getLibrary();
    this.root.hidden = lib.length === 0;
    if (lib.length === 0) return;
    const doubtful = lib.filter(isDoubtful).length;
    const hidden = doubtful && this.hideDoubtful() ? ' (masqués)' : '';
    this.root.innerHTML = `
      <summary><h2 class="inline">Bibliothèque</h2> <span class="muted small">${lib.length} morceau(x)${doubtful ? ` · ${doubtful} à vérifier${hidden}` : ''}
        · <span id="lib-sel-count"></span></span></summary>
      <p id="lib-note" class="muted small">${esc(this.note)}</p>
      <div class="lib-tools">
        <input type="search" id="lib-search" placeholder="Rechercher un titre ou un artiste" value="${esc(this.query)}" />
        <label class="check"><input type="checkbox" id="lib-doubtful" ${this.onlyDoubtful ? 'checked' : ''} /> À vérifier seulement</label>
        <label class="check"><input type="checkbox" id="lib-selected" ${this.onlySelected ? 'checked' : ''} /> Cochés seulement</label>
      </div>
      <p class="muted small">Cochez les morceaux que vous voulez entendre en courant, puis activez « Morceaux cochés seulement »
        dans les options de sélection.</p>
      <p class="muted small">Le BPM détecté peut être le double ou la moitié du tempo perçu : les deux conviennent pour courir
        (un pas par temps ou par demi-temps). Corrigez surtout les valeurs franchement fausses.</p>
      <div id="lib-pages-top" class="lib-pages"></div>
      <div class="table-wrap">
        <table class="lib-table">
          <thead><tr><th class="sel-col"><input type="checkbox" id="lib-sel-all" title="Cocher ou décocher les morceaux affichés" aria-label="Cocher les morceaux affichés" /></th><th>Morceau</th><th class="num">Durée</th><th class="num">BPM</th><th class="src-col">Source</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div id="lib-pages-bottom" class="lib-pages"></div>`;
    this.renderRows();
  }

  /** Morceaux correspondant à la recherche et aux filtres, triés. */
  private visible(): Song[] {
    const q = normalizeName(this.query);
    return this.getLibrary()
      .filter((s) => !q || normalizeName(`${s.artist} ${s.title}`).includes(q))
      .filter((s) => (this.onlyDoubtful ? isDoubtful(s) : !(this.hideDoubtful() && isDoubtful(s))))
      .filter((s) => !this.onlySelected || this.selection.has(s))
      .sort((a, b) => a.artist.localeCompare(b.artist, 'fr') || a.title.localeCompare(b.title, 'fr'));
  }

  private select(songs: Song[], on: boolean): void {
    this.selection.set(songs, on);
    this.onEdit({ selection: true });
    this.renderRows();
  }

  private renderRows(): void {
    const tbody = this.root.querySelector('tbody');
    if (!tbody) return;
    const rows = this.visible();
    const lib = this.getLibrary();
    const count = this.root.querySelector('#lib-sel-count');
    if (count) count.textContent = `${this.selection.count(lib)} coché(s)`;
    const all = this.root.querySelector<HTMLInputElement>('#lib-sel-all');
    if (all) {
      const n = rows.filter((s) => this.selection.has(s)).length;
      all.checked = rows.length > 0 && n === rows.length;
      all.indeterminate = n > 0 && n < rows.length;
      all.title = `${all.checked ? 'Décocher' : 'Cocher'} les ${rows.length} morceau(x) de la liste filtrée (toutes pages)`;
    }
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    this.page = Math.min(this.page, pages - 1);
    const start = this.page * PAGE_SIZE;
    const nav =
      pages > 1
        ? `<button type="button" data-page="first" ${this.page === 0 ? 'disabled' : ''} aria-label="Première page">«</button>
           <button type="button" data-page="prev" ${this.page === 0 ? 'disabled' : ''} aria-label="Page précédente">‹</button>
           <span class="small muted">Page ${this.page + 1} / ${pages} · ${start + 1}–${Math.min(rows.length, start + PAGE_SIZE)} sur ${rows.length}</span>
           <button type="button" data-page="next" ${this.page === pages - 1 ? 'disabled' : ''} aria-label="Page suivante">›</button>
           <button type="button" data-page="last" ${this.page === pages - 1 ? 'disabled' : ''} aria-label="Dernière page">»</button>`
        : `<span class="small muted">${rows.length} morceau(x)</span>`;
    for (const id of ['lib-pages-top', 'lib-pages-bottom']) {
      const el = this.root.querySelector(`#${id}`);
      if (el) el.innerHTML = id === 'lib-pages-bottom' && pages === 1 ? '' : nav;
    }
    tbody.innerHTML = rows
      .slice(start, start + PAGE_SIZE)
      .map((s) => {
        const doubtful = isDoubtful(s);
        const excluded = s.confidence !== undefined && s.confidence < NO_PULSE;
        const source = s.bpmSource ? SOURCE_LABEL[s.bpmSource] : '';
        const conf = s.bpmSource === 'analyse' && s.confidence !== undefined ? ` ${Math.round(s.confidence * 100)} %` : '';
        const tag = `<span class="tag ${doubtful ? 'warn' : ''}" title="${excluded ? 'Pas de pulsation nette : écarté des playlists tant que le BPM n’est pas corrigé' : doubtful ? 'Pulsation peu nette : à vérifier. Masqué et écarté des playlists tant que le BPM n’est pas corrigé, si l’option est active' : ''}">${source}${conf}${excluded ? ' · écarté' : ''}</span>`;
        return `<tr class="${doubtful ? 'doubtful' : ''}">
          <td class="sel-col"><input type="checkbox" class="sel" data-id="${esc(s.id)}" ${this.selection.has(s) ? 'checked' : ''} aria-label="Courir avec ${esc(s.title)}" /></td>
          <td><div class="song-title">${esc(s.title)}</div><div class="muted small">${esc(s.artist)} <span class="src-inline">${tag}</span></div></td>
          <td class="num">${formatDuration(s.duration)}</td>
          <td class="num"><input class="bpm-edit" type="text" inputmode="decimal" data-id="${esc(s.id)}" value="${s.bpm}" aria-label="BPM de ${esc(s.title)}" /></td>
          <td class="src-col">${tag}</td>
          <td class="actions">
            <button type="button" data-act="half" data-id="${esc(s.id)}" title="Diviser le BPM par 2">÷2</button>
            <button type="button" data-act="x2" data-id="${esc(s.id)}" title="Multiplier le BPM par 2">×2</button>
            <button type="button" data-act="del" data-id="${esc(s.id)}" class="link danger" title="Retirer de la bibliothèque" aria-label="Retirer ${esc(s.title)} de la bibliothèque"><span class="del-label">Retirer</span><span class="del-icon" aria-hidden="true">✕</span></button>
          </td>
        </tr>`;
      })
      .join('');
  }

  private find(id: string | undefined): Song | undefined {
    return id ? this.getLibrary().find((s) => s.id === id) : undefined;
  }

  private setBpm(song: Song, bpm: number): void {
    song.bpm = Math.round(bpm * 10) / 10;
    song.bpmSource = 'manuel';
    song.confidence = undefined;
    this.onEdit({ edited: song });
    this.render();
  }
}
