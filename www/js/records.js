// Récords y ranking interno, calculados a partir de los partidos guardados.
// Función pura (sin DOM): recorre los partidos terminados con ganador y arma,
// para cada pareja y cada jugador, cuántos jugó/ganó/perdió, contra quién,
// rachas y estadísticas de saque y tie-break.

import { replayMatch } from './scoring-engine.js';

// Puntos del ranking interno. Se ajustan acá, en un solo lugar.
export const POINTS_WIN = 3;
export const POINTS_LOSS = 1; // suma por jugar, para premiar la constancia

function clean(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function keyOf(name) {
  return clean(name).toLowerCase();
}

function membersOf(team) {
  return [team?.p1, team?.p2].map(clean).filter(Boolean);
}

function makeEntity(key, name, members) {
  return {
    key, name, members,
    played: 0, won: 0, lost: 0, points: 0, winPct: 0,
    lastPlayed: 0,
    streak: 0, bestStreak: 0, // racha de victorias actual y mejor
    beat: new Map(), // rival -> { name, count }   (a quién le ganó)
    lostTo: new Map(), // rival -> { name, count }  (contra quién perdió)
    partners: new Map(), // solo jugadores: compañero -> { name, won, lost }
    // Tantos según quién saca. En pádel se sabe qué PAREJA saca, no qué
    // jugador, así que cada jugador hereda los números de su pareja.
    serve: { played: 0, won: 0 },
    receive: { played: 0, won: 0 },
    tiebreakPoints: { played: 0, won: 0 },
    tiebreaks: { won: 0, lost: 0 },
  };
}

function bump(map, key, name, field) {
  const cur = map.get(key) || { name, count: 0, won: 0, lost: 0 };
  if (field) cur[field] += 1; else cur.count += 1;
  map.set(key, cur);
}

function outcome(entity, won, when) {
  entity.played += 1;
  if (won) {
    entity.won += 1; entity.points += POINTS_WIN;
    entity.streak += 1;
    entity.bestStreak = Math.max(entity.bestStreak, entity.streak);
  } else {
    entity.lost += 1; entity.points += POINTS_LOSS;
    entity.streak = 0;
  }
  entity.lastPlayed = Math.max(entity.lastPlayed, when || 0);
}

function addMatchStats(entity, side, replayed) {
  for (const p of replayed.pointLog) {
    const mine = p.team === side ? 1 : 0;
    if (p.tiebreak) {
      entity.tiebreakPoints.played += 1;
      entity.tiebreakPoints.won += mine;
    } else if (p.server === side) {
      entity.serve.played += 1;
      entity.serve.won += mine;
    } else {
      entity.receive.played += 1;
      entity.receive.won += mine;
    }
  }
  for (const g of replayed.gameLog) {
    if (!g.tiebreak) continue;
    if (g.winner === side) entity.tiebreaks.won += 1; else entity.tiebreaks.lost += 1;
  }
}

function rank(list) {
  for (const e of list) e.winPct = e.played ? Math.round((e.won / e.played) * 100) : 0;
  return list.sort((a, b) =>
    b.points - a.points || b.winPct - a.winPct || b.played - a.played || a.name.localeCompare(b.name, 'es'));
}

/** Porcentaje entero, o null si no hay datos. */
export function pct(part) {
  return part.played ? Math.round((part.won / part.played) * 100) : null;
}

/** Lista ordenada de rivales: [{name, count}], más frecuentes primero. */
export function topList(map) {
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es'));
}

// ---------- Períodos para filtrar el ranking ----------

export const PERIODS = [
  { id: 'all', label: 'Todo' },
  { id: 'month', label: 'Este mes' },
  { id: 'lastmonth', label: 'Mes anterior' },
  { id: 'year', label: 'Este año' },
];

/** Rango [from, to) en ms para un período; null = sin límite. */
export function periodRange(id, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  if (id === 'month') return { from: new Date(y, m, 1).getTime(), to: new Date(y, m + 1, 1).getTime() };
  if (id === 'lastmonth') return { from: new Date(y, m - 1, 1).getTime(), to: new Date(y, m, 1).getTime() };
  if (id === 'year') return { from: new Date(y, 0, 1).getTime(), to: new Date(y + 1, 0, 1).getTime() };
  return { from: null, to: null };
}

function whenOf(m) {
  return m.endedAt || m.startedAt || 0;
}

export function computeRecords(matches, period = { from: null, to: null }) {
  const pairs = new Map();
  const players = new Map();

  // Orden cronológico: hace falta para calcular las rachas.
  const ordered = matches
    .filter((m) => m.finalState?.winner)
    .filter((m) => (period.from === null || whenOf(m) >= period.from) && (period.to === null || whenOf(m) < period.to))
    .sort((a, b) => whenOf(a) - whenOf(b));

  for (const m of ordered) {
    const winner = m.finalState.winner;
    const teams = { A: membersOf(m.teams?.A), B: membersOf(m.teams?.B) };
    if (!teams.A.length || !teams.B.length) continue;
    const when = whenOf(m);
    const replayed = m.events?.length ? replayMatch(m.config, m.events) : null;

    const info = {};
    for (const side of ['A', 'B']) {
      const sorted = [...teams[side]].sort((x, y) => keyOf(x).localeCompare(keyOf(y)));
      info[side] = {
        members: teams[side],
        pairKey: sorted.map(keyOf).join('|'),
        pairName: teams[side].join(' / '),
      };
    }

    for (const side of ['A', 'B']) {
      const mine = info[side];
      const rival = info[side === 'A' ? 'B' : 'A'];
      const won = winner === side;

      if (mine.members.length === 2) {
        if (!pairs.has(mine.pairKey)) pairs.set(mine.pairKey, makeEntity(mine.pairKey, mine.pairName, mine.members));
        const pair = pairs.get(mine.pairKey);
        outcome(pair, won, when);
        bump(won ? pair.beat : pair.lostTo, rival.pairKey, rival.pairName);
        if (replayed) addMatchStats(pair, side, replayed);
      }

      for (const p of mine.members) {
        const k = keyOf(p);
        if (!players.has(k)) players.set(k, makeEntity(k, p, [p]));
        const ent = players.get(k);
        outcome(ent, won, when);
        for (const r of rival.members) bump(won ? ent.beat : ent.lostTo, keyOf(r), r);
        for (const mate of mine.members) {
          if (mate === p) continue;
          bump(ent.partners, keyOf(mate), mate, won ? 'won' : 'lost');
        }
        if (replayed) addMatchStats(ent, side, replayed);
      }
    }
  }

  return {
    pairs: rank([...pairs.values()]),
    players: rank([...players.values()]),
  };
}
