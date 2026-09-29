import { createMatchController, resumeMatchController } from './match-controller.js';
import { initSetupWizard } from './ui-setup.js';
import { initScoreboard } from './ui-scoreboard.js';
import { initHistory } from './ui-history.js';
import { initSettings } from './ui-settings.js';
import { applyDisplaySettings } from './settings.js';
import { getInProgressMatch, getLastFinishedMatch, saveMatch } from './db.js';
import { replayMatch } from './scoring-engine.js';
import { renderStatsCard } from './match-stats-view.js';
import { copyMatchImage, copyResultMessage } from './share-image.js';

const views = ['pin', 'home', 'setup', 'scoreboard', 'summary', 'history', 'settings'];
const PIN_KEY = 'zscoreLitePin';
let lastSummaryRecord = null;
let lastSummaryStats = null;

function showView(name) {
  views.forEach((v) => {
    document.getElementById(`view-${v}`).classList.toggle('is-active', v === name);
  });
  // El marcador va horizontal (landscape); el resto de la app, vertical.
  const lock = name === 'scoreboard' ? 'landscape' : 'portrait';

  // Dentro de la app nativa (Capacitor), el plugin nativo es el que
  // realmente funciona: la API web de orientación no es confiable ahí.
  const nativeScreenOrientation = window.Capacitor?.Plugins?.ScreenOrientation;
  if (nativeScreenOrientation) {
    nativeScreenOrientation.lock({ orientation: lock }).catch(() => {});
    return;
  }

  // Como PWA/navegador normal: la API web (no todos la soportan, ej. iOS
  // Safari nunca la permite, por eso el try/catch silencioso).
  try {
    screen.orientation?.lock?.(lock)?.catch?.(() => {});
  } catch (e) { /* no soportado en este navegador, se ignora */ }
}

applyDisplaySettings();
const history = initHistory();
const settings = initSettings({ onDataChanged: () => refreshLastMatchButton() });

const setup = initSetupWizard((meta) => {
  const controller = createMatchController(meta);
  scoreboard.start(controller);
  showView('scoreboard');
});

const scoreboard = initScoreboard({
  onMatchFinished: (record) => {
    renderSummary(record);
    refreshLastMatchButton();
    showView('summary');
  },
  onPause: () => {
    showView('home');
  },
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderSummary(record) {
  const winnerKey = record.finalState?.winner;
  const winnerName = winnerKey ? record.teamNames[winnerKey] : null;
  document.getElementById('summary-winner').textContent = winnerName ? `Ganó ${winnerName}` : 'Partido finalizado';

  const sets = record.finalState?.completedSets || [];
  document.getElementById('summary-score').textContent = sets.map((s) => `${s.gamesA}-${s.gamesB}`).join('  ') || '—';

  const durationMin = record.endedAt && record.startedAt
    ? Math.max(1, Math.round((record.endedAt - record.startedAt) / 60000))
    : null;

  const detailTiles = [];
  if (record.club) detailTiles.push(['Club', escapeHtml(record.club)]);
  if (record.court) detailTiles.push(['Cancha', escapeHtml(record.court)]);
  if (durationMin) detailTiles.push(['Duración', `${durationMin} min`]);
  if (record.finalState) {
    detailTiles.push(['Quiebres de saque', `${escapeHtml(record.teamNames.A)}: ${record.finalState.breaksA} &nbsp;·&nbsp; ${escapeHtml(record.teamNames.B)}: ${record.finalState.breaksB}`]);
  }
  document.getElementById('summary-detail').innerHTML = detailTiles.length
    ? `<div class="stat-tile-card">${detailTiles.map(([l, v]) => `<div class="stat-tile"><div class="stat-tile-label">${l}</div><div class="stat-tile-value">${v}</div></div>`).join('')}</div>`
    : '';

  const replayed = replayMatch(record.config, record.events || []);
  document.getElementById('summary-stats').innerHTML = renderStatsCard(record.teamNames, replayed.stats);

  lastSummaryRecord = record;
  lastSummaryStats = replayed.stats;
}

async function refreshLastMatchButton() {
  const last = await getLastFinishedMatch();
  const btn = document.getElementById('btn-last-match');
  btn.style.display = last ? '' : 'none';
}

document.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;

  if (action === 'go-home') { showView('home'); return; }
  if (action === 'go-history') { history.render(); showView('history'); return; }
  if (action === 'go-settings') { settings.render(); showView('settings'); return; }
  if (action === 'go-setup') { goToSetup(); return; }
  if (action === 'copy-match' && lastSummaryRecord) {
    copyMatchImage(lastSummaryRecord, lastSummaryStats).then((result) => alert(copyResultMessage(result)));
    return;
  }
  if (action === 'go-last-match') { openLastMatchDetail(); return; }
});

async function goToSetup() {
  const inProgress = await getInProgressMatch();
  if (inProgress) {
    openResumePrompt(inProgress, {
      onDiscard: () => { setup.resetWizard(); showView('setup'); },
    });
    return;
  }
  setup.resetWizard();
  showView('setup');
}

document.addEventListener('navigate', (e) => {
  if (e.detail === 'home') showView('home');
});

async function openLastMatchDetail() {
  const last = await getLastFinishedMatch();
  if (!last) return;
  history.openDetail(last);
}

// ---------------- PIN de acceso ----------------

function initPinGate() {
  const input = document.getElementById('pin-input');
  const title = document.getElementById('pin-title');
  const sub = document.getElementById('pin-sub');
  const forgotBtn = document.getElementById('pin-forgot');
  let pendingFirstPin = null;

  function focusInput() {
    input.value = '';
    setTimeout(() => input.focus(), 50);
  }

  function showCreateStep1() {
    pendingFirstPin = null;
    title.textContent = 'Creá un PIN de acceso';
    sub.textContent = '4 dígitos, para proteger la app';
    sub.style.color = '';
    focusInput();
  }

  function showCreateStep2() {
    title.textContent = 'Confirmá el PIN';
    sub.textContent = 'Volvé a escribirlo';
    sub.style.color = '';
    focusInput();
  }

  function showEnter(error) {
    title.textContent = 'Ingresá tu PIN';
    sub.textContent = error ? 'PIN incorrecto, probá de nuevo' : ' ';
    sub.style.color = error ? 'var(--danger)' : '';
    focusInput();
  }

  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 4);
    if (input.value.length !== 4) return;

    const savedPin = localStorage.getItem(PIN_KEY);
    if (!savedPin) {
      // Flujo de creación
      if (pendingFirstPin === null) {
        pendingFirstPin = input.value;
        showCreateStep2();
      } else if (pendingFirstPin === input.value) {
        localStorage.setItem(PIN_KEY, pendingFirstPin);
        unlockApp();
      } else {
        showCreateStep1();
        sub.textContent = 'No coincide, probá de nuevo';
        sub.style.color = 'var(--danger)';
      }
    } else if (input.value === savedPin) {
      unlockApp();
    } else {
      showEnter(true);
    }
  });

  forgotBtn.addEventListener('click', () => {
    if (confirm('Esto borra el PIN actual y vas a poder crear uno nuevo. ¿Continuar?')) {
      localStorage.removeItem(PIN_KEY);
      showCreateStep1();
    }
  });

  const savedPin = localStorage.getItem(PIN_KEY);
  if (savedPin) showEnter(false); else showCreateStep1();
}

async function unlockApp() {
  await refreshLastMatchButton();
  showView('home');

  const inProgress = await getInProgressMatch();
  if (inProgress) openResumePrompt(inProgress);
}

function openResumePrompt(record, { onDiscard } = {}) {
  const overlay = document.getElementById('overlay-resume');
  const sets = (record.events || []).length;
  document.getElementById('resume-summary').textContent =
    `${record.teamNames?.A || 'Pareja A'} vs ${record.teamNames?.B || 'Pareja B'} · ${sets} tantos jugados`;
  overlay.classList.add('is-active');

  overlay.onclick = (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'resume-continue') {
      overlay.classList.remove('is-active');
      const controller = resumeMatchController(record);
      scoreboard.start(controller);
      showView('scoreboard');
    } else if (action === 'resume-discard') {
      overlay.classList.remove('is-active');
      // Se guarda como terminado (cortado) para que no quede colgado como "en curso".
      saveMatch({ ...record, inProgress: false, endedAt: Date.now() }).catch(() => {});
      if (onDiscard) onDiscard();
    }
  };
}

showView('pin');
initPinGate();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
