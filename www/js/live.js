// Transmisión en vivo del partido: el marcador publica su estado en el
// servidor (server/live-server.cjs) y el público lo sigue desde un link.
// Solo se manda lo que el visor necesita (puntaje, nombres, sets).

const SESSION_KEY = 'zscoreLiveSession';
const HEARTBEAT_MS = 20000;

let session = null; // { matchId, code, token }
let controller = null;
let unsubscribe = null;
let heartbeat = null;
let inFlight = false;
let dirty = false;
let lastState = null;
let status = 'off'; // 'off' | 'on' | 'offline'
const listeners = new Set();

function emit() {
  for (const cb of listeners) cb(getLiveInfo());
}

export function onLiveChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getLiveInfo() {
  return {
    active: !!session,
    status,
    code: session?.code || null,
    url: session ? viewerUrl(session.code) : null,
  };
}

export function viewerUrl(code) {
  return `${location.origin}/ver.html?c=${code}`;
}

function readSaved() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; }
}

function save() {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch (e) { /* sin almacenamiento */ }
}

function buildSnapshot(state, teamNames) {
  const lastGame = state.gameLog[state.gameLog.length - 1];
  const lastSet = state.completedSets[state.completedSets.length - 1];
  return {
    names: { A: teamNames.A, B: teamNames.B },
    display: state.display,
    completedSets: state.completedSets.map((s) => ({ gamesA: s.gamesA, gamesB: s.gamesB })),
    counts: { games: state.gameLog.length, sets: state.completedSets.length },
    lastGameWinner: lastGame ? lastGame.winner : null,
    lastSetWinner: lastSet ? (lastSet.gamesA > lastSet.gamesB ? 'A' : 'B') : null,
    matchOver: state.matchOver,
    winner: state.winner,
    startedAt: state.startedAt,
  };
}

async function push() {
  if (!session || !lastState) return;
  if (inFlight) { dirty = true; return; }
  inFlight = true;
  dirty = false;
  try {
    const res = await fetch(`/api/live/${session.code}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-token': session.token },
      body: JSON.stringify(buildSnapshot(lastState.state, lastState.teamNames)),
      keepalive: true,
    });
    if (res.status === 404 || res.status === 403) {
      // El servidor ya no conoce esta transmisión (se venció): se crea otra.
      await createSession(session.matchId);
    } else {
      status = res.ok ? 'on' : 'offline';
    }
  } catch (e) {
    status = 'offline';
  } finally {
    inFlight = false;
    emit();
    if (dirty) push();
  }
}

async function createSession(matchId) {
  const res = await fetch('/api/live', { method: 'POST' });
  if (!res.ok) throw new Error(res.status === 429 ? 'Demasiadas transmisiones seguidas. Probá en un rato.' : 'El servidor no pudo crear la transmisión.');
  const { code, token } = await res.json();
  session = { matchId, code, token };
  save();
}

/** Empieza (o retoma) la transmisión del partido. Devuelve { code, url }. */
export async function startLive(matchController) {
  if (session && controller === matchController) return getLiveInfo();
  await stopLocalOnly();
  session = null;
  controller = matchController;

  const saved = readSaved();
  if (saved && saved.matchId !== matchController.id) {
    // Quedó una transmisión de otro partido: se cierra en el servidor.
    fetch(`/api/live/${saved.code}`, { method: 'DELETE', headers: { 'x-token': saved.token } }).catch(() => {});
  }
  if (saved && saved.matchId === matchController.id) {
    // Mismo partido retomado: se sigue con el mismo link.
    const ok = await fetch(`/api/live/${saved.code}`).then((r) => r.ok).catch(() => false);
    if (ok) session = saved;
  }
  if (!session) {
    try {
      await createSession(matchController.id);
    } catch (e) {
      controller = null;
      throw new Error(e.message === 'Failed to fetch' ? 'Sin conexión a internet.' : e.message);
    }
  }
  status = 'on';
  unsubscribe = controller.subscribe((state, teamNames) => {
    lastState = { state, teamNames };
    push();
  });
  heartbeat = setInterval(push, HEARTBEAT_MS);
  window.addEventListener('online', push);
  emit();
  return getLiveInfo();
}

async function stopLocalOnly() {
  if (unsubscribe) unsubscribe();
  if (heartbeat) clearInterval(heartbeat);
  window.removeEventListener('online', push);
  unsubscribe = null;
  heartbeat = null;
  lastState = null;
  controller = null;
}

/** Corta la transmisión (el link deja de funcionar). */
export async function stopLive() {
  const old = session;
  await stopLocalOnly();
  session = null;
  status = 'off';
  save();
  emit();
  if (old) {
    try {
      await fetch(`/api/live/${old.code}`, { method: 'DELETE', headers: { 'x-token': old.token }, keepalive: true });
    } catch (e) { /* si no hay red, el servidor la borra solo al rato */ }
  }
}

/** El partido terminó: se avisa al público y se suelta la sesión. */
export async function finishLive() {
  if (!session) return;
  // Un último envío con el resultado final; el link sigue mostrando el final.
  await push();
  await stopLocalOnly();
  session = null;
  status = 'off';
  save();
  emit();
}
