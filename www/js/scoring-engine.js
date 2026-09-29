// Motor de puntaje puro (sin DOM, sin efectos de lado).
// Diseñado por reproducción de eventos: cada tanto es un evento {team, t}.
// El estado completo del partido siempre se recalcula reproduciendo los eventos
// desde cero. Esto hace que "restar un tanto" (deshacer) sea trivial y sin errores,
// y de paso deja un registro exacto de todo lo sucedido (útil para el historial).

export const POINT_LABELS = ['0', '15', '30', '40'];

export function defaultConfig(overrides = {}) {
  return {
    sport: 'padel', // 'padel' | 'tenis'
    mode: 'sets', // 'sets' (partido a sets) | 'games' (social, a X games)
    setsToWin: 2, // 1 = un solo set/tanda de games, 2 = mejor de 3, 3 = mejor de 5
    gamesPerSet: 6, // 6 clásico, 4 "sets cortos" para rotar parejas
    tiebreakPoints: 7, // puntos para ganar el tie-break normal (por 2)
    superTiebreakDecider: false, // si es true, el set decisivo se juega a súper tie-break
    superTiebreakPoints: 10,
    noAd: false, // punto de oro (muerte súbita en 40-40)
    targetGames: 4, // usado solo en mode:'games' (informativo, igual a gamesPerSet)
    // Quién saca el primer game del partido. Si queda en null (no se eligió
    // en la configuración), lo decide el primer tanto jugado: el equipo al
    // que se le toca el primer punto queda como el que estaba sacando.
    firstServer: null,
    ...overrides,
  };
}

function evaluateGame(a, b, noAd) {
  if (a < 3 && b < 3) return { over: false };
  if (a >= 3 && b >= 3) {
    if (noAd) {
      if (a === b) return { over: false, goldenPoint: true };
      return { over: true, winner: a > b ? 'A' : 'B' };
    }
    if (Math.abs(a - b) >= 2) return { over: true, winner: a > b ? 'A' : 'B' };
    return { over: false, deuce: a === b, advantage: a === b ? null : (a > b ? 'A' : 'B') };
  }
  if (a >= 4 || b >= 4) return { over: true, winner: a > b ? 'A' : 'B' };
  return { over: false };
}

function evaluateBreak(a, b, target) {
  if ((a >= target || b >= target) && Math.abs(a - b) >= 2) {
    return { over: true, winner: a > b ? 'A' : 'B' };
  }
  return { over: false };
}

function otherTeam(t) { return t === 'A' ? 'B' : 'A'; }

/**
 * Quién saca el punto número `pointNumber` (1-indexado) dentro de un tie-break,
 * dado quién sacó el primer punto. Regla real: el primer punto lo saca un
 * equipo, y a partir de ahí se alterna cada 2 puntos (1, 2-2, 2-2, ...).
 */
function tiebreakServerAt(pointNumber, initialServer) {
  if (pointNumber <= 1) return initialServer;
  const block = Math.floor((pointNumber - 2) / 2);
  return block % 2 === 0 ? otherTeam(initialServer) : initialServer;
}

function pointLabel(mine, other, noAd) {
  if (mine < 3 && other < 3) return POINT_LABELS[mine];
  // En punto de oro (40-40) se muestra 40 en ambos lados; display.goldenPoint
  // avisa que es el punto decisivo (lo usa la voz).
  if (noAd && mine >= 3 && other >= 3) return POINT_LABELS[3];
  if (mine >= 3 && other >= 3) {
    const diff = mine - other;
    if (diff === 0) return 'Iguales';
    if (diff >= 1) return 'Ventaja';
    return POINT_LABELS[3];
  }
  return POINT_LABELS[Math.min(mine, 3)];
}

/**
 * Reproduce todos los eventos de tanto y devuelve el estado completo del partido.
 * @param {object} config - ver defaultConfig()
 * @param {Array<{team: 'A'|'B', t: number}>} events
 */
export function replayMatch(config, events) {
  const cfg = defaultConfig(config);
  // Si no se eligió sacador en la configuración, lo define el equipo del
  // primer evento (el primer toque de la pantalla/control decide el saque).
  const inferredFirstServer = cfg.firstServer || (events.length ? events[0].team : null);

  const state = {
    matchOver: false,
    winner: null,
    setsWonA: 0,
    setsWonB: 0,
    completedSets: [], // {gamesA, gamesB, tiebreak: {a,b}|null, superTiebreak: bool}
    currentSet: { gamesA: 0, gamesB: 0 },
    gamePointsA: 0,
    gamePointsB: 0,
    inTiebreak: false,
    tiebreakA: 0,
    tiebreakB: 0,
    isSuperTiebreakNow: false,
    server: inferredFirstServer, // equipo que saca el game/tanda actual (null si todavía no se jugó nada)
    firstServerOfSet: inferredFirstServer,
    breaksA: 0, // quiebres de saque ganados por A
    breaksB: 0,
    gameLog: [], // registro de cada game/tie-break terminado
    pointLog: [], // registro crudo de cada tanto con timestamp
    startedAt: events.length ? events[0].t : null,
    endedAt: null,
    lastEventTeam: null,
  };

  let serverAtGameStart = state.server;

  function finishGame(winner, wasTiebreak, wasSuperTiebreak) {
    if (!wasSuperTiebreak) {
      if (winner === 'A') state.currentSet.gamesA += 1;
      else state.currentSet.gamesB += 1;
    }
    if (winner !== serverAtGameStart && !wasSuperTiebreak) {
      if (winner === 'A') state.breaksA += 1; else state.breaksB += 1;
    }
    state.gameLog.push({
      winner,
      server: serverAtGameStart,
      wasBreak: winner !== serverAtGameStart && !wasSuperTiebreak,
      tiebreak: wasTiebreak ? { a: state.tiebreakA, b: state.tiebreakB, superTiebreak: !!wasSuperTiebreak } : null,
      setScoreAfter: { a: state.currentSet.gamesA, b: state.currentSet.gamesB },
    });

    state.gamePointsA = 0;
    state.gamePointsB = 0;
    state.inTiebreak = false;
    state.tiebreakA = 0;
    state.tiebreakB = 0;
    state.isSuperTiebreakNow = false;

    if (wasSuperTiebreak) {
      // El súper tie-break decide el set directamente (se registra 1 game simbólico extra)
      if (winner === 'A') state.currentSet.gamesA += 1; else state.currentSet.gamesB += 1;
      closeSet(winner, true);
      return;
    }

    if (wasTiebreak) {
      // Un tie-break normal siempre define el set (ej: 7-6), aunque la diferencia
      // de games sea de solo 1: no aplica la regla genérica de "ganar por 2 games".
      closeSet(winner, false);
      return;
    }

    const setEval = evaluateSet(state.currentSet.gamesA, state.currentSet.gamesB, cfg);
    if (setEval.triggerTiebreak) {
      // Nota: si este es el set decisivo con súper tie-break configurado, nunca
      // se llega a jugar games (closeSet ya deja ese set directo en super-tiebreak
      // desde el arranque). Este tie-break normal es siempre el de fin de set.
      state.inTiebreak = true;
      // El que saca el tie-break es el que le tocaría sacar en el siguiente game
      state.server = winner === serverAtGameStart ? otherTeam(serverAtGameStart) : serverAtGameStart;
      serverAtGameStart = state.server;
      tiebreakInitialServer = state.server;
      return;
    }
    if (setEval.over) {
      closeSet(setEval.winner, false);
      return;
    }
    // Set continúa: alterna el saque
    state.server = otherTeam(serverAtGameStart);
    serverAtGameStart = state.server;
  }

  function isDecidingSetNow() {
    if (cfg.mode !== 'sets') return false;
    return state.setsWonA === cfg.setsToWin - 1 && state.setsWonB === cfg.setsToWin - 1;
  }

  function closeSet(winner, viaSuperTiebreak) {
    state.completedSets.push({
      gamesA: state.currentSet.gamesA,
      gamesB: state.currentSet.gamesB,
      superTiebreak: viaSuperTiebreak,
    });
    if (winner === 'A') state.setsWonA += 1; else state.setsWonB += 1;
    state.currentSet = { gamesA: 0, gamesB: 0 };

    if (state.setsWonA >= cfg.setsToWin || state.setsWonB >= cfg.setsToWin) {
      state.matchOver = true;
      state.winner = state.setsWonA > state.setsWonB ? 'A' : 'B';
      return;
    }
    // Alterna quién saca primero el próximo set
    state.firstServerOfSet = otherTeam(state.firstServerOfSet);
    state.server = state.firstServerOfSet;
    serverAtGameStart = state.server;

    // Si el set que arranca es el decisivo y el partido usa súper tie-break
    // como definición, ese set se juega ENTERO como un tie-break a 10 (o el
    // valor configurado), sin jugar games previos.
    if (cfg.superTiebreakDecider && isDecidingSetNow()) {
      state.inTiebreak = true;
      state.isSuperTiebreakNow = true;
      tiebreakInitialServer = state.server;
    }
  }

  let tiebreakInitialServer = null;

  for (const ev of events) {
    if (state.matchOver) break;
    state.lastEventTeam = ev.team;

    const pointServer = state.inTiebreak
      ? tiebreakServerAt(state.tiebreakA + state.tiebreakB + 1, tiebreakInitialServer)
      : state.server;
    state.pointLog.push({ team: ev.team, t: ev.t, server: pointServer });

    if (state.inTiebreak) {
      if (ev.team === 'A') state.tiebreakA += 1; else state.tiebreakB += 1;
      const target = state.isSuperTiebreakNow ? cfg.superTiebreakPoints : cfg.tiebreakPoints;
      const brEval = evaluateBreak(state.tiebreakA, state.tiebreakB, target);
      if (brEval.over) {
        finishGame(brEval.winner, true, state.isSuperTiebreakNow);
      }
      continue;
    }

    if (ev.team === 'A') state.gamePointsA += 1; else state.gamePointsB += 1;
    const gEval = evaluateGame(state.gamePointsA, state.gamePointsB, cfg.noAd);
    if (gEval.over) {
      finishGame(gEval.winner, false, false);
    }
  }

  // Quién saca el PRÓXIMO punto (para el indicador en pantalla), respetando
  // la rotación punto a punto dentro de un tie-break.
  const liveServer = state.inTiebreak
    ? tiebreakServerAt(state.tiebreakA + state.tiebreakB + 1, tiebreakInitialServer)
    : state.server;

  // ---- Estadísticas del partido, calculadas a partir del registro de puntos ----
  let pointsWonA = 0, pointsWonB = 0;
  let servePlayedA = 0, serveWonA = 0, servePlayedB = 0, serveWonB = 0;
  let streakTeam = null, streakCount = 0, longestStreak = { team: null, count: 0 };

  for (const p of state.pointLog) {
    if (p.team === 'A') pointsWonA += 1; else pointsWonB += 1;

    if (p.server === 'A') {
      servePlayedA += 1;
      if (p.team === 'A') serveWonA += 1;
    } else {
      servePlayedB += 1;
      if (p.team === 'B') serveWonB += 1;
    }

    if (p.team === streakTeam) streakCount += 1;
    else { streakTeam = p.team; streakCount = 1; }
    if (streakCount > longestStreak.count) longestStreak = { team: streakTeam, count: streakCount };
  }

  state.stats = {
    totalPoints: state.pointLog.length,
    pointsWonA, pointsWonB,
    servePctA: servePlayedA ? Math.round((serveWonA / servePlayedA) * 100) : null,
    servePctB: servePlayedB ? Math.round((serveWonB / servePlayedB) * 100) : null,
    servePlayedA, serveWonA, servePlayedB, serveWonB,
    longestStreak,
    avgPointsPerGame: state.gameLog.length ? Math.round((state.pointLog.length / state.gameLog.length) * 10) / 10 : null,
  };

  state.endedAt = state.matchOver && state.pointLog.length ? state.pointLog[state.pointLog.length - 1].t : null;

  // Etiquetas para mostrar en pantalla
  state.display = {
    pointA: state.inTiebreak ? String(state.tiebreakA) : pointLabel(state.gamePointsA, state.gamePointsB, cfg.noAd),
    pointB: state.inTiebreak ? String(state.tiebreakB) : pointLabel(state.gamePointsB, state.gamePointsA, cfg.noAd),
    gamesA: state.currentSet.gamesA,
    gamesB: state.currentSet.gamesB,
    setsA: state.setsWonA,
    setsB: state.setsWonB,
    server: liveServer,
    inTiebreak: state.inTiebreak,
    isSuperTiebreak: state.isSuperTiebreakNow,
    goldenPoint: !state.inTiebreak && cfg.noAd && state.gamePointsA >= 3 && state.gamePointsA === state.gamePointsB,
  };

  return state;
}

function evaluateSet(gamesA, gamesB, cfg) {
  const N = cfg.gamesPerSet;
  if (gamesA === N && gamesB === N) return { triggerTiebreak: true };
  if ((gamesA >= N || gamesB >= N) && Math.abs(gamesA - gamesB) >= 2) {
    return { over: true, winner: gamesA > gamesB ? 'A' : 'B' };
  }
  return { over: false };
}

export function describeConfig(cfg) {
  const c = defaultConfig(cfg);
  if (c.mode === 'games') {
    return `A ${c.gamesPerSet} games${c.noAd ? ', punto de oro' : ''}`;
  }
  const bestOf = c.setsToWin === 1 ? '1 set' : c.setsToWin === 2 ? 'mejor de 3 sets' : 'mejor de 5 sets';
  const parts = [bestOf, `games a ${c.gamesPerSet}`];
  if (c.noAd) parts.push('punto de oro');
  if (c.superTiebreakDecider && c.setsToWin > 1) parts.push('set decisivo a súper tie-break');
  return parts.join(' · ');
}
