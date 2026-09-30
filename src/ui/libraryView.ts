import { formatDuration, type Song } from '../core/library';
import { normalizeName } from '../core/names';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const MAX_ROWS = 200;
/** En dessous de cette confiance, le BPM détecté mérite une vérification. */
export const LOW_CONFIDENCE = 0.5;
/** En dessous, aucune pulsation nette : le morceau est écarté des playlists tant qu'il n'est pas corrigé. */
export const NO_PULSE = 0.15;

const SOURCE_LABEL: Record<NonNullable<Song['bpmSource']>, string> = {
  tag: 'tag',
  analyse: 'analyse',
  import: 'import',
  manuel: 'corrigé',
};

/**
 * Tableau de la bibliothèque : recherche, filtre « à vérifier », correction du BPM
 * (saisie, ×2, ÷2) et suppression.
 */
export class LibraryView {
  private query = '';
  private onlyDoubtful = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly getLibrary: () => Song[],
    private readonly onEdit: (removed?: Song) => void,
  ) {
    root.addEventListener('input', (ev) => {
      const el = ev.target as HTMLInputElement;
      if (el.id === 'lib-search') {
        this.query = el.value;
        this.renderRows();
      } else if (el.id === 'lib-doubtful') {
        this.onlyDoubtful = el.checked;
        this.renderRows();
      }
    });
    root.addEventListener('change', (ev) => {
      const el = ev.target as HTMLInputElement;
      if (!el.matches('input.bpm-edit')) return;
      const song = this.find(el.dataset.id);
      const v = Number.parseFloat(el.value.replace(',', '.'));
      if (song && v >= 40 && v <= 260) this.setBpm(song, v);
      else if (song) el.value = String(song.bpm);
    });
    root.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
      const song = this.find(btn?.dataset.id);
      if (!btn || !song) return;
      if (btn.dataset.act === 'x2' && song.bpm * 2 <= 260) this.setBpm(song, song.bpm * 2);
      else if (btn.dataset.act === 'half' && song.bpm / 2 >= 40) this.setBpm(song, song.bpm / 2);
      else if (btn.dataset.act === 'del') {
        const lib = this.getLibrary();
        lib.splice(lib.indexOf(song), 1);
        this.onEdit(song);
        this.render();
      }
    });
  }

  render(): void {
    const lib = this.getLibrary();
    this.root.hidden = lib.length === 0;
    if (lib.length === 0) return;
    const doubtful = lib.filter((s) => s.confidence !== undefined && s.confidence < LOW_CONFIDENCE).length;
    this.root.innerHTML = `
      <summary><h2 class="inline">Bibliothèque</h2> <span class="muted small">${lib.length} morceau(x)${doubtful ? ` · ${doubtful} à vérifier` : ''}</span></summary>
      <div class="lib-tools">
        <input type="search" id="lib-search" placeholder="Rechercher un titre ou un artiste" value="${esc(this.query)}" />
        <label class="check"><input type="checkbox" id="lib-doubtful" ${this.onlyDoubtful ? 'checked' : ''} /> À vérifier seulement</label>
      </div>
      <p class="muted small">Le BPM détecté peut être le double ou la moitié du tempo perçu : les deux conviennent pour courir
        (un pas par temps ou par demi-temps). Corrigez surtout les valeurs franchement fausses.</p>
      <div class="table-wrap">
        <table class="lib-table">
          <thead><tr><th>Morceau</th><th class="num">Durée</th><th class="num">BPM</th><th>Source</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <p id="lib-more" class="muted small"></p>`;
    this.renderRows();
  }

  private renderRows(): void {
    const tbody = this.root.querySelector('tbody');
    if (!tbody) return;
    const q = normalizeName(this.query);
    const rows = this.getLibrary()
      .filter((s) => !q || normalizeName(`${s.artist} ${s.title}`).includes(q))
      .filter((s) => !this.onlyDoubtful || (s.confidence !== undefined && s.confidence < LOW_CONFIDENCE))
      .sort((a, b) => a.artist.localeCompare(b.artist, 'fr') || a.title.localeCompare(b.title, 'fr'));
    tbody.innerHTML = rows
      .slice(0, MAX_ROWS)
      .map((s) => {
        const doubtful = s.confidence !== undefined && s.confidence < LOW_CONFIDENCE;
        const excluded = s.confidence !== undefined && s.confidence < NO_PULSE;
        const source = s.bpmSource ? SOURCE_LABEL[s.bpmSource] : '';
        const conf = s.bpmSource === 'analyse' && s.confidence !== undefined ? ` ${Math.round(s.confidence * 100)} %` : '';
        return `<tr class="${doubtful ? 'doubtful' : ''}">
          <td><div class="song-title">${esc(s.title)}</div><div class="muted small">${esc(s.artist)}</div></td>
          <td class="num">${formatDuration(s.duration)}</td>
          <td class="num"><input class="bpm-edit" type="text" inputmode="decimal" data-id="${esc(s.id)}" value="${s.bpm}" aria-label="BPM de ${esc(s.title)}" /></td>
          <td><span class="tag ${doubtful ? 'warn' : ''}" title="${excluded ? 'Pas de pulsation nette : écarté des playlists tant que le BPM n’est pas corrigé' : doubtful ? 'Pulsation peu nette : à vérifier' : ''}">${source}${conf}${excluded ? ' · écarté' : ''}</span></td>
          <td class="actions">
            <button type="button" data-act="half" data-id="${esc(s.id)}" title="Diviser le BPM par 2">÷2</button>
            <button type="button" data-act="x2" data-id="${esc(s.id)}" title="Multiplier le BPM par 2">×2</button>
            <button type="button" data-act="del" data-id="${esc(s.id)}" class="link danger" title="Retirer de la bibliothèque">Retirer</button>
          </td>
        </tr>`;
      })
      .join('');
    const more = this.root.querySelector('#lib-more');
    if (more) more.textContent = rows.length > MAX_ROWS ? `${rows.length - MAX_ROWS} autres morceaux : affinez la recherche.` : '';
  }

  private find(id: string | undefined): Song | undefined {
    return id ? this.getLibrary().find((s) => s.id === id) : undefined;
  }

  private setBpm(song: Song, bpm: number): void {
    song.bpm = Math.round(bpm * 10) / 10;
    song.bpmSource = 'manuel';
    song.confidence = undefined;
    this.onEdit();
    this.render();
  }
}
