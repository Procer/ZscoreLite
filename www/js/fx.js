// Efectos de celebración dibujados en un canvas que cubre el marcador:
// chispas (game), ráfagas grandes (set) y fuegos artificiales + confeti (partido).

export function createFx(canvas) {
  const ctx = canvas.getContext('2d');
  let particles = [];
  let raf = null;
  let last = 0;
  let w = 0;
  let h = 0;
  const timers = new Set();

  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = r.width;
    h = r.height;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function later(ms, fn) {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
  }

  function rand(a, b) { return a + Math.random() * (b - a); }
  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

  function ensureLoop() {
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function frame(now) {
    const dt = Math.min(32, now - last) / 16.667; // 1 = un cuadro a 60fps
    last = now;
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';

    particles = particles.filter((p) => p.age < p.life);
    for (const p of particles) {
      p.age += dt * 16.667;
      const k = 1 - p.age / p.life; // 1 -> 0
      p.vx *= Math.pow(p.drag, dt);
      p.vy = p.vy * Math.pow(p.drag, dt) + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;

      ctx.globalAlpha = Math.max(0, Math.min(1, k * 1.4));
      if (p.shape === 'spark') {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size * (0.4 + k);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 2.2, p.y - p.vy * 2.2);
        ctx.stroke();
      } else {
        // confeti: rectángulo que gira
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size, -p.size * 0.5, p.size * 2, p.size);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    if (particles.length) raf = requestAnimationFrame(frame);
    else { raf = null; ctx.clearRect(0, 0, w, h); }
  }

  /** Ráfaga de chispas desde (x, y). */
  function burst(x, y, { colors, count = 60, speed = 7, life = 1000, gravity = 0.14, size = 3, drag = 0.985 }) {
    for (let i = 0; i < count; i++) {
      const angle = rand(0, Math.PI * 2);
      const v = speed * rand(0.35, 1);
      particles.push({
        x, y, vx: Math.cos(angle) * v, vy: Math.sin(angle) * v - speed * 0.15,
        gravity, drag, life: life * rand(0.6, 1.1), age: 0,
        color: pick(colors), size: size * rand(0.7, 1.4), shape: 'spark', rot: 0, spin: 0,
      });
    }
    ensureLoop();
  }

  /** Lluvia de confeti desde arriba durante `duration` ms. */
  function confetti({ colors, duration = 3000, perTick = 5 }) {
    const start = performance.now();
    (function tick() {
      if (performance.now() - start > duration) return;
      for (let i = 0; i < perTick; i++) {
        particles.push({
          x: rand(0, w), y: rand(-30, -4), vx: rand(-1.2, 1.2), vy: rand(1.5, 3.5),
          gravity: 0.03, drag: 0.998, life: rand(2600, 4200), age: 0,
          color: pick(colors), size: rand(4, 8), shape: 'confetti', rot: rand(0, 6), spin: rand(-0.2, 0.2),
        });
      }
      ensureLoop();
      later(50, tick);
    })();
  }

  return {
    resize,
    burst,
    confetti,
    later,
    clear() {
      timers.forEach(clearTimeout);
      timers.clear();
      particles = [];
      ctx.clearRect(0, 0, w, h);
    },
    size: () => ({ w, h }),
  };
}
