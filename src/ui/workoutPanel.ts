import { fetchCorosWorkout, parseCorosLink } from '../core/coros';
import { formatDuration } from '../core/library';
import {
  formatPaceShort,
  parsePaceInput,
  parseWorkout,
  resolveSteps,
  stepCadence,
  suggestedCadences,
  type CadenceCategory,
  type DefaultCadences,
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
  /** Cadences par défaut des blocs sans allure. */
  defaults?: DefaultCadences;
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
      this.state.defaults = {};
      this.save();
      this.render();
      this.onChange();
    });
    el.defaults.addEventListener('change', (ev) => {
      const input = ev.target as HTMLInputElement;
      const key = input.dataset.default as CadenceCategory | undefined;
      if (!key) return;
      const v = Number.parseInt(input.value, 10);
      const defaults = { ...this.state.defaults };
      // Champ vidé : retour à la valeur proposée.
      if (input.value.trim() === '') delete defaults[key];
      else if (v >= 100 && v <= 220) defaults[key] = v;
      else {
        input.classList.add('invalid');
        return;
      }
      input.classList.remove('invalid');
      this.state.defaults = defaults;
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

  /** Cadences fixées par l'utilisateur, par catégorie de bloc (les autres suivent la séance). */
  get defaults(): DefaultCadences {
    return this.state.defaults ?? {};
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

  /** Champs des cadences : valeur fixée par l'utilisateur, sinon valeur proposée (en gris). */
  private renderDefaults(): void {
    const suggested = suggestedCadences(this.parsed, this.cadenceFor, this.fallbackPace());
    const chosen = this.state.defaults ?? {};
    for (const input of this.el.defaults.querySelectorAll<HTMLInputElement>('input[data-default]')) {
      const key = input.dataset.default as CadenceCategory;
      const own = chosen[key];
      input.classList.toggle('suggested', !own);
      input.title = own ? `Fixée par vous (proposée : ${suggested[key]})` : 'Valeur proposée d’après la séance ; modifiez-la pour adapter tous ces blocs';
      if (document.activeElement !== input) input.value = String(own ?? suggested[key]);
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
    const resolved = resolveSteps(w, this.fallbackPace());
    const total = resolved.reduce((a, s) => a + s.duration, 0);
    const dist = resolved.reduce((a, s) => a + s.distance, 0);
    const estimated = resolved.some((s) => s.paceSource === 'estimée');
    const defaults = this.defaults;
    const fromLink = !!parseCorosLink(this.state.text);
    const announced =
      w.totalDuration && Math.abs(total - w.totalDuration) > 30
        ? ` <span class="warn-text">(annoncée : ${formatDuration(w.totalDuration)})</span>`
        : '';
    this.el.summary.className = 'summary';
    this.el.summary.innerHTML =
      `<strong>${esc(w.title)}</strong>${fromLink ? ' <span class="tag">COROS</span>' : ''}<br>${formatDuration(total)}${announced} · ≈ ${(dist / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} km · ` +
      `${resolved.length} bloc(s)` +
      (estimated ? '<br><span class="small muted">Allures « estimées » : déduites des autres blocs, modifiables ci-dessous.</span>' : '');

    // Un rang par bloc distinct (les répétitions ne sont pas recopiées).
    const first = new Map(resolved.map((r) => [r.step, r]));
    const rows = w.blocks.flatMap((b, i) =>
      b.steps.map((s, j) => {
        const r = first.get(s)!;
        const target = s.duration !== undefined ? formatDuration(s.duration) : `${((s.distance ?? 0) / 1000).toLocaleString('fr-FR')} km`;
        const { cadence, fromDefault } = stepCadence(r, this.cadenceFor, defaults);
        const range = s.paceLow !== undefined ? `${formatPaceShort(s.paceLow)}–${formatPaceShort(s.paceHigh!)}` : '';
        return `<tr class="${j === 0 && b.repeat > 1 ? 'rep-start' : ''}">
          <td>${j === 0 && b.repeat > 1 ? `<span class="tag">×${b.repeat}</span> ` : b.repeat > 1 ? '<span class="rep-indent"></span>' : ''}${esc(s.name)}</td>
          <td class="num">${target}</td>
          <td class="num"><input class="pace-edit" type="text" inputmode="decimal" data-step="${i}.${j}"
            value="${s.paceOverride ? formatPaceShort(s.paceOverride) : ''}" placeholder="${formatPaceShort(r.pace)}"
            title="${range ? `Plage indiquée : ${range} /km. ` : ''}Allure retenue (min:s par km) ; videz pour revenir à la valeur proposée"
            aria-label="Allure de ${esc(s.name)}" />${r.paceSource === 'estimée' ? '<span class="tag warn" title="Pas d’allure dans la séance : estimée">est.</span>' : ''}</td>
          <td class="num strong">${cadence}${fromDefault ? ' <span class="tag" title="Cadence fixée pour cette catégorie de bloc">fixée</span>' : ''}</td>
        </tr>`;
      }),
    );
    this.el.steps.innerHTML = `<div class="table-wrap"><table class="workout-table">
      <thead><tr><th>Bloc</th><th class="num">Durée</th><th class="num">Allure /km</th><th class="num">Pas/min</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>`;
  }
}
