// Предметы на столе: комки, обрывки и штемпельную подушку можно перетаскивать. Обрывки и подушка
// остаются там, где их положили. Комок можно бросить: он летит, падает, немного катится и
// останавливается, а если долетел до корзины — падает в неё, и рядом карандашом прибавляется зарубка.

const SVG_NS = 'http://www.w3.org/2000/svg';
const VISIBLE_SHARE = 0.6; // какая часть предмета должна оставаться на экране
const DEG = 180 / Math.PI;

const TAP_SLOP = 6; // px: сдвинули меньше — это нажатие, а не перенос
const TAP_TIME = 450; // мс
const THROW_MIN = 300; // px/с: медленнее — комок просто положили
const THROW_MAX = 3400;
const AIR_SHARE = 0.6; // какая доля скорости руки достаётся полёту: бумажный комок лёгкий
const ROLL_SHARE = 0.35; // какая доля скорости остаётся после приземления
const FRICTION = 3.2; // 1/с: как быстро катящийся комок замедляется
const BOUNCE = 0.45; // какая доля скорости остаётся после удара о край, блокнот или другой комок
const STOP_SPEED = 14; // px/с
const BINNED_SCALE = 0.64; // комок на дне корзины дальше от глаз, поэтому меньше
const BIN_LAYER = '2'; // между корзиной и её ободом (style.css)
const EXTRA_BALLS = 3; // сколько комков от входов держим в корзине, лишние «уходят на дно»

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const calm = () => reducedMotion.matches;

export function initDesk({ desk, obstacles = () => [], onTap = () => {} }) {
  const items = [];
  const balls = [];
  const extras = []; // комки, которые прилетели после входа
  const moving = new Set();
  const basketNode = desk.querySelector('.basket');
  const tally = createTally(desk.querySelector('.tally'));

  let layer = 10; // выше обода корзины
  let frame = 0;
  let lastFrame = 0;

  // Скрытая панель или вкладка браузера может на время получить окно 0×0: по нему предметы
  // не раскладываем и не прижимаем к краям — иначе все они съедутся в угол
  const viewportShown = () => innerWidth > 0 && innerHeight > 0;

  // Корзина в координатах экрана; null, если на узком экране её нет
  function basket() {
    if (!basketNode?.offsetWidth || !viewportShown()) return null;
    const box = basketNode.getBoundingClientRect();
    const size = box.width;
    return {
      x: box.left + size / 2,
      y: box.top + size / 2,
      outer: size * 0.48, // наружный край обода
      mouth: size * 0.39, // внутренний край обода
      floor: size * 0.24, // дно
    };
  }

  // Попал в корзину: центр комка над отверстием с запасом на половину обода
  const overMouth = (item, bin) => Math.hypot(item.x - bin.x, item.y - bin.y) < bin.mouth - item.r * BINNED_SCALE * 0.5;

  // CSS расставил предметы через left/right/top/bottom; забираем их координаты и дальше двигаем сами
  function adopt(item) {
    const { node } = item;
    item.w = node.offsetWidth;
    item.h = node.offsetHeight;
    // скрыт на узком экране или окно свёрнуто в ноль — подхватим при ресайзе
    if (!item.w || !item.h || !viewportShown()) return;
    const box = node.getBoundingClientRect();
    item.x = box.left + box.width / 2;
    item.y = box.top + box.height / 2;
    item.r = Math.min(item.w, item.h) * 0.44;
    item.rot = parseFloat(getComputedStyle(node).getPropertyValue('--rot')) || 0;
    Object.assign(node.style, { left: '0px', top: '0px', right: 'auto', bottom: 'auto' });
    item.ready = true;
    render(item);
  }

  // Масштаб: поднятый рукой чуть крупнее, летящий — тем крупнее, чем выше, на дне корзины — мельче
  function render(item) {
    const lift = item.held ? 1.07 : 1;
    const scale = lift * (1 + item.z) * (1 - item.sink * (1 - BINNED_SCALE));
    item.node.style.transform =
      `translate3d(${(item.x - item.w / 2).toFixed(1)}px, ${(item.y - item.h / 2).toFixed(1)}px, 0) `
      + `rotate(${(item.rot + item.angle).toFixed(1)}deg) scale(${scale.toFixed(3)})`;
    // тень летящего комка уходит дальше и светлеет
    item.node.style.filter = item.z > 0.001
      ? `drop-shadow(${(5 + item.z * 70).toFixed(1)}px ${(10 + item.z * 90).toFixed(1)}px ${(7 + item.z * 30).toFixed(1)}px rgb(70 50 15 / ${(0.34 - item.z * 0.35).toFixed(3)}))`
      : '';
  }

  // Куда вытолкнуть предмет из-под блокнота или стикера (по кратчайшей оси); null — он и так снаружи
  function exitFrom(item, rect) {
    const halfW = item.kind === 'ball' ? item.r : item.w * 0.42;
    const halfH = item.kind === 'ball' ? item.r : item.h * 0.42;
    const left = rect.left - halfW;
    const right = rect.right + halfW;
    const top = rect.top - halfH;
    const bottom = rect.bottom + halfH;
    if (item.x <= left || item.x >= right || item.y <= top || item.y >= bottom) return null;

    if (item.kind === 'ball') {
      // круг против прямоугольника: выталкиваем от ближайшей точки
      const cx = clamp(item.x, rect.left, rect.right);
      const cy = clamp(item.y, rect.top, rect.bottom);
      const dx = item.x - cx;
      const dy = item.y - cy;
      const dist = Math.hypot(dx, dy);
      if (dist >= item.r) return null;
      if (dist > 0) return { x: cx + (dx / dist) * item.r, y: cy + (dy / dist) * item.r };
    }

    // центр внутри прямоугольника (или это обрывок) — к ближайшему краю
    const exits = [[item.x - left, left, item.y], [right - item.x, right, item.y], [item.y - top, item.x, top], [bottom - item.y, item.x, bottom]];
    const [, x, y] = exits.sort((a, b) => a[0] - b[0])[0];
    return { x, y };
  }

  function collideRect(item, rect) {
    const to = exitFrom(item, rect);
    if (to) Object.assign(item, to);
  }

  // Предмет заметно лежит под прямоугольником, а не просто касается края после выталкивания
  function tucked(item, rect) {
    const to = exitFrom(item, rect);
    return !!to && Math.hypot(to.x - item.x, to.y - item.y) > 1;
  }

  function collideBounds(item) {
    const halfW = item.kind === 'ball' ? item.r : item.w / 2;
    const halfH = item.kind === 'ball' ? item.r : item.h / 2;
    const keepX = halfW * (2 * VISIBLE_SHARE - 1);
    const keepY = halfH * (2 * VISIBLE_SHARE - 1);
    item.x = clamp(item.x, keepX, innerWidth - keepX);
    item.y = clamp(item.y, keepY, innerHeight - keepY);
  }

  // Комок упирается в другой круг (комок или стенку корзины), а не расталкивает его
  function collideCircle(item, circle) {
    const dx = item.x - circle.x;
    const dy = item.y - circle.y;
    const dist = Math.hypot(dx, dy);
    const gap = item.r + circle.r;
    if (dist >= gap) return;
    const nx = dist ? dx / dist : 1;
    const ny = dist ? dy / dist : 0;
    item.x = circle.x + nx * gap;
    item.y = circle.y + ny * gap;
  }

  // Круг уже заметно налезает на комок (так их разложила вёрстка) — из-под него не выталкиваем
  const overlapping = (item, circle) => item.r + circle.r - Math.hypot(item.x - circle.x, item.y - circle.y) > 1;

  function solidRects() {
    return obstacles()
      .filter((rect) => rect && rect.width > 0 && rect.height > 0);
  }

  // Двигаем маленькими шагами: так предмет упирается в тот край блокнота, к которому подъехал,
  // и скользит вдоль него, а резкий рывок не проскакивает препятствие насквозь.
  // Если предмет уже лежал под блокнотом или на соседнем комке (так его разложила вёрстка, особенно
  // на телефоне), оттуда его не выталкиваем — иначе он отпрыгнет сам; пусть его вытащат рукой.
  // Летящий комок пролетает над другими комками, а комок в руке — над корзиной, чтобы его можно было
  // опустить в неё. Край экрана проверяем последним: предмет не должен уехать за экран ни от чего
  function travel(item, dx, dy) {
    const rects = solidRects();
    const isBall = item.kind === 'ball';
    const airborne = item.z > 0;
    const circles = isBall && !airborne
      ? balls.filter((ball) => ball !== item && ball.ready && !ball.binned)
      : [];
    const bin = isBall && !airborne && !item.held ? basket() : null;
    if (bin) circles.push({ x: bin.x, y: bin.y, r: bin.outer });
    const reach = isBall ? item.r : Math.min(item.w, item.h) * 0.4;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(4, reach * 0.4)));
    for (let i = 0; i < steps; i += 1) {
      const blockingRects = rects.filter((rect) => !tucked(item, rect));
      const blockingCircles = circles.filter((circle) => !overlapping(item, circle));
      item.x += dx / steps;
      item.y += dy / steps;
      for (const circle of blockingCircles) collideCircle(item, circle);
      for (const rect of blockingRects) collideRect(item, rect);
      collideBounds(item);
    }
  }

  /* ---------- Бросок ---------- */

  function startMoving(item) {
    moving.add(item);
    if (frame) return;
    lastFrame = performance.now();
    frame = requestAnimationFrame(tick);
  }

  function stopMoving(item) {
    moving.delete(item);
    item.vx = 0;
    item.vy = 0;
    item.flight = null;
    item.tween = null;
    item.z = 0;
  }

  function tick(now) {
    const dt = Math.min(0.034, Math.max(0, (now - lastFrame) / 1000));
    lastFrame = now;
    for (const item of [...moving]) {
      if (item.tween) sinkStep(item, now);
      else step(item, dt);
    }
    frame = moving.size ? requestAnimationFrame(tick) : 0;
  }

  // Сдвиг на скорость × время. Если что-то остановило комок (край, блокнот, сосед, корзина),
  // скорость отражается от этого препятствия и теряет часть величины
  function move(item, dt) {
    const wantX = item.x + item.vx * dt;
    const wantY = item.y + item.vy * dt;
    travel(item, item.vx * dt, item.vy * dt);
    const cx = item.x - wantX;
    const cy = item.y - wantY;
    const push = Math.hypot(cx, cy);
    if (push < 0.01) return;
    const nx = cx / push;
    const ny = cy / push;
    const along = item.vx * nx + item.vy * ny;
    if (along >= 0) return;
    item.vx -= (1 + BOUNCE) * along * nx;
    item.vy -= (1 + BOUNCE) * along * ny;
  }

  function step(item, dt) {
    const prevX = item.x;
    const bin = basket();
    if (item.flight) {
      const flight = item.flight;
      flight.t = Math.min(flight.duration, flight.t + dt);
      const u = flight.t / flight.duration;
      item.z = flight.height * 4 * u * (1 - u);
      move(item, dt);
      // на спуске над отверстием — значит, падает в корзину
      if (bin && u > 0.55 && overMouth(item, bin)) {
        drop(item, bin, true);
        return;
      }
      if (u >= 1) land(item);
    } else {
      const decay = Math.exp(-FRICTION * dt);
      item.vx *= decay;
      item.vy *= decay;
      move(item, dt);
      if (Math.hypot(item.vx, item.vy) < STOP_SPEED) stopMoving(item);
    }
    item.angle += ((item.x - prevX) / item.r) * DEG; // катится и вертится
    render(item);
  }

  function land(item) {
    item.flight = null;
    item.z = 0;
    item.vx *= ROLL_SHARE;
    item.vy *= ROLL_SHARE;
  }

  // Скорость руки за последние ~90 мс; если перед тем, как отпустить, руку остановили — нуль
  function releaseVelocity(item, now) {
    const { trail } = item;
    const last = trail[trail.length - 1];
    if (trail.length < 2 || now - last.t > 70) return { vx: 0, vy: 0 };
    const first = trail[0];
    const dt = (last.t - first.t) / 1000;
    if (dt < 0.012) return { vx: 0, vy: 0 };
    return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
  }

  function launch(item, { vx, vy }) {
    const bin = basket();
    const speed = Math.hypot(vx, vy);
    if (calm() || speed < THROW_MIN) {
      // просто положили: над отверстием корзины — падает в неё, на ободе — скатывается наружу
      if (!bin) return;
      const dist = Math.hypot(item.x - bin.x, item.y - bin.y);
      if (overMouth(item, bin)) {
        drop(item, bin, false);
      } else if (dist < bin.outer + item.r) {
        const nx = dist ? (item.x - bin.x) / dist : 1;
        const ny = dist ? (item.y - bin.y) / dist : 0;
        if (calm()) {
          item.x = bin.x + nx * (bin.outer + item.r);
          item.y = bin.y + ny * (bin.outer + item.r);
          collideBounds(item);
          render(item);
        } else {
          // с обода комок скатывается наружу (пока он лежит на ободе, стенка корзины его не держит)
          item.vx = nx * 240;
          item.vy = ny * 240;
          startMoving(item);
        }
      }
      return;
    }
    const k = (Math.min(speed, THROW_MAX) / speed) * AIR_SHARE;
    item.vx = vx * k;
    item.vy = vy * k;
    const thrown = speed * k;
    item.flight = {
      t: 0,
      duration: clamp(0.16 + thrown / 4200, 0.2, 0.62),
      height: clamp(thrown / 5200, 0.1, 0.42), // насколько комок «приближается» к глазу в верхней точке
    };
    startMoving(item);
  }

  /* ---------- Корзина ---------- */

  // Место на дне для index-го комка: по спирали от середины, чтобы не лечь ровно друг на друга
  function binSpot(bin, index) {
    const angle = index * 2.4 + 0.6;
    const radius = bin.floor * Math.min(1, Math.sqrt(index / 5)) * 0.9;
    return { x: bin.x + Math.cos(angle) * radius, y: bin.y + Math.sin(angle) * radius };
  }

  // Комок падает на дно: съезжает к своему месту и уменьшается
  function drop(item, bin, counted) {
    stopMoving(item);
    const spot = binSpot(bin, balls.filter((ball) => ball.binned).length);
    item.binned = true;
    item.node.classList.add('is-binned');
    item.node.style.zIndex = BIN_LAYER;
    if (counted) tally.add();
    if (calm()) {
      Object.assign(item, spot, { sink: 1 });
      render(item);
      return;
    }
    item.tween = { from: { x: item.x, y: item.y, sink: item.sink }, to: spot, start: performance.now(), duration: 340 };
    startMoving(item);
  }

  function sinkStep(item, now) {
    const { from, to, start, duration } = item.tween;
    const t = Math.min(1, (now - start) / duration);
    const ease = 1 - (1 - t) ** 3;
    item.x = from.x + (to.x - from.x) * ease;
    item.y = from.y + (to.y - from.y) * ease;
    item.sink = from.sink + (1 - from.sink) * ease;
    item.angle += 2.5 * (1 - t);
    render(item);
    if (t >= 1) stopMoving(item);
  }

  /* ---------- Рука ---------- */

  function grab(item, event) {
    if (event.button !== 0 || !item.ready) return;
    event.preventDefault();
    item.node.setPointerCapture(event.pointerId);
    stopMoving(item); // поймали на лету
    if (item.binned) {
      // достали из корзины
      item.binned = false;
      item.sink = 0;
      item.node.classList.remove('is-binned');
    }
    item.held = true;
    item.grab = { dx: item.x - event.clientX, dy: item.y - event.clientY };
    item.press = { x: event.clientX, y: event.clientY, t: event.timeStamp };
    item.trail = [{ x: event.clientX, y: event.clientY, t: event.timeStamp }];
    layer += 1;
    item.node.style.zIndex = String(layer);
    item.node.classList.add('is-held');
    // пока тащим, текст формы не должен выделяться
    document.documentElement.classList.add('is-dragging');
    document.getSelection()?.removeAllRanges();
    render(item);
  }

  function drag(item, event) {
    if (!item.held) return;
    const prevX = item.x;
    item.trail.push({ x: event.clientX, y: event.clientY, t: event.timeStamp });
    while (item.trail.length > 2 && event.timeStamp - item.trail[0].t > 90) item.trail.shift();
    travel(item, event.clientX + item.grab.dx - item.x, event.clientY + item.grab.dy - item.y);
    if (item.kind === 'ball') item.angle += ((item.x - prevX) / item.r) * DEG; // комок катится под рукой
    render(item);
  }

  // Отпустили — обрывок остаётся ровно там, где его положили, а брошенный комок летит дальше.
  // Нажатие без переноса — это щелчок по предмету (по штемпельной подушке — обмакнуть палец)
  function release(item, event) {
    if (!item.held) return;
    item.held = false;
    item.node.classList.remove('is-held');
    document.documentElement.classList.remove('is-dragging');
    document.getSelection()?.removeAllRanges();
    if (item.node.hasPointerCapture(event.pointerId)) item.node.releasePointerCapture(event.pointerId);
    render(item);
    if (event.type !== 'pointerup') return;

    const tap = Math.hypot(event.clientX - item.press.x, event.clientY - item.press.y) < TAP_SLOP
      && event.timeStamp - item.press.t < TAP_TIME;
    if (tap) onTap(item.node);
    if (item.kind === 'ball') launch(item, tap ? { vx: 0, vy: 0 } : releaseVelocity(item, event.timeStamp));
  }

  function register(node) {
    const item = {
      node,
      kind: node.dataset.desk,
      ready: false,
      x: 0, y: 0,
      w: 0, h: 0, r: 0,
      rot: 0, angle: 0,
      z: 0, sink: 0,
      vx: 0, vy: 0,
      held: false,
      binned: false,
      flight: null,
      tween: null,
      trail: [],
    };
    items.push(item);
    if (item.kind === 'ball') balls.push(item);
    node.addEventListener('pointerdown', (event) => grab(item, event));
    node.addEventListener('pointermove', (event) => drag(item, event));
    node.addEventListener('pointerup', (event) => release(item, event));
    node.addEventListener('pointercancel', (event) => release(item, event));
    // Chrome начинает выделение текста по mousedown даже после отменённого pointerdown
    node.addEventListener('mousedown', (event) => event.preventDefault());
    node.addEventListener('dragstart', (event) => event.preventDefault());
    return item;
  }

  function forget(item) {
    stopMoving(item);
    item.node.remove();
    for (const list of [items, balls, extras]) {
      const index = list.indexOf(item);
      if (index !== -1) list.splice(index, 1);
    }
  }

  for (const node of desk.querySelectorAll('[data-desk]')) adopt(register(node));

  document.addEventListener('selectstart', (event) => {
    if (items.some((item) => item.held)) event.preventDefault();
  });

  // Комки на дне следуют за корзиной (она привязана к углу экрана), а если корзину спрятали
  // (узкий экран) — остаются на столе там, где была корзина
  function rebin() {
    const bin = basket();
    const binned = balls.filter((ball) => ball.binned && ball.ready && !ball.held);
    binned.forEach((ball, index) => {
      stopMoving(ball);
      if (bin) {
        Object.assign(ball, binSpot(bin, index), { sink: 1 });
      } else {
        ball.binned = false;
        ball.sink = 0;
        ball.node.classList.remove('is-binned');
        ball.node.style.zIndex = '';
        collideBounds(ball);
      }
      render(ball);
    });
  }

  // Окно стало уже — то, что оказалось за краем, возвращаем на экран (и только это, без анимации).
  // Изменение одной высоты предметы не трогает: на телефоне так прячется адресная строка при
  // прокрутке и выезжает клавиатура — комки не должны от этого прыгать
  let resizeTimer;
  let lastWidth = innerWidth;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!viewportShown()) return;
      rebin();
      if (innerWidth === lastWidth) return;
      lastWidth = innerWidth;
      for (const item of items) {
        if (!item.ready) {
          adopt(item);
          continue;
        }
        if (!item.node.offsetWidth || item.binned) continue; // сейчас скрыт или лежит в корзине
        item.w = item.node.offsetWidth;
        item.h = item.node.offsetHeight;
        item.r = Math.min(item.w, item.h) * 0.44;
        collideBounds(item);
        render(item);
      }
    }, 150);
  });

  return {
    // Куда бросить комок после входа: середина корзины, если она видна
    basketTarget() {
      const bin = basket();
      return bin && { x: bin.x, y: bin.y };
    },

    // Комок от входа долетел до корзины и остаётся на дне: его можно достать, попадание засчитано.
    // scale — во сколько раз он сейчас меньше size (долетел издалека)
    catchBall({ src, size, scale = 1 }) {
      const bin = basket();
      if (!bin) return;
      const node = document.createElement('img');
      Object.assign(node, { className: 'ball', src, alt: '', width: Math.round(size), height: Math.round(size), draggable: false });
      node.dataset.desk = 'ball';
      node.style.setProperty('--size', `${size}px`);
      Object.assign(node.style, { left: '0px', top: '0px' });
      desk.append(node);
      const item = register(node);
      Object.assign(item, {
        ready: true,
        x: bin.x,
        y: bin.y,
        w: size,
        h: size,
        r: size * 0.44,
        rot: Math.random() * 360,
        sink: clamp((1 - scale) / (1 - BINNED_SCALE), 0, 1),
      });
      extras.push(item);
      // старые комки от входов уходят на дно корзины, чтобы стол не зарастал бумагой
      while (extras.length > EXTRA_BALLS) {
        const oldest = extras.find((ball) => ball.binned && ball !== item);
        if (!oldest) break;
        forget(oldest);
      }
      render(item);
      drop(item, bin, true);
    },
  };
}

// Зарубки карандашом: четыре вертикальные, пятая перечёркивает их наискосок. Ряды растут вверх
function createTally(svg) {
  let count = 0;
  const GROUP = 34;
  const ROW = 40;
  const PER_ROW = 4;
  const ROWS = 3;
  const wobble = () => Math.random() * 2 - 1;

  return {
    add() {
      if (!svg) return;
      const index = count;
      count += 1;
      const group = Math.floor(index / 5);
      const row = Math.floor(group / PER_ROW);
      if (row >= ROWS) return; // столько попаданий на столе уже не помещается — дальше счёт идёт молча
      const x0 = (group % PER_ROW) * GROUP + 6;
      const y0 = 120 - (row + 1) * ROW + 6;
      const mark = index % 5;
      const d = mark < 4
        ? `M${(x0 + mark * 7 + wobble()).toFixed(1)} ${(y0 + 1 + wobble()).toFixed(1)}`
          + `L${(x0 + mark * 7 - 2 + wobble()).toFixed(1)} ${(y0 + 29 + wobble()).toFixed(1)}`
        : `M${x0 - 5} ${y0 + 24}L${x0 + 27} ${y0 + 6}`;
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('pathLength', '1');
      svg.append(path);
      if (!calm()) {
        path.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 260, delay: 120, easing: 'ease-out', fill: 'backwards' });
      }
    },
  };
}
