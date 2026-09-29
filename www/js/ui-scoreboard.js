import { startWakeLock, stopWakeLock } from './wakelock.js';
import { onRemotePress } from './remote-button.js';

function formatClock(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

export function initScoreboard({ onMatchFinished, onPause }) {
  const root = document.getElementById('view-scoreboard');
  const overlayMenu = document.getElementById('overlay-menu');
  let controller = null;
  let unsubscribe = null;
  let clockInterval = null;
  let matchStartTime = null;
  let unsubscribeRemote = null;
  // Los dos botones del control mandan la misma tecla y el usuario aprieta a
  // ~0.6-1s entre toques; con 600ms un doble toque normal se leía como dos
  // toques sueltos (y a 40-30 el segundo daba el game al equipo equivocado).
  const REMOTE_TAP_WINDOW_MS = 900;
  let remoteTapCount = 0;
  let remoteTapTimer = null;

  function render(state, teamNames) {
    document.getElementById('name-a').textContent = teamNames.A;
    document.getElementById('name-b').textContent = teamNames.B;
    document.getElementById('point-a').textContent = state.display.pointA;
    document.getElementById('point-b').textContent = state.display.pointB;
    document.getElementById('games-a').textContent = state.display.gamesA;
    document.getElementById('games-b').textContent = state.display.gamesB;
    document.getElementById('serve-dot-a').classList.toggle('is-serving', state.display.server === 'A');
    document.getElementById('serve-dot-b').classList.toggle('is-serving', state.display.server === 'B');
    const setsWonA = state.completedSets.filter((s) => s.gamesA > s.gamesB).length;
    const setsWonB = state.completedSets.filter((s) => s.gamesB > s.gamesA).length;
    document.getElementById('sets-a').textContent = setsWonA;
    document.getElementById('sets-b').textContent = setsWonB;

    document.getElementById('serve-hint').style.display = state.display.server ? 'none' : '';

    const banner = document.getElementById('tiebreak-banner');
    banner.style.display = state.display.inTiebreak ? '' : 'none';
    banner.textContent = state.display.isSuperTiebreak ? 'SÚPER TIE-BREAK' : 'TIE-BREAK';

    if (state.matchOver) {
      setTimeout(() => finishMatch(), 900);
    }
  }

  function finishMatch() {
    if (!controller) return;
    const record = controller.finalizeAndSave();
    teardown();
    onMatchFinished(record);
  }

  function pauseMatch() {
    if (!controller) return;
    // No se finaliza: cada tanto ya se guarda solo como "en curso", así que
    // simplemente dejamos de mostrarlo. Se puede retomar después.
    teardown();
    onPause();
  }

  function tick() {
    if (matchStartTime) {
      document.getElementById('match-clock').textContent = formatClock(Date.now() - matchStartTime);
    }
  }

  function teardown() {
    if (unsubscribe) unsubscribe();
    if (unsubscribeRemote) unsubscribeRemote();
    clearTimeout(remoteTapTimer);
    remoteTapCount = 0;
    if (clockInterval) clearInterval(clockInterval);
    unsubscribe = null;
    unsubscribeRemote = null;
    clockInterval = null;
    matchStartTime = null;
    stopWakeLock();
    controller = null;
  }

  function start(newController) {
    controller = newController;
    matchStartTime = Date.now();
    startWakeLock();
    unsubscribe = controller.subscribe(render);
    clockInterval = setInterval(tick, 1000);
    tick();

    // Control remoto de UN solo botón efectivo: los dos botones físicos del
    // control (iOS/Android) mandan exactamente el mismo código HID, así que no
    // se pueden distinguir. Se cuentan los toques dentro de una ventana corta:
    // 1 toque -> lado izquierdo (A), 2 toques -> lado derecho (B), 3 toques ->
    // deshacer el último tanto. La decisión se toma al vencer la ventana, por
    // eso hay una pequeña demora antes de que se refleje el tanto.
    // Antes del primer tanto, el gesto elige quién saca (sin sumar tanto).
    remoteTapCount = 0;
    unsubscribeRemote = onRemotePress(() => {
      if (!controller) return;
      remoteTapCount += 1;
      clearTimeout(remoteTapTimer);
      remoteTapTimer = setTimeout(() => {
        const taps = remoteTapCount;
        remoteTapCount = 0;
        if (!controller) return;
        const choosingServer = !controller.getState().state.display.server;
        if (choosingServer) {
          if (taps === 1) controller.setFirstServer('A');
          else if (taps === 2) controller.setFirstServer('B');
          return;
        }
        if (taps === 1) controller.addPoint('A');
        else if (taps === 2) controller.addPoint('B');
        else if (taps >= 3) controller.undo();
      }, REMOTE_TAP_WINDOW_MS);
    });
  }

  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;

    if (action === 'point' && controller) {
      controller.addPoint(el.dataset.team);
      return;
    }
    if (action === 'open-menu') {
      overlayMenu.classList.add('is-active');
      return;
    }
    if (action === 'undo-team' && controller) {
      controller.undoLastForTeam(el.dataset.team);
      return;
    }
  });

  overlayMenu.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'close-menu') overlayMenu.classList.remove('is-active');
    if (action === 'undo-point') { controller?.undo(); }
    if (action === 'end-match') {
      overlayMenu.classList.remove('is-active');
      finishMatch();
    }
    if (action === 'pause-match') {
      overlayMenu.classList.remove('is-active');
      pauseMatch();
    }
  });

  return { start };
}
