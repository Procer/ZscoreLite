import { createMatchController } from './match-controller.js';
import { initSetupWizard } from './ui-setup.js';
import { initScoreboard } from './ui-scoreboard.js';
import { initHistory } from './ui-history.js';

const views = ['home', 'setup', 'scoreboard', 'summary', 'history'];

function showView(name) {
  views.forEach((v) => {
    document.getElementById(`view-${v}`).classList.toggle('is-active', v === name);
  });
}

const history = initHistory();

const setup = initSetupWizard((meta) => {
  const controller = createMatchController(meta);
  scoreboard.start(controller);
  showView('scoreboard');
});

const scoreboard = initScoreboard({
  onMatchFinished: (record) => {
    renderSummary(record);
    showView('summary');
  },
});

function renderSummary(record) {
  const winnerKey = record.finalState?.winner;
  const winnerName = winnerKey ? record.teamNames[winnerKey] : null;
  document.getElementById('summary-winner').textContent = winnerName ? `Ganó ${winnerName}` : 'Partido finalizado';

  const sets = record.finalState?.completedSets || [];
  document.getElementById('summary-score').textContent = sets.map((s) => `${s.gamesA}-${s.gamesB}`).join('  ') || '—';

  const durationMin = record.endedAt && record.startedAt
    ? Math.max(1, Math.round((record.endedAt - record.startedAt) / 60000))
    : null;

  const lines = [];
  if (record.club) lines.push(`Club: ${record.club}`);
  if (record.court) lines.push(`Cancha: ${record.court}`);
  if (durationMin) lines.push(`Duración: ${durationMin} min`);
  if (record.finalState) lines.push(`Quiebres: ${record.teamNames.A} ${record.finalState.breaksA} · ${record.teamNames.B} ${record.finalState.breaksB}`);
  document.getElementById('summary-detail').innerHTML = lines.join('<br/>');
}

document.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;

  if (action === 'go-home') { showView('home'); return; }
  if (action === 'go-history') { history.render(); showView('history'); return; }
  if (action === 'go-setup') { setup.resetWizard(); showView('setup'); return; }
});

document.addEventListener('navigate', (e) => {
  if (e.detail === 'home') showView('home');
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
