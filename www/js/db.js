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
export const saveClubName = (name) => upsertName('clubs', name);
export const listClubNames = () => listNames('clubs');
export const saveCourtName = (name) => upsertName('courts', name);
export const listCourtNames = () => listNames('courts');

export async function deletePlayerName(name) {
  return tx('players', 'readwrite', (store) => store.delete(name));
}

const SEED_PLAYERS = [
  'Juan Pérez', 'Pedro Gómez', 'Lucas Fernández', 'Mateo Sosa',
  'Martín Díaz', 'Nicolás Romero', 'Federico López', 'Santiago Torres',
];

/** Precarga una lista inicial de jugadores, solo si todavía no hay ninguno. */
export async function seedDefaultPlayersIfEmpty() {
  const existing = await listPlayerNames();
  if (existing.length > 0) return;
  await Promise.all(SEED_PLAYERS.map((name, i) =>
    tx('players', 'readwrite', (store) => store.put({ name, lastUsed: i }))
  ));
}
