import { formatDuration } from '../core/library';
import {
  formatPaceShort,
  parsePaceInput,
  parseWorkout,
  resolveSteps,
  WALK_CADENCE,
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
 * Écran 1, mode « Séance » : texte de la séance collé depuis l'application d'entraînement, lu en
 * direct ; tableau des blocs avec allure modifiable et cadence correspondante.
 */
export class WorkoutPanel {
  private readonly store = safeStorage(() => localStorage);
  private state: Saved = { mode: 'route', text: '', overrides: {} };
  private parsed?: Workout;
  private error = '';
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly el: { modes: HTMLElement; routePanel: HTMLElement; panel: HTMLElement; text: HTMLTextAreaElement; steps: HTMLElement; summary: HTMLElement },
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

  /** Recalcule l'affichage (après un changement de profil ou d'allure de référence). */
  refresh(): void {
    this.render();
  }

  private setText(text: string): void {
    if (text === this.state.text) return;
    this.state.text = text;
    this.state.overrides = {};
    this.parse();
    this.save();
    this.render();
    this.onChange();
  }

  private parse(): void {
    this.parsed = undefined;
    this.error = '';
    if (!this.state.text.trim()) return;
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

  private render(): void {
    const workout = this.state.mode === 'workout';
    for (const b of this.el.modes.querySelectorAll<HTMLElement>('[data-mode]')) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === this.state.mode));
    }
    this.el.routePanel.hidden = workout;
    this.el.panel.hidden = !workout;
    if (!workout) return;

    if (this.error) {
      this.el.summary.className = 'summary error-text';
      this.el.summary.textContent = this.error;
      this.el.steps.innerHTML = '';
      return;
    }
    const w = this.parsed;
    if (!w) {
      this.el.summary.className = 'summary muted';
      this.el.summary.textContent = 'Aucune séance.';
      this.el.steps.innerHTML = '';
      return;
    }
    const resolved = resolveSteps(w, this.fallbackPace());
    const total = resolved.reduce((a, s) => a + s.duration, 0);
    const dist = resolved.reduce((a, s) => a + s.distance, 0);
    const estimated = resolved.some((s) => s.paceSource === 'estimée');
    const announced =
      w.totalDuration && Math.abs(total - w.totalDuration) > 30
        ? ` <span class="warn-text">(annoncée : ${formatDuration(w.totalDuration)})</span>`
        : '';
    this.el.summary.className = 'summary';
    this.el.summary.innerHTML =
      `<strong>${esc(w.title)}</strong><br>${formatDuration(total)}${announced} · ≈ ${(dist / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} km · ` +
      `${resolved.length} bloc(s)` +
      (estimated ? '<br><span class="small muted">Allures « estimées » : déduites des autres blocs, modifiables ci-dessous.</span>' : '');

    // Un rang par bloc distinct (les répétitions ne sont pas recopiées).
    const first = new Map(resolved.map((r) => [r.step, r]));
    const rows = w.blocks.flatMap((b, i) =>
      b.steps.map((s, j) => {
        const r = first.get(s)!;
        const target = s.duration !== undefined ? formatDuration(s.duration) : `${((s.distance ?? 0) / 1000).toLocaleString('fr-FR')} km`;
        const cadence = s.kind === 'walk' ? WALK_CADENCE : Math.round(this.cadenceFor(3600 / r.pace));
        const range = s.paceLow !== undefined ? `${formatPaceShort(s.paceLow)}–${formatPaceShort(s.paceHigh!)}` : '';
        return `<tr class="${j === 0 && b.repeat > 1 ? 'rep-start' : ''}">
          <td>${j === 0 && b.repeat > 1 ? `<span class="tag">×${b.repeat}</span> ` : b.repeat > 1 ? '<span class="rep-indent"></span>' : ''}${esc(s.name)}</td>
          <td class="num">${target}</td>
          <td class="num"><input class="pace-edit" type="text" inputmode="decimal" data-step="${i}.${j}"
            value="${s.paceOverride ? formatPaceShort(s.paceOverride) : ''}" placeholder="${formatPaceShort(r.pace)}"
            title="${range ? `Plage indiquée : ${range} /km. ` : ''}Allure retenue (min:s par km) ; videz pour revenir à la valeur proposée"
            aria-label="Allure de ${esc(s.name)}" />${r.paceSource === 'estimée' ? '<span class="tag warn" title="Pas d’allure dans la séance : estimée">est.</span>' : ''}</td>
          <td class="num strong">${cadence}</td>
        </tr>`;
      }),
    );
    this.el.steps.innerHTML = `<div class="table-wrap"><table class="workout-table">
      <thead><tr><th>Bloc</th><th class="num">Durée</th><th class="num">Allure /km</th><th class="num">Pas/min</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>`;
  }
}
