/** Arma el texto del resultado, listo para pegar en WhatsApp. */
export function buildShareText(record) {
  const lines = ['🎾 Z-Score Lite', ''];
  lines.push(`${record.teamNames.A} vs ${record.teamNames.B}`);

  if (record.finalState) {
    lines.push(`🏆 Ganó ${record.teamNames[record.finalState.winner]}`);
    const sets = (record.finalState.completedSets || []).map((s) => `${s.gamesA}-${s.gamesB}`).join('  ');
    if (sets) lines.push(`Sets: ${sets}`);
  } else {
    lines.push('Partido sin terminar');
  }

  if (record.club) lines.push(`Club: ${record.club}`);
  if (record.court) lines.push(`Cancha: ${record.court}`);
  if (record.category) lines.push(`Categoría: ${record.category}`);

  const durationMin = record.endedAt && record.startedAt
    ? Math.max(1, Math.round((record.endedAt - record.startedAt) / 60000))
    : null;
  if (durationMin) lines.push(`Duración: ${durationMin} min`);

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
