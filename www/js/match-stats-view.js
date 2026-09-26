function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Un dato con su etiqueta arriba (chico, gris) y el valor abajo (grande,
 * blanco). Mucho más legible en el celular que una fila "etiqueta: valor"
 * cuando el valor es largo (nombres de pareja + números). */
function tile(label, value) {
  return `
    <div class="stat-tile">
      <div class="stat-tile-label">${label}</div>
      <div class="stat-tile-value">${value}</div>
    </div>
  `;
}

/** HTML de la tarjeta de estadísticas del partido, a partir del `state.stats`
 * que devuelve replayMatch(). Se reutiliza en el resumen de fin de partido y
 * en el detalle del historial. */
export function renderStatsCard(teamNames, stats) {
  if (!stats || !stats.totalPoints) return '';
  const streakName = stats.longestStreak.team ? teamNames[stats.longestStreak.team] : null;
  const nameA = escapeHtml(teamNames.A);
  const nameB = escapeHtml(teamNames.B);

  const tiles = [
    tile('Tantos jugados en total', stats.totalPoints),
    tile('Tantos ganados', `${nameA}: ${stats.pointsWonA} &nbsp;·&nbsp; ${nameB}: ${stats.pointsWonB}`),
  ];
  if (stats.servePctA !== null) {
    tiles.push(tile('Efectividad al saque', `${nameA}: ${stats.servePctA}% &nbsp;·&nbsp; ${nameB}: ${stats.servePctB}%`));
  }
  if (streakName) {
    tiles.push(tile('Racha más larga', `${stats.longestStreak.count} tantos seguidos de ${escapeHtml(streakName)}`));
  }
  if (stats.avgPointsPerGame) {
    tiles.push(tile('Promedio de tantos por game', stats.avgPointsPerGame));
  }

  return `
    <div class="section-title">Estadísticas</div>
    <div class="stat-tile-card">${tiles.join('')}</div>
  `;
}
