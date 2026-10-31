import { createMatchController, resumeMatchController } from './match-controller.js';
import { initSetupWizard } from './ui-setup.js';
import { initScoreboard } from './ui-scoreboard.js';
import { initHistory } from './ui-history.js';
import { initSettings } from './ui-settings.js';
import { applyDisplaySettings, getSettings } from './settings.js';
import { initLiveUi } from './ui-live.js';
import { startLive, finishLive } from './live.js';
import { getInProgressMatch, getLastFinishedMatch, saveMatch } from './db.js';
import { replayMatch } from './scoring-engine.js';
import { renderStatsCard } from './match-stats-view.js';
import { TRIAL_ENABLED, checkLicense, startLicenseWatch, onLicenseChange, isBlocked, getLicense, activate, startTrial, bannerText, checkUpdate, openDownload } from './license.js';
import { copyMatchImage, copyResultMessage } from './share-image.js';
import { loadSession, saveSession, clearSession, createSession, applyResult, courtTeams, courtFirstSlot } from './social.js';
import { initSocialView } from './ui-social.js';

const views = ['pin', 'license', 'home', 'setup', 'scoreboard', 'social', 'summary', 'history', 'settings'];
const PIN_KEY = 'zscoreLitePin';
let lastSummaryRecord = null;
let lastSummaryStats = null;

function showView(name) {
  // Sin licencia vigente no se puede ir al inicio ni armar partidos nuevos
  // (sí terminar uno en curso, ver el historial y sacar la copia de seguridad).
  if ((name === 'home' || name === 'setup') && isBlocked()) name = 'license';
  if (name === 'license') renderLicenseView();
  views.forEach((v) => {
    document.getElementById(`view-${v}`).classList.toggle('is-active', v === name);
  });
  // El marcador va horizontal (landscape); el resto de la app, vertical.
  const lock = name === 'scoreboard' || name === 'social' ? 'landscape' : 'portrait';

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

function playMatch(meta) {
  const controller = createMatchController(meta);
  scoreboard.start(controller);
  autoLive(controller);
  showView('scoreboard');
}

const setup = initSetupWizard((meta) => {
  if (meta.social) {
    const s = createSession({ id: meta.id, pairs: meta.social.pairs, config: meta.config, voiceLevel: meta.voiceLevel, firstSlot: meta.social.firstSlot });
    saveSession(s);
    meta.sessionId = s.id;
  } else {
    clearSession();
  }
  playMatch(meta);
});

/** Arranca el próximo partido de la jornada con las parejas que quedaron en cancha. */
function startNextSocialMatch(s) {
  playMatch({
    id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId: s.id,
    sport: 'padel',
    config: s.config,
    teams: courtTeams(s),
    firstSlot: courtFirstSlot(s),
    voiceLevel: s.voiceLevel,
  });
}

const social = initSocialView({
  onStart: startNextSocialMatch,
  onHome: () => showView('home'),
  onEnd: () => {
    clearSession();
    refreshSocialButton();
    if (lastSummaryRecord) showView('summary'); else showView('home');
  },
});

function refreshSocialButton() {
  const s = loadSession();
  document.getElementById('btn-social').style.display = s ? '' : 'none';
}

/** Vuelve a la jornada: al cambio de parejas pendiente o al partido que quedó en curso. */
async function continueSocial() {
  const s = loadSession();
  if (!s) return;
  if (s.pending) { if (social.open()) showView('social'); return; }
  const inProgress = await getInProgressMatch();
  if (!inProgress) return;
  const controller = resumeMatchController(inProgress);
  scoreboard.start(controller);
  autoLive(controller);
  showView('scoreboard');
}

const scoreboard = initScoreboard({
  onMatchFinished: (record) => {
    finishLive();
    renderSummary(record);
    refreshLastMatchButton();
    const s = loadSession();
    if (s && record.sessionId === s.id) {
      const winner = record.finalState?.winner;
      if (winner) {
        // Gana una pareja: se anota y se pasa directo al cambio de parejas.
        const last = record.finalState.completedSets[record.finalState.completedSets.length - 1];
        applyResult(s, record.id, winner, last ? `${last.gamesA}-${last.gamesB}` : '');
        saveSession(s);
        refreshSocialButton();
        if (social.open()) { showView('social'); return; }
      }
      // Partido cortado a mano: la jornada termina.
      clearSession();
      refreshSocialButton();
    }
    showView('summary');
  },
  onPause: () => {
    showView('home');
  },
  onOpenLive: () => liveUi.open(),
});

const liveUi = initLiveUi({ getController: () => scoreboard.getController() });

/** Si el club eligió transmitir cada partido, el link se arma solo. */
function autoLive(controller) {
  if (getSettings().liveAuto) startLive(controller).catch(() => {});
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderSummary(record) {
  const winnerKey = record.finalState?.winner;
  const winnerName = winnerKey ? record.teamNames[winnerKey] : null;
  document.getElementById('summary-winner').textContent = winnerName ? `Ganó ${winnerName}` : 'Partido finalizado';

  const sets = record.finalState?.completedSets || [];
  document.getElementById('summary-score').textContent = sets.map((s) => `${s.gamesA}-${s.gamesB}`).join('  ') || '—';
  // Tablero: una fila por pareja, una columna por set; el set ganado va resaltado.
  const boardRow = (key) => `<div class="sb-row sb-row--${key.toLowerCase()}${winnerKey && winnerKey !== key ? ' is-loser' : ''}">
      <span class="sb-name">${escapeHtml(record.teamNames[key])}${winnerKey === key ? ' 🏆' : ''}</span>
      ${sets.map((st) => { const a = key === 'A' ? st.gamesA : st.gamesB; const b = key === 'A' ? st.gamesB : st.gamesA; return `<span class="sb-set${a > b ? ' is-won' : ''}">${a}</span>`; }).join('')}
    </div>`;
  document.getElementById('summary-board').innerHTML = sets.length ? boardRow('A') + boardRow('B') : '';

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
  if (action === 'go-license') { showView('license'); return; }
  if (action === 'go-setup') { goToSetup(); return; }
  if (action === 'go-social') { continueSocial(); return; }
  if (action === 'copy-match' && lastSummaryRecord) {
    copyMatchImage(lastSummaryRecord, lastSummaryStats).then((result) => alert(copyResultMessage(result)));
    return;
  }
  if (action === 'go-last-match') { openLastMatchDetail(); return; }
});

async function goToSetup() {
  if (loadSession() && !confirm('Hay una jornada social en curso. Si empezás un partido nuevo, la jornada se termina. ¿Seguir?')) return;
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
  refreshSocialButton();
  showView('home');

  const inProgress = await getInProgressMatch();
  if (inProgress) openResumePrompt(inProgress);
  else if (social.open()) showView('social'); // quedó un cambio de parejas sin resolver
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
      autoLive(controller);
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
checkLicense().then(() => { renderLicenseBanner(); refreshUpdateBanner(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshUpdateBanner(); });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// ---------------- Licencia ----------------

function renderLicenseView() {
  const blocked = getLicense().status === 'blocked';
  document.getElementById('license-title').textContent = blocked ? 'Tu licencia venció' : 'Activá tu licencia';
  document.getElementById('license-sub').textContent = blocked
    ? 'Renovala o activá un código nuevo para seguir usando la app'
    : getLicense().reason === 'liberada'
      ? 'Este celular ya no está asociado a la licencia. Escribí el código para activarlo de nuevo'
      : 'Escribí el código que recibiste';
  document.getElementById('license-msg').textContent = '';
  // La prueba solo se ofrece a quien nunca tuvo licencia en este celular (si ya la usó, el servidor lo rechaza igual).
  document.getElementById('license-trial').style.display = TRIAL_ENABLED && getLicense().status === 'none' ? '' : 'none';
  document.getElementById('license-extra').classList.add('is-shown');
}

function renderLicenseBanner() {
  const lic = getLicense();
  const el = document.getElementById('license-banner');
  const text = bannerText(lic);
  el.style.display = text ? '' : 'none';
  el.textContent = text;
  el.classList.toggle('license-banner--grace', lic.status === 'grace');
}

let pendingUpdate = null;

async function refreshUpdateBanner() {
  const el = document.getElementById('update-banner');
  pendingUpdate = await checkUpdate().catch(() => null);
  el.style.display = pendingUpdate ? '' : 'none';
  if (pendingUpdate) el.querySelector('span').textContent = `Hay una versión nueva (${pendingUpdate.versionName}).`;
}

function openUpdateSheet() {
  if (!pendingUpdate) return;
  document.getElementById('update-title').textContent = `Versión ${pendingUpdate.versionName}`;
  const list = document.getElementById('update-notes');
  list.replaceChildren(...(pendingUpdate.notes.length ? pendingUpdate.notes : ['Mejoras y correcciones.']).map((n) => {
    const li = document.createElement('li');
    li.textContent = n; // textContent: las novedades vienen del servidor, nunca como HTML
    return li;
  }));
  document.getElementById('overlay-update').classList.add('is-active');
}

function initLicenseUi() {
  document.getElementById('update-open').addEventListener('click', openUpdateSheet);
  document.getElementById('update-later').addEventListener('click', () => {
    document.getElementById('overlay-update').classList.remove('is-active');
  });
  document.getElementById('update-download').addEventListener('click', () => {
    if (pendingUpdate) openDownload(pendingUpdate.url);
  });

  const input = document.getElementById('license-input');
  const msg = document.getElementById('license-msg');
  const btn = document.getElementById('license-activate');

  input.addEventListener('input', () => {
    // Autoguiones: el usuario escribe solo letras y números.
    const raw = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^ZSL/, '').slice(0, 8);
    input.value = raw.length ? `ZSL-${raw.slice(0, 4)}${raw.length > 4 ? '-' + raw.slice(4) : ''}` : '';
  });

  btn.addEventListener('click', async () => {
    msg.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Activando…';
    const result = await activate(input.value);
    btn.disabled = false;
    btn.textContent = 'Activar';
    if (!result.ok) { msg.textContent = result.message; return; }
    input.value = '';
    showView('home');
  });

  const trial = document.getElementById('license-trial');
  trial.addEventListener('click', async () => {
    msg.textContent = '';
    trial.disabled = true;
    trial.textContent = 'Activando…';
    const result = await startTrial();
    trial.disabled = false;
    trial.textContent = 'Probar gratis';
    if (!result.ok) { msg.textContent = result.message; return; }
    showView('home');
  });

  onLicenseChange(renderLicenseBanner);
  // Si el servidor desconoce este celular mientras está en el inicio, se pasa a pedir el código (nunca en pleno partido).
  onLicenseChange((lic) => {
    if (lic.reason !== 'liberada' || !isBlocked()) return;
    if (document.getElementById('view-home').classList.contains('is-active')
      || document.getElementById('view-setup').classList.contains('is-active')) showView('license');
  });
  startLicenseWatch();
}

initLicenseUi();
