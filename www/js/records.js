// Récords y ranking interno, calculados a partir de los partidos guardados.
// Función pura (sin DOM): recorre los partidos terminados con ganador y arma,
// para cada pareja y cada jugador, cuántos jugó/ganó/perdió y contra quién.

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
    beat: new Map(), // rival -> { name, count }   (a quién le ganó)
    lostTo: new Map(), // rival -> { name, count }  (contra quién perdió)
    partners: new Map(), // solo jugadores: compañero -> { name, won, lost }
  };
}

function bump(map, key, name, field) {
  const cur = map.get(key) || { name, count: 0, won: 0, lost: 0 };
  if (field) cur[field] += 1; else cur.count += 1;
  map.set(key, cur);
}

function record(entity, won, when, rivalKey, rivalName) {
  entity.played += 1;
  if (won) { entity.won += 1; entity.points += POINTS_WIN; bump(entity.beat, rivalKey, rivalName); }
  else { entity.lost += 1; entity.points += POINTS_LOSS; bump(entity.lostTo, rivalKey, rivalName); }
  entity.lastPlayed = Math.max(entity.lastPlayed, when || 0);
}

function rank(list) {
  for (const e of list) e.winPct = e.played ? Math.round((e.won / e.played) * 100) : 0;
  return list.sort((a, b) =>
    b.points - a.points || b.winPct - a.winPct || b.played - a.played || a.name.localeCompare(b.name, 'es'));
}

/** Lista ordenada de ejemplos de rivales: [{name, count}], más frecuentes primero. */
export function topList(map) {
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es'));
}

export function computeRecords(matches) {
  const pairs = new Map();
  const players = new Map();

  for (const m of matches) {
    const winner = m.finalState?.winner;
    if (!winner) continue; // en curso o cortado sin ganador: no cuenta
    const teams = { A: membersOf(m.teams?.A), B: membersOf(m.teams?.B) };
    if (!teams.A.length || !teams.B.length) continue;
    const when = m.endedAt || m.startedAt || 0;

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
        record(pairs.get(mine.pairKey), won, when, rival.pairKey, rival.pairName);
      }

      for (const p of mine.members) {
        const k = keyOf(p);
        if (!players.has(k)) players.set(k, makeEntity(k, p, [p]));
        const ent = players.get(k);
        // Un jugador cuenta el partido una sola vez; sus rivales, uno por uno.
        ent.played += 1;
        if (won) { ent.won += 1; ent.points += POINTS_WIN; } else { ent.lost += 1; ent.points += POINTS_LOSS; }
        ent.lastPlayed = Math.max(ent.lastPlayed, when);
        for (const r of rival.members) bump(won ? ent.beat : ent.lostTo, keyOf(r), r);
        for (const mate of mine.members) {
          if (mate === p) continue;
          bump(ent.partners, keyOf(mate), mate, won ? 'won' : 'lost');
        }
      }
    }
  }

  return {
    pairs: rank([...pairs.values()]),
    players: rank([...players.values()]),
  };
}
