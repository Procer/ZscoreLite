// Anuncios por voz (Web Speech API) para el parlante Bluetooth de la cancha.

import { getSettings } from './settings.js';

let voice = null;
let voicesReady = false;
let nativeVoiceApplied = null;

const COUNTRY_NAMES = { ES: 'España', US: 'EE. UU.', MX: 'México', CO: 'Colombia', CL: 'Chile', PE: 'Perú', VE: 'Venezuela', UY: 'Uruguay', PY: 'Paraguay', BO: 'Bolivia', EC: 'Ecuador', CR: 'Costa Rica', PA: 'Panamá', DO: 'R. Dominicana', CU: 'Cuba', GT: 'Guatemala', HN: 'Honduras', NI: 'Nicaragua', SV: 'El Salvador', PR: 'Puerto Rico', '419': 'Latinoamérica' };

function regionOf(country) {
  if (country === 'AR') return 'Argentina';
  if (country === 'ES' || country === 'US' || !country) return 'Otras';
  return 'Latina';
}

/** Voces en español disponibles: [{ name, label }]. Vacío si no hay ninguna para elegir. */
export function listVoices() {
  const native = window.ZScoreNative;
  if (native?.listVoices) {
    try {
      const all = JSON.parse(native.listVoices());
      const count = {};
      return all
        .map((v) => {
          const country = (v.lang.split('-')[1] || '').toUpperCase();
          const region = regionOf(country);
          const n = v.name.toLowerCase();
          const gender = /female/.test(n) ? 'femenina' : /male/.test(n) ? 'masculina' : '';
          const order = { Argentina: 0, Latina: 1, Otras: 2 }[region];
          return { name: v.name, region, gender, country, order, online: !!v.online };
        })
        .sort((a, b) => a.order - b.order || a.country.localeCompare(b.country) || a.name.localeCompare(b.name))
        .map((v) => {
          count[v.region] = (count[v.region] || 0) + 1;
          return {
            name: v.name,
            region: v.region,
            gender: v.gender,
            title: `Voz ${count[v.region]}`,
            sub: [v.gender, v.region !== 'Argentina' ? COUNTRY_NAMES[v.country] || v.country : '', v.online ? 'con internet' : '']
              .filter(Boolean).join(' · ') || 'Español',
          };
        });
    } catch (e) { /* cae a las del navegador */ }
  }
  if (!('speechSynthesis' in window)) return [];
  return window.speechSynthesis.getVoices()
    .filter((v) => v.lang && /^es/i.test(v.lang))
    .map((v) => ({
      name: v.name,
      region: regionOf((v.lang.split(/[-_]/)[1] || '').toUpperCase()),
      gender: '',
      title: v.name,
      sub: v.lang,
    }));
}

function pickVoice() {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  const chosen = getSettings().voiceName;
  return (
    (chosen && voices.find((v) => v.name === chosen)) ||
    voices.find((v) => v.lang === 'es-AR') ||
    voices.find((v) => v.lang && v.lang.startsWith('es')) ||
    voices[0]
  );
}

function ensureVoice() {
  const chosen = getSettings().voiceName || '';
  if (voicesReady && (voice?.name === chosen || !chosen)) return;
  voice = pickVoice();
  if (voice) voicesReady = true;
}

if ('speechSynthesis' in window) {
  ensureVoice();
  window.speechSynthesis.onvoiceschanged = () => ensureVoice();
}

export function speak(text) {
  if (!text) return;
  // En el APK se usa el motor de voz nativo de Android (el del WebView no suena en varios celulares).
  const native = window.ZScoreNative;
  if (native?.speak && native.speakReady?.()) {
    try {
      const want = getSettings().voiceName || '';
      if (native.setVoice && want !== nativeVoiceApplied) {
        native.setVoice(want);
        nativeVoiceApplied = want;
      } if (native.speak(text)) return; } catch (e) { /* cae a la voz del navegador */ }
  }
  if (!('speechSynthesis' in window)) return;
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

  // `extra` va pegado al anuncio (ej. "Saca X"): cada speak() corta al anterior.
  function announceGame(winnerTeamKey, display, teamNames, extra = '') {
    const winnerName = teamNames[winnerTeamKey];
    if (level === 'simple') {
      speak(`Juego para ${winnerName}. ${display.gamesA} a ${display.gamesB}`);
      return;
    }
    speak(`Juego, ${winnerName}. ${display.gamesA} a ${display.gamesB}. ${extra}`);
  }

  function announceSet(winnerTeamKey, setScore, display, teamNames, extra = '') {
    const winnerName = teamNames[winnerTeamKey];
    speak(`Set para ${winnerName}, ${setScore.a} a ${setScore.b}. Sets: ${display.setsA} a ${display.setsB}. ${extra}`);
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
