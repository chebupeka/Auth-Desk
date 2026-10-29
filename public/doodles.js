// Рисунки от скуки: если 20 секунд ничего не делать, на полях листа медленно появляются каракули —
// спираль, звёздочка, кубик. Стоит начать печатать или нажать что-нибудь, ручка замирает, а
// дорисовывает после следующих 20 секунд тишины. Новый лист — чистый, рисунки начинаются заново.

const SVG_NS = 'http://www.w3.org/2000/svg';
const IDLE_MS = 20_000;
const PEN_SPEED = 34; // px/с — медленно, как от скуки
const PAUSE_MS = 1800; // между рисунками
const PAD = 6; // зазор вокруг рисунка

const random = (min, max) => min + Math.random() * (max - min);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// Небольшая дрожь руки: точки ломаной чуть сдвинуты
const wobbly = (points, amount = 0.6) =>
  points.map(([x, y], i) => `${i ? 'L' : 'M'}${(x + random(-amount, amount)).toFixed(1)} ${(y + random(-amount, amount)).toFixed(1)}`).join('');

// Отрезок, разбитый на точки, чтобы дрожь была и посередине
function line(x1, y1, x2, y2) {
  const steps = Math.max(2, Math.round(Math.hypot(x2 - x1, y2 - y1) / 5));
  return Array.from({ length: steps + 1 }, (_, i) => [x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps]);
}

const polyline = (corners) => corners.slice(1).flatMap((point, i) => line(...corners[i], ...point).slice(i ? 1 : 0));

// Каждый рисунок — размер и штрихи в своей системе координат (0…size)
const DOODLES = {
  spiral: {
    size: 56,
    strokes() {
      const points = [];
      const turns = 3.4;
      for (let t = 0; t <= turns * Math.PI * 2; t += 0.16) {
        const r = 2 + (t / (turns * Math.PI * 2)) * 24;
        points.push([28 + r * Math.cos(t), 28 + r * Math.sin(t) * 0.92]);
      }
      return [wobbly(points, 0.5)];
    },
  },
  star: {
    size: 40,
    // пятиконечная звезда одним росчерком и второй, чуть мимо, — так рисуют от скуки
    strokes() {
      const corner = (k, r = 18) => {
        const a = -Math.PI / 2 + (k * 4 * Math.PI) / 5;
        return [20 + r * Math.cos(a), 21 + r * Math.sin(a)];
      };
      const first = polyline([0, 1, 2, 3, 4, 5].map((k) => corner(k)));
      const second = polyline([0, 1, 2, 3, 4, 5].map((k) => corner(k, 17)).map(([x, y]) => [x + 1.2, y + 0.8]));
      return [wobbly(first), wobbly(second, 0.8)];
    },
  },
  cube: {
    size: 48,
    strokes() {
      const front = [[5, 17], [31, 17], [31, 43], [5, 43], [5, 17]];
      const back = front.map(([x, y]) => [x + 12, y - 12]);
      return [
        wobbly(polyline(front)),
        wobbly(polyline(back)),
        ...[0, 1, 2, 3].map((i) => wobbly(line(...front[i], ...back[i]))),
      ];
    },
  },
};
const ORDER = ['spiral', 'star', 'cube'];

export function initDoodles({ sheet, marks, canDraw }) {
  let progress = { done: [], job: null }; // job — рисунок, который сейчас рисуется: { svg, paths, index, drawn }
  let idleTimer = 0;
  let pauseTimer = 0;
  let frame = 0;
  let last = 0;

  /* ---------- Где рисовать ---------- */

  // Прямоугольники, занятые содержимым листа, в координатах листа
  function occupied() {
    const origin = sheet.getBoundingClientRect();
    const rects = [];
    const add = (box) => {
      if (box.width && box.height) rects.push({ left: box.left - origin.left, top: box.top - origin.top, right: box.right - origin.left, bottom: box.bottom - origin.top });
    };
    // у текстовых блоков считаем сам текст, а не всю строку
    const text = (node) => {
      if (!node?.textContent.trim()) return;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const box of range.getClientRects()) add(box);
    };
    for (const node of sheet.querySelectorAll('.form__title, .form__hint, .field__label, .field__error, .form__error, .form__switch, .margin-note')) text(node);
    for (const node of sheet.querySelectorAll('.field__control, .stamp-btn')) {
      if (node.offsetParent) add(node.getBoundingClientRect());
    }
    for (const node of marks().querySelectorAll('.doodle, .print')) add(node.getBoundingClientRect());
    // отверстия у корешка
    const holes = sheet.querySelector('.holes')?.getBoundingClientRect();
    if (holes) {
      for (const share of [0.18, 0.5, 0.82]) {
        const y = holes.top + holes.height * share;
        add(new DOMRect(holes.left - 2, y - 13, holes.width + 4, 26));
      }
    }
    return rects;
  }

  // Места-кандидаты для каждого рисунка — центры в координатах листа
  function candidates(name, size) {
    const W = sheet.clientWidth;
    const H = sheet.clientHeight;
    const marginX = parseFloat(getComputedStyle(sheet).getPropertyValue('--margin-x')) || 62;
    const at = (selector) => {
      const node = sheet.querySelector(selector);
      if (!node?.offsetParent) return null;
      const box = node.getBoundingClientRect();
      const origin = sheet.getBoundingClientRect();
      return { left: box.left - origin.left, right: box.right - origin.left, top: box.top - origin.top, bottom: box.bottom - origin.top };
    };
    const title = at('.form__title');
    const hint = at('.form__hint');
    const button = at('.stamp-btn');
    const switcher = at('.form__switch');
    const spots = {
      topBand: [W * 0.6, 38], // над заголовком, под скотчем углов не заезжаем
      besideTitle: title && [W - 30 - size / 2, (title.top + title.bottom) / 2 + 6],
      marginHigh: hint && [marginX / 2, (hint.top + hint.bottom) / 2],
      marginLow: [marginX / 2, H * 0.66],
      besideButton: button && [button.right + 34 + size / 2, (button.top + button.bottom) / 2],
      bottom: switcher && [W * 0.7, (switcher.bottom + H - 30) / 2],
    };
    const prefer = {
      spiral: ['besideTitle', 'topBand', 'bottom', 'besideButton'],
      star: ['marginHigh', 'marginLow', 'topBand', 'bottom'],
      cube: ['besideButton', 'bottom', 'topBand', 'besideTitle'],
    }[name];
    return prefer.map((key) => spots[key]).filter(Boolean);
  }

  function place(name) {
    const { size } = DOODLES[name];
    const W = sheet.clientWidth;
    const H = sheet.clientHeight;
    const taken = occupied();
    for (const [cx, cy] of candidates(name, size)) {
      const box = { left: cx - size / 2 - PAD, top: cy - size / 2 - PAD, right: cx + size / 2 + PAD, bottom: cy + size / 2 + PAD };
      // внутри листа: снизу рваный край
      if (box.left < 2 || box.top < 4 || box.right > W - 4 || box.bottom > H - 28) continue;
      if (taken.some((r) => r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top)) continue;
      return { x: cx - size / 2, y: cy - size / 2 };
    }
    return null;
  }

  /* ---------- Рисование ---------- */

  function start(name) {
    const spot = place(name);
    if (!spot) return null;
    const { size } = DOODLES[name];
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'doodle');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    Object.assign(svg.style, { left: `${spot.x.toFixed(0)}px`, top: `${spot.y.toFixed(0)}px`, width: `${size}px`, height: `${size}px`, rotate: `${random(-12, 12).toFixed(0)}deg` });
    marks().append(svg);
    const paths = DOODLES[name].strokes().map((d) => {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
      const length = path.getTotalLength();
      // ещё не начатый штрих скрыт: иначе круглый кончик пустого штриха рисует точку
      Object.assign(path.style, { strokeDasharray: `${length} ${length + 2}`, strokeDashoffset: String(length), visibility: 'hidden' });
      return { path, length };
    });
    return { name, svg, paths, index: 0, drawn: 0 };
  }

  // Состояние штриха пишем прямо в style: лист клонируется при перелистывании вместе с недорисованным
  function paint(job) {
    const stroke = job.paths[job.index];
    stroke.path.style.visibility = 'visible';
    stroke.path.style.strokeDashoffset = Math.max(0, stroke.length - job.drawn).toFixed(1);
  }

  function draw(now) {
    frame = 0;
    const state = progress;
    const { job } = state;
    if (!job || !canDraw()) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    // без анимаций рисунок появляется целиком
    let ink = reducedMotion.matches ? Infinity : PEN_SPEED * dt;
    while (ink > 0 && job.index < job.paths.length) {
      const { length } = job.paths[job.index];
      const used = Math.min(ink, length - job.drawn);
      job.drawn += used;
      ink -= used;
      paint(job);
      if (job.drawn >= length) {
        job.index += 1;
        job.drawn = 0;
      }
    }
    if (job.index >= job.paths.length) {
      state.done.push(job.name);
      state.job = null;
      pauseTimer = setTimeout(next, reducedMotion.matches ? 0 : PAUSE_MS);
      return;
    }
    frame = requestAnimationFrame(draw);
  }

  // Взяться за следующий рисунок (или продолжить начатый)
  function next() {
    pauseTimer = 0;
    if (!canDraw() || document.hidden) {
      wait();
      return;
    }
    const state = progress;
    if (!state.job) {
      const name = ORDER.find((candidate) => !state.done.includes(candidate));
      if (!name) return; // всё нарисовано
      state.job = start(name);
      if (!state.job) {
        state.done.push(name); // места нет — этот рисунок пропускаем
        next();
        return;
      }
    }
    last = performance.now();
    frame = requestAnimationFrame(draw);
  }

  function wait() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(next, IDLE_MS);
  }

  // Ручка замирает на полуслове: недорисованный штрих остаётся как есть
  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    clearTimeout(pauseTimer);
    pauseTimer = 0;
  }

  const busy = () => frame || pauseTimer;

  // Печатают или нажимают — рисование прекращается. Движение мышью рисования не прерывает,
  // но и не даёт ему начаться
  for (const type of ['keydown', 'pointerdown', 'input', 'wheel']) {
    addEventListener(type, () => {
      stop();
      wait();
    }, { capture: true, passive: true });
  }
  addEventListener('pointermove', () => {
    if (!busy()) wait();
  }, { capture: true, passive: true });

  wait();

  return {
    // Новый чистый лист: старые рисунки ушли вместе со старым, начинаем заново
    reset() {
      stop();
      progress = { done: [], job: null };
      wait();
    },
  };
}
