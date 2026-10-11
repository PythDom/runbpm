/**
 * Confirmation en deux clics, sans boîte de dialogue du navigateur (bloquées dans certains
 * affichages intégrés) : le premier clic change le libellé du bouton en « Confirmer… », le second
 * exécute l'action. Sans second clic dans les 4 s, le bouton reprend son libellé.
 */
export function confirmClick(button: HTMLElement, confirmLabel: string, action: () => void): void {
  if (button.dataset.armed === '1') {
    delete button.dataset.armed;
    button.textContent = button.dataset.label ?? button.textContent;
    action();
    return;
  }
  button.dataset.label = button.textContent ?? '';
  button.dataset.armed = '1';
  button.textContent = confirmLabel;
  setTimeout(() => {
    if (button.dataset.armed !== '1') return;
    delete button.dataset.armed;
    button.textContent = button.dataset.label ?? '';
  }, 4000);
}
