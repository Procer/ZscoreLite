// Configuración del club, guardada en el dispositivo (localStorage).

const KEY = 'zscoreLiteSettings';

export const BALL_SIZES = {
  s: { label: 'Chica', css: 'clamp(32px, 7vh, 56px)' },
  m: { label: 'Mediana', css: 'clamp(48px, 10vh, 80px)' },
  l: { label: 'Grande', css: 'clamp(70px, 15vh, 120px)' },
};

export const DEFAULTS = {
  tapWindowMs: 1800, // cuánto se espera para contar los toques del control
  firstTapSide: 'left', // a qué lado suma 1 toque: 'left' | 'right' (2 toques, el otro)
  beep: true,
  vibrate: true,
  highContrast: false,
  ballSize: 'm',
};

let cache = null;

export function getSettings() {
  if (cache) return cache;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { saved = {}; }
  cache = { ...DEFAULTS, ...saved };
  return cache;
}

export function saveSettings(patch) {
  cache = { ...getSettings(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) { /* sin almacenamiento */ }
  applyDisplaySettings();
  return cache;
}

/** Aplica alto contraste y tamaño de la pelota a toda la app. */
export function applyDisplaySettings() {
  const s = getSettings();
  document.documentElement.classList.toggle('hc', !!s.highContrast);
  const ball = BALL_SIZES[s.ballSize] || BALL_SIZES.m;
  document.documentElement.style.setProperty('--serve-ball-size', ball.css);
}

/** Equipo al que suma 1 toque del control ('A' = izquierda, 'B' = derecha). */
export function firstTapTeam() {
  return getSettings().firstTapSide === 'right' ? 'B' : 'A';
}

// ---------- Aviso por toque del control: sonido y vibración ----------
// Se usa el puente nativo (ToneGenerator/Vibrator) porque el control llega
// como tecla del sistema, sin gesto de pantalla, y el audio web puede quedar
// bloqueado. Fuera del APK se cae a WebAudio y a navigator.vibrate.

let audioCtx = null;

function webBeep(freq, ms) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    gain.gain.value = 0.18;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + ms / 1000);
  } catch (e) { /* sin audio */ }
}

/** tone: 1 = primer toque, 2 = segundo, 3 = deshacer, 0 = confirmación aplicada */
export function feedbackTap(tone) {
  const s = getSettings();
  const freq = { 0: 1320, 1: 880, 2: 1100, 3: 520 }[tone] || 880;
  const ms = tone === 3 ? 160 : 70;
  const native = window.ZScoreNative;
  if (s.beep) {
    if (native?.beep) { try { native.beep(freq, ms); } catch (e) { webBeep(freq, ms); } } else webBeep(freq, ms);
  }
  if (s.vibrate) {
    try {
      if (native?.vibrate) native.vibrate(tone === 0 ? 60 : 35);
      else navigator.vibrate?.(tone === 0 ? 60 : 35);
    } catch (e) { /* sin vibración */ }
  }
}
