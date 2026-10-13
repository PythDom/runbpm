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
    this.setActive(i);
    this.pager.scrollTo({ left: i * this.pager.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
  }

  /** Marque une étape comme faite (coche sur l'onglet) ou à faire (point). */
  setDone(i: number, done: boolean): void {
    this.tabs[i]?.classList.toggle('done', done);
    this.tabs[i]?.classList.toggle('todo', !done);
  }

  private snap(): void {
    if (this.mobile) this.pager.scrollTo({ left: this.index * this.pager.clientWidth, behavior: 'auto' });
  }

  private sync(): void {
    if (!this.mobile || this.pager.clientWidth === 0) return;
    const i = Math.round(this.pager.scrollLeft / this.pager.clientWidth);
    if (i !== this.index && i >= 0 && i < this.screens.length) this.setActive(i);
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
