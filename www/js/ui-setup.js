import { describeConfig } from './scoring-engine.js';
import {
  listPlayerNames, savePlayerName,
  listClubNames, saveClubName,
  listCourtNames, saveCourtName,
} from './db.js';
import { initRemoteButton, onRemotePress } from './remote-button.js';

initRemoteButton();
onRemotePress(() => {
  const status = document.getElementById('remote-test-status');
  if (status) {
    status.textContent = '¡Detectado! El control remoto funciona en este celular.';
    status.style.color = 'var(--accent)';
  }
});

const steps = ['modalidad', 'parejas', 'contexto'];
const stepTitles = { modalidad: 'Modalidad', parejas: 'Parejas', contexto: 'Detalles' };

export function initSetupWizard(onStartMatch) {
  const root = document.getElementById('view-setup');
  const wizard = {
    stepIndex: 0,
    mode: 'sets',
    bestOf: 2, // setsToWin
    gamesPerSet: 6,
    noAd: false,
    superTiebreak: false,
    targetGames: 4,
    firstServer: 'A',
    voiceLevel: 'full',
  };

  function selectCard(groupSelector, attr, value, container = root) {
    container.querySelectorAll(groupSelector).forEach((el) => {
      el.classList.toggle('is-selected', el.dataset[attr] === String(value));
    });
  }

  function renderStep() {
    const stepName = steps[wizard.stepIndex];
    root.querySelectorAll('.step').forEach((el) => {
      el.classList.toggle('is-active', el.dataset.step === stepName);
    });
    document.getElementById('setup-step-title').textContent = stepTitles[stepName];
    if (stepName === 'contexto') updateSummaryLine();
  }

  function updateSummaryLine() {
    const cfg = buildConfig();
    document.getElementById('setup-summary').textContent = describeConfig(cfg);
  }

  function buildConfig() {
    return {
      sport: 'padel',
      mode: wizard.mode,
      setsToWin: wizard.mode === 'games' ? 1 : wizard.bestOf,
      gamesPerSet: wizard.mode === 'games' ? wizard.targetGames : wizard.gamesPerSet,
      noAd: wizard.noAd,
      superTiebreakDecider: wizard.mode === 'sets' ? wizard.superTiebreak : false,
      firstServer: wizard.firstServer,
    };
  }

  // ---- Paso 1: modalidad ----
  document.getElementById('mode-options').querySelectorAll('.option-card').forEach((btn) => {
    btn.addEventListener('click', () => {
      wizard.mode = btn.dataset.mode;
      selectCard('#mode-options .option-card', 'mode', wizard.mode);
      document.getElementById('sets-options').style.display = wizard.mode === 'sets' ? '' : 'none';
      document.getElementById('games-options').style.display = wizard.mode === 'games' ? '' : 'none';
    });
  });
  selectCard('#mode-options .option-card', 'mode', wizard.mode);

  document.getElementById('bestof-options').querySelectorAll('.option-card').forEach((btn) => {
    btn.addEventListener('click', () => {
      wizard.bestOf = Number(btn.dataset.bestof);
      selectCard('#bestof-options .option-card', 'bestof', wizard.bestOf);
      const stRow = document.getElementById('supertiebreak-row');
      stRow.style.display = wizard.bestOf > 1 ? '' : 'none';
    });
  });
  selectCard('#bestof-options .option-card', 'bestof', wizard.bestOf);

  document.getElementById('gamesperset-options').querySelectorAll('.option-card').forEach((btn) => {
    btn.addEventListener('click', () => {
      wizard.gamesPerSet = Number(btn.dataset.games);
      selectCard('#gamesperset-options .option-card', 'games', wizard.gamesPerSet);
    });
  });
  selectCard('#gamesperset-options .option-card', 'games', wizard.gamesPerSet);

  document.getElementById('chk-noad').addEventListener('change', (e) => { wizard.noAd = e.target.checked; });
  document.getElementById('chk-supertiebreak').addEventListener('change', (e) => { wizard.superTiebreak = e.target.checked; });
  document.getElementById('input-targetgames').addEventListener('input', (e) => {
    wizard.targetGames = Math.max(2, Number(e.target.value) || 4);
  });

  // ---- Paso 2: parejas ----
  document.querySelectorAll('[data-server]').forEach((btn) => {
    btn.addEventListener('click', () => {
      wizard.firstServer = btn.dataset.server;
      selectCard('[data-server]', 'server', wizard.firstServer, document);
    });
  });
  selectCard('[data-server]', 'server', wizard.firstServer, document);

  // ---- Paso 3: voz ----
  document.getElementById('voice-options').querySelectorAll('.option-card').forEach((btn) => {
    btn.addEventListener('click', () => {
      wizard.voiceLevel = btn.dataset.voice;
      selectCard('#voice-options .option-card', 'voice', wizard.voiceLevel);
    });
  });
  selectCard('#voice-options .option-card', 'voice', wizard.voiceLevel);

  async function populateDatalists() {
    const [players, clubs, courts] = await Promise.all([listPlayerNames(), listClubNames(), listCourtNames()]);
    fillDatalist('dl-players', players);
    fillDatalist('dl-clubs', clubs);
    fillDatalist('dl-courts', courts);
  }

  function fillDatalist(id, values) {
    const dl = document.getElementById(id);
    dl.innerHTML = values.map((v) => `<option value="${escapeHtml(v)}"></option>`).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function resetWizard() {
    wizard.stepIndex = 0;
    ['input-a1', 'input-a2', 'input-b1', 'input-b2', 'input-club', 'input-court', 'input-category'].forEach((id) => {
      document.getElementById(id).value = '';
    });
    document.getElementById('remote-test-status').textContent = 'Todavía no se detectó ninguna pulsación';
    renderStep();
    populateDatalists();
  }

  document.getElementById('view-setup').addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;

    if (action === 'step-next') {
      if (wizard.stepIndex < steps.length - 1) {
        wizard.stepIndex += 1;
        renderStep();
      }
      return;
    }

    if (action === 'setup-back') {
      if (wizard.stepIndex > 0) {
        wizard.stepIndex -= 1;
        renderStep();
      } else {
        document.dispatchEvent(new CustomEvent('navigate', { detail: 'home' }));
      }
      return;
    }

    if (action === 'test-remote') {
      const status = document.getElementById('remote-test-status');
      status.textContent = 'Esperando... presioná el botón del control ahora';
      status.style.color = '';
      return;
    }

    if (action === 'start-match') {
      const a1 = document.getElementById('input-a1').value.trim();
      const a2 = document.getElementById('input-a2').value.trim();
      const b1 = document.getElementById('input-b1').value.trim();
      const b2 = document.getElementById('input-b2').value.trim();
      const club = document.getElementById('input-club').value.trim();
      const court = document.getElementById('input-court').value.trim();
      const category = document.getElementById('input-category').value.trim();

      await Promise.all([a1, a2, b1, b2].filter(Boolean).map(savePlayerName));
      if (club) await saveClubName(club);
      if (court) await saveCourtName(court);

      const meta = {
        id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        sport: 'padel',
        config: buildConfig(),
        teams: { A: { p1: a1, p2: a2 }, B: { p1: b1, p2: b2 } },
        club, court, category,
        voiceLevel: wizard.voiceLevel,
      };
      onStartMatch(meta);
    }
  });

  renderStep();
  populateDatalists();

  return { resetWizard };
}
