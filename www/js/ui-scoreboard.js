import { startWakeLock, stopWakeLock } from './wakelock.js';
import { onRemotePress } from './remote-button.js';
import { createFx } from './fx.js';
import { getSettings, firstTapTeam, feedbackTap } from './settings.js';

function formatClock(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

const TEAM_COLOR = { A: '#8ce23a', B: '#ff3b3b' };

// Cuánto se muestra el cartel de "GANÓ" antes de volver a los tantos (y soltar
// las chispas), y cuánto más se espera antes de pasar al resumen del partido.
const CELEBRATION = {
  game: { hold: 1700 },
  set: { hold: 2800 },
  match: { hold: 3800, afterHold: 2700 },
};

export function initScoreboard({ onMatchFinished, onPause }) {
  const root = document.getElementById('view-scoreboard');
  const overlayMenu = document.getElementById('overlay-menu');
  const banner = document.getElementById('win-banner');
  const fx = createFx(document.getElementById('fx-canvas'));
  let controller = null;
  let unsubscribe = null;
  let clockInterval = null;
  let matchStartTime = null;
  let unsubscribeRemote = null;
  let lastCounts = null;
  let celebrationTimers = [];

  // Los dos botones del control mandan la misma tecla y el usuario aprieta
  // a ~1.1-1.4s entre toques aunque quiera apretar rápido. Con ventanas
  // cortas un doble toque se leía como dos toques sueltos y el game lo
  // ganaba el equipo equivocado. La ventana es larga y se ve la cuenta
  // regresiva en pantalla, así se sabe qué se va a aplicar antes de que pase.
  // (la duración es configurable: getSettings().tapWindowMs)
  let remoteTapCount = 0;
  let remoteTapTimer = null;
  let tapBarAnim = null;

  // ---------- Texto de la fila superior: nombre + games/sets en UN renglón ----------
  // La letra se achica lo necesario para que el nombre entre entero.
  function fitTopRows() {
    root.querySelectorAll('.team-top').forEach((top) => {
      const name = top.querySelector('.team-name');
      if (!name || !top.clientWidth) return;
      let size = 24;
      top.style.fontSize = `${size}px`;
      while (name.scrollWidth > name.clientWidth + 1 && size > 10) {
        size -= 1;
        top.style.fontSize = `${size}px`;
      }
    });
  }

  const lastTopWidth = new WeakMap();
  const topObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => {
        let changed = false;
        for (const entry of entries) {
          const w = Math.round(entry.contentRect.width);
          if (lastTopWidth.get(entry.target) !== w) { lastTopWidth.set(entry.target, w); changed = true; }
        }
        if (changed) fitTopRows();
      })
    : null;
  root.querySelectorAll('.team-top').forEach((el) => topObserver?.observe(el));
  window.addEventListener('resize', () => { fx.resize(); fitTopRows(); });

  // Los textos largos (VENTAJA, IGUALES) van más chicos que los números para
  // que entren enteros en su mitad de pantalla.
  function setPointText(id, text) {
    const el = document.getElementById(id);
    el.textContent = text;
    el.classList.toggle('is-long', String(text).length > 2);
  }

  // ---------- Celebraciones ----------
  function clearCelebration() {
    celebrationTimers.forEach(clearTimeout);
    celebrationTimers = [];
    banner.classList.remove('is-active');
    fx.clear();
  }

  function later(ms, fn) {
    celebrationTimers.push(setTimeout(fn, ms));
  }

  function scoreCenter(team) {
    const r = document.getElementById(team === 'A' ? 'point-a' : 'point-b').getBoundingClientRect();
    const c = document.getElementById('fx-canvas').getBoundingClientRect();
    return { x: r.left - c.left + r.width / 2, y: r.top - c.top + r.height / 2 };
  }

  /** Chispas que salen del tanto del equipo ganador, al volver a 0-0. */
  function sparksFromScore(team, kind) {
    const { x, y } = scoreCenter(team);
    const colors = [TEAM_COLOR[team], '#ffffff', team === 'A' ? '#d7e600' : '#ffb347'];
    if (kind === 'game') {
      fx.burst(x, y, { colors, count: 140, speed: 9, life: 1300, size: 4.4 });
      fx.later(170, () => fx.burst(x, y, { colors, count: 80, speed: 5.5, life: 1000, size: 4 }));
    } else if (kind === 'set') {
      [0, 220, 440].forEach((d, i) => fx.later(d, () => fx.burst(x, y, { colors, count: 200, speed: 11 + i * 2, life: 1700, size: 5 })));
      const { w } = fx.size();
      [0.2, 0.8].forEach((f, i) => fx.later(300 + i * 250, () => fx.burst(w * f, y * 0.7, { colors, count: 110, speed: 9, life: 1300, size: 4.4 })));
    } else {
      [0, 200, 400, 600, 800].forEach((d, i) => fx.later(d, () => fx.burst(x, y, { colors, count: 240, speed: 12 + (i % 3) * 2, life: 1900, size: 5.2 })));
    }
  }

  /** Fuegos artificiales por toda la pantalla + confeti (fin del partido). */
  function fireworks(team) {
    const { w, h } = fx.size();
    const colors = [TEAM_COLOR[team], '#ffffff', '#ffd23f', team === 'A' ? '#d7e600' : '#ff8a5c'];
    for (let i = 0; i < 12; i++) {
      fx.later(i * 320, () => fx.burst(
        w * (0.1 + Math.random() * 0.8), h * (0.15 + Math.random() * 0.45),
        { colors, count: 170, speed: 10, life: 1700, size: 4.6 },
      ));
    }
    fx.confetti({ colors, duration: 5200, perTick: 6 });
  }

  function celebrate(kind, winner, teamNames) {
    clearCelebration();
    fx.resize();
    const cfg = CELEBRATION[kind];

    document.getElementById('wb-title').textContent =
      kind === 'game' ? 'GANÓ' : kind === 'set' ? 'GANÓ EL SET' : 'GANÓ EL PARTIDO';
    document.getElementById('wb-sub').textContent = kind === 'game' ? '' : teamNames[winner];
    banner.className = `win-banner is-active win-banner--${kind} win-banner--${winner.toLowerCase()}`;
    banner.style.color = TEAM_COLOR[winner];

    if (kind === 'match') fireworks(winner);

    later(cfg.hold, () => {
      banner.classList.remove('is-active');
      sparksFromScore(winner, kind);
    });
    if (kind === 'match') later(cfg.hold + cfg.afterHold, () => finishMatch());
  }

  /** Detecta game/set/partido ganado comparando con el render anterior. */
  function detectCelebration(state, teamNames) {
    const counts = { games: state.gameLog.length, sets: state.completedSets.length, over: state.matchOver };
    const prev = lastCounts;
    lastCounts = counts;

    if (!prev) {
      // Primer render (al empezar o retomar): sin celebración.
      if (state.matchOver) setTimeout(() => finishMatch(), 900);
      return;
    }
    if (counts.over && !prev.over) {
      celebrate('match', state.winner, teamNames);
    } else if (counts.sets > prev.sets) {
      const closed = state.completedSets[state.completedSets.length - 1];
      celebrate('set', closed.gamesA > closed.gamesB ? 'A' : 'B', teamNames);
    } else if (counts.games > prev.games) {
      celebrate('game', state.gameLog[state.gameLog.length - 1].winner, teamNames);
    } else if (counts.games < prev.games || (prev.over && !counts.over)) {
      clearCelebration(); // se deshizo el tanto que cerraba el game
    }
  }

  function render(state, teamNames) {
    document.getElementById('name-a').textContent = teamNames.A;
    document.getElementById('name-b').textContent = teamNames.B;
    setPointText('point-a', state.display.pointA);
    setPointText('point-b', state.display.pointB);
    document.getElementById('games-a').textContent = state.display.gamesA;
    document.getElementById('games-b').textContent = state.display.gamesB;
    document.getElementById('serve-dot-a').classList.toggle('is-serving', state.display.server === 'A');
    document.getElementById('serve-dot-b').classList.toggle('is-serving', state.display.server === 'B');
    const setsWonA = state.completedSets.filter((s) => s.gamesA > s.gamesB).length;
    const setsWonB = state.completedSets.filter((s) => s.gamesB > s.gamesA).length;
    document.getElementById('sets-a').textContent = setsWonA;
    document.getElementById('sets-b').textContent = setsWonB;

    document.getElementById('serve-hint').style.display = state.display.server ? 'none' : '';
    document.querySelector('#serve-hint span').innerHTML = firstTapTeam() === 'A'
      ? 'CONTROL: 1 TOQUE = IZQUIERDA<br>2 TOQUES = DERECHA'
      : 'CONTROL: 1 TOQUE = DERECHA<br>2 TOQUES = IZQUIERDA';

    const tieBanner = document.getElementById('tiebreak-banner');
    tieBanner.style.display = state.display.inTiebreak ? '' : 'none';
    tieBanner.textContent = state.display.isSuperTiebreak ? 'SÚPER TIE-BREAK' : 'TIE-BREAK';

    requestAnimationFrame(fitTopRows);
    detectCelebration(state, teamNames);
  }

  function finishMatch() {
    if (!controller) return;
    clearCelebration();
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

  // ---------- Indicador de toques del control ----------
  // Muestra cuántos toques se contaron y qué va a pasar, con una barra que se
  // vacía: cuando llega a cero se aplica. Un toque más reinicia la cuenta.
  function showTapHint(taps, choosingServer) {
    const el = document.getElementById('tap-hint');
    const team = teamForTaps(taps);
    const side = team ? (team === 'A' ? 'IZQUIERDA' : 'DERECHA') : null;
    const text = choosingServer
      ? (side ? `SACA ${side}` : '')
      : (side ? `TANTO ${side}` : 'DESHACER ÚLTIMO TANTO');
    document.getElementById('tap-text').textContent = text ? `${taps} · ${text}` : '';
    el.dataset.side = team ? team.toLowerCase() : 'undo';
    el.style.display = text ? '' : 'none';
    tapBarAnim?.cancel();
    tapBarAnim = document.getElementById('tap-bar').animate(
      [{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }],
      { duration: getSettings().tapWindowMs, easing: 'linear', fill: 'forwards' },
    );
  }

  /** Equipo que corresponde a esa cantidad de toques (null = deshacer). */
  function teamForTaps(taps) {
    const first = firstTapTeam();
    if (taps === 1) return first;
    if (taps === 2) return first === 'A' ? 'B' : 'A';
    return null;
  }

  function hideTapHint() {
    tapBarAnim?.cancel();
    document.getElementById('tap-hint').style.display = 'none';
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
    hideTapHint();
    clearCelebration();
    lastCounts = null;
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
    lastCounts = null;
    startWakeLock();
    unsubscribe = controller.subscribe(render);
    clockInterval = setInterval(tick, 1000);
    tick();
    requestAnimationFrame(() => { fx.resize(); fitTopRows(); });

    // Control remoto de UN solo botón efectivo: los dos botones físicos del
    // control (iOS/Android) mandan exactamente el mismo código HID, así que no
    // se pueden distinguir. Se cuentan los toques dentro de una ventana:
    // 1 toque -> lado izquierdo (A), 2 toques -> lado derecho (B), 3 toques ->
    // deshacer el último tanto. La decisión se toma al vencer la ventana.
    // Antes del primer tanto, el gesto elige quién saca (sin sumar tanto).
    remoteTapCount = 0;
    unsubscribeRemote = onRemotePress(() => {
      if (!controller) return;
      remoteTapCount += 1;
      feedbackTap(remoteTapCount >= 3 ? 3 : remoteTapCount);
      showTapHint(remoteTapCount, !controller.getState().state.display.server);
      clearTimeout(remoteTapTimer);
      remoteTapTimer = setTimeout(() => {
        const taps = remoteTapCount;
        remoteTapCount = 0;
        hideTapHint();
        if (!controller) return;
        feedbackTap(0);
        const team = teamForTaps(taps);
        const choosingServer = !controller.getState().state.display.server;
        if (choosingServer) {
          if (team) controller.setFirstServer(team);
          return;
        }
        if (team) controller.addPoint(team);
        else controller.undo();
      }, getSettings().tapWindowMs);
    });
  }

  // Tocar el cartel de "GANÓ EL PARTIDO" salta directo al resumen.
  banner.addEventListener('click', () => {
    if (banner.classList.contains('win-banner--match')) finishMatch();
  });

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
