// Pantalla de cambio de parejas entre partido y partido de la jornada social.

import { loadSession, saveSession, applyChange, pairLabel } from './social.js';
import { createTapChooser, hintText, legendText } from './remote-choice.js';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function initSocialView({ onStart, onEnd, onHome }) {
  const root = document.getElementById('view-social');
  let stay = null;
  let enter = null;
  let slots = {}; // por pareja: quién saca primero ('p1' | 'p2')
  let step = 'stay'; // paso que contesta el control remoto

  const hasNames = (s, i) => !!(s.pairs[i].p1 && s.pairs[i].p2);

  /** Pasos del control: quién se queda, quién entra, quién saca primero en cada pareja, empezar. */
  function stepsNow(s) {
    return [
      'stay',
      s.queue.length > 1 ? 'enter' : null,
      hasNames(s, stay) ? 'slotStay' : null,
      hasNames(s, enter) ? 'slotEnter' : null,
      'go',
    ].filter(Boolean);
  }

  function nextStep(s) {
    const steps = stepsNow(s);
    const i = steps.indexOf(step);
    step = steps[Math.min(i + 1, steps.length - 1)] || 'go';
  }

  /** Pregunta y opciones del paso actual, para el control remoto. */
  function remoteStep(s) {
    const { winner, loser } = s.pending;
    const slotOpts = (i) => ['p1', 'p2'].map((k) => ({ label: s.pairs[i][k], pick: () => { slots[i] = k; nextStep(s); render(); } }));
    if (step === 'stay') {
      return { q: '¿Quién se queda en cancha?', opts: [
        { label: `${pairLabel(s.pairs[winner])} (ganó)`, pick: () => { stay = winner; nextStep(s); render(); } },
        { label: `${pairLabel(s.pairs[loser])} (perdió)`, pick: () => { stay = loser; nextStep(s); render(); } },
      ] };
    }
    if (step === 'enter') {
      return { q: '¿Quién entra?', opts: s.queue.map((i) => ({ label: pairLabel(s.pairs[i]), pick: () => { enter = i; nextStep(s); render(); } })) };
    }
    if (step === 'slotStay') return { q: `¿Quién saca primero en ${pairLabel(s.pairs[stay])}?`, opts: slotOpts(stay) };
    if (step === 'slotEnter') return { q: `¿Quién saca primero en ${pairLabel(s.pairs[enter])}?`, opts: slotOpts(enter) };
    return { q: 'Todo listo', opts: [
      { label: 'Empezar partido', pick: () => startMatch() },
      { label: 'Volver a elegir', pick: () => { step = 'stay'; render(); } },
    ] };
  }

  createTapChooser({
    isActive: () => root.classList.contains('is-active'),
    getOptions: () => { const s = loadSession(); return s?.pending ? remoteStep(s).opts : null; },
    onHint: (taps, options) => {
      const el = document.getElementById('social-remote-hint');
      if (el) el.textContent = hintText(taps, options);
    },
    onChoose: (i) => { const s = loadSession(); if (s?.pending) remoteStep(s).opts[i]?.pick(); },
  });

  function startMatch() {
    const s = loadSession();
    if (!s?.pending) return;
    applyChange(s, stay, enter);
    s.firstSlot = s.pairs.map((_, i) => slots[i] || 'p1');
    saveSession(s);
    onStart(s);
  }

  function slotRow(s, i) {
    const p = s.pairs[i];
    if (!(p.p1 && p.p2)) return '';
    return `<div class="social-slot"><span>Saca primero en ${escapeHtml(pairLabel(p))}:</span>
      ${['p1', 'p2'].map((k) => `<button class="seg-btn${slots[i] === k ? ' is-active' : ''}" data-pair="${i}" data-slot="${k}">${escapeHtml(p[k])}</button>`).join('')}
    </div>`;
  }

  function card(s, i, role, tag) {
    const selected = (role === 'stay' ? stay : enter) === i;
    const wins = s.wins[i];
    const meta = [tag, `${wins} ${wins === 1 ? 'ganado' : 'ganados'}`, s.streak[i] > 1 ? `${s.streak[i]} seguidos` : '']
      .filter(Boolean).join(' · ');
    return `<button class="social-card${selected ? ' is-selected' : ''}" data-role="${role}" data-i="${i}">
      <span class="social-card-name">${escapeHtml(pairLabel(s.pairs[i]))}</span>
      <span class="social-card-meta">${escapeHtml(meta)}</span>
    </button>`;
  }

  function render() {
    const s = loadSession();
    if (!s?.pending) return;
    const { winner, loser, score } = s.pending;
    const queueCards = s.queue.map((i, pos) => card(s, i, 'enter', pos === 0 ? 'Próxima' : `Turno ${pos + 1}`)).join('');
    root.innerHTML = `
      <div class="social-head">
        <div class="social-title">Cambio de parejas</div>
        <div class="social-result">Ganó <strong>${escapeHtml(pairLabel(s.pairs[winner]))}</strong>${score ? ` · ${escapeHtml(score)}` : ''}</div>
      </div>
      <div class="social-remote">
        <div class="social-remote-q">${escapeHtml(remoteStep(s).q)}</div>
        <div class="social-remote-opts">Control: ${escapeHtml(legendText(remoteStep(s).opts))}</div>
        <div class="remote-hint" id="social-remote-hint"></div>
      </div>
      <div class="social-cols">
        <div class="social-col">
          <div class="section-title">Se queda en cancha</div>
          ${card(s, winner, 'stay', 'Ganó')}
          ${card(s, loser, 'stay', 'Perdió')}
        </div>
        <div class="social-col">
          <div class="section-title">Entra</div>
          ${queueCards}
        </div>
      </div>
      <div class="social-next">Próximo partido: <strong>${escapeHtml(pairLabel(s.pairs[stay]))}</strong> vs <strong>${escapeHtml(pairLabel(s.pairs[enter]))}</strong></div>
      <div class="social-slots">${slotRow(s, stay)}${slotRow(s, enter)}</div>
      <button class="btn btn-primary btn-block social-go" data-social="start">Empezar partido</button>
      <div class="social-foot">
        <button class="btn btn-ghost" data-social="home">Volver al inicio</button>
        <button class="btn btn-ghost" data-social="end">Terminar jornada</button>
      </div>
    `;
  }

  /** Muestra el cambio pendiente. Devuelve false si no hay jornada esperando. */
  function open() {
    const s = loadSession();
    if (!s?.pending) return false;
    stay = s.pending.winner;
    enter = s.queue[0];
    step = 'stay';
    slots = Object.fromEntries(s.pairs.map((_, i) => [i, s.firstSlot?.[i] || 'p1']));
    render();
    return true;
  }

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.slot) {
      slots[btn.dataset.pair] = btn.dataset.slot;
      render();
      return;
    }
    if (btn.dataset.role) {
      const i = Number(btn.dataset.i);
      if (btn.dataset.role === 'stay') stay = i; else enter = i;
      render();
      return;
    }
    const act = btn.dataset.social;
    if (act === 'start') {
      startMatch();
    } else if (act === 'home') {
      onHome();
    } else if (act === 'end') {
      if (confirm('¿Terminar la jornada? Los partidos jugados quedan en el historial.')) onEnd();
    }
  });

  return { open };
}
