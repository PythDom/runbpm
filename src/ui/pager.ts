const MOBILE = '(max-width: 899px)';
const KEY = 'runbpm.screen';

/**
 * Écrans de l'application sur téléphone : un écran par étape, on glisse de l'un à l'autre
 * (défilement horizontal aimanté) ou on touche un onglet. Sur grand écran, toutes les étapes restent
 * visibles ensemble et les onglets ne servent pas.
 */
export class Pager {
  private readonly screens: HTMLElement[];
  private readonly tabs: HTMLButtonElement[];
  private readonly mq = window.matchMedia(MOBILE);
  private index = 0;
  private frame = 0;
  /** Étapes sautées (ex. Allure en mode séance) : ni onglet, ni écran sur téléphone. */
  private readonly skipped = new Set<number>();

  constructor(
    private readonly pager: HTMLElement,
    tabbar: HTMLElement,
    private readonly title: HTMLElement,
  ) {
    this.screens = Array.from(pager.querySelectorAll<HTMLElement>(':scope > .screen'));
    this.tabs = Array.from(tabbar.querySelectorAll<HTMLButtonElement>('button[data-tab]'));
    document.addEventListener('click', (ev) => {
      const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-go]');
      if (target) this.go(Number(target.dataset.go));
    });
    pager.addEventListener('scroll', () => {
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => this.sync());
    });
    // Rotation, clavier virtuel… : on se recale sur l'écran courant.
    window.addEventListener('resize', () => this.snap());
    this.mq.addEventListener('change', () => this.snap());
    let saved = 0;
    try {
      saved = Number(localStorage.getItem(KEY) ?? 0);
    } catch {
      /* préférence indisponible */
    }
    this.setActive(Number.isInteger(saved) && saved >= 0 && saved < this.screens.length ? saved : 0);
    requestAnimationFrame(() => this.snap());
  }

  get mobile(): boolean {
    return this.mq.matches;
  }

  get current(): number {
    return this.index;
  }

  go(i: number, smooth = true): void {
    if (!Number.isInteger(i) || i < 0 || i >= this.screens.length) return;
    if (!this.mobile) {
      this.screens[i].scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
      return;
    }
    i = this.nearestShown(i);
    this.setActive(i);
    this.pager.scrollTo({ left: this.shown().indexOf(i) * this.pager.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
  }

  /** Saute (ou rétablit) une étape sur téléphone ; si c'est l'écran courant, on passe au suivant. */
  setSkipped(i: number, skip: boolean): void {
    if (this.skipped.has(i) === skip) return;
    if (skip) this.skipped.add(i);
    else this.skipped.delete(i);
    this.screens[i]?.classList.toggle('skipped', skip);
    this.tabs[i]?.classList.toggle('skipped', skip);
    if (skip && this.index === i) this.setActive(this.nearestShown(i));
    this.snap();
  }

  /** Étapes affichées sur téléphone, dans l'ordre. */
  private shown(): number[] {
    return this.screens.map((_, k) => k).filter((k) => !this.skipped.has(k));
  }

  /** L'étape elle-même si elle est affichée, sinon la suivante (ou la précédente en fin de liste). */
  private nearestShown(i: number): number {
    const shown = this.shown();
    return shown.find((k) => k >= i) ?? shown[shown.length - 1] ?? 0;
  }

  /** Marque une étape comme faite (coche sur l'onglet) ou à faire (point). */
  setDone(i: number, done: boolean): void {
    this.tabs[i]?.classList.toggle('done', done);
    this.tabs[i]?.classList.toggle('todo', !done);
  }

  private snap(): void {
    if (this.mobile) this.pager.scrollTo({ left: this.shown().indexOf(this.index) * this.pager.clientWidth, behavior: 'auto' });
  }

  private sync(): void {
    if (!this.mobile || this.pager.clientWidth === 0) return;
    const i = this.shown()[Math.round(this.pager.scrollLeft / this.pager.clientWidth)];
    if (i !== undefined && i !== this.index) this.setActive(i);
  }

  private setActive(i: number): void {
    this.index = i;
    this.tabs.forEach((t, k) => {
      if (k === i) t.setAttribute('aria-current', 'step');
      else t.removeAttribute('aria-current');
    });
    this.title.textContent = this.screens[i]?.dataset.title ?? '';
    try {
      localStorage.setItem(KEY, String(i));
    } catch {
      /* préférence non enregistrée */
    }
  }
}
