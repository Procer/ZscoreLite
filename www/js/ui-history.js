import { listMatches } from './db.js';
import { describeConfig, replayMatch } from './scoring-engine.js';
import { renderStatsCard } from './match-stats-view.js';
import { buildShareText, shareMatch } from './share.js';

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' · ' + d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(startedAt, endedAt) {
  if (!startedAt || !endedAt) return null;
  const min = Math.max(1, Math.round((endedAt - startedAt) / 60000));
  return `${min} min`;
}

function scoreSummary(match) {
  if (!match.finalState) return 'Sin terminar';
  const sets = match.finalState.completedSets || [];
  return sets.map((s) => `${s.gamesA}-${s.gamesB}`).join('  ');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function initHistory() {
  const list = document.getElementById('history-list');
  const overlay = document.getElementById('overlay-match-detail');
  const content = document.getElementById('match-detail-content');
  let cache = [];
  let currentDetailMatch = null;
  let currentDetailStats = null;

  async function render() {
    cache = await listMatches();
    if (!cache.length) {
      list.innerHTML = '<div class="empty-state">Todavía no hay partidos guardados.<br/>Jugá uno para verlo acá.</div>';
      return;
    }
    list.innerHTML = cache.map((m, i) => {
      const winnerName = m.finalState ? m.teamNames[m.finalState.winner] : null;
      return `
        <button class="match-card" data-index="${i}" style="text-align:left; width:100%;">
          <div class="match-card-row">
            <div class="match-card-teams">${escapeHtml(m.teamNames.A)} <span style="color:var(--text-dim);">vs</span> ${escapeHtml(m.teamNames.B)}</div>
            <div class="match-card-score">${scoreSummary(m)}</div>
          </div>
          <div class="match-card-meta">
            ${winnerName ? `🏆 ${escapeHtml(winnerName)} · ` : ''}${formatDate(m.startedAt)}${m.inProgress ? ' · en curso' : ''}
          </div>
          <div class="match-card-meta">${[m.club, m.court, m.category].filter(Boolean).map(escapeHtml).join(' · ')}</div>
        </button>
      `;
    }).join('');
  }

  function openDetail(match) {
    const duration = formatDuration(match.startedAt, match.endedAt);
    const sets = match.finalState?.completedSets || [];
    const winnerName = match.finalState ? match.teamNames[match.finalState.winner] : null;
    const replayed = replayMatch(match.config, match.events || []);
    const statsHtml = renderStatsCard(match.teamNames, replayed.stats);

    const setsHtml = sets.length
      ? sets.map((s, i) => `
          <div class="stat-tile">
            <div class="stat-tile-label">Set ${i + 1}${s.superTiebreak ? ' · súper tie-break' : ''}</div>
            <div class="stat-tile-value">${s.gamesA} - ${s.gamesB}</div>
          </div>
        `).join('')
      : '<div class="stat-tile"><div class="stat-tile-value">Partido sin terminar</div></div>';

    const infoTiles = [
      ['Modalidad', escapeHtml(describeConfig(match.config))],
      ['Fecha', formatDate(match.startedAt)],
    ];
    if (duration) infoTiles.push(['Duración', duration]);
    if (match.club) infoTiles.push(['Club', escapeHtml(match.club)]);
    if (match.court) infoTiles.push(['Cancha', escapeHtml(match.court)]);
    if (match.category) infoTiles.push(['Categoría', escapeHtml(match.category)]);
    if (match.finalState) {
      infoTiles.push(['Quiebres de saque', `${escapeHtml(match.teamNames.A)}: ${match.finalState.breaksA} &nbsp;·&nbsp; ${escapeHtml(match.teamNames.B)}: ${match.finalState.breaksB}`]);
    }
    const infoHtml = infoTiles.map(([l, v]) => `<div class="stat-tile"><div class="stat-tile-label">${l}</div><div class="stat-tile-value">${v}</div></div>`).join('');

    content.innerHTML = `
      <h2>${escapeHtml(match.teamNames.A)} vs ${escapeHtml(match.teamNames.B)}</h2>
      ${winnerName ? `<p><strong style="color:var(--accent); font-size:16px;">🏆 Ganó ${escapeHtml(winnerName)}</strong></p>` : ''}
      <div class="section-title">Resultado</div>
      <div class="stat-tile-card">${setsHtml}</div>
      <div class="section-title">Detalles</div>
      <div class="stat-tile-card">${infoHtml}</div>
      ${statsHtml}
      <button class="btn btn-primary btn-block" data-action="share-match">📤 Compartir resultado</button>
      <button class="btn btn-ghost btn-block" data-action="close-match-detail">Cerrar</button>
    `;
    overlay.classList.add('is-active');
    currentDetailMatch = match;
    currentDetailStats = replayed.stats;
  }

  list.addEventListener('click', (e) => {
    const idx = e.target.closest('[data-index]')?.dataset.index;
    if (idx === undefined) return;
    openDetail(cache[Number(idx)]);
  });

  overlay.addEventListener('click', async (e) => {
    if (e.target.closest('[data-action="close-match-detail"]') || e.target === overlay) {
      overlay.classList.remove('is-active');
      return;
    }
    if (e.target.closest('[data-action="share-match"]') && currentDetailMatch) {
      e.stopPropagation(); // evita que el listener global de app.js también dispare el compartir
      const result = await shareMatch(buildShareText(currentDetailMatch, currentDetailStats));
      if (result === 'copied') alert('Copiado. Pegalo en WhatsApp o donde quieras mandarlo.');
      if (result === 'failed') alert('No se pudo compartir ni copiar en este navegador.');
    }
  });

  return { render, openDetail };
}
