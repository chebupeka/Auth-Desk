import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';
import { createApp } from '../src/app.js';
import { createThrottle } from '../src/throttle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let db;
let server;
let base;

before(async () => {
  db = openDb(':memory:');
  await seed(db);
  server = createApp({ db, publicDir: path.join(ROOT, 'public') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
});

const post = (url, body, headers = {}) => fetch(base + url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const cookieOf = (res) => res.headers.get('set-cookie')?.split(';')[0];
const me = async (cookie) => (await fetch(`${base}/api/me`, { headers: cookie ? { cookie } : {} })).json();

test('тестовый пользователь test / test входит и получает сессию', async () => {
  const res = await post('/api/login', { login: 'test', password: 'test' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { user: { id: 1, login: 'test' } });

  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /^sid=[\w-]{20,};/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.deepEqual(await me(cookieOf(res)), { user: { id: 1, login: 'test' } });
});

test('логин не зависит от регистра и пробелов по краям', async () => {
  const res = await post('/api/login', { login: '  TEST ', password: 'test' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { user: { id: 1, login: 'test' } });
});

test('неверный пароль и несуществующий логин дают одинаковый ответ 401', async () => {
  const wrongPassword = await post('/api/login', { login: 'ivan', password: 'nope' });
  const noSuchUser = await post('/api/login', { login: 'ghost', password: 'nope' });
  assert.equal(wrongPassword.status, 401);
  assert.equal(noSuchUser.status, 401);
  assert.deepEqual(await wrongPassword.json(), await noSuchUser.json());
  assert.equal(wrongPassword.headers.get('set-cookie'), null);
});

test('пустые поля при входе подсвечиваются по полю', async () => {
  const res = await post('/api/login', { login: '', password: '' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).field, 'login');
});

test('регистрация создаёт пользователя и сразу открывает сессию', async () => {
  const res = await post('/api/register', { login: 'Пётр_1', password: 'secret' });
  assert.equal(res.status, 201);
  const { user } = await res.json();
  assert.equal(user.login, 'Пётр_1');
  assert.ok(Number.isInteger(user.id) && user.id > 3, 'новый id идёт после тестовых пользователей');
  assert.deepEqual(await me(cookieOf(res)), { user });

  const again = await post('/api/login', { login: 'пётр_1', password: 'secret' });
  assert.equal(again.status, 200);
});

test('занятый логин (в любом регистре) — 409 на поле login', async () => {
  const res = await post('/api/register', { login: 'TeSt', password: 'whatever' });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'этот логин уже занят', field: 'login' });
});

test('регистрация проверяет логин и пароль', async () => {
  const cases = [
    [{ login: 'ab', password: 'long-enough' }, 'login'],
    [{ login: 'x'.repeat(33), password: 'long-enough' }, 'login'],
    [{ login: 'with space', password: 'long-enough' }, 'login'],
    [{ login: 'okname', password: '123' }, 'password'],
    [{ login: 'okname', password: 'x'.repeat(129) }, 'password'],
    [{ login: 42, password: 'long-enough' }, 'login'],
  ];
  for (const [body, field] of cases) {
    const res = await post('/api/register', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).field, field, JSON.stringify(body));
  }
});

test('выход удаляет сессию', async () => {
  const cookie = cookieOf(await post('/api/login', { login: 'anna', password: 'anna2026' }));
  assert.deepEqual(await me(cookie), { user: { id: 2, login: 'anna' } });

  const res = await post('/api/logout', {}, { cookie });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
  assert.deepEqual(await me(cookie), { user: null });
});

test('без сессии /api/me возвращает user: null', async () => {
  assert.deepEqual(await me(), { user: null });
  assert.deepEqual(await me('sid=forged-token'), { user: null });
});

test('POST без JSON отклоняется (защита от CSRF через формы)', async () => {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'login=test&password=test',
  });
  assert.equal(res.status, 415);
});

test('битый JSON и неизвестные маршруты', async () => {
  const broken = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope',
  });
  assert.equal(broken.status, 400);
  assert.equal((await fetch(`${base}/api/nothing`)).status, 404);
  assert.equal((await fetch(`${base}/api/login`)).status, 405);
});

test('после 5 неудачных попыток вход временно блокируется', async () => {
  assert.equal((await post('/api/register', { login: 'throttled', password: 'right-one' })).status, 201);
  for (let i = 1; i <= 4; i += 1) {
    assert.equal((await post('/api/login', { login: 'throttled', password: `bad-${i}` })).status, 401);
  }
  const fifth = await post('/api/login', { login: 'throttled', password: 'bad-5' });
  assert.equal(fifth.status, 429);
  assert.ok(Number(fifth.headers.get('retry-after')) > 0);

  const correct = await post('/api/login', { login: 'throttled', password: 'right-one' });
  assert.equal(correct.status, 429, 'пока действует блокировка, даже верный пароль ждёт');

  const otherUser = await post('/api/login', { login: 'anna', password: 'anna2026' });
  assert.equal(otherUser.status, 200, 'блокировка не задевает других пользователей');
});

test('пачка параллельных попыток не обходит лимит', async () => {
  assert.equal((await post('/api/register', { login: 'burst', password: 'right-one' })).status, 201);
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, i) => post('/api/login', { login: 'burst', password: `wrong-${i}` })),
  );
  const statuses = results.map((res) => res.status);
  assert.ok(statuses.filter((s) => s === 401).length <= 5, `проверено паролей: ${statuses.filter((s) => s === 401).length}`);
  assert.ok(statuses.every((s) => s === 401 || s === 429), statuses.join(','));

  const correct = await post('/api/login', { login: 'burst', password: 'right-one' });
  assert.equal(correct.status, 429, 'после исчерпанного лимита и верный пароль ждёт');
});

test('успешный вход не снимает уже наложенную блокировку', () => {
  const throttle = createThrottle({ maxFailures: 2, windowMs: 60_000, blockMs: 30_000 });
  const t = 1_000;
  assert.equal(throttle.acquire('k', t), 0);
  assert.equal(throttle.acquire('k', t), 0);
  assert.equal(throttle.acquire('k', t), 1, 'третья попытка ждёт, пока идут две');
  assert.equal(throttle.release('k', 'wrong', t), 0);
  assert.ok(throttle.release('k', 'wrong', t) > 0, 'вторая неудача включает блокировку');
  assert.equal(throttle.release('k', 'ok', t), 0);
  assert.ok(throttle.acquire('k', t + 1_000) > 0, 'блокировка осталась');
  assert.equal(throttle.acquire('k', t + 31_000), 0, 'после блокировки снова можно');
});

test('битый адрес запроса — 400, а не 500', async () => {
  const { port } = server.address();
  const reply = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  assert.match(reply, /^HTTP\/1\.1 400/);
});

test('статика отдаётся, выход за пределы public — нет', async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);

  assert.equal((await fetch(`${base}/%2e%2e%2fserver.js`)).status, 403);
  // На Windows «\» — разделитель пути (403), на Linux — обычный символ имени (404)
  assert.notEqual((await fetch(`${base}/..%5cserver.js`)).status, 200);
  assert.equal((await fetch(`${base}/nope.css`)).status, 404);
});

test('картинки и шрифты отдаются с правильными типами', async () => {
  const types = {
    '/assets/desk-kraft.webp': 'image/webp',
    '/assets/og-image.jpg': 'image/jpeg',
    '/assets/icon-32.png': 'image/png',
    '/fonts/caveat-cyrillic.woff2': 'font/woff2',
  };
  for (const [url, type] of Object.entries(types)) {
    const res = await fetch(base + url);
    assert.equal(res.status, 200, url);
    assert.equal(res.headers.get('content-type'), type, url);
    await res.arrayBuffer();
  }
});
