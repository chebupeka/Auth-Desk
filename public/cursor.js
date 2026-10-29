// Курсор-рука: вместо системной стрелки по странице ходит фото руки. Вытянутый палец — обычный курсор,
// щепоть — пока зажата левая кнопка мыши, рука с ручкой — над полем ввода. Пока картинки не загрузились,
// без мыши (сенсорный экран) и если картинок нет, остаётся системный курсор.

const SWAP_MS = 140; // за это время рука «доезжает» до новой позы, чтобы предплечье не прыгало
const TYPING_KEYS = new Set(['Backspace', 'Delete']);

// поле, в котором можно писать: :read-write не ловит кнопки, флажки, readonly и disabled
const writable = (target) => target instanceof Element && target.matches(':read-write');

export async function initCursor({ node, calm = () => false }) {
  if (!node || !matchMedia('(any-hover: hover) and (any-pointer: fine)').matches) return;

  let poses;
  const images = {};
  const parts = [];
  try {
    const response = await fetch('/assets/cursor/cursor.json');
    if (!response.ok) return;
    ({ poses } = await response.json());
    for (const [name, pose] of Object.entries(poses)) {
      const img = new Image();
      img.alt = '';
      img.draggable = false;
      img.src = `/assets/cursor/${pose.file}`;
      // положение картинки относительно горячей точки, в долях ширины исходного кадра (--frame в CSS)
      const [hotX, hotY] = pose.hotspot;
      const [x, y, w, h] = pose.box;
      img.style.setProperty('--x', (x - hotX).toFixed(4));
      img.style.setProperty('--y', (y - hotY).toFixed(4));
      img.style.setProperty('--w', w);
      img.style.setProperty('--h', h);
      images[name] = img;

      // краска на кончиках пальцев (палец обмакнули в подушку, prints.js): пятно у горячей точки,
      // обрезанное по силуэту той же картинки, чтобы не вылезало за палец
      const ink = document.createElement('span');
      ink.className = 'cursor__ink';
      ink.style.cssText = img.style.cssText;
      ink.style.setProperty('--ink-mask', `url("${img.src}")`);
      ink.style.setProperty('--ink-at', `${(((hotX - x) / w) * 100).toFixed(1)}% ${(((hotY - y) / h) * 100).toFixed(1)}%`);
      parts.push(img, ink);
    }
    await Promise.all(Object.values(images).map((img) => img.decode()));
  } catch {
    return; // нет картинок — остаётся системный курсор
  }
  if (!images.pointer) return;

  const root = document.documentElement;
  const hand = document.createElement('div');
  hand.className = 'cursor__hand';
  hand.append(...parts);
  node.replaceChildren(hand);
  node.hidden = false;

  let pose = 'pointer';
  let pressed = null; // поза, которую держим, пока зажата кнопка: щепоть или ручка (если нажали в поле)
  let inside = false;
  let typing = false;
  images.pointer.classList.add('is-on');
  node.dataset.pose = pose;

  const render = () => node.classList.toggle('is-on', inside && !typing);

  function setPose(next) {
    if (next === pose || !images[next]) return;
    const [fromX, fromY] = poses[pose].hotspot;
    const [toX, toY] = poses[next].hotspot;
    images[pose].classList.remove('is-on');
    images[next].classList.add('is-on');
    node.dataset.pose = next;
    // все позы сняты одной камерой и предплечье в кадре на одном месте: новая поза появляется там,
    // где было предплечье, и доезжает, пока её горячая точка не окажется под указателем
    if (!calm()) {
      const frame = images[next].offsetWidth / poses[next].box[2];
      const dx = ((toX - fromX) * frame).toFixed(1);
      const dy = ((toY - fromY) * frame).toFixed(1);
      images[next].animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], {
        duration: SWAP_MS,
        easing: 'cubic-bezier(.3, .7, .4, 1)',
      });
    }
    pose = next;
  }

  const restingPose = (target) => (writable(target) ? 'pen' : 'pointer');

  document.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse') {
      inside = false;
      render();
      return;
    }
    node.style.transform = `translate3d(${event.clientX}px, ${event.clientY}px, 0)`;
    // Chrome шлёт pointermove и без движения (когда под неподвижной мышью меняется вёрстка)
    if (typing && (event.movementX || event.movementY)) typing = false;
    if (pressed && !(event.buttons & 1)) pressed = null; // кнопку отпустили за пределами окна
    setPose(pressed ?? restingPose(event.target));
    inside = true;
    // системный курсор прячем только сейчас: до первого движения мыши мы не знаем, где рисовать руку
    root.classList.add('has-hand-cursor');
    render();
  }, { capture: true, passive: true });

  document.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    pressed = writable(event.target) ? 'pen' : 'grab';
    setPose(pressed);
  }, { capture: true, passive: true });

  const release = (event) => {
    if (!pressed || event.pointerType !== 'mouse') return;
    pressed = null;
    setPose(restingPose(event.target));
  };
  document.addEventListener('pointerup', (event) => event.button === 0 && release(event), { capture: true, passive: true });
  document.addEventListener('pointercancel', release, { capture: true, passive: true });

  // указатель ушёл за окно
  document.addEventListener('pointerout', (event) => {
    if (event.relatedTarget) return;
    inside = false;
    render();
  }, { capture: true, passive: true });

  // Пока печатают, рука не закрывает поле (как системный курсор в Windows); вернётся, когда двинут мышь
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || !writable(event.target)) return;
    if (event.key.length !== 1 && !TYPING_KEYS.has(event.key)) return;
    typing = true;
    render();
  }, { capture: true, passive: true });
}
