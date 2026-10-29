// Черновик: переключение «вход / регистрация», отправка формы и бумажные анимации
import { initDesk } from './desk.js';
import { initCursor } from './cursor.js';
import { initPrints } from './prints.js';
import { initDoodles } from './doodles.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const BALL_FILL = 0.9; // доля картинки ball-ruled.webp, которую занимает сам комок (в среднем по ширине и высоте)
const LOGIN_PATTERN = /^[\p{L}\p{N}_.-]+$/u;
const LOGIN_MIN = 3;
const LOGIN_MAX = 32;
const PASSWORD_MIN = 4;

const MODES = {
  login: {
    title: 'Вход',
    hint: 'впишите свои данные',
    submit: 'Войти',
    question: 'Нет аккаунта?',
    switchTo: 'Зарегистрироваться',
    autocomplete: 'current-password',
    endpoint: '/api/login',
    pageTitle: 'Черновик · вход',
  },
  register: {
    title: 'Регистрация',
    hint: 'заведите новую страницу',
    submit: 'Создать',
    question: 'Уже есть аккаунт?',
    switchTo: 'Войти',
    autocomplete: 'new-password',
    endpoint: '/api/register',
    pageTitle: 'Черновик · регистрация',
  },
};

const $ = (selector) => document.querySelector(selector);

const el = {
  scene: $('#scene'),
  notebook: $('#notebook'),
  crumple: $('#crumple'),
  stack: $('#stack'),
  sheet: $('#sheet'),
  creases: $('#creases'),
  tapes: [...document.querySelectorAll('.tape')],
  tabs: [...document.querySelectorAll('.tab')],
  form: $('#form'),
  title: $('#title'),
  hint: $('#hint'),
  login: $('#login'),
  password: $('#password'),
  password2: $('#password2'),
  repeatField: $('#repeatField'),
  formError: $('#formError'),
  submit: $('#submit'),
  submitText: $('#submitText'),
  question: $('#question'),
  switchBtn: $('#switchBtn'),
  peek: $('#peek'),
  fillTest: $('#fillTest'),
  sticky: $('#sticky'),
  approved: $('#approved'),
  ball: $('#flyingBall'),
  hand: $('#hand'),
  deskStamp: $('#deskStamp'),
  welcome: $('#welcome'),
  welcomeTitle: $('#welcomeTitle'),
  welcomeSvg: $('#welcomeSvg'),
  welcomeWord: $('#welcomeWord'),
  welcomeUnderline: $('#welcomeUnderline'),
  logout: $('#logout'),
  logoutError: $('#logoutError'),
  confetti: $('#confetti'),
  displacement: $('#fx-crumple feDisplacementMap'),
  marks: $('#marks'),
  marginNotes: $('#marginNotes'),
  lockout: $('#lockout'),
  lockoutTapes: [...document.querySelectorAll('.lockout__tape')],
  lockoutWords: [...document.querySelectorAll('.lockout__word')],
  lockoutCount: $('#lockoutCount'),
  lockoutStatus: $('#lockoutStatus'),
  weakNote: $('#weakNote'),
  weakPaper: $('#weakNote .desk-note__paper'),
  weakRemark: $('#weakNote .desk-note__remark'),
  inkPad: $('.desk-item--pad'),
  approvedInk: $('#approvedInk'),
  welcomeHello: $('#welcomeHello'),
};

const FIELDS = { login: el.login, password: el.password, password2: el.password2 };

const state = {
  mode: 'login',
  busy: false,
  switching: false,
  filling: false,
  locked: false, // лист заклеен скотчем после 5 неверных паролей
  wrongTries: 0, // неверные пароли на этом листе — по ним пишутся пометки на полях
  scolded: '', // слабый пароль, за который записка уже «отругала»
  user: null, // кто вошёл: { id, login }
  welcomeLayout: null,
};

// Модули стола и листа: появляются после загрузки (boot)
let desk = null;
let doodles = null;

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const calm = () => reducedMotion.matches;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const random = (min, max) => min + Math.random() * (max - min);

// Плавное изменение числа по кадрам (для атрибутов SVG-фильтра, которые CSS не анимирует)
function tween(duration, onFrame) {
  return new Promise((resolve) => {
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      onFrame(t);
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

/* ---------- Бумага ---------- */

// Текстуры и шрифты, без которых первый кадр выглядит «голым»
const PAPER_IMAGES = [
  '/assets/desk-kraft.webp',
  '/assets/sheet-soft.webp',
  '/assets/sheet-crumpled.webp',
  '/assets/creases.webp',
  '/assets/sticky-note.webp',
  innerWidth / innerHeight < 1 ? '/assets/welcome-portrait.webp' : '/assets/welcome-landscape.webp',
];

// Шрифты первого экрана. load() без текста проверяет только пробел и грузит один латинский файл,
// поэтому даём образец с кириллицей: иначе подсказка «впишите свои данные» показывалась, пока
// PT Mono ещё не пришёл, — запасным Courier New
const PAPER_FONTS = [
  ['600 25px "Caveat"', 'Вход Логин: test'],
  ['13px "PT Mono"', 'впишите свои данные test •'],
  ['600 23px "Oswald"', 'ВОЙТИ'],
];

// Ждём загрузки, но не дольше timeout: медленная картинка не должна держать форму скрытой
function preparePaper(timeout = 1500) {
  const images = PAPER_IMAGES.map((src) => {
    const img = new Image();
    img.src = src;
    return img.decode().catch(() => {});
  });
  const fonts = document.fonts ? PAPER_FONTS.map(([font, text]) => document.fonts.load(font, text).catch(() => {})) : [];
  return Promise.race([Promise.all([...images, ...fonts]), wait(timeout)]);
}

// Chrome при загрузке подставляет сохранённые логин и пароль «подсказкой»: текст виден, но в поле
// его ещё нет (value пустое до первого действия человека), а рисуется он системным шрифтом, который
// стилями страницы не поправить. Обновление страницы — чистый лист, поэтому такую подсказку убираем;
// сохранённый пароль браузер всё равно предложит по щелчку на поле. Возвращает проверку «на сейчас».
function dropAutofillPreview() {
  let touched = false;
  const touch = () => { touched = true; };
  addEventListener('pointerdown', touch, { capture: true, once: true });
  addEventListener('keydown', touch, { capture: true, once: true });

  const clear = (input) => {
    if (touched || input.value !== '') return; // настоящее значение (Firefox, Safari) не трогаем
    input.value = ' '; // смена значения сбрасывает и подсказку браузера
    input.value = '';
  };
  // style.css запускает анимацию autofill-on, как только поле стало :-webkit-autofill
  el.form.addEventListener('animationstart', (event) => {
    if (event.animationName === 'autofill-on' && event.target.name in FIELDS) clear(event.target);
  });
  return () => {
    for (const input of Object.values(FIELDS)) {
      try {
        if (input.matches(':-webkit-autofill')) clear(input);
      } catch {
        // браузер не знает такого псевдокласса — значит, и подсказок таких не делает
      }
    }
  };
}

/* ---------- Режимы ---------- */

// Новый лист — чистый: отпечатки, каракули и пометки на полях уходят вместе со старым
function clearSheet() {
  el.marks.replaceChildren();
  el.marginNotes.replaceChildren();
  state.wrongTries = 0;
  doodles?.reset();
}

function applyMode(mode) {
  const m = MODES[mode];
  clearSheet();
  state.mode = mode;
  el.title.textContent = m.title;
  el.hint.textContent = m.hint;
  el.submitText.textContent = m.submit;
  el.question.textContent = m.question;
  el.switchBtn.textContent = m.switchTo;
  el.password.autocomplete = m.autocomplete;
  el.form.action = m.endpoint;
  el.repeatField.hidden = mode !== 'register';
  el.password2.required = mode === 'register';
  document.title = m.pageTitle;

  for (const tab of el.tabs) {
    const active = tab.dataset.mode === mode;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  el.sheet.setAttribute('aria-labelledby', `tab-${mode}`);
  clearErrors();
}

const MODE_ORDER = ['login', 'register'];

// Можно ли сейчас сменить лист: не во время запроса, сминания, автозаполнения или перерыва
const canSwitch = () => !state.busy && !state.switching && !state.filling && !state.locked;

async function switchMode(mode, { focusLogin = false } = {}) {
  if (mode === state.mode || !canSwitch()) return;
  await changeMode(mode);
  if (focusLogin) el.login.focus();
}

// Без проверок: вызывающий сам решает, можно ли менять режим
function changeMode(mode) {
  if (mode === state.mode) return Promise.resolve();
  if (calm()) {
    applyMode(mode);
    return Promise.resolve();
  }
  const forward = MODE_ORDER.indexOf(mode) > MODE_ORDER.indexOf(state.mode);
  state.turn = tearOffPage(() => applyMode(mode), forward);
  return state.turn;
}

// Неживая копия листа для анимации: без id и name, вне фокуса и дерева доступности
function snapshotSheet() {
  const copy = el.sheet.cloneNode(true);
  copy.removeAttribute('id');
  copy.removeAttribute('role');
  copy.removeAttribute('aria-labelledby');
  for (const node of copy.querySelectorAll('[id], [name]')) {
    node.removeAttribute('id');
    node.removeAttribute('name');
  }
  copy.setAttribute('aria-hidden', 'true');
  copy.inert = true;
  return copy;
}

// Смена режима: верхний лист выдёргивают из-под скотча, сминают и бросают со стола,
// а под ним уже лежит чистый лист с новой формой. Скотч остаётся на месте и держит новый лист.
// Высота листа в обоих режимах одинаковая, поэтому вокруг ничего не сдвигается.
async function tearOffPage(update, forward) {
  state.switching = true;
  const width = el.sheet.offsetWidth;
  const height = el.sheet.offsetHeight;
  const torn = snapshotSheet();
  update();

  // SVG-фильтр висит на обёртке, а не на самом листе: так коробится и край смятого листа
  const wad = document.createElement('div');
  wad.className = 'wad';
  Object.assign(wad.style, { width: `${width}px`, height: `${height}px` });
  wad.append(torn);
  el.stack.append(wad);

  const DURATION = 640;
  const END_SCALE = 0.22;
  const END_CLIP = 0.3;
  const TUG = 0.16; // доля, за которую лист отрывается от скотча
  const timing = { duration: DURATION, easing: 'cubic-bezier(.45, 0, .25, 1)', fill: 'forwards' };

  const crumple = torn.animate(
    [
      { transform: 'translateY(0) rotate(0deg) scale(1)', clipPath: 'circle(100% at 50% 50%)' },
      { transform: 'translateY(-10px) rotate(-1.5deg) scale(1.015)', clipPath: 'circle(100% at 50% 50%)', offset: TUG },
      { transform: 'translateY(-6px) rotate(5deg) scale(.62)', clipPath: 'circle(52% at 50% 50%)', offset: 0.55 },
      { transform: `translateY(0) rotate(-12deg) scale(${END_SCALE})`, clipPath: `circle(${END_CLIP * 100}% at 50% 50%)` },
    ],
    timing,
  );
  torn.querySelector('.sheet__creases').animate([{ opacity: 0 }, { opacity: 0.6, offset: 0.4 }, { opacity: 1 }], timing);
  // скотч дёргается, когда из-под него вырывают лист
  for (const tape of el.tapes) {
    tape.animate([{ translate: '0 0' }, { translate: '0 -2px' }, { translate: '0 0' }], { duration: 220, delay: 60, easing: 'ease-out' });
  }

  try {
    // лист поднимают над столом (тень уходит дальше), потом он мнётся
    await tween(DURATION, (t) => {
      const lift = Math.min(1, t / 0.25);
      const u = Math.max(0, (t - TUG) / (1 - TUG));
      el.displacement.setAttribute('scale', (Math.sin((u * Math.PI) / 2) * 55 * (1 - 0.55 * u)).toFixed(1));
      wad.style.filter = `url(#fx-crumple) drop-shadow(0 ${(2 + 8 * lift).toFixed(1)}px ${(3 + 9 * lift).toFixed(1)}px rgb(70 50 15 / ${(0.15 + 0.2 * lift).toFixed(2)}))`;
    });
    await crumple.finished;

    const box = wad.getBoundingClientRect();
    const reference = Math.hypot(width, height) / Math.SQRT2;
    throwAway({ x: box.left + box.width / 2, y: box.top + box.height / 2, diameter: 2 * END_CLIP * reference * END_SCALE }, forward ? 1 : -1);
    await wad.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' }).finished;
  } catch {
    // анимацию отменили — просто убираем смятый лист
  } finally {
    wad.remove();
    el.displacement.setAttribute('scale', '0');
    state.switching = false;
  }
}

// Комок подменяет смятый лист: того же размера и в той же точке
function placeBall(ball, { x, y, diameter }) {
  const size = diameter / BALL_FILL;
  Object.assign(ball.style, {
    width: `${size}px`,
    height: `${size}px`,
    left: `${x - size / 2}px`,
    top: `${y - size / 2}px`,
  });
  return size;
}

// Комок от сменённого листа летит по невысокой дуге за край стола: side = 1 — вправо, -1 — влево
function throwAway(spot, side) {
  const ball = Object.assign(new Image(), { className: 'flying-ball', src: '/assets/ball-ruled.webp', alt: '' });
  ball.setAttribute('aria-hidden', 'true');
  const size = placeBall(ball, spot);
  document.body.append(ball);

  const dx = side * (innerWidth / 2 + size);
  const rise = innerHeight * 0.55;
  const gravity = innerHeight * 0.75;
  const keyframes = [{ transform: 'translate(0, 0) rotate(0deg) scale(1)', opacity: 0 }];
  for (let i = 1; i <= 10; i += 1) {
    const u = i / 10;
    keyframes.push({
      transform: `translate(${(dx * u).toFixed(1)}px, ${(-rise * u + gravity * u * u).toFixed(1)}px) `
        + `rotate(${(side * 620 * u).toFixed(0)}deg) scale(${(1 - 0.25 * u).toFixed(3)})`,
      opacity: 1,
    });
  }
  ball.animate(keyframes, { duration: 800, fill: 'forwards' }).finished
    .catch(() => {})
    .then(() => ball.remove());
}

/* ---------- Ошибки ---------- */

function setFieldError(name, message) {
  const input = FIELDS[name];
  if (!input) return false;
  input.closest('.field').dataset.invalid = '';
  input.setAttribute('aria-invalid', 'true');
  document.getElementById(`${name}-error`).textContent = message;
  return true;
}

function clearFieldError(name) {
  const input = FIELDS[name];
  if (!input) return;
  delete input.closest('.field').dataset.invalid;
  input.removeAttribute('aria-invalid');
  document.getElementById(`${name}-error`).textContent = '';
}

function clearErrors() {
  for (const name of Object.keys(FIELDS)) clearFieldError(name);
  el.formError.textContent = '';
}

function validate() {
  const errors = {};
  const login = loginValue();
  const password = el.password.value;

  if (!login) errors.login = 'впишите логин';
  if (!password) errors.password = 'впишите пароль';

  if (state.mode === 'register') {
    const length = [...login].length;
    if (login && (length < LOGIN_MIN || length > LOGIN_MAX)) errors.login = `от ${LOGIN_MIN} до ${LOGIN_MAX} символов`;
    else if (login && !LOGIN_PATTERN.test(login)) errors.login = 'только буквы, цифры и _ . -';
    if (password && password.length < PASSWORD_MIN) errors.password = `минимум ${PASSWORD_MIN} символа`;
    if (!el.password2.value) errors.password2 = 'повторите пароль';
    else if (password && el.password2.value !== password) errors.password2 = 'пароли не совпадают';
  }
  return errors;
}

function shake() {
  if (calm()) return;
  el.stack.animate(
    [
      { transform: 'none' },
      { transform: 'translateX(-9px) rotate(-1.2deg)' },
      { transform: 'translateX(8px) rotate(.9deg)' },
      { transform: 'translateX(-5px) rotate(-.5deg)' },
      { transform: 'translateX(2px) rotate(.2deg)' },
      { transform: 'none' },
    ],
    { duration: 460, easing: 'ease-out' },
  );
}

// Неверный пароль зачёркивается красной ручкой и стирается — если его ещё не начали
// исправлять. Возвращает true, если поле очищено.
async function strikeOut(input) {
  const field = input.closest('.field');
  const struck = input.value;
  field.classList.add('is-struck');
  await wait(calm() ? 0 : 650);
  field.classList.remove('is-struck');
  if (input.value !== struck) return false;
  input.value = '';
  return true;
}

/* ---------- Отправка ---------- */

function setBusy(busy) {
  state.busy = busy;
  el.submit.disabled = busy;
  el.form.setAttribute('aria-busy', String(busy));
  el.submitText.textContent = busy ? 'Минутку…' : MODES[state.mode].submit;
}

// Логин сравниваем так же, как сервер: без пробелов по краям и в форме NFC
const loginValue = () => el.login.value.trim().normalize('NFC');

async function onSubmit(event) {
  event.preventDefault();
  if (state.busy || state.switching || state.filling || state.locked) return;
  clearErrors();

  const errors = validate();
  const invalid = Object.keys(FIELDS).filter((name) => errors[name]);
  if (invalid.length) {
    for (const name of invalid) setFieldError(name, errors[name]);
    FIELDS[invalid[0]].focus();
    shake();
    return;
  }

  if (state.mode === 'register') scold(); // слабый пароль не запрещён, но записка на столе всё помнит

  setBusy(true);
  let response;
  let body = {};
  try {
    response = await fetch(MODES[state.mode].endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: loginValue(), password: el.password.value }),
    });
    body = await response.json().catch(() => ({}));
  } catch {
    setBusy(false);
    el.formError.textContent = 'Сервер не отвечает — он запущен?';
    shake();
    return;
  }

  if (!response.ok) {
    setBusy(false);
    onFailure(response, body);
    return;
  }

  await celebrate(body.user ?? { login: loginValue() });
}

function onFailure(response, body) {
  const { status } = response;
  // перерыв вместо текста ошибки: лист заклеивают скотчем
  if (status === 429) {
    lockOut(retryAfter(response, body), body.error);
    return;
  }

  const message = body.error || 'Что-то пошло не так, попробуйте ещё раз';
  if (!(body.field && setFieldError(body.field, message))) el.formError.textContent = message;
  shake();

  if (status === 401) {
    markWrong();
    strikeOut(el.password).then((cleared) => {
      // не перетаскиваем фокус, если человек уже ушёл в другое поле или снова отправил форму
      const idle = document.activeElement === el.password || document.activeElement === document.body;
      if (cleared && idle && !state.busy) el.password.focus();
    });
  } else {
    (FIELDS[body.field] ?? el.login).focus();
  }
}

/* ---------- Работа над ошибками: красная ручка на полях ---------- */

// Обвести двойку: первый круг и, если ошиблись снова, второй — поверх
const GRADE_RINGS = [
  'M31 9C23 1 7 5 4 20C1 35 13 47 27 45C41 43 46 27 39 14C36 9 31 7 26 7',
  'M12 7C22 0 39 4 42 19C45 35 32 48 17 44C5 41 1 25 9 13',
];

function writeMarginNote(text, top, tilt) {
  const note = Object.assign(document.createElement('span'), { className: 'margin-note', textContent: text });
  note.style.top = `${top}px`;
  note.style.setProperty('--tilt', `${tilt}deg`);
  el.marginNotes.append(note);
  if (!calm()) {
    // пишется слева направо, пока зачёркивается пароль
    note.animate([{ clipPath: 'inset(-30% 100% -30% 0)' }, { clipPath: 'inset(-30% -10% -30% 0)' }], {
      duration: 420, delay: 250, easing: 'ease-in-out', fill: 'backwards',
    });
  }
  return note;
}

function ringGrade(index) {
  const grade = el.marginNotes.querySelector('.margin-note--grade');
  if (!grade || index >= GRADE_RINGS.length) return;
  const ring = document.createElementNS(SVG_NS, 'svg');
  ring.setAttribute('class', 'margin-note__ring');
  ring.setAttribute('viewBox', '0 0 46 52');
  ring.style.rotate = `${index * 14 - 4}deg`;
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', GRADE_RINGS[index]);
  path.setAttribute('pathLength', '1');
  ring.append(path);
  grade.append(ring);
  if (!calm()) {
    path.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], {
      duration: 420, delay: index ? 250 : 650, easing: 'ease-in-out', fill: 'backwards',
    });
  }
}

// Неверный пароль: на полях у строки «Пароль» — «неверно», потом ниже «см. выше», потом обведённая «2»
function markWrong() {
  state.wrongTries += 1;
  const top = el.form.offsetTop + el.password.closest('.field').offsetTop; // строка «Пароль» в координатах листа
  if (state.wrongTries === 1) {
    writeMarginNote('неверно', top + 6, -7);
  } else if (state.wrongTries === 2) {
    writeMarginNote('см. выше', top + 58, -4);
  } else if (state.wrongTries === 3) {
    writeMarginNote('2', top + 84, 4).classList.add('margin-note--grade');
    ringGrade(0);
  } else {
    ringGrade(state.wrongTries - 3);
  }
}

/* ---------- Перерыв после 5 неверных паролей: лист заклеен крест-накрест ---------- */

// Сколько ждать: сервер пишет это в Retry-After, а на всякий случай и в тексте ошибки
function retryAfter(response, body) {
  const header = Number(response.headers.get('Retry-After'));
  const inText = Number(/\d+/.exec(body.error ?? '')?.[0]);
  const seconds = header > 0 ? header : inText > 0 ? inText : 60;
  return Math.min(3600, Math.ceil(seconds));
}

// Скотч шлёпают на лист полоса за полосой (лист чуть проседает), потом ручкой пишут на нём
function tapeOn() {
  if (calm()) return Promise.resolve();
  const [first, second] = el.lockoutTapes;
  const slap = (tape, delay) => tape.animate(
    [
      { opacity: 0, scale: '1.16', rotate: '-4deg' },
      { opacity: 1, scale: '.98', rotate: '0deg', offset: 0.7 },
      { opacity: 1, scale: '1', rotate: '0deg' },
    ],
    { duration: 260, delay, easing: 'cubic-bezier(.3, .7, .4, 1)', fill: 'backwards' },
  ).finished;
  const press = (delay) => el.stack.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(.988) translateY(2px)' }, { transform: 'scale(1)' }],
    { duration: 200, delay, easing: 'ease-out' },
  );
  const write = (word, delay) => word.animate(
    [{ clipPath: 'inset(-40% 100% -40% 0)' }, { clipPath: 'inset(-40% -10% -40% 0)' }],
    { duration: 520, delay, easing: 'ease-in-out', fill: 'backwards' },
  ).finished;
  press(170);
  press(410);
  return Promise.all([slap(first, 0), slap(second, 240), write(el.lockoutWords[0], 560), write(el.lockoutWords[1], 860)])
    .catch(() => {});
}

// Время вышло — полосы отклеивают за верхние концы и уносят
async function tapeOff() {
  if (calm()) return;
  const peel = (tape, side, delay) => {
    const strip = tape.querySelector('.lockout__strip');
    strip.style.transformOrigin = side < 0 ? 'right center' : 'left center';
    return strip.animate(
      [
        { transform: 'none', opacity: 1 },
        { transform: `perspective(700px) rotateY(${-side * 34}deg)`, opacity: 1, offset: 0.35 },
        { transform: `perspective(700px) translateX(${side * 38}%) rotateY(${-side * 70}deg) rotate(${-side * 6}deg)`, opacity: 0 },
      ],
      { duration: 700, delay, easing: 'cubic-bezier(.5, 0, .75, .8)', fill: 'forwards' },
    ).finished;
  };
  const [first, second] = el.lockoutTapes;
  await Promise.all([peel(second, 1, 0), peel(first, -1, 180)]).catch(() => {});
}

async function lockOut(seconds, message) {
  if (state.locked) return;
  state.locked = true;
  const deadline = performance.now() + seconds * 1000;
  const left = () => Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
  const show = () => { el.lockoutCount.textContent = `${left()} сек`; };

  for (const node of [...el.lockoutTapes, ...el.lockout.querySelectorAll('.lockout__strip')]) {
    for (const animation of node.getAnimations()) animation.cancel();
  }
  show();
  el.form.inert = true;
  el.lockout.hidden = false;
  el.lockout.focus({ preventScroll: true });
  // текст в живую область — когда она уже видна, иначе экранный диктор его пропустит
  setTimeout(() => { el.lockoutStatus.textContent = message || `Слишком много попыток. Подождите ${seconds} сек.`; }, 100);

  const countdown = new Promise((resolve) => {
    const timer = setInterval(() => {
      show();
      if (left() > 0) return;
      clearInterval(timer);
      resolve();
    }, 250);
  });
  await tapeOn();
  await countdown;

  el.lockoutStatus.textContent = 'Можно попробовать снова';
  await tapeOff();
  el.lockout.hidden = true;
  el.form.inert = false;
  state.locked = false;
  el.password.focus();
  el.password.select();
}

/* ---------- Записка с «qwerty 123456» всё помнит ---------- */

const WEAK_PASSWORDS = new Set([
  'qwerty', '123456', '1234', '12345', '1234567', '12345678', '123456789', '1234567890', '111111', '000000',
  '123123', '654321', 'qwerty123', 'qwertyuiop', 'password', 'пароль', 'йцукен', 'abc123', '1q2w3e', '1q2w3e4r',
]);
const isWeak = (password) => WEAK_PASSWORDS.has(password.trim().toLowerCase());
let scoldTimer = 0;

// При регистрации ввели пароль из записки: записка вздрагивает, и на ней красной ручкой
// появляется «я же говорил!». За один и тот же пароль — один раз
function scold() {
  clearTimeout(scoldTimer);
  const password = el.password.value.trim().toLowerCase();
  if (state.mode !== 'register' || !isWeak(password) || state.scolded === password) return;
  if (!el.weakNote?.offsetWidth) return; // на узком экране записки нет
  state.scolded = password;
  const first = !el.weakRemark.classList.contains('is-on');
  el.weakRemark.classList.add('is-on');
  if (calm()) return;

  el.weakPaper.animate(
    [
      { transform: 'none' },
      { transform: 'translateY(-9px) rotate(-3deg) scale(1.04)', offset: 0.18 },
      { transform: 'translateY(2px) rotate(2deg)', offset: 0.4 },
      { transform: 'translateY(-2px) rotate(-1.2deg)', offset: 0.62 },
      { transform: 'rotate(.5deg)', offset: 0.82 },
      { transform: 'none' },
    ],
    { duration: 560, easing: 'ease-out' },
  );
  if (first) {
    el.weakRemark.animate([{ clipPath: 'inset(-30% 100% -30% 0)' }, { clipPath: 'inset(-30% -10% -30% 0)' }], {
      duration: 650, delay: 380, easing: 'ease-in-out', fill: 'backwards',
    });
  } else {
    el.weakRemark.animate([{ scale: '1' }, { scale: '1.18' }, { scale: '1' }], { duration: 420, delay: 300, easing: 'ease-out' });
  }
}

// Пока пароль печатают, ждём паузу: «1234» по пути к «12345678» записку не дёргает
function watchWeakPassword() {
  clearTimeout(scoldTimer);
  if (!isWeak(el.password.value)) {
    state.scolded = '';
    return;
  }
  scoldTimer = setTimeout(scold, 500);
}

/* ---------- Тестовые данные со стикера ---------- */

async function typeInto(input, text) {
  input.value = '';
  if (calm()) {
    input.value = text;
    return;
  }
  input.focus();
  for (const char of text) {
    input.value += char;
    await wait(random(60, 130));
  }
}

async function fillTestCredentials() {
  if (state.busy || state.filling || state.locked) return;
  state.filling = true;
  try {
    // если лист ещё сминается, дожидаемся и смотрим, где оказались
    await state.turn?.catch(() => {});
    if (state.mode !== 'login') await changeMode('login');
    clearErrors();
    await typeInto(el.login, 'test');
    await typeInto(el.password, 'test');
    el.submit.focus();
  } finally {
    state.filling = false;
  }
}

function setPasswordVisible(visible) {
  const type = visible ? 'text' : 'password';
  el.password.type = type;
  el.password2.type = type;
  // название кнопки постоянное, состояние передаёт только aria-pressed
  el.peek.setAttribute('aria-pressed', String(visible));
}

/* ---------- Успешный вход: штамп → комок → «Вы вошли» ---------- */

async function celebrate(user) {
  state.user = user;
  el.scene.inert = true;
  el.submitText.textContent = MODES[state.mode].submit;
  setImprint(user);

  if (calm()) {
    await showWelcome();
    return;
  }

  if (hand.meta) await stampWithHand();
  else await stampApproved();
  dropSticky();
  const ball = await crumpleSheet();
  // в корзину комок летит дольше: «Вы вошли» опускается, когда он уже над ней
  const intoBasket = tossBall(ball);
  await wait(intoBasket ? 700 : 420);
  await showWelcome();
}

// Оттиск: при входе «Принято», при регистрации — «Новый лист № 0042» с номером нового пользователя
function setImprint(user) {
  const fresh = state.mode === 'register' && Number.isInteger(user?.id);
  el.approved.classList.toggle('approved--sheet', fresh);
  if (!fresh) {
    el.approvedInk.textContent = 'Принято';
    return;
  }
  const line = (className, text) => Object.assign(document.createElement('span'), { className, textContent: text });
  el.approvedInk.replaceChildren(
    line('approved__line', 'Новый лист'),
    line('approved__num', `№ ${String(user.id).padStart(4, '0')}`),
  );
}

const stampTilt = () => parseFloat(getComputedStyle(el.approved).getPropertyValue('--tilt')) || 0;

// Оттиск появляется сразу, лист чуть проседает под штампом
function printImprint() {
  el.approved.animate([{ opacity: 0 }, { opacity: 0.92 }], { duration: 60, fill: 'forwards' });
  el.stack.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(.982) translateY(2px)' }, { transform: 'scale(1)' }],
    { duration: 220, easing: 'ease-out' },
  );
}

// Запасной вариант без руки: штамп «падает» на лист сверху
async function stampApproved() {
  const base = `translate(-50%, -50%) rotate(${stampTilt()}deg)`;
  el.approved.animate(
    [
      { opacity: 0, transform: `${base} scale(2.8)` },
      { opacity: 0.95, transform: `${base} scale(.93)`, offset: 0.7 },
      { opacity: 0.9, transform: `${base} scale(1)` },
    ],
    { duration: 380, easing: 'cubic-bezier(.3, .6, .4, 1)', fill: 'forwards' },
  );
  await wait(270);
  el.stack.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(.982) translateY(2px)' }, { transform: 'scale(1)' }],
    { duration: 220, easing: 'ease-out' },
  );
  await wait(650);
}

/* ---------- Рука со штампом: покадровая анимация с псевдо-3D ---------- */

const hand = { meta: null, frames: {} };
const HAND_DURATION = 1700;
const IMPRINT_SHARE = 0.9; // оттиск чуть уже деревянного основания штампа
// какой кадр показывать с какого момента (доля длительности)
const HAND_SCHEDULE = [[0, 'blur'], [0.2, 'raised'], [0.42, 'pressing'], [0.5, 'rock'], [0.56, 'pressing'], [0.63, 'lift'], [0.82, 'blur']];
const HAND_CONTACT = 0.42;

// Кадры грузятся в фоне; пока их нет (или нет hand.json), работает штамп без руки
async function prepareHand() {
  try {
    const response = await fetch('/assets/hand/hand.json');
    if (!response.ok) return;
    const meta = await response.json();
    const frames = Object.entries(meta.frames).map(([name, file]) => {
      const img = new Image();
      img.alt = '';
      img.src = `/assets/hand/${file}`;
      return [name, img];
    });
    await Promise.all(frames.map(([, img]) => img.decode()));
    el.hand.replaceChildren(...frames.map(([, img]) => img));
    hand.frames = Object.fromEntries(frames);
    hand.meta = meta;
  } catch {
    hand.meta = null;
  }
}

function showHandFrame(name) {
  for (const [key, img] of Object.entries(hand.frames)) img.classList.toggle('is-on', key === name);
}

// Рука прилетает из правого нижнего угла по направлению предплечья, зависает над листом,
// опускается, ставит штамп, покачивает его и уходит. Объём даёт масштаб (высота над листом)
// и тень по силуэту руки: чем выше рука, тем тень дальше, крупнее и мягче.
async function stampWithHand() {
  const { meta } = hand;
  const tilt = stampTilt();
  const box = el.approved.getBoundingClientRect();
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const width = el.approved.offsetWidth / IMPRINT_SHARE / meta.baseShare;
  const height = (width * meta.size[1]) / meta.size[0];
  const ox = meta.anchor[0] * width;
  const oy = meta.anchor[1] * height;
  Object.assign(el.hand.style, {
    width: `${width}px`,
    height: `${height}px`,
    left: `${cx - ox}px`,
    top: `${cy - oy}px`,
    transformOrigin: `${ox}px ${oy}px`,
  });

  // предплечье в кадре идёт под 45° вниз-вправо, плюс наклон штампа
  const direction = ((45 + tilt) * Math.PI) / 180;
  const distance = (innerHeight - cy + oy * 1.4 + 40) / Math.sin(direction);
  const awayX = Math.cos(direction) * distance;
  const awayY = Math.sin(direction) * distance;
  const pose = (scale, away = 0) =>
    `translate(${(awayX * away).toFixed(1)}px, ${(awayY * away).toFixed(1)}px) rotate(${tilt}deg) scale(${scale})`;
  const shadow = (x, y, blur, alpha) => `drop-shadow(${x}px ${y}px ${blur}px rgb(40 26 8 / ${alpha}))`;
  const FAR = shadow(70, 92, 30, 0.16);
  const HIGH = shadow(40, 54, 22, 0.24);
  const LOW = shadow(6, 8, 5, 0.36);
  const approach = 'cubic-bezier(.2, .7, .3, 1)';
  const drop = 'cubic-bezier(.6, 0, .9, .5)';

  showHandFrame('blur');
  el.hand.hidden = false;
  const flight = el.hand.animate(
    [
      { offset: 0, transform: pose(1.32, 1), filter: FAR, easing: approach },
      { offset: 0.26, transform: pose(1.22), filter: HIGH },
      { offset: 0.32, transform: pose(1.22), filter: HIGH, easing: drop },
      { offset: HAND_CONTACT, transform: pose(1), filter: LOW },
      { offset: 0.45, transform: pose(0.985), filter: LOW },
      { offset: 0.5, transform: pose(1), filter: LOW },
      { offset: 0.62, transform: pose(1), filter: LOW, easing: approach },
      { offset: 0.74, transform: pose(1.18), filter: HIGH },
      { offset: 0.78, transform: pose(1.18), filter: HIGH, easing: drop },
      { offset: 1, transform: pose(1.34, 1), filter: FAR },
    ],
    { duration: HAND_DURATION, fill: 'forwards' },
  );

  // штамп со стола «забрала» рука
  el.deskStamp?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, fill: 'forwards' });

  let stamped = false;
  const sync = () => {
    const progress = (flight.currentTime ?? 0) / HAND_DURATION;
    showHandFrame(HAND_SCHEDULE.reduce((frame, [at, name]) => (progress >= at ? name : frame), 'blur'));
    if (!stamped && progress >= HAND_CONTACT) {
      stamped = true;
      printImprint();
    }
    if (flight.playState === 'running') requestAnimationFrame(sync);
  };
  requestAnimationFrame(sync);

  await flight.finished.catch(() => {});
  if (!stamped) printImprint();
  el.hand.hidden = true;
  flight.cancel();
}

function dropSticky() {
  el.sticky.animate(
    [{ transform: `translate(${random(20, 60)}px, 115vh) rotate(${random(30, 70)}deg)` }],
    { duration: 950, easing: 'cubic-bezier(.55, 0, .85, .55)', fill: 'forwards' },
  );
}

// Сминание: лист сжимается в круг, проступают складки, а SVG-фильтр коробит содержимое
async function crumpleSheet() {
  const DURATION = 1100;
  const END_SCALE = 0.24;
  const END_CLIP = 0.3;

  el.crumple.style.filter = 'url(#fx-crumple)';
  el.creases.animate([{ opacity: 0 }, { opacity: 0.55, offset: 0.35 }, { opacity: 1 }], {
    duration: DURATION * 0.8, easing: 'ease-in', fill: 'forwards',
  });

  const shrink = el.stack.animate(
    [
      { transform: 'scale(1) rotate(0deg)', clipPath: 'circle(100% at 50% 50%)' },
      { transform: 'scale(.86) rotate(-3deg)', clipPath: 'circle(68% at 50% 50%)', offset: 0.3 },
      { transform: 'scale(.5) rotate(6deg)', clipPath: 'circle(42% at 50% 50%)', offset: 0.65 },
      { transform: `scale(${END_SCALE}) rotate(18deg)`, clipPath: `circle(${END_CLIP * 100}% at 50% 50%)` },
    ],
    { duration: DURATION, easing: 'cubic-bezier(.5, 0, .3, 1)', fill: 'forwards' },
  );

  await tween(DURATION, (t) => {
    const ease = Math.sin((t * Math.PI) / 2);
    el.displacement.setAttribute('scale', (ease * 60 * (1 - 0.6 * t)).toFixed(1));
  });
  await shrink.finished;

  const box = el.crumple.getBoundingClientRect();
  const reference = Math.hypot(el.stack.offsetWidth, el.stack.offsetHeight) / Math.SQRT2;
  return {
    x: box.left + box.width / 2,
    y: box.top + box.height / 2,
    diameter: 2 * END_CLIP * reference * END_SCALE,
  };
}

// Комок подменяет смятый лист и летит по дуге в корзину на столе и остаётся в ней,
// а если корзины нет (узкий экран) — за край экрана. true — летит в корзину
function tossBall(spot) {
  const size = placeBall(el.ball, spot);

  el.crumple.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });

  const target = desk?.basketTarget();
  if (target) {
    const END_SCALE = 0.7; // над корзиной комок уже ниже и дальше от глаз
    const dx = target.x - spot.x;
    const dy = target.y - spot.y;
    const rise = Math.max(160, innerHeight * 0.32);
    const keyframes = [
      { transform: 'translate(0, 0) rotate(0deg) scale(1)', opacity: 0, offset: 0 },
      { transform: 'translate(-4px, 10px) rotate(-10deg) scale(.95)', opacity: 1, offset: 0.1 },
      { transform: 'translate(-8px, 18px) rotate(-16deg) scale(.9)', opacity: 1, offset: 0.2 },
    ];
    for (let i = 1; i <= 10; i += 1) {
      const u = i / 10;
      const x = -8 + (dx + 8) * u;
      const y = 18 + (dy - 18) * u - rise * 4 * u * (1 - u);
      const scale = 0.9 + 0.3 * Math.sin(Math.PI * u) - (0.9 - END_SCALE) * u;
      keyframes.push({
        transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${(-16 + 560 * u).toFixed(0)}deg) scale(${scale.toFixed(3)})`,
        opacity: 1,
        offset: 0.2 + 0.8 * u,
      });
    }
    el.ball.animate(keyframes, { duration: 1100, fill: 'forwards' }).finished.then(() => {
      desk.catchBall({ src: el.ball.src, size, scale: END_SCALE });
      el.ball.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 60, fill: 'forwards' });
    }, () => {});
    return true;
  }

  const dx = innerWidth * 0.72;
  const rise = innerHeight * 1.35;
  const gravity = innerHeight * 0.4;
  const keyframes = [
    { transform: 'translate(0, 0) rotate(0deg) scale(1)', opacity: 0, offset: 0 },
    { transform: 'translate(-4px, 10px) rotate(-10deg) scale(.95)', opacity: 1, offset: 0.12 },
    { transform: 'translate(-8px, 18px) rotate(-16deg) scale(.9)', opacity: 1, offset: 0.24 },
  ];
  for (let i = 1; i <= 8; i += 1) {
    const u = i / 8;
    keyframes.push({
      transform: `translate(${(-8 + dx * u).toFixed(1)}px, ${(18 - rise * u + gravity * u * u).toFixed(1)}px) `
        + `rotate(${(-16 + 680 * u).toFixed(0)}deg) scale(${(0.9 - 0.35 * u).toFixed(3)})`,
      opacity: 1,
      offset: 0.24 + 0.76 * u,
    });
  }
  el.ball.animate(keyframes, { duration: 1000, easing: 'cubic-bezier(.4, 0, .7, 1)', fill: 'forwards' });
  return false;
}

function fontsReady() {
  if (!document.fonts?.load) return Promise.resolve();
  return Promise.race([document.fonts.load('700 100px "Caveat"', `Вы вошли Привет, ${state.user?.login ?? ''}`), wait(1500)]).catch(() => {});
}

// «Привет, anna» под подчёркиванием: мельче, пишется после него и не шире главной надписи.
// Возвращает рамку строки или null, если имени нет
function layoutHello(box, y, fontSize, delay) {
  const hello = el.welcomeHello;
  hello.replaceChildren();
  const login = state.user?.login;
  if (!login) return null;

  [...`Привет, ${login}`].forEach((char, index) => {
    const tspan = document.createElementNS(SVG_NS, 'tspan');
    tspan.textContent = char;
    tspan.style.setProperty('--i', String(index));
    hello.append(tspan);
  });
  hello.setAttribute('x', String(box.x + box.width / 2));
  const setSize = (size) => {
    hello.style.fontSize = `${size}px`;
    hello.setAttribute('y', (y + size * 1.3).toFixed(1));
  };
  let size = fontSize * 0.42;
  setSize(size);
  const maxWidth = Math.max(box.width, fontSize * 2.4);
  const { width } = hello.getBBox();
  if (width > maxWidth) {
    size *= maxWidth / width;
    setSize(size);
  }
  el.welcome.style.setProperty('--hello-delay', `${delay}ms`);
  return hello.getBBox();
}

// Раскладка надписи: по букве на tspan, чтобы «писать» их по очереди
function layoutWelcome() {
  const portrait = innerWidth / innerHeight < 0.85;
  const layout = portrait ? 'portrait' : 'landscape';
  const lines = portrait ? ['Вы', 'вошли'] : ['Вы вошли'];
  const word = el.welcomeWord;
  const lineHeight = 0.95;

  word.replaceChildren();
  let index = 0;
  lines.forEach((line, lineIndex) => {
    [...line].forEach((char, charIndex) => {
      const tspan = document.createElementNS(SVG_NS, 'tspan');
      if (charIndex === 0) {
        tspan.setAttribute('x', '0');
        if (lineIndex > 0) tspan.setAttribute('dy', `${lineHeight}em`);
      }
      tspan.textContent = char;
      tspan.style.setProperty('--i', String(index));
      index += 1;
      word.append(tspan);
    });
  });

  const box = word.getBBox();
  const fontSize = parseFloat(getComputedStyle(word).fontSize) || 200;
  const baseline = (lines.length - 1) * lineHeight * fontSize;
  const y = baseline + fontSize * 0.2;
  const x0 = box.x + box.width * 0.04;
  const width = box.width * 0.92;
  el.welcomeUnderline.setAttribute(
    'd',
    `M${x0} ${y + 6}C${x0 + width * 0.22} ${y - 12} ${x0 + width * 0.42} ${y + 14} ${x0 + width * 0.6} ${y}`
      + `S${x0 + width * 0.88} ${y - 12} ${x0 + width} ${y + 2}`,
  );
  el.welcome.style.setProperty('--underline-delay', `${index * 110 + 650}ms`);
  const hello = layoutHello(box, y, fontSize, index * 110 + 650 + 750);

  const pad = 30;
  const left = Math.min(box.x, hello?.x ?? box.x);
  const right = Math.max(box.x + box.width, hello ? hello.x + hello.width : -Infinity);
  const bottom = Math.max(box.y + box.height, y + 24, hello ? hello.y + hello.height : -Infinity);
  el.welcomeSvg.setAttribute(
    'viewBox',
    `${left - pad} ${box.y - pad} ${right - left + pad * 2} ${bottom - box.y + pad * 2}`,
  );
  state.welcomeLayout = layout;
}

async function showWelcome() {
  await fontsReady();
  // «выйти» недоступен, пока лист не лёг: иначе выход и окончание появления спорят за сцену
  el.logout.disabled = true;
  el.logoutError.textContent = '';
  el.welcomeTitle.textContent = state.user?.login ? `Вы вошли. Привет, ${state.user.login}` : 'Вы вошли';
  el.welcome.hidden = false;
  layoutWelcome();
  el.welcomeTitle.focus({ preventScroll: true });

  if (calm()) {
    el.welcome.classList.add('is-written');
  } else {
    rainConfetti();
    const drop = el.welcome.animate(
      [
        { transform: 'translateY(-112%) rotate(-5deg) scale(1.08)' },
        { transform: 'translateY(2.5%) rotate(1deg) scale(1.03)', offset: 0.62 },
        { transform: 'translateY(-.8%) rotate(-.3deg) scale(1.01)', offset: 0.82 },
        { transform: 'none' },
      ],
      { duration: 1000, easing: 'cubic-bezier(.22, .8, .3, 1)' },
    );
    await wait(560);
    el.welcome.classList.add('is-writing');
    await drop.finished;
  }

  el.scene.hidden = true;
  resetNotebook();
  el.logout.disabled = false;
}

function tornPolygon() {
  const r = () => random(0, 22).toFixed(0);
  return `polygon(${r()}% 0, 55% ${r() / 3}%, 100% ${r()}%, ${100 - r() / 3}% 55%, ${100 - r()}% 100%, 45% ${100 - r() / 3}%, 0 ${100 - r()}%, ${r() / 3}% 45%)`;
}

const SCRAP_COLORS = ['#fdfaf1', '#f5eedd', '#fde68b', '#e9dec4', '#dbe7f3', '#f4d3cd'];

function rainConfetti(count = 52) {
  for (let i = 0; i < count; i += 1) {
    const bit = document.createElement('span');
    bit.className = i % 4 === 0 ? 'confetti__bit confetti__bit--ruled' : 'confetti__bit';
    Object.assign(bit.style, {
      left: `${random(-2, 100)}%`,
      width: `${random(10, 26).toFixed(0)}px`,
      height: `${random(8, 20).toFixed(0)}px`,
      backgroundColor: SCRAP_COLORS[i % SCRAP_COLORS.length],
      clipPath: tornPolygon(),
    });
    el.confetti.append(bit);

    const drift = random(-130, 130);
    const spin = random(-560, 560);
    const flips = Math.round(random(2, 5)) * 180;
    bit.animate(
      [
        { transform: 'translate(0, 0) rotate(0deg) rotateX(0deg)' },
        { transform: `translate(${drift * 0.6}px, 55vh) rotate(${spin * 0.5}deg) rotateX(${flips}deg)`, offset: 0.5 },
        { transform: `translate(${drift}px, calc(100vh + 80px)) rotate(${spin}deg) rotateX(${flips * 2}deg)` },
      ],
      { duration: random(2400, 4000), delay: random(0, 700), easing: 'cubic-bezier(.25, .35, .5, 1)', fill: 'backwards' },
    ).finished.then(() => bit.remove(), () => bit.remove());
  }
}

// Возвращает блокнот в исходное состояние (после входа или выхода)
function resetNotebook() {
  for (const node of [el.crumple, el.stack, el.creases, el.approved, el.sticky, el.ball, el.hand, el.deskStamp]) {
    for (const animation of node?.getAnimations() ?? []) animation.cancel();
  }
  el.hand.hidden = true;
  el.crumple.style.filter = '';
  el.displacement.setAttribute('scale', '0');
  el.form.reset();
  setPasswordVisible(false);
  applyMode('login');
  setImprint(null);
  setBusy(false);
}

// true — сессия закрыта (или её и не было)
async function endSession() {
  try {
    const response = await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return response.ok;
  } catch {
    return false; // сервер недоступен — сессия жива
  }
}

async function logout() {
  el.logout.disabled = true;
  el.logoutError.textContent = '';
  if (!(await endSession())) {
    el.logoutError.textContent = 'Не получилось выйти — сервер не отвечает';
    el.logout.disabled = false;
    return;
  }

  el.scene.hidden = false;
  el.scene.inert = false;
  if (!calm()) {
    await el.welcome.animate(
      [{ transform: 'none' }, { transform: 'translateY(-110%) rotate(3deg)' }],
      { duration: 650, easing: 'cubic-bezier(.6, 0, .35, 1)' },
    ).finished;
  }
  el.welcome.hidden = true;
  el.welcome.classList.remove('is-writing', 'is-written');
  el.logout.disabled = false;
  el.login.focus();
}

/* ---------- Запуск ---------- */

function bindEvents() {
  el.form.addEventListener('submit', onSubmit);

  el.form.addEventListener('input', (event) => {
    const name = event.target.name;
    if (name in FIELDS) clearFieldError(name);
    el.formError.textContent = '';
    if (name === 'password' && state.mode === 'register') watchWeakPassword();
  });

  el.tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => switchMode(tab.dataset.mode));
    tab.addEventListener('keydown', (event) => {
      const last = el.tabs.length - 1;
      const target = {
        ArrowRight: index === last ? 0 : index + 1,
        ArrowLeft: index === 0 ? last : index - 1,
        Home: 0,
        End: last,
      }[event.key];
      if (target === undefined) return;
      event.preventDefault();
      if (!canSwitch()) return; // фокус не уходит на вкладку, которую сейчас нельзя выбрать
      el.tabs[target].focus();
      switchMode(el.tabs[target].dataset.mode);
    });
  });

  el.switchBtn.addEventListener('click', () => {
    switchMode(state.mode === 'login' ? 'register' : 'login', { focusLogin: true });
  });

  el.peek.addEventListener('click', () => setPasswordVisible(el.password.type === 'password'));
  el.fillTest.addEventListener('click', fillTestCredentials);
  el.logout.addEventListener('click', logout);

  let resizeTimer;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (el.welcome.hidden) return;
      const portrait = innerWidth / innerHeight < 0.85;
      if ((portrait ? 'portrait' : 'landscape') === state.welcomeLayout) return;
      el.welcome.classList.replace('is-writing', 'is-written');
      layoutWelcome();
    }, 150);
  });
}

// Обновление страницы — всегда чистый лист: форма входа с пустыми полями, прошлая сессия закрыта,
// предметы на столе на своих местах
async function boot() {
  history.scrollRestoration = 'manual';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  bindEvents();
  el.form.reset(); // Firefox при обновлении возвращает в поля прежний текст
  const sweepAutofill = dropAutofillPreview();
  applyMode('login');
  prepareHand(); // не ждём: до входа кадры успеют загрузиться, а если нет — будет штамп без руки
  initCursor({ node: $('#cursor'), calm }); // тоже в фоне: пока рука грузится, работает системный курсор
  // сессию закрываем до показа формы: иначе ответ на выход мог бы стереть cookie нового входа
  await Promise.all([preparePaper(), endSession()]);
  sweepAutofill();

  document.body.classList.remove('is-booting');
  document.body.classList.add('is-ready');

  const prints = initPrints({ desk: $('.desk'), sheetMarks: () => el.marks });
  desk = initDesk({
    desk: $('.desk'),
    obstacles: deskObstacles,
    onTap: (node) => node === el.inkPad && prints.ink(node), // щелчок по подушке — палец в краске
  });
  doodles = initDoodles({
    sheet: el.sheet,
    marks: () => el.marks,
    canDraw: () => !el.scene.hidden && !el.scene.inert && !state.busy && !state.switching,
  });
}

// Что на столе нельзя «проехать насквозь»: блокнот вместе с закладками и стикер
function deskObstacles() {
  if (el.scene.hidden) return [];
  const sheet = el.stack.getBoundingClientRect();
  const notebook = new DOMRect(sheet.x - 12, sheet.y - 44, sheet.width + 24, sheet.height + 56);
  return [notebook, el.sticky.getBoundingClientRect()];
}

boot();
