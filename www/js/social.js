// Jornada de formato social: varias parejas, la que gana se queda en cancha y
// entra la siguiente. Se guarda en el celular para sobrevivir a cerrar la app.

const KEY = 'zscoreSocialSession';

export function loadSession() {
  try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch (e) { return null; }
}

export function saveSession(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* sin almacenamiento: sigue en memoria */ }
}

export function clearSession() {
  try { localStorage.removeItem(KEY); } catch (e) { /* nada que borrar */ }
}

export function pairLabel(pair) {
  const parts = [pair.p1, pair.p2].filter(Boolean);
  return parts.length ? parts.join(' / ') : 'Sin nombre';
}

/** pairs: [{p1,p2}] en orden de llegada. Juegan las dos primeras; el resto espera en fila. */
export function createSession({ id, pairs, config, voiceLevel, firstSlot = [] }) {
  return {
    id,
    pairs,
    firstSlot: pairs.map((_, i) => firstSlot[i] || 'p1'), // quién de cada pareja saca primero
    config, // se repite en cada partido de la jornada
    voiceLevel,
    court: { A: 0, B: 1 },
    queue: pairs.map((_, i) => i).slice(2),
    wins: pairs.map(() => 0),
    streak: pairs.map(() => 0),
    pending: null, // { matchId, winner, loser, score } mientras se decide el cambio
  };
}

/** Equipos {A,B} del partido que se juega ahora. */
export function courtTeams(s) {
  return { A: { ...s.pairs[s.court.A] }, B: { ...s.pairs[s.court.B] } };
}

export function courtFirstSlot(s) {
  return { A: s.firstSlot[s.court.A] || 'p1', B: s.firstSlot[s.court.B] || 'p1' };
}

/** Anota el resultado de un partido terminado. No hace nada si ya se anotó. */
export function applyResult(s, matchId, winnerSide, score) {
  if (s.pending?.matchId === matchId) return s;
  const winner = s.court[winnerSide];
  const loser = s.court[winnerSide === 'A' ? 'B' : 'A'];
  s.wins[winner] += 1;
  s.streak[winner] += 1;
  s.streak[loser] = 0;
  s.pending = { matchId, winner, loser, score, winnerSide };
  return s;
}

/** Arma la cancha siguiente: `stay` sigue (conserva su lado), `enter` entra, el que sale va al final de la fila. */
export function applyChange(s, stay, enter) {
  const { winner, loser, winnerSide } = s.pending;
  const stayWasSide = stay === winner ? winnerSide : (winnerSide === 'A' ? 'B' : 'A');
  const leaving = stay === winner ? loser : winner;
  s.queue = s.queue.filter((i) => i !== enter);
  s.queue.push(leaving);
  s.court = stayWasSide === 'A' ? { A: stay, B: enter } : { A: enter, B: stay };
  s.pending = null;
  return s;
}
