/**
 * Arma el texto del resultado, listo para pegar en WhatsApp. Incluye todo lo
 * que se ve en el detalle del historial (no solo el resultado), por eso pide
 * también `stats` (el `state.stats` que devuelve replayMatch()).
 */
export function buildShareText(record, stats) {
  const lines = ['🎾 Z-Score Lite', ''];
  lines.push(`${record.teamNames.A} vs ${record.teamNames.B}`);

  if (record.finalState) {
    lines.push(`🏆 Ganó ${record.teamNames[record.finalState.winner]}`);
    lines.push('');
    lines.push('Sets:');
    (record.finalState.completedSets || []).forEach((s, i) => {
      lines.push(`  Set ${i + 1}${s.superTiebreak ? ' (súper tie-break)' : ''}: ${s.gamesA}-${s.gamesB}`);
    });
  } else {
    lines.push('Partido sin terminar');
  }

  const context = [];
  if (record.club) context.push(`Club: ${record.club}`);
  if (record.court) context.push(`Cancha: ${record.court}`);
  if (record.category) context.push(`Categoría: ${record.category}`);
  const durationMin = record.endedAt && record.startedAt
    ? Math.max(1, Math.round((record.endedAt - record.startedAt) / 60000))
    : null;
  if (durationMin) context.push(`Duración: ${durationMin} min`);
  if (context.length) { lines.push(''); lines.push(...context); }

  if (record.finalState) {
    lines.push('');
    lines.push(`Quiebres de saque: ${record.teamNames.A} ${record.finalState.breaksA} · ${record.teamNames.B} ${record.finalState.breaksB}`);
  }

  if (stats && stats.totalPoints) {
    lines.push('');
    lines.push('Estadísticas:');
    lines.push(`  Tantos jugados: ${stats.totalPoints}`);
    lines.push(`  Tantos ganados: ${record.teamNames.A} ${stats.pointsWonA} · ${record.teamNames.B} ${stats.pointsWonB}`);
    if (stats.servePctA !== null) {
      lines.push(`  Efectividad al saque: ${record.teamNames.A} ${stats.servePctA}% · ${record.teamNames.B} ${stats.servePctB}%`);
    }
    if (stats.longestStreak?.team) {
      lines.push(`  Racha más larga: ${stats.longestStreak.count} tantos de ${record.teamNames[stats.longestStreak.team]}`);
    }
  }

  return lines.join('\n');
}

/**
 * Comparte el texto con el selector nativo del celular (WhatsApp, etc.).
 * Si el navegador no lo soporta, lo copia al portapapeles como respaldo.
 * Devuelve 'shared' | 'copied' | 'cancelled' | 'failed'.
 */
export async function shareMatch(text) {
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Z-Score Lite', text });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      // sigue al respaldo de portapapeles si falló por otra razón
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch (e) {
    return 'failed';
  }
}
