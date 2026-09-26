// Mantiene la pantalla encendida mientras se juega (el celular queda colgado
// mostrando el marcador). Se re-adquiere solo si la pestaña vuelve a estar
// visible, porque el sistema libera el wake lock al perder foco.

let sentinel = null;

async function acquire() {
  if (!('wakeLock' in navigator)) return;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
  } catch (e) {
    // puede fallar si la pestaña no está visible; se reintenta con visibilitychange
  }
}

export function startWakeLock() {
  acquire();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !sentinel) acquire();
  });
}

export async function stopWakeLock() {
  if (sentinel) {
    await sentinel.release();
    sentinel = null;
  }
}
