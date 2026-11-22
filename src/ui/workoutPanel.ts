import { fetchCorosWorkout, parseCorosLink } from '../core/coros';
import { formatDuration } from '../core/library';
import {
  formatPaceShort,
  parsePaceInput,
  parseWorkout,
  resolveSteps,
  stepCadence,
  suggestedPaces,
  type CategoryPaces,
  type PaceCategory,
  type Workout,
} from '../core/workout';
import { safeStorage } from '../services/spotify';

const KEY = 'runbpm.workout';
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export type PlanMode = 'route' | 'workout';

interface Saved {
  mode: PlanMode;
  text: string;
  /** Allures saisies, par bloc : « indexBloc.indexÉtape » → s/km. */
  overrides: Record<string, number>;
  /** Séance importée par lien COROS (gardée pour ne pas la retélécharger). */
  imported?: Workout;
  /** Allures choisies par catégorie de bloc (s/km). */
  paces?: CategoryPaces;
}

export const WORKOUT_SAMPLE = `4x 4min/3min
44:00 8.31km

Warm Up
1.00 km
Pace | 5'30''-6'30'' min/km
Repeat 4 Times
Training
04:00
Pace | 4'30''-5'10'' min/km
Rest
03:00
Pace | 5'00''-6'00'' min/km
Cool Down
10:00
Pace | 5'00''-6'00'' min/km`;

/**
 * Écran 1, mode « Séance » : texte de la séance collé depuis l'application d'entraînement, ou lien de
 * partage COROS, lu en direct ; cadences par défaut des blocs sans allure ; tableau des blocs avec
 * allure modifiable et cadence correspondante.
 */
export class WorkoutPanel {
  private readonly store = safeStorage(() => localStorage);
  private state: Saved = { mode: 'route', text: '', overrides: {} };
  private parsed?: Workout;
  private error = '';
  private timer?: ReturnType<typeof setTimeout>;
  private loading = false;
  /** Téléchargement en cours (un lien collé remplace le précédent). */
  private fetchRun = 0;

  constructor(
    private readonly el: {
      modes: HTMLElement;
      routePanel: HTMLElement;
      panel: HTMLElement;
      text: HTMLTextAreaElement;
      steps: HTMLElement;
      summary: HTMLElement;
      defaults: HTMLElement;
    },
    /** Cadence (pas/min) pour une vitesse en km/h, selon le profil du coureur. */
    private readonly cadenceFor: (speedKmh: number) => number,
    private readonly fallbackPace: () => number,
    /** Allures habituelles du coureur (sorties importées dans son profil), s'il y en a. */
    private readonly historyPaces: () => Required<CategoryPaces> | undefined,
    private readonly onChange: () => void,
  ) {
    try {
      const raw = this.store.getItem(KEY);
      if (raw) this.state = { ...this.state, ...(JSON.parse(raw) as Saved) };
    } catch {
      /* séance illisible : on repart de zéro */
    }
    el.text.value = this.state.text;
    this.parse();
    const savedLink = parseCorosLink(this.state.text);
    if (savedLink && !this.state.imported) void this.importLink(savedLink);
    el.defaults.addEventListener('click', (ev) => {
      if (!(ev.target as HTMLElement).closest('#workout-defaults-reset')) return;
      this.state.paces = {};
      this.save();
      this.render();
      this.onChange();
    });
    el.defaults.addEventListener('change', (ev) => {
      const input = ev.target as HTMLInputElement;
      const key = input.dataset.default as PaceCategory | undefined;
      if (!key) return;
      const v = parsePaceInput(input.value);
      const paces = { ...this.state.paces };
      // Champ vidé : retour à la valeur proposée.
      if (input.value.trim() === '') delete paces[key];
      else if (v) paces[key] = v;
      else {
        input.classList.add('invalid');
        return;
      }
      input.classList.remove('invalid');
      this.state.paces = paces;
      this.save();
      this.render();
      this.onChange();
    });

    el.modes.addEventListener('click', (ev) => {
      const mode = (ev.target as HTMLElement).closest<HTMLElement>('[data-mode]')?.dataset.mode as PlanMode | undefined;
      if (mode && mode !== this.state.mode) {
        this.state.mode = mode;
        this.save();
        this.render();
        this.onChange();
      }
    });
    el.text.addEventListener('input', () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.setText(el.text.value), 350);
    });
    el.panel.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('#workout-sample')) {
        el.text.value = WORKOUT_SAMPLE;
        this.setText(WORKOUT_SAMPLE);
      }
    });
    el.steps.addEventListener('change', (ev) => {
      const input = ev.target as HTMLInputElement;
      const key = input.dataset.step;
      if (!key) return;
      const pace = parsePaceInput(input.value);
      if (input.value.trim() === '') delete this.state.overrides[key];
      else if (pace) this.state.overrides[key] = pace;
      else {
        input.classList.add('invalid');
        return;
      }
      this.applyOverrides();
      this.save();
      // Le tableau est reconstruit après la sortie du champ (pas pendant le « blur » qui la déclenche).
      setTimeout(() => {
        this.render();
        this.onChange();
      }, 0);
    });
    this.render();
  }

  get mode(): PlanMode {
    return this.state.mode;
  }

  /** Séance lue, si le mode « Séance » est actif. */
  get workout(): Workout | undefined {
    return this.state.mode === 'workout' ? this.parsed : undefined;
  }

  get title(): string | undefined {
    return this.parsed?.title;
  }

  /** Allures choisies par l'utilisateur, par catégorie de bloc (les autres suivent la séance). */
  get paces(): CategoryPaces {
    return this.state.paces ?? {};
  }

  /** Allures proposées par catégorie, pour les blocs sans allure dans la séance. */
  get proposedPaces(): Required<CategoryPaces> {
    return suggestedPaces(this.parsed, this.fallbackPace(), this.historyPaces());
  }

  /** Recalcule l'affichage (après un changement de profil ou d'allure de référence). */
  refresh(): void {
    this.render();
  }

  private setText(text: string): void {
    if (text === this.state.text) return;
    this.state.text = text;
    this.state.overrides = {};
    this.state.imported = undefined;
    this.parse();
    this.save();
    this.render();
    this.onChange();
    const link = parseCorosLink(text);
    if (link) void this.importLink(link);
  }

  /** Télécharge la séance d'un lien COROS. */
  private async importLink(link: NonNullable<ReturnType<typeof parseCorosLink>>): Promise<void> {
    const run = ++this.fetchRun;
    this.loading = true;
    this.render();
    try {
      const workout = await fetchCorosWorkout(link);
      if (run !== this.fetchRun) return;
      this.state.imported = workout;
      this.error = '';
      this.save();
    } catch (e) {
      if (run !== this.fetchRun) return;
      this.error = (e as Error).message;
    } finally {
      if (run === this.fetchRun) {
        this.loading = false;
        this.parse(false);
        this.render();
        this.onChange();
      }
    }
  }

  private parse(resetError = true): void {
    this.parsed = undefined;
    if (resetError) this.error = '';
    if (!this.state.text.trim()) return;
    if (parseCorosLink(this.state.text)) {
      // Lien COROS : séance téléchargée (copie, pour y appliquer les allures saisies).
      if (this.state.imported) {
        this.parsed = structuredClone(this.state.imported);
        this.applyOverrides();
      }
      return;
    }
    try {
      this.parsed = parseWorkout(this.state.text);
      this.applyOverrides();
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  private applyOverrides(): void {
    this.parsed?.blocks.forEach((b, i) =>
      b.steps.forEach((s, j) => {
        s.paceOverride = this.state.overrides[`${i}.${j}`];
      }),
    );
  }

  private save(): void {
    this.store.setItem(KEY, JSON.stringify(this.state));
  }

  /** Champs des allures : valeur choisie par l'utilisateur, sinon valeur proposée (en gris), et cadence correspondante. */
  private renderDefaults(): void {
    const suggested = suggestedPaces(this.parsed, this.fallbackPace(), this.historyPaces());
    const chosen = this.state.paces ?? {};
    for (const input of this.el.defaults.querySelectorAll<HTMLInputElement>('input[data-default]')) {
      const key = input.dataset.default as PaceCategory;
      const own = chosen[key];
      const pace = own ?? suggested[key];
      input.classList.toggle('suggested', !own);
      input.classList.remove('invalid');
      input.title = own
        ? `Choisie par vous (proposée : ${formatPaceShort(suggested[key])} /km)`
        : 'Allure proposée (séance, sinon vos sorties) ; modifiez-la pour adapter tous ces blocs';
      if (document.activeElement !== input) input.value = formatPaceShort(pace);
      const hint = this.el.defaults.querySelector(`[data-cadence="${key}"]`);
      if (hint) hint.textContent = `≈ ${Math.round(this.cadenceFor(3600 / pace))} pas/min`;
    }
    const reset = this.el.defaults.querySelector<HTMLElement>('#workout-defaults-reset');
    if (reset) reset.hidden = !Object.keys(chosen).length;
  }

  private render(): void {
    const workout = this.state.mode === 'workout';
    for (const b of this.el.modes.querySelectorAll<HTMLElement>('[data-mode]')) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === this.state.mode));
    }
    this.el.routePanel.hidden = workout;
    this.el.panel.hidden = !workout;
    if (!workout) return;
    this.renderDefaults();

    if (this.error) {
      this.el.summary.className = 'summary error-text';
      this.el.summary.textContent = this.error;
      this.el.steps.innerHTML = '';
      return;
    }
    const w = this.parsed;
    if (!w) {
      this.el.summary.className = 'summary muted';
      this.el.summary.textContent = this.loading ? 'Chargement de la séance COROS…' : 'Aucune séance.';
      this.el.steps.innerHTML = '';
      return;
    }
    const categories = this.paces;
    const resolved = resolveSteps(w, this.fallbackPace(), categories, this.proposedPaces);
    const total = resolved.reduce((a, s) => a + s.duration, 0);
    const dist = resolved.reduce((a, s) => a + s.distance, 0);
    const estimated = resolved.some((s) => s.paceSource === 'estimée');
    const fromLink = !!parseCorosLink(this.state.text);
    const announced =
      w.totalDuration && Math.abs(total - w.totalDuration) > 30
        ? ` <span class="warn-text">(annoncée : ${formatDuration(w.totalDuration)})</span>`
        : '';
    this.el.summary.className = 'summary';
    this.el.summary.innerHTML =
      `<strong>${esc(w.title)}</strong>${fromLink ? ' <span class="tag">COROS</span>' : ''}<br>${formatDuration(total)}${announced} · ≈ ${(dist / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} km · ` +
      `${resolved.length} bloc(s)` +
      (estimated ? '<br><span class="small muted">Blocs sans allure dans la séance (« prop. ») : allure proposée pour leur catégorie, modifiable ci-dessus ou bloc par bloc.</span>' : '');

    // Un rang par bloc distinct (les répétitions ne sont pas recopiées).
    const first = new Map(resolved.map((r) => [r.step, r]));
    const rows = w.blocks.flatMap((b, i) =>
      b.steps.map((s, j) => {
        const r = first.get(s)!;
        const target = s.duration !== undefined ? formatDuration(s.duration) : `${((s.distance ?? 0) / 1000).toLocaleString('fr-FR')} km`;
        const cadence = stepCadence(r, this.cadenceFor);
        const range = s.paceLow !== undefined ? `${formatPaceShort(s.paceLow)}–${formatPaceShort(s.paceHigh!)}` : '';
        return `<tr class="${j === 0 && b.repeat > 1 ? 'rep-start' : ''}">
          <td>${j === 0 && b.repeat > 1 ? `<span class="tag">×${b.repeat}</span> ` : b.repeat > 1 ? '<span class="rep-indent"></span>' : ''}${esc(s.name)}</td>
          <td class="num">${target}</td>
          <td class="num"><input class="pace-edit" type="text" inputmode="decimal" data-step="${i}.${j}"
            value="${s.paceOverride ? formatPaceShort(s.paceOverride) : ''}" placeholder="${formatPaceShort(r.pace)}"
            title="${range ? `Plage indiquée : ${range} /km. ` : ''}Allure retenue (min:s par km) ; videz pour revenir à la valeur proposée"
            aria-label="Allure de ${esc(s.name)}" />${
              r.paceSource === 'estimée'
                ? '<span class="tag warn" title="Pas d’allure dans la séance : allure proposée pour sa catégorie">prop.</span>'
                : r.paceSource === 'catégorie'
                  ? '<span class="tag" title="Allure choisie pour cette catégorie de bloc">cat.</span>'
                  : ''
            }</td>
          <td class="num strong">${cadence}</td>
        </tr>`;
      }),
    );
    this.el.steps.innerHTML = `<div class="table-wrap"><table class="workout-table">
      <thead><tr><th>Bloc</th><th class="num">Durée</th><th class="num">Allure /km</th><th class="num">Pas/min</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>`;
  }
}
