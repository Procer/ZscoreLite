// Licencia de Z-Score Lite: el servidor entrega un token firmado (ECDSA P-256)
// y la app lo verifica sin internet con la clave pública de abajo.
//
// Token = base64url(JSON) + '.' + base64url(firma r||s de 64 bytes)
// JSON  = { v, code, type: 'paga'|'cortesia'|'prueba', dev, iat, exp }  (exp en ms; null = no vence)
//
// Estados: 'off' (control apagado) | 'none' (sin licencia) | 'active' | 'expiring' | 'grace' | 'blocked'

// Interruptor: con false la app funciona como siempre, sin pedir licencia.
// Pasarlo a true recién cuando el servicio de licencias esté instalado y probado.
export const LICENSE_REQUIRED = false;

export const GRACE_DAYS = 3;
export const WARN_DAYS = 5; // desde cuántos días antes de vencer se avisa
const RENEW_DAYS = 10; // desde cuántos días antes de vencer se intenta renovar en silencio
const DAY = 86400000;

const PUBLIC_KEY_B64 =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEVZY7ccSBG7BzrwLKkx+M0WS+AyeEBdnUzvo9qWPJE4v4Vsw+MuWOoxgbtqaTeSGU96ajc9OHnDYeycSkidcmgw==';

const STORE_KEY = 'zscoreLiteLicense';
const SEEN_KEY = 'zscoreLiteLicenseSeen'; // última hora vista: evita "atrasar el reloj" para no vencer

const ERROR_TEXT = {
  codigo: 'Ese código no existe. Revisalo y probá de nuevo.',
  en_uso: 'Ese código ya está activado en otro dispositivo.',
  vencida: 'Esa licencia está vencida.',
  revocada: 'Esa licencia fue dada de baja.',
  demasiados: 'Demasiados intentos. Probá de nuevo en una hora.',
  red: 'No hay conexión con el servidor. Probá de nuevo con internet.',
};

function b64ToBytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

let keyPromise = null;
function getKey() {
  keyPromise = keyPromise || crypto.subtle.importKey(
    'spki', b64ToBytes(PUBLIC_KEY_B64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return keyPromise;
}

/** Devuelve el contenido del token si la firma es válida; si no, null. */
export async function verifyToken(token) {
  try {
    const [body, sig] = String(token).split('.');
    if (!body || !sig) return null;
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, await getKey(), b64ToBytes(sig), new TextEncoder().encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64ToBytes(body)));
    return payload && payload.v === 1 ? payload : null;
  } catch (e) {
    return null;
  }
}

function read() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { return null; }
}

function write(data) {
  try {
    if (data) localStorage.setItem(STORE_KEY, JSON.stringify(data));
    else localStorage.removeItem(STORE_KEY);
  } catch (e) { /* sin almacenamiento */ }
}

/** Hora "confiable": nunca va hacia atrás respecto de la última vez que se vio. */
function now() {
  let seen = 0;
  try { seen = Number(localStorage.getItem(SEEN_KEY)) || 0; } catch (e) { /* nada */ }
  const t = Math.max(Date.now(), seen);
  try { localStorage.setItem(SEEN_KEY, String(t)); } catch (e) { /* nada */ }
  return t;
}

function deviceId() {
  const saved = read();
  return saved?.device || crypto.randomUUID();
}

let current = { status: LICENSE_REQUIRED ? 'none' : 'off', info: null };
const listeners = new Set();

export function onLicenseChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getLicense() {
  return current;
}

/** ¿Hay que frenar el uso normal (nuevo partido, etc.)? */
export function isBlocked() {
  return LICENSE_REQUIRED && (current.status === 'none' || current.status === 'blocked');
}

function setCurrent(next) {
  current = next;
  for (const cb of listeners) cb(current);
}

/** Calcula el estado a partir de lo guardado (sin internet). */
export async function evaluate() {
  const saved = read();
  if (!saved?.token) {
    setCurrent({ status: LICENSE_REQUIRED ? 'none' : 'off', info: null });
    return current;
  }
  const payload = await verifyToken(saved.token);
  if (!payload || payload.dev !== saved.device) {
    setCurrent({ status: LICENSE_REQUIRED ? 'none' : 'off', info: null });
    return current;
  }
  const t = now();
  const info = { type: payload.type, code: payload.code, exp: payload.exp, daysLeft: null, graceLeft: null };
  let status = 'active';
  if (payload.exp != null) {
    info.daysLeft = Math.ceil((payload.exp - t) / DAY);
    if (t <= payload.exp) {
      status = info.daysLeft <= WARN_DAYS ? 'expiring' : 'active';
    } else {
      info.graceLeft = Math.ceil((payload.exp + GRACE_DAYS * DAY - t) / DAY);
      status = info.graceLeft > 0 ? 'grace' : 'blocked';
    }
  }
  setCurrent({ status, info });
  return current;
}

async function post(path, body) {
  let res;
  try {
    res = await fetch(`/api/license/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: 'red' };
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* respuesta sin cuerpo */ }
  if (res.ok) return { ok: true, ...data };
  return { ok: false, error: data.error || (res.status >= 500 ? 'red' : 'codigo') };
}

/** Activa este dispositivo con un código ZSL-XXXX-XXXX. */
export async function activate(rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!/^ZSL-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
    return { ok: false, message: 'El código tiene el formato ZSL-XXXX-XXXX.' };
  }
  const device = deviceId();
  const r = await post('activar', { code, device });
  if (!r.ok) return { ok: false, message: ERROR_TEXT[r.error] || ERROR_TEXT.codigo };
  const payload = await verifyToken(r.token);
  if (!payload || payload.dev !== device) return { ok: false, message: 'El servidor devolvió una licencia inválida.' };
  write({ token: r.token, device, code });
  await evaluate();
  return { ok: true };
}

/** Pide un token nuevo (silencioso). Si falla, se sigue con el token actual. */
export async function renew({ force = false } = {}) {
  const saved = read();
  if (!saved?.token) return false;
  const payload = await verifyToken(saved.token);
  if (!payload || payload.exp == null) return false; // las cortesías no vencen
  if (!force && payload.exp - now() > RENEW_DAYS * DAY) return false;
  const r = await post('renovar', { token: saved.token, device: saved.device });
  if (!r.ok) return false;
  const fresh = await verifyToken(r.token);
  if (!fresh || fresh.dev !== saved.device) return false;
  write({ ...saved, token: r.token });
  await evaluate();
  return true;
}

export function deactivateLocal() {
  write(null);
  return evaluate();
}

/** Se llama al abrir la app y cada vez que vuelve internet. */
export async function checkLicense() {
  await evaluate();
  renew().catch(() => {});
  return current;
}

/**
 * ¿Hay un APK más nuevo? Solo lo sabe quien tiene licencia al día (el servidor
 * lo verifica). Devuelve { versionName, url } o null. Solo dentro de la app
 * instalada: en el navegador la web se actualiza sola.
 */
export async function checkUpdate() {
  const native = window.ZScoreNative;
  const saved = read();
  if (!native?.appVersionCode || !saved?.token) return null;
  const installed = native.appVersionCode();
  if (!(installed > 0)) return null;
  const r = await post('version', { token: saved.token, device: saved.device });
  if (!r.ok) return null;
  if (!(r.versionCode > installed)) return null;
  return { versionName: r.versionName, url: r.url };
}

export function openDownload(url) {
  const full = new URL(url, location.origin).href;
  if (window.ZScoreNative?.openUrl?.(full)) return;
  window.open(full, '_blank');
}

export function startLicenseWatch() {
  window.addEventListener('online', () => { renew().catch(() => {}); });
  // La app puede quedar abierta días en un celular: se re-evalúa al volver a primer plano.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkLicense().catch(() => {});
  });
}

// ---------- Texto para mostrar ----------

export function describeLicense(lic = current) {
  const { status, info } = lic;
  if (!info) return '';
  const typeName = { paga: 'Licencia', cortesia: 'Licencia de cortesía', prueba: 'Licencia de prueba' }[info.type] || 'Licencia';
  if (info.exp == null) return `${typeName} · sin vencimiento`;
  const fecha = new Date(info.exp).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' });
  if (status === 'grace' || status === 'blocked') return `${typeName} vencida el ${fecha}`;
  return `${typeName} · vence el ${fecha}`;
}

/** Aviso corto para la pantalla de inicio; '' si no hay nada que avisar. */
export function bannerText(lic = current) {
  const { status, info } = lic;
  if (status === 'expiring') {
    return info.daysLeft <= 1 ? 'Tu licencia vence hoy o mañana. Conectate a internet para renovarla.'
      : `Tu licencia vence en ${info.daysLeft} días. Conectate a internet para renovarla.`;
  }
  if (status === 'grace') {
    return `Tu licencia venció. Te ${info.graceLeft === 1 ? 'queda 1 día' : `quedan ${info.graceLeft} días`} para renovarla antes de que se bloquee la app.`;
  }
  return '';
}
