import { listMatches } from './db.js';

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' · ' + d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(startedAt, endedAt) {
  if (!startedAt || !endedAt) return '';
  const min = Math.max(1, Math.round((endedAt - startedAt) / 60000));
  return `${min} min`;
}

function scoreSummary(match) {
  if (!match.finalState) return 'Sin terminar';
  const sets = match.finalState.completedSets || [];
  return sets.map((s) => `${s.gamesA}-${s.gamesB}`).join('  ');
}

export function initHistory() {
  const list = document.getElementById('history-list');

  async function render() {
    const matches = await listMatches();
    if (!matches.length) {
      list.innerHTML = '<div class="empty-state">Todavía no hay partidos guardados.<br/>Jugá uno para verlo acá.</div>';
      return;
    }
    list.innerHTML = matches.map((m) => {
      const winnerName = m.finalState ? m.teamNames[m.finalState.winner] : null;
      return `
        <div class="match-card">
          <div class="match-card-row">
            <div class="match-card-teams">${escapeHtml(m.teamNames.A)} <span style="color:var(--text-dim);">vs</span> ${escapeHtml(m.teamNames.B)}</div>
            <div class="match-card-score">${scoreSummary(m)}</div>
          </div>
          <div class="match-card-meta">
            ${winnerName ? `🏆 ${escapeHtml(winnerName)} · ` : ''}${formatDate(m.startedAt)}${m.endedAt ? ' · ' + formatDuration(m.startedAt, m.endedAt) : ''}
          </div>
          <div class="match-card-meta">${[m.club, m.court, m.category].filter(Boolean).map(escapeHtml).join(' · ')}</div>
        </div>
      `;
    }).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  return { render };
}
