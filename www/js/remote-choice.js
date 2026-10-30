// Elegir entre opciones con el control remoto: 1 toque = primera, 2 toques = segunda, etc.
// Igual que en el marcador, la elección se aplica al vencer la ventana de toques.

import { onRemotePress } from './remote-button.js';
import { getSettings, feedbackTap } from './settings.js';

/**
 * isActive(): la pantalla está a la vista. getOptions(): [{ label }] o null si no hay nada que elegir.
 * onHint(taps, options): para mostrar la cuenta (taps = 0 cuando se apaga). onChoose(index): se eligió esa opción.
 */
export function createTapChooser({ isActive, getOptions, onHint, onChoose }) {
  let taps = 0;
  let timer = null;

  onRemotePress(() => {
    if (!isActive()) return;
    const options = getOptions();
    if (!options?.length) return;
    taps += 1;
    feedbackTap(Math.min(taps, 3));
    onHint(taps, options);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const n = taps;
      taps = 0;
      onHint(0, options);
      if (!isActive()) return;
      feedbackTap(0);
      if (n >= 1 && n <= options.length) onChoose(n - 1);
    }, getSettings().tapWindowMs);
  });
}

/** Texto de la cuenta de toques: "2 · Pérez". Vacío si no hay toques. */
export function hintText(taps, options) {
  if (!taps) return '';
  return `${taps} · ${options[taps - 1]?.label ?? 'sin opción'}`;
}

/** Leyenda fija: "1 toque: A · 2 toques: B". */
export function legendText(options) {
  return options.map((o, i) => `${i + 1} ${i === 0 ? 'toque' : 'toques'}: ${o.label}`).join(' · ');
}
