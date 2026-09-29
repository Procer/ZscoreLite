// Capa de almacenamiento local (IndexedDB). Todo el registro del partido vive
// acá: nada sale del dispositivo salvo que el usuario exporte/comparta manualmente.

const DB_NAME = 'zscore-lite';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('matches')) {
        const store = db.createObjectStore('matches', { keyPath: 'id' });
        store.createIndex('byDate', 'startedAt');
      }
      if (!db.objectStoreNames.contains('players')) {
        db.createObjectStore('players', { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains('clubs')) {
        db.createObjectStore('clubs', { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains('courts')) {
        db.createObjectStore('courts', { keyPath: 'name' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const result = fn(store);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
  });
}

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveMatch(match) {
  await tx('matches', 'readwrite', (store) => store.put(match));
  return match;
}

export async function getMatch(id) {
  return tx('matches', 'readonly', (store) => requestToPromise(store.get(id))).then((p) => p);
}

export async function listMatches() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('matches', 'readonly');
    const store = transaction.objectStore('matches');
    const req = store.getAll();
    req.onsuccess = () => {
      const all = req.result || [];
      all.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      resolve(all);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteMatch(id) {
  return tx('matches', 'readwrite', (store) => store.delete(id));
}

/** Partido en curso más reciente (para ofrecer "continuar" al abrir la app). */
export async function getInProgressMatch() {
  const all = await listMatches();
  return all.find((m) => m.inProgress) || null;
}

/** Último partido terminado (para el acceso rápido "ver partido anterior"). */
export async function getLastFinishedMatch() {
  const all = await listMatches();
  return all.find((m) => !m.inProgress && m.finalState) || null;
}

async function upsertName(storeName, name) {
  const clean = (name || '').trim();
  if (!clean) return;
  await tx(storeName, 'readwrite', (store) => {
    store.put({ name: clean, lastUsed: Date.now() });
  });
}

async function listNames(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => {
      const all = req.result || [];
      all.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
      resolve(all.map((r) => r.name));
    };
    req.onerror = () => reject(req.error);
  });
}

export const savePlayerName = (name) => upsertName('players', name);
export const listPlayerNames = () => listNames('players');

export async function deletePlayerName(name) {
  return tx('players', 'readwrite', (store) => store.delete(name));
}

// ---------- Copia de seguridad ----------

export async function exportBackup() {
  const matches = await listMatches();
  const players = await listPlayerNames();
  return {
    app: 'zscore-lite',
    version: 1,
    exportedAt: Date.now(),
    matches,
    players,
  };
}

/** Suma los partidos y jugadores del archivo a los existentes (mismo id = se pisa). */
export async function importBackup(data) {
  if (!data || data.app !== 'zscore-lite' || !Array.isArray(data.matches)) {
    throw new Error('El archivo no es una copia de seguridad de Z-Score Lite.');
  }
  let matches = 0;
  for (const m of data.matches) {
    if (!m || !m.id) continue;
    await saveMatch(m);
    matches += 1;
  }
  for (const name of data.players || []) await savePlayerName(name);
  return { matches };
}

// ---------- Editar jugadores ----------

function cleanName(n) { return String(n || '').trim().replace(/\s+/g, ' '); }

/** Cambia el nombre de un jugador en TODOS los partidos. Si el nombre nuevo ya
 * existe, los dos quedan fusionados en uno solo. Devuelve cuántos partidos tocó. */
export async function renamePlayer(oldName, newName) {
  const from = cleanName(oldName).toLowerCase();
  const to = cleanName(newName);
  if (!from || !to) throw new Error('Falta el nombre.');
  const matches = await listMatches();
  let touched = 0;
  for (const m of matches) {
    let changed = false;
    for (const side of ['A', 'B']) {
      const team = m.teams?.[side];
      if (!team) continue;
      for (const slot of ['p1', 'p2']) {
        if (cleanName(team[slot]).toLowerCase() === from) { team[slot] = to; changed = true; }
      }
      if (changed) {
        const parts = [team.p1, team.p2].filter(Boolean);
        m.teamNames = { ...m.teamNames, [side]: parts.length ? parts.join(' / ') : 'Sin nombre' };
      }
    }
    if (changed) { await saveMatch(m); touched += 1; }
  }
  // Lista de nombres para autocompletar
  const all = await listPlayerNames();
  for (const n of all) if (cleanName(n).toLowerCase() === from) await deletePlayerName(n);
  await savePlayerName(to);
  return touched;
}
