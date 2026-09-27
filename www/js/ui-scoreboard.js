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
  const DOUBLE_PRESS_WINDOW_MS = 700;
  let lastRemotePressAt = { A: 0, B: 0 };

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

    // Mapeo del control remoto: botón "foto" -> Pareja A, botón "video" -> Pareja B.
    // Es una convención razonable dado que no hay forma estándar de identificar
    // qué botón físico dispara cada evento; puede ajustarse una vez probado en
    // el dispositivo real.
    // Un solo click suma un tanto. Dos clicks seguidos (menos de 450ms) del
    // MISMO botón restan el último tanto de ESE equipo, aunque el otro equipo
    // haya anotado después. No usamos "mantener presionado" porque estos
    // controles suelen mandar un clic instantáneo, sin estado de "sostenido".
    lastRemotePressAt = { A: 0, B: 0 };
    unsubscribeRemote = onRemotePress((source) => {
      if (!controller) return;
      let side = null;
      if (source.includes('volumeup') || source.includes('nexttrack') || source === 'native:shutter' || source === 'simulated') {
        side = 'A';
      } else if (source.includes('volumedown') || source.includes('previoustrack')) {
        side = 'B';
      }
      if (!side) return;

      const now = Date.now();
      const isDoublePress = now - lastRemotePressAt[side] < DOUBLE_PRESS_WINDOW_MS;
      if (isDoublePress) {
        lastRemotePressAt[side] = 0;
        controller.undoLastForTeam(side);
      } else {
        lastRemotePressAt[side] = now;
        controller.addPoint(side);
      }
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
