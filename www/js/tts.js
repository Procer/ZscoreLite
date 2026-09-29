// Anuncios por voz (Web Speech API) para el parlante Bluetooth de la cancha.

let voice = null;
let voicesReady = false;

function pickVoice() {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  return (
    voices.find((v) => v.lang === 'es-AR') ||
    voices.find((v) => v.lang && v.lang.startsWith('es')) ||
    voices[0]
  );
}

function ensureVoice() {
  if (voicesReady) return;
  voice = pickVoice();
  if (voice) voicesReady = true;
}

if ('speechSynthesis' in window) {
  ensureVoice();
  window.speechSynthesis.onvoiceschanged = () => ensureVoice();
}

function speak(text) {
  if (!('speechSynthesis' in window) || !text) return;
  ensureVoice();
  window.speechSynthesis.cancel(); // no acumular anuncios atrasados
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = voice ? voice.lang : 'es-AR';
  if (voice) utter.voice = voice;
  utter.rate = 1;
  window.speechSynthesis.speak(utter);
}

/**
 * detailLevel: 'full' | 'simple'
 * 'full'   -> anuncia tanto a tanto con terminología ("15 a 30", "iguales", "ventaja", "juego"...)
 * 'simple' -> solo el resultado acumulado ("uno a cero")
 */
export function createAnnouncer(detailLevel = 'full') {
  const level = detailLevel;

  function announcePoint(display, teamNames) {
    if (level === 'simple') {
      speak(`${display.pointA} a ${display.pointB}`);
      return;
    }
    if (display.inTiebreak) {
      speak(`${display.pointA} - ${display.pointB}`);
      return;
    }
    if (display.goldenPoint) {
      speak('Punto de oro');
      return;
    }
    if (display.pointA === 'Iguales' || display.pointB === 'Iguales') {
      speak('Iguales');
      return;
    }
    if (display.pointA === 'Ventaja') {
      speak(`Ventaja ${teamNames.A}`);
      return;
    }
    if (display.pointB === 'Ventaja') {
      speak(`Ventaja ${teamNames.B}`);
      return;
    }
    speak(`${display.pointA} - ${display.pointB}`);
  }

  function announceGame(winnerTeamKey, display, teamNames) {
    const winnerName = teamNames[winnerTeamKey];
    if (level === 'simple') {
      speak(`Juego para ${winnerName}. ${display.gamesA} a ${display.gamesB}`);
      return;
    }
    speak(`Juego, ${winnerName}. ${display.gamesA} a ${display.gamesB}`);
  }

  function announceSet(winnerTeamKey, setScore, display, teamNames) {
    const winnerName = teamNames[winnerTeamKey];
    speak(`Set para ${winnerName}, ${setScore.a} a ${setScore.b}. Sets: ${display.setsA} a ${display.setsB}`);
  }

  function announceMatchOver(winnerTeamKey, teamNames) {
    speak(`Partido para ${teamNames[winnerTeamKey]}`);
  }

  function announceServer(teamKey, teamNames) {
    if (level === 'simple') return;
    speak(`Saca ${teamNames[teamKey]}`);
  }

  function say(text) {
    speak(text);
  }

  return { announcePoint, announceGame, announceSet, announceMatchOver, announceServer, say };
}
