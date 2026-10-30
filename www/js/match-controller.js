import { replayMatch, defaultConfig } from './scoring-engine.js';
import { saveMatch } from './db.js';
import { createAnnouncer } from './tts.js';

function teamLabel(names) {
  const parts = [names.p1, names.p2].filter(Boolean);
  return parts.length ? parts.join(' / ') : 'Sin nombre';
}

/**
 * meta: {
 *   id, sport, config, club, court, category,
 *   teams: { A: {p1, p2}, B: {p1, p2} },
 *   voiceLevel: 'full' | 'simple' | 'off'
 * }
 * resumeEvents: eventos ya jugados de un partido guardado (para continuar
 * un partido que quedó en curso al cerrar la app).
 */
export function createMatchController(meta, resumeEvents) {
  const events = resumeEvents ? resumeEvents.slice() : [];
  const config = defaultConfig(meta.config);
  const teamNames = { A: teamLabel(meta.teams.A), B: teamLabel(meta.teams.B) };
  const announcer = meta.voiceLevel !== 'off' ? createAnnouncer(meta.voiceLevel) : null;

  // Quién saca se fija con el primer tanto y no cambia si después se resta ese
  // tanto (si no, restarle un punto al que saca le pasaba el saque al otro).
  // Si todavía no se había elegido, se resuelve al primer tanto y se suelta si
  // se deshace hasta quedar en 0.
  let serverInferred = false;
  if (!config.firstServer && events.length) {
    config.firstServer = events[0].team;
    serverInferred = true;
  }
  let state = replayMatch(config, events);
  function releaseInferredServer() {
    if (serverInferred && !events.length) { config.firstServer = null; serverInferred = false; }
  }
  const listeners = new Set();

  function notify() {
    for (const cb of listeners) cb(state, teamNames);
  }

  function persist(finalize) {
    const record = {
      id: meta.id,
      sessionId: meta.sessionId || null,
      firstSlot: meta.firstSlot || { A: 'p1', B: 'p1' },
      sport: meta.sport,
      config,
      club: meta.club || '',
      court: meta.court || '',
      category: meta.category || '',
      teams: meta.teams,
      teamNames,
      voiceLevel: meta.voiceLevel,
      startedAt: events.length ? events[0].t : Date.now(),
      updatedAt: Date.now(),
      endedAt: finalize ? (state.endedAt || Date.now()) : null,
      inProgress: !finalize,
      events: events.slice(), // registro completo del partido, tanto por tanto
      finalState: finalize
        ? {
            winner: state.winner,
            setsA: state.setsWonA,
            setsB: state.setsWonB,
            completedSets: state.completedSets,
            breaksA: state.breaksA,
            breaksB: state.breaksB,
            gameLog: state.gameLog,
          }
        : null,
      pointCount: events.length,
    };
    saveMatch(record).catch(() => {});
    return record;
  }

  /** Quién saca ahora: el jugador que toca si la pareja tiene dos, si no el nombre de la pareja.
   * Los dos se alternan en cada game que saca su pareja, empezando por el elegido al arrancar. */
  function serverName(team) {
    const t = meta.teams[team];
    if (!(t.p1 && t.p2)) return teamNames[team];
    const first = meta.firstSlot?.[team] || 'p1';
    const served = state.gameLog.filter((g) => g.server === team).length;
    return t[served % 2 === 0 ? first : (first === 'p1' ? 'p2' : 'p1')];
  }

  /** "Saca X" para pegar al anuncio de game/set (solo con el anuncio completo). */
  function serveNote() {
    const server = state.display.server;
    return meta.voiceLevel === 'full' && server ? `Saca ${serverName(server)}` : '';
  }

  function addPoint(team) {
    if (state.matchOver) return;
    const prev = state;
    if (!config.firstServer) { config.firstServer = team; serverInferred = true; }
    events.push({ team, t: Date.now() });
    state = replayMatch(config, events);

    if (announcer) {
      if (state.matchOver) {
        announcer.announceMatchOver(state.winner, teamNames);
      } else if (state.completedSets.length > prev.completedSets.length) {
        const closed = state.completedSets[state.completedSets.length - 1];
        const setWinner = closed.gamesA > closed.gamesB ? 'A' : 'B';
        announcer.announceSet(setWinner, { a: closed.gamesA, b: closed.gamesB }, state.display, teamNames, serveNote());
      } else if (state.gameLog.length > prev.gameLog.length) {
        const g = state.gameLog[state.gameLog.length - 1];
        announcer.announceGame(g.winner, state.display, teamNames, serveNote());
      } else {
        announcer.announcePoint(state.display, teamNames);
      }
    }

    persist(false);
    notify();
  }

  /** Define quién saca el primer game, sin sumar tanto. Solo vale antes del
   * primer tanto. No se persiste acá: se guarda con el primer tanto (config
   * ya lleva firstServer), así no queda un partido "en curso" vacío. */
  function setFirstServer(team) {
    if (events.length) return;
    config.firstServer = team;
    state = replayMatch(config, events);
    announcer?.say(`Saca ${serverName(team)}`);
    notify();
  }

  function undo() {
    if (events.length === 0) return;
    events.pop();
    releaseInferredServer();
    state = replayMatch(config, events);
    persist(false);
    notify();
  }

  /** Resta el último tanto anotado específicamente por ese equipo, aunque el
   * otro equipo haya sumado puntos después. Usado por el doble click del
   * control remoto en el botón de un equipo. */
  function undoLastForTeam(team) {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].team === team) {
        events.splice(i, 1);
        releaseInferredServer();
        state = replayMatch(config, events);
        persist(false);
        notify();
        return;
      }
    }
  }

  function finalizeAndSave() {
    if (!state.matchOver && events.length) {
      // Partido cortado manualmente: se guarda igual con lo jugado hasta acá.
      state = { ...state, endedAt: Date.now() };
    }
    return persist(true);
  }

  function getState() {
    return { state, teamNames, config, events };
  }

  function subscribe(cb) {
    listeners.add(cb);
    cb(state, teamNames);
    return () => listeners.delete(cb);
  }

  return { id: meta.id, sessionId: meta.sessionId || null, addPoint, setFirstServer, undo, undoLastForTeam, finalizeAndSave, getState, subscribe, teamNames, config };
}

/** Reconstruye un controlador a partir de un partido guardado en curso. */
export function resumeMatchController(record) {
  const meta = {
    id: record.id,
    sessionId: record.sessionId,
    firstSlot: record.firstSlot,
    sport: record.sport,
    config: record.config,
    club: record.club,
    court: record.court,
    category: record.category,
    teams: record.teams,
    voiceLevel: record.voiceLevel || 'off',
  };
  return createMatchController(meta, record.events || []);
}
