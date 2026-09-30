function silence(osc: OscillatorNode): void {
  try {
    osc.stop(0);
  } catch {
    /* déjà arrêté */
  }
}

/**
 * Métronome Web Audio : les clics sont planifiés à l'avance sur l'horloge audio (et non avec
 * setTimeout), ce qui garantit un tempo régulier. Quand la page passe en arrière-plan, les minuteurs
 * du navigateur sont ralentis (jusqu'à 1 fois par seconde) : on planifie alors 2 s d'avance.
 * Un changement de tempo annule les clics déjà planifiés et repart sans à-coup.
 */
export class Metronome {
  private ctx?: AudioContext;
  private timer?: ReturnType<typeof setInterval>;
  private nextClick = 0;
  private bpm = 170;
  private volume = 0.6;
  private pending: { osc: OscillatorNode; time: number }[] = [];

  /** À appeler depuis un geste utilisateur (clic) : les navigateurs l'exigent pour l'audio. */
  unlock(): void {
    const ctx = this.context();
    if (ctx.state === 'suspended') void ctx.resume();
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  get tempo(): number {
    return this.bpm;
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
  }

  setBpm(bpm: number): void {
    if (!(bpm > 0) || Math.abs(bpm - this.bpm) < 0.01) return;
    this.bpm = bpm;
    if (!this.running) return;
    // Annule les clics futurs et enchaîne au nouveau tempo après le dernier clic conservé.
    const now = this.context().currentTime;
    const keep = this.pending.filter((p) => p.time <= now + 0.03);
    for (const p of this.pending) if (p.time > now + 0.03) silence(p.osc);
    this.pending = keep;
    const last = keep.length ? keep[keep.length - 1].time : now;
    this.nextClick = Math.max(now + 0.03, last + 60 / this.bpm);
  }

  start(bpm: number): void {
    this.bpm = bpm > 0 ? bpm : this.bpm;
    if (this.running) return;
    const ctx = this.context();
    if (ctx.state === 'suspended') void ctx.resume();
    this.nextClick = ctx.currentTime + 0.05;
    this.schedule();
    this.timer = setInterval(() => this.schedule(), 50);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const p of this.pending) silence(p.osc);
    this.pending = [];
  }

  private context(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  private schedule(): void {
    const ctx = this.context();
    const now = ctx.currentTime;
    this.pending = this.pending.filter((p) => p.time > now - 0.1);
    // Rattrapage après une mise en veille : on repart de maintenant.
    if (this.nextClick < now - 0.2) this.nextClick = now + 0.02;
    const lookahead = typeof document !== 'undefined' && document.hidden ? 2 : 0.25;
    while (this.nextClick < now + lookahead) {
      this.click(this.nextClick);
      this.nextClick += 60 / this.bpm;
    }
  }

  private click(t: number): void {
    const ctx = this.context();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 1600;
    gain.gain.setValueAtTime(Math.max(0.0001, this.volume), t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.04);
    this.pending.push({ osc, time: t });
  }
}
