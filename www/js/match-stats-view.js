function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** HTML de la tarjeta de estadísticas del partido, a partir del `state.stats`
 * que devuelve replayMatch(). Se reutiliza en el resumen de fin de partido y
 * en el detalle del historial. */
export function renderStatsCard(teamNames, stats) {
  if (!stats || !stats.totalPoints) return '';
  const streakName = stats.longestStreak.team ? teamNames[stats.longestStreak.team] : null;
  return `
    <div class="summary-card">
      <div class="match-card-row"><span>Tantos jugados</span><span>${stats.totalPoints}</span></div>
      <div class="match-card-row"><span>Tantos ganados</span><span>${escapeHtml(teamNames.A)} ${stats.pointsWonA} · ${escapeHtml(teamNames.B)} ${stats.pointsWonB}</span></div>
      ${stats.servePctA !== null ? `<div class="match-card-row"><span>Efectividad al saque</span><span>${escapeHtml(teamNames.A)} ${stats.servePctA}% · ${escapeHtml(teamNames.B)} ${stats.servePctB}%</span></div>` : ''}
      ${streakName ? `<div class="match-card-row"><span>Racha más larga</span><span>${stats.longestStreak.count} tantos (${escapeHtml(streakName)})</span></div>` : ''}
      ${stats.avgPointsPerGame ? `<div class="match-card-row"><span>Promedio por game</span><span>${stats.avgPointsPerGame} tantos</span></div>` : ''}
    </div>
  `;
}
