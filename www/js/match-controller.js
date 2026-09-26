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

  let state = replayMatch(config, events);
  const listeners = new Set();

  function notify() {
    for (const cb of listeners) cb(state, teamNames);
  }

  function persist(finalize) {
    const record = {
      id: meta.id,
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

  function addPoint(team) {
    if (state.matchOver) return;
    const prev = state;
    events.push({ team, t: Date.now() });
    state = replayMatch(config, events);

    if (announcer) {
      if (state.matchOver) {
        announcer.announceMatchOver(state.winner, teamNames);
      } else if (state.completedSets.length > prev.completedSets.length) {
        const closed = state.completedSets[state.completedSets.length - 1];
        const setWinner = closed.gamesA > closed.gamesB ? 'A' : 'B';
        announcer.announceSet(setWinner, { a: closed.gamesA, b: closed.gamesB }, state.display, teamNames);
      } else if (state.gameLog.length > prev.gameLog.length) {
        const g = state.gameLog[state.gameLog.length - 1];
        announcer.announceGame(g.winner, state.display, teamNames);
      } else {
        announcer.announcePoint(state.display, teamNames);
      }
    }

    persist(false);
    notify();
  }

  function undo() {
    if (events.length === 0) return;
    events.pop();
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

  return { addPoint, undo, undoLastForTeam, finalizeAndSave, getState, subscribe, teamNames, config };
}

/** Reconstruye un controlador a partir de un partido guardado en curso. */
export function resumeMatchController(record) {
  const meta = {
    id: record.id,
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
