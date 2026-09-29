import { listMatches } from './db.js';
import { describeConfig, replayMatch } from './scoring-engine.js';
import { renderStatsCard } from './match-stats-view.js';
import { computeRecords, topList, POINTS_WIN, POINTS_LOSS } from './records.js';
import { copyMatchImage, copyResultMessage } from './share-image.js';

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Tablero de dos filas (una por pareja) con una columna por set. Se usa en
 * la tarjeta de la lista y arriba del detalle. */
function scoreTable(match, big) {
  const sets = match.finalState?.completedSets || [];
  const winner = match.finalState?.winner || null;
  const rows = ['A', 'B'].map((side) => {
    const isWinner = winner === side;
    const cells = sets.map((s) => {
      const mine = side === 'A' ? s.gamesA : s.gamesB;
      const theirs = side === 'A' ? s.gamesB : s.gamesA;
      return `<span class="hm-set${mine > theirs ? ' is-won' : ''}">${mine}</span>`;
    }).join('');
    return `
      <div class="hm-row hm-row--${side.toLowerCase()}${isWinner ? ' is-winner' : winner ? ' is-loser' : ''}">
        <span class="hm-dot"></span>
        <span class="hm-name">${escapeHtml(match.teamNames[side])}</span>
        ${isWinner ? '<span class="hm-trophy">🏆</span>' : ''}
        <span class="hm-sets">${cells}</span>
      </div>`;
  }).join('');
  return `<div class="hm-table${big ? ' hm-table--big' : ''}">${rows}</div>`;
}

function medal(pos) {
  return pos === 1 ? '🥇' : pos === 2 ? '🥈' : pos === 3 ? '🥉' : `#${pos}`;
}

function rivalList(map, empty) {
  const list = topList(map);
  if (!list.length) return `<div class="rk-empty">${empty}</div>`;
  return `<ul class="rk-list">${list.map((r) =>
    `<li><span>${escapeHtml(r.name)}</span><b>${r.count > 1 ? `×${r.count}` : '×1'}</b></li>`).join('')}</ul>`;
}

function partnerList(map) {
  const list = [...map.values()].sort((a, b) => (b.won + b.lost) - (a.won + a.lost));
  if (!list.length) return '';
  return `
    <div class="rk-sub-title">Compañeros</div>
    <ul class="rk-list">${list.map((p) =>
      `<li><span>${escapeHtml(p.name)}</span><b>${p.won} G · ${p.lost} P</b></li>`).join('')}</ul>`;
}

function rankingCard(e, pos, isPair, index, maxPoints) {
  const many = e.played === 1 ? 'partido' : 'partidos';
  const verbPlayed = isPair ? 'jugaron' : 'jugó';
  const verbWon = isPair ? 'ganaron' : 'ganó';
  const verbLost = isPair ? 'perdieron' : 'perdió';
  const summary = `<strong>${escapeHtml(e.name)}</strong> ${verbPlayed} <b>${e.played}</b> ${many}: ${verbWon} <b class="is-win">${e.won}</b> y ${verbLost} <b class="is-loss">${e.lost}</b>.`;
  const barW = maxPoints ? Math.max(4, Math.round((e.points / maxPoints) * 100)) : 0;
  return `
    <div class="rk-card${pos <= 3 ? ` rk-card--top${pos}` : ''}" data-toggle="${index}">
      <div class="rk-head">
        <div class="rk-pos">${medal(pos)}</div>
        <div class="rk-main">
          <div class="rk-name">${escapeHtml(e.name)}</div>
          <div class="rk-sub">${e.played} PJ · <span class="is-win">${e.won} G</span> · <span class="is-loss">${e.lost} P</span> · ${e.winPct}%</div>
        </div>
        <div class="rk-pts"><b>${e.points}</b><span>pts</span></div>
      </div>
      <div class="rk-bar"><i style="width:${barW}%"></i></div>
      <div class="rk-detail">
        <p class="rk-summary">${summary}</p>
        ${isPair ? '' : partnerList(e.partners)}
        <div class="rk-sub-title">${isPair ? 'Ganaron contra' : 'Ganó contra'}</div>
        ${rivalList(e.beat, 'Todavía sin victorias.')}
        <div class="rk-sub-title">${isPair ? 'Perdieron contra' : 'Perdió contra'}</div>
        ${rivalList(e.lostTo, 'Todavía sin derrotas.')}
      </div>
    </div>`;
}

export function initHistory() {
  const list = document.getElementById('history-list');
  const tabsEl = document.getElementById('hist-tabs');
  const overlay = document.getElementById('overlay-match-detail');
  const content = document.getElementById('match-detail-content');
  let cache = [];
  let records = { pairs: [], players: [] };
  let currentTab = 'matches';
  let currentDetailMatch = null;
  let currentDetailStats = null;

  function renderMatches() {
    if (!cache.length) {
      list.innerHTML = '<div class="empty-state">Todavía no hay partidos guardados.<br/>Jugá uno para verlo acá.</div>';
      return;
    }
    list.innerHTML = cache.map((m, i) => {
      const badge = m.inProgress
        ? '<span class="hm-badge hm-badge--live">En curso</span>'
        : m.finalState?.winner ? '' : '<span class="hm-badge">Cortado</span>';
      const place = [m.club, m.court].filter(Boolean).map(escapeHtml).join(' · ');
      const duration = formatDuration(m.startedAt, m.endedAt);
      return `
        <button class="hm-card" data-index="${i}">
          <div class="hm-head">
            <span>${formatDate(m.startedAt)}</span>
            ${badge}
          </div>
          ${scoreTable(m, false)}
          ${(place || duration) ? `<div class="hm-foot">${[place, duration].filter(Boolean).join(' · ')}</div>` : ''}
        </button>`;
    }).join('');
  }

  function renderRanking(kind) {
    const isPair = kind === 'pairs';
    const items = isPair ? records.pairs : records.players;
    if (!items.length) {
      list.innerHTML = `<div class="empty-state">${isPair
        ? 'Todavía no hay parejas con partidos terminados.<br/>Cuando termines partidos con dos jugadores cada lado, van a aparecer acá.'
        : 'Todavía no hay jugadores con partidos terminados.'}</div>`;
      return;
    }
    const maxPoints = items[0].points;
    list.innerHTML = `
      <div class="rk-intro">
        <strong>Ranking interno</strong>
        <span>Ganar suma ${POINTS_WIN} pts · jugar suma ${POINTS_LOSS} pt. Tocá una tarjeta para ver contra quién ganó y perdió.</span>
      </div>
      ${items.map((e, i) => rankingCard(e, i + 1, isPair, i, maxPoints)).join('')}`;
  }

  function renderTab() {
    tabsEl.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === currentTab));
    if (currentTab === 'matches') renderMatches();
    else renderRanking(currentTab);
  }

  async function render() {
    cache = await listMatches();
    records = computeRecords(cache);
    renderTab();
  }

  function openDetail(match) {
    const duration = formatDuration(match.startedAt, match.endedAt);
    const winnerName = match.finalState?.winner ? match.teamNames[match.finalState.winner] : null;
    const replayed = replayMatch(match.config, match.events || []);
    const statsHtml = renderStatsCard(match.teamNames, replayed.stats);

    const infoTiles = [
      ['Modalidad', escapeHtml(describeConfig(match.config))],
      ['Fecha', formatDate(match.startedAt)],
    ];
    if (duration) infoTiles.push(['Duración', duration]);
    if (match.club) infoTiles.push(['Club', escapeHtml(match.club)]);
    if (match.court) infoTiles.push(['Cancha', escapeHtml(match.court)]);
    if (match.finalState) {
      infoTiles.push(['Quiebres de saque', `${escapeHtml(match.teamNames.A)}: ${match.finalState.breaksA} &nbsp;·&nbsp; ${escapeHtml(match.teamNames.B)}: ${match.finalState.breaksB}`]);
    }
    const infoHtml = infoTiles.map(([l, v]) => `<div class="stat-tile"><div class="stat-tile-label">${l}</div><div class="stat-tile-value">${v}</div></div>`).join('');

    content.innerHTML = `
      ${winnerName ? `<div class="hm-winner">🏆 Ganó ${escapeHtml(winnerName)}</div>` : '<div class="hm-winner hm-winner--muted">Partido sin terminar</div>'}
      ${scoreTable(match, true)}
      ${statsHtml}
      <div class="section-title">Detalles</div>
      <div class="stat-tile-card">${infoHtml}</div>
      <button class="btn btn-primary btn-block" data-action="copy-match">📋 Copiar imagen</button>
      <button class="btn btn-ghost btn-block" data-action="close-match-detail">Cerrar</button>
    `;
    overlay.classList.add('is-active');
    currentDetailMatch = match;
    currentDetailStats = replayed.stats;
  }

  tabsEl.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]')?.dataset.tab;
    if (!tab || tab === currentTab) return;
    currentTab = tab;
    renderTab();
    document.getElementById('view-history').scrollTop = 0;
  });

  list.addEventListener('click', (e) => {
    const card = e.target.closest('[data-index]');
    if (card) { openDetail(cache[Number(card.dataset.index)]); return; }
    const rk = e.target.closest('[data-toggle]');
    if (rk) rk.classList.toggle('is-open');
  });

  overlay.addEventListener('click', async (e) => {
    if (e.target.closest('[data-action="close-match-detail"]') || e.target === overlay) {
      overlay.classList.remove('is-active');
      return;
    }
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy-match' && currentDetailMatch) {
      e.stopPropagation(); // evita que el listener global de app.js también copie
      alert(copyResultMessage(await copyMatchImage(currentDetailMatch, currentDetailStats)));
    }
  });

  return { render, openDetail };
}
