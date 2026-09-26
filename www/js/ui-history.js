import { listMatches } from './db.js';
import { describeConfig } from './scoring-engine.js';

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

    const setsHtml = sets.length
      ? sets.map((s, i) => `
          <div class="match-card-row">
            <span>Set ${i + 1}${s.superTiebreak ? ' (súper tie-break)' : ''}</span>
            <strong>${s.gamesA} - ${s.gamesB}</strong>
          </div>
        `).join('')
      : '<div class="match-card-meta">Partido sin terminar</div>';

    content.innerHTML = `
      <h2>${escapeHtml(match.teamNames.A)} vs ${escapeHtml(match.teamNames.B)}</h2>
      ${winnerName ? `<p><strong style="color:var(--accent);">🏆 Ganó ${escapeHtml(winnerName)}</strong></p>` : ''}
      <div class="summary-card">
        ${setsHtml}
      </div>
      <div class="summary-card">
        <div class="match-card-row"><span>Modalidad</span><span>${escapeHtml(describeConfig(match.config))}</span></div>
        <div class="match-card-row"><span>Fecha</span><span>${formatDate(match.startedAt)}</span></div>
        ${duration ? `<div class="match-card-row"><span>Duración</span><span>${duration}</span></div>` : ''}
        ${match.club ? `<div class="match-card-row"><span>Club</span><span>${escapeHtml(match.club)}</span></div>` : ''}
        ${match.court ? `<div class="match-card-row"><span>Cancha</span><span>${escapeHtml(match.court)}</span></div>` : ''}
        ${match.category ? `<div class="match-card-row"><span>Categoría</span><span>${escapeHtml(match.category)}</span></div>` : ''}
        ${match.finalState ? `<div class="match-card-row"><span>Quiebres de saque</span><span>${escapeHtml(match.teamNames.A)} ${match.finalState.breaksA} · ${escapeHtml(match.teamNames.B)} ${match.finalState.breaksB}</span></div>` : ''}
        <div class="match-card-row"><span>Tantos jugados</span><span>${(match.events || []).length}</span></div>
      </div>
      <button class="btn btn-ghost btn-block" data-action="close-match-detail">Cerrar</button>
    `;
    overlay.classList.add('is-active');
  }

  list.addEventListener('click', (e) => {
    const idx = e.target.closest('[data-index]')?.dataset.index;
    if (idx === undefined) return;
    openDetail(cache[Number(idx)]);
  });

  overlay.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="close-match-detail"]') || e.target === overlay) {
      overlay.classList.remove('is-active');
    }
  });

  return { render, openDetail };
}
