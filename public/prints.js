// Отпечатки пальцев: щёлкнули по штемпельной подушке — палец в краске. Следующие щелчки по листу
// или по столу оставляют красный отпечаток, каждый бледнее предыдущего, пока краска не кончится.
// Esc вытирает палец.

const SVG_NS = 'http://www.w3.org/2000/svg';
const INK = [0.92, 0.7, 0.5, 0.34, 0.2]; // насыщенность отпечатков по порядку
const DESK_LIMIT = 30; // старые отпечатки стираются, чтобы не копить узлы
const SHEET_LIMIT = 16;

const random = (min, max) => min + Math.random() * (max - min);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// Где отпечаток не ставим: там, где щелчок что-то делает
const ACTIVE = 'input, button, a, label, select, textarea, [role="tab"], [data-desk]';

export function initPrints({ desk, sheetMarks }) {
  const root = document.documentElement;
  let next = -1; // номер следующего отпечатка; -1 — палец чистый

  function ink(pad) {
    next = 0;
    root.classList.add('is-inked');
    if (!reducedMotion.matches) {
      pad.animate([{ scale: '1' }, { scale: '.94' }, { scale: '1' }], { duration: 220, easing: 'ease-out' });
    }
  }

  function wipe() {
    next = -1;
    root.classList.remove('is-inked');
  }

  // На столе отпечаток ложится на сам стол — под комки и обрывки (они идут в разметке дальше)
  function press(container, x, y, limit) {
    const print = fingerprint(INK[next]);
    Object.assign(print.style, { left: x, top: y });
    if (container === desk) desk.querySelector('.coffee').after(print);
    else container.append(print);
    const old = [...container.querySelectorAll('.print')];
    if (container === desk) old.reverse(); // новые вставляются в начало
    for (let i = 0; i < old.length - limit; i += 1) old[i].remove();
    for (let i = 0; i < old.length - limit; i += 1) old[i].remove();
    next += 1;
    if (next >= INK.length) wipe();
  }

  document.addEventListener('click', (event) => {
    if (next < 0 || event.button !== 0) return;
    const { target } = event;
    if (!(target instanceof Element) || target.closest(ACTIVE)) return;

    const sheet = target.closest('.sheet');
    if (sheet) {
      const box = sheet.getBoundingClientRect();
      const x = ((event.clientX - box.left) / box.width) * 100;
      press(sheetMarks(), `${x.toFixed(2)}%`, `${(event.clientY - box.top).toFixed(0)}px`, SHEET_LIMIT);
    } else if (target === document.body || target === root) {
      // пустое место стола: стол и сцена пропускают указатель насквозь (style.css)
      press(desk, `${event.clientX}px`, `${event.clientY}px`, DESK_LIMIT);
    }
  });

  addEventListener('keydown', (event) => {
    if (event.key === 'Escape') wipe();
  });

  return { ink, wipe };
}

// Узор-завиток: спираль от середины подушечки, обрезанная овалом пальца. Края светлее (палец давит
// слабее), в линиях случайные разрывы — краска ложится неровно
function fingerprint(alpha) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'print');
  svg.setAttribute('viewBox', '-50 -62 100 124');
  svg.style.opacity = alpha.toFixed(2);
  svg.style.rotate = `${random(-28, 28).toFixed(0)}deg`;

  const RX = 44;
  const RY = 56;
  const gap = random(6.2, 7);
  const turns = RY / gap + 1.5;
  const core = { x: random(-4, 4), y: random(2, 10) };
  const phase = random(0, Math.PI * 2);
  const bands = ['', '', '']; // середина, ближе к краю, у самого края
  const pen = [false, false, false];

  for (let t = 0.6; t < turns * Math.PI * 2; t += 0.11) {
    const r = (t / (Math.PI * 2)) * gap * (1 + 0.05 * Math.sin(3 * t + phase));
    const x = core.x + r * 0.84 * Math.cos(t);
    const y = core.y + r * Math.sin(t) * (1 - 0.12 * Math.cos(t));
    const edge = Math.hypot(x / RX, y / RY);
    const band = edge < 0.7 ? 0 : edge < 0.88 ? 1 : edge < 1 ? 2 : -1;
    const skip = Math.random() < 0.06; // разрыв линии
    for (let b = 0; b < 3; b += 1) {
      if (b === band && !skip) {
        bands[b] += `${pen[b] ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
        pen[b] = true;
      } else {
        pen[b] = false;
      }
    }
  }

  [1, 0.62, 0.3].forEach((opacity, b) => {
    if (!bands[b]) return;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', bands[b]);
    path.setAttribute('opacity', String(opacity));
    svg.append(path);
  });
  return svg;
}
