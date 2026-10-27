import { readActivity, type CadenceSegment } from '../core/activity';
import { calibrate, predictCadence, type CalibrationResult } from '../core/calibration';
import type { PlanOptions } from '../core/pacing';
import { DEFAULT_SLOPE_RULES, rangeLabel, withValues, type SlopeRule } from '../core/slopeRules';
import { safeStorage } from '../services/spotify';
import { confirmClick } from './confirm';
import { fileAccept } from './native';

/**
 * Profils coureur : chacun a ses réglages de cadence et, en option, un calibrage personnel issu
 * de sorties enregistrées (FIT, TCX). Tout reste dans ce navigateur.
 */

const KEY = 'runbpm.profiles';
/** Nombre maximal de tronçons conservés par profil (les plus récents). */
const MAX_SEGMENTS = 6000;

export interface RunnerProfile {
  id: string;
  name: string;
  baseCadence: string;
  /** Anciens coefficients linéaires (conservés pour compatibilité, plus utilisés). */
  uphill?: string;
  downhill?: string;
  /** Valeurs personnalisées des règles par pente (identifiant de tranche → valeur). */
  slopeValues?: Record<string, number>;
  useCalibration: boolean;
  calibration?: {
    activities: { name: string; date?: string; distanceKm: number; segments: number }[];
    segments: CadenceSegment[];
    model: CalibrationResult;
  };
}

interface Stored {
  current: string;
  profiles: RunnerProfile[];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fr = (n: number, d = 1) => n.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });

function newProfile(name: string): RunnerProfile {
  return { id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, baseCadence: '', useCalibration: true };
}

export class ProfilePanel {
  private readonly store = safeStorage(() => localStorage);
  private data: Stored;
  private message = '';
  private messageIsError = false;

  constructor(
    private readonly el: {
      select: HTMLSelectElement;
      calibration: HTMLElement;
      hint: HTMLElement;
      baseCadence: HTMLInputElement;
      rules: HTMLElement;
      newBtn: HTMLElement;
      renameBtn: HTMLElement;
      deleteBtn: HTMLElement;
      /** Saisie du nom (création ou renommage), dans la page plutôt qu'une boîte de dialogue. */
      nameForm: HTMLElement;
      nameInput: HTMLInputElement;
      nameSave: HTMLElement;
      nameCancel: HTMLElement;
    },
    private readonly onChange: () => void,
  ) {
    this.data = this.load();
    el.select.addEventListener('change', () => {
      this.data.current = el.select.value;
      this.message = '';
      this.persist();
      this.applyToInputs();
      this.render();
      onChange();
    });
    let nameMode: 'new' | 'rename' = 'new';
    const openNameForm = (mode: 'new' | 'rename') => {
      nameMode = mode;
      el.nameInput.value = mode === 'rename' ? this.current.name : '';
      el.nameInput.placeholder = mode === 'rename' ? 'Nouveau nom' : 'Nom du coureur';
      el.nameForm.hidden = false;
      el.nameInput.focus();
    };
    const saveName = () => {
      const name = el.nameInput.value.trim();
      if (!name) return;
      el.nameForm.hidden = true;
      if (nameMode === 'rename') {
        this.current.name = name;
        this.persist();
        this.render();
        return;
      }
      const p = newProfile(name);
      this.data.profiles.push(p);
      this.data.current = p.id;
      this.persist();
      this.applyToInputs();
      this.render();
      onChange();
    };
    el.newBtn.addEventListener('click', () => openNameForm('new'));
    el.renameBtn.addEventListener('click', () => openNameForm('rename'));
    el.nameSave.addEventListener('click', saveName);
    el.nameCancel.addEventListener('click', () => (el.nameForm.hidden = true));
    el.nameInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') saveName();
      else if (ev.key === 'Escape') el.nameForm.hidden = true;
    });
    el.deleteBtn.addEventListener('click', () => {
      if (this.data.profiles.length <= 1) return;
      confirmClick(el.deleteBtn, `Supprimer « ${this.current.name} » ?`, () => {
        this.data.profiles = this.data.profiles.filter((p) => p.id !== this.data.current);
        this.data.current = this.data.profiles[0].id;
        this.persist();
        this.applyToInputs();
        this.render();
        onChange();
      });
    });
    // Les réglages manuels sont mémorisés dans le profil courant.
    el.baseCadence.addEventListener('input', () => {
      if (this.calibrationActive) return;
      this.current.baseCadence = el.baseCadence.value;
      this.persist();
    });
    el.rules.addEventListener('input', (ev) => {
      const input = ev.target as HTMLInputElement;
      const id = input.dataset.rule;
      const v = Number.parseFloat(input.value);
      if (!id || !Number.isFinite(v)) return;
      this.current.slopeValues = { ...this.current.slopeValues, [id]: v };
      this.persist();
      onChange();
    });
    el.rules.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).id !== 'slope-rules-reset') return;
      this.current.slopeValues = undefined;
      this.persist();
      this.render();
      onChange();
    });
    el.calibration.addEventListener('change', (ev) => {
      const t = ev.target as HTMLInputElement;
      if (t.id === 'calibration-files') {
        void this.addActivities(Array.from(t.files ?? [])).finally(() => (t.value = ''));
      } else if (t.id === 'calibration-use') {
        this.current.useCalibration = t.checked;
        this.persist();
        this.applyToInputs();
        this.render();
        onChange();
      }
    });
    el.calibration.addEventListener('click', (ev) => {
      const btn = ev.target as HTMLElement;
      if (btn.id !== 'calibration-clear') return;
      confirmClick(btn, 'Confirmer l’effacement', () => {
        this.current.calibration = undefined;
        this.message = '';
        this.persist();
        this.applyToInputs();
        this.render();
        onChange();
      });
    });
    this.applyToInputs();
    this.render();
  }

  get current(): RunnerProfile {
    return this.data.profiles.find((p) => p.id === this.data.current) ?? this.data.profiles[0];
  }

  get calibrationActive(): boolean {
    return !!(this.current.useCalibration && this.current.calibration);
  }

  /** Règles de cadence par pente du profil courant. */
  slopeRules(): SlopeRule[] {
    return withValues(this.current.slopeValues);
  }

  /**
   * Cadence au plat X issue du calibrage pour une vitesse cible donnée (la pente est gérée par les
   * règles par tranche, qui décrivent déjà la cadence en côte).
   */
  planOptions(targetKmh: number): Partial<PlanOptions> | undefined {
    const cal = this.current.calibration;
    if (!this.calibrationActive || !cal) return undefined;
    const m = cal.model;
    return { baseCadence: predictCadence(m, targetKmh), speedSensitivity: m.kv };
  }

  /** Affiche dans les champs la cadence calibrée pour l'allure choisie. */
  showCalibratedCadence(targetKmh: number | undefined): void {
    const opts = targetKmh ? this.planOptions(targetKmh) : undefined;
    if (opts?.baseCadence) this.el.baseCadence.value = String(Math.round(opts.baseCadence));
  }

  // ---------- interne ----------

  private load(): Stored {
    try {
      const raw = this.store.getItem(KEY);
      if (raw) {
        const d = JSON.parse(raw) as Stored;
        if (d.profiles?.length) return d;
      }
    } catch {
      /* profils illisibles : on repart d'un profil par défaut */
    }
    const p = newProfile('Moi');
    return { current: p.id, profiles: [p] };
  }

  private persist(): void {
    this.store.setItem(KEY, JSON.stringify(this.data));
  }

  private applyToInputs(): void {
    const p = this.current;
    const cal = this.calibrationActive ? p.calibration!.model : undefined;
    this.el.baseCadence.disabled = !!cal;
    if (!cal) this.el.baseCadence.value = p.baseCadence;
    this.el.hint.hidden = !cal;
    this.el.hint.textContent = cal ? 'Cadence au plat issue du calibrage de ce profil.' : '';
  }

  private async addActivities(files: File[]): Promise<void> {
    if (files.length === 0) return;
    const p = this.current;
    const errors: string[] = [];
    const added: string[] = [];
    const cal = p.calibration ?? { activities: [], segments: [], model: undefined as unknown as CalibrationResult };
    for (const f of files) {
      try {
        if (cal.activities.some((a) => a.name === f.name)) {
          errors.push(`${f.name} : déjà utilisée`);
          continue;
        }
        const act = readActivity(f.name, new Uint8Array(await f.arrayBuffer()));
        cal.activities.push({ name: f.name, date: act.date, distanceKm: act.distanceKm, segments: act.segments.length });
        cal.segments.push(
          ...act.segments.map((s) => ({
            speedKmh: Math.round(s.speedKmh * 100) / 100,
            gradePct: Math.round(s.gradePct * 100) / 100,
            cadence: Math.round(s.cadence * 10) / 10,
            weight: Math.round(s.weight),
          })),
        );
        added.push(f.name);
        errors.push(...act.warnings.map((w) => `${f.name} : ${w}`));
      } catch (e) {
        errors.push(`${f.name} : ${(e as Error).message}`);
      }
    }
    if (added.length) {
      cal.segments = cal.segments.slice(-MAX_SEGMENTS);
      try {
        cal.model = calibrate(cal.segments);
        p.calibration = cal;
        p.useCalibration = true;
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    this.message = [added.length ? `${added.length} sortie(s) ajoutée(s).` : '', ...errors].filter(Boolean).join(' ');
    this.messageIsError = added.length === 0;
    this.persist();
    this.applyToInputs();
    this.render();
    this.onChange();
  }

  private renderRules(): void {
    const rules = this.slopeRules();
    const custom = Object.keys(this.current.slopeValues ?? {}).length > 0;
    const rows = rules
      .map((r) => {
        const def = DEFAULT_SLOPE_RULES.find((d) => d.id === r.id)!;
        const changed = r.value !== def.value;
        const field = `<input type="number" step="1" data-rule="${r.id}" id="rule-${r.id}" value="${r.value}" aria-label="${esc(r.label)}" class="${changed ? 'changed' : ''}" />`;
        // Décalage signé par rapport à X (ex. X + 3, X − 7) ou cadence imposée.
        const cell = r.mode === 'offset' ? `<span class="rule-unit">X +</span>${field}` : `${field}<span class="rule-unit">pas/min</span>`;
        return `<tr><th scope="row">${esc(r.label)}<span class="small muted">${esc(rangeLabel(r))}</span></th><td class="rule-value">${cell}</td><td class="small muted">${esc(r.tip)}</td></tr>`;
      })
      .join('');
    this.el.rules.innerHTML = `
      <h3 class="calib-title">Cadence selon la pente</h3>
      <p class="small muted">Règle générale : garder une cadence à peu près stable (X, votre cadence au plat) et laisser la longueur de foulée absorber la pente.</p>
      <div class="table-wrap"><table class="rules-table">${rows}</table></div>
      ${custom ? '<button type="button" class="link" id="slope-rules-reset">Revenir aux valeurs conseillées</button>' : ''}`;
  }

  private render(): void {
    this.renderRules();
    const single = this.data.profiles.length <= 1;
    (this.el.deleteBtn as HTMLButtonElement).disabled = single;
    this.el.deleteBtn.title = single ? 'Il faut garder au moins un profil' : 'Supprimer ce profil et son calibrage';
    this.el.select.innerHTML = this.data.profiles
      .map((p) => `<option value="${esc(p.id)}" ${p.id === this.current.id ? 'selected' : ''}>${esc(p.name)}</option>`)
      .join('');
    const p = this.current;
    const cal = p.calibration;
    const msg = this.message ? `<p class="small ${this.messageIsError ? 'error-text' : 'muted'}">${esc(this.message)}</p>` : '';
    const fileInput = `<label class="file compact"><input type="file" id="calibration-files" accept="${fileAccept('.fit,.tcx')}" multiple />
      <span>${cal ? 'Ajouter des sorties' : 'Calibrer avec des sorties enregistrées'} (FIT, TCX)</span></label>`;
    if (!cal) {
      this.el.calibration.innerHTML = `
        <h3 class="calib-title">Calibrage personnel</h3>
        <p class="small muted">Importez une ou plusieurs sorties de votre montre (fichier FIT ou TCX avec cadence),
          de préférence vallonnées : RunBPM en déduit votre cadence selon la vitesse et la pente.</p>
        ${fileInput}${msg}`;
      return;
    }
    const m = cal.model;
    const km = cal.activities.reduce((a, x) => a + x.distanceKm, 0);
    const hillCovered = m.gradeRange[1] - m.gradeRange[0] >= 4;
    this.el.calibration.innerHTML = `
      <h3 class="calib-title">Calibrage personnel</h3>
      <label class="check"><input type="checkbox" id="calibration-use" ${p.useCalibration ? 'checked' : ''} /> Utiliser le calibrage de « ${esc(p.name)} »</label>
      <table class="calib-table small">
        <tr><td>Cadence au plat</td><td>${Math.round(predictCadence(m, 10))} pas/min à 10 km/h · ${Math.round(predictCadence(m, 12))} à 12 km/h</td></tr>
        <tr><td>Effet de la vitesse</td><td>${m.kv >= 0 ? '+' : ''}${fr(m.kv)} pas/min par km/h</td></tr>
        <tr><td>Pente mesurée</td><td>${m.uphill >= 0 ? '+' : ''}${fr(m.uphill, 2)} / ${m.downhill >= 0 ? '+' : ''}${fr(m.downhill, 2)} pas/min par % (montée / descente), pour information : le tableau ci-dessus s’applique</td></tr>
        <tr><td>Données</td><td>${cal.activities.length} sortie(s), ${fr(km)} km · vitesses ${fr(m.speedRange[0])}–${fr(m.speedRange[1])} km/h · pentes ${fr(m.gradeRange[0])} à ${fr(m.gradeRange[1])} % · écart moyen ${fr(m.rmse)} pas/min</td></tr>
      </table>
      ${hillCovered ? '' : '<p class="small warn-text">Sorties peu vallonnées : les coefficients de pente restent proches des valeurs par défaut. Ajoutez une sortie avec des côtes.</p>'}
      <details class="small"><summary>Sorties utilisées</summary><ul class="calib-list">${cal.activities
        .map((a) => `<li>${esc(a.name)}${a.date ? ` · ${new Date(a.date).toLocaleDateString('fr-FR')}` : ''} · ${fr(a.distanceKm)} km</li>`)
        .join('')}</ul></details>
      <div class="row">${fileInput}<button type="button" class="link danger" id="calibration-clear">Effacer le calibrage</button></div>
      ${msg}`;
  }
}
