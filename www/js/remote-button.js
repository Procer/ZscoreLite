// Intento "best-effort" de capturar el disparador Bluetooth (control tipo
// "shutter" para selfies) desde el navegador.
//
// LIMITACIÓN REAL: estos controles simulan la tecla física de volumen del
// sistema operativo. Android e iOS interceptan esa tecla antes de que llegue
// a cualquier página web; no existe una API web estándar para leerla de forma
// garantizada. Lo que sigue son dos intentos que a veces funcionan según
// navegador/dispositivo, más un modo de prueba para que el usuario verifique
// en su propio celular antes del partido. La forma DEFINITIVA de garantizar
// el botón (para cuando se arme el wrapper nativo con Capacitor) es
// interceptar la tecla a nivel nativo y despachar el mismo evento
// 'remote-shutter' que dispara este módulo, para no tener que tocar el resto
// de la app.

const listeners = new Set();
let silentAudio = null;
let initialized = false;

function emit(source) {
  for (const cb of listeners) cb(source);
}

function trySilentAudioForMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    silentAudio = new Audio(
      'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='
    );
    silentAudio.loop = true;
    silentAudio.volume = 0.001;
    const playPromise = silentAudio.play();
    if (playPromise && playPromise.catch) playPromise.catch(() => {});
  } catch (e) {
    // el navegador puede bloquear autoplay sin gesto del usuario; se reintenta
    // en startRemoteButton() tras el primer toque en pantalla.
  }

  try {
    navigator.mediaSession.setActionHandler('nexttrack', () => emit('mediaSession:nexttrack'));
    navigator.mediaSession.setActionHandler('previoustrack', () => emit('mediaSession:previoustrack'));
  } catch (e) {
    /* algunos navegadores no soportan estas acciones */
  }
}

function onKeyDown(e) {
  if (e.code === 'AudioVolumeUp' || e.key === 'AudioVolumeUp' || e.keyCode === 175) {
    e.preventDefault?.();
    emit('keydown:volumeup');
  } else if (e.code === 'AudioVolumeDown' || e.key === 'AudioVolumeDown' || e.keyCode === 174) {
    e.preventDefault?.();
    emit('keydown:volumedown');
  }
}

export function initRemoteButton() {
  if (initialized) return;
  initialized = true;
  window.addEventListener('keydown', onKeyDown, { passive: false });
  trySilentAudioForMediaSession();

  // Reintentar reproducir el audio silencioso tras el primer gesto del
  // usuario, porque los navegadores móviles bloquean autoplay sin toque.
  const resume = () => {
    if (silentAudio && silentAudio.paused) {
      silentAudio.play().catch(() => {});
    }
    window.removeEventListener('touchstart', resume);
    window.removeEventListener('click', resume);
  };
  window.addEventListener('touchstart', resume, { once: true, passive: true });
  window.addEventListener('click', resume, { once: true });

  // Escuchar también el evento que despachará el futuro wrapper nativo
  // (Capacitor) cuando intercepte el botón físico a nivel de sistema.
  window.addEventListener('remote-shutter', () => emit('native:shutter'));
}

/** Suscribirse a pulsaciones detectadas. cb recibe un string con el origen. */
export function onRemotePress(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Dispara manualmente un evento, útil para la pantalla de "Probar control remoto". */
export function simulateRemotePress() {
  emit('simulated');
}
