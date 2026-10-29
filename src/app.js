import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createAuth, SESSION_TTL_MS, LOGIN_MAX, loginKey } from './auth.js';
import { createThrottle } from './throttle.js';
import {
  HttpError, SECURITY_HEADERS, sendJson, sendText, readJson, isJsonRequest, readCookie, sessionCookie,
} from './http.js';

const SESSION_COOKIE = 'sid';

// Что о пользователе видит страница: id нужен для номера на штампе «Новый лист № 0042»
const publicUser = (user) => ({ id: user.id, login: user.login });

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function createApp({ db, publicDir }) {
  const auth = createAuth(db);
  const throttle = createThrottle();
  const root = path.resolve(publicDir);

  const tooManyAttempts = (seconds) => new HttpError(429, `Слишком много попыток. Подождите ${seconds} сек.`, {
    headers: { 'Retry-After': String(seconds) },
  });

  function startSession(req, res, status, user) {
    auth.destroySession(readCookie(req, SESSION_COOKIE));
    const token = auth.createSession(user.id);
    sendJson(res, status, { user: publicUser(user) }, {
      'Set-Cookie': sessionCookie(SESSION_COOKIE, token, SESSION_TTL_MS),
    });
  }

  const api = {
    async 'POST /api/login'(req, res) {
      const body = await readJson(req);
      const login = typeof body.login === 'string' ? body.login.trim().normalize('NFC') : '';
      // длиннее LOGIN_MAX логинов не бывает, а ключ живёт в памяти — не храним мегабайтные строки
      const key = `${req.socket.remoteAddress}|${loginKey(login).slice(0, LOGIN_MAX * 2)}`;

      const wait = throttle.acquire(key);
      if (wait) throw tooManyAttempts(wait);

      let user;
      try {
        user = await auth.login(body);
      } catch (err) {
        const blocked = throttle.release(key, err.status === 401 ? 'wrong' : 'error');
        if (blocked) throw tooManyAttempts(blocked);
        throw err;
      }
      throttle.release(key, 'ok');
      startSession(req, res, 200, user);
    },

    async 'POST /api/register'(req, res) {
      const user = await auth.register(await readJson(req));
      startSession(req, res, 201, user);
    },

    async 'POST /api/logout'(req, res) {
      auth.destroySession(readCookie(req, SESSION_COOKIE));
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(SESSION_COOKIE, '', 0) });
    },

    async 'GET /api/me'(req, res) {
      const user = auth.userBySession(readCookie(req, SESSION_COOKIE));
      sendJson(res, 200, { user: user ? publicUser(user) : null });
    },
  };

  async function handleApi(req, res, pathname) {
    const handler = api[`${req.method} ${pathname}`];
    if (!handler) {
      const allowed = Object.keys(api)
        .filter((route) => route.endsWith(` ${pathname}`))
        .map((route) => route.split(' ')[0]);
      if (allowed.length) return sendJson(res, 405, { error: 'Метод не поддерживается' }, { Allow: allowed.join(', ') });
      return sendJson(res, 404, { error: 'Не найдено' });
    }
    // Требуем JSON у всех POST: обычная HTML-форма с чужого сайта так не умеет (защита от CSRF)
    if (req.method === 'POST' && !isJsonRequest(req)) {
      return sendJson(res, 415, { error: 'Ожидается JSON' });
    }
    await handler(req, res);
  }

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendText(res, 405, 'Метод не поддерживается', { Allow: 'GET, HEAD' });
    }
    let relative;
    try {
      relative = decodeURIComponent(pathname);
    } catch {
      return sendText(res, 400, 'Некорректный адрес');
    }
    if (relative.endsWith('/')) relative += 'index.html';

    const file = path.join(root, relative);
    if (!file.startsWith(root + path.sep)) return sendText(res, 403, 'Доступ запрещён');

    let info;
    try {
      info = await stat(file);
    } catch {
      info = null;
    }
    if (!info?.isFile()) return sendText(res, 404, 'Не найдено');

    const body = await readFile(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  const server = http.createServer(async (req, res) => {
    let pathname;
    try {
      // парсер HTTP пропускает адреса вроде «//[», которые URL уже не разбирает
      ({ pathname } = new URL(req.url, 'http://localhost'));
    } catch {
      sendText(res, 400, 'Некорректный адрес');
      return;
    }
    try {
      if (pathname === '/api' || pathname.startsWith('/api/')) await handleApi(req, res, pathname);
      else await serveStatic(req, res, pathname);
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message, ...(err.field && { field: err.field }) }, err.headers);
        return;
      }
      console.error(err);
      sendJson(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
  });

  // Исключение в таймере уронило бы весь процесс — например, если базу держит открытой редактор
  const housekeeping = setInterval(() => {
    try {
      auth.purgeExpiredSessions();
    } catch (err) {
      console.error('Не удалось удалить просроченные сессии:', err.message);
    }
    throttle.sweep();
  }, 10 * 60_000).unref();
  server.on('close', () => clearInterval(housekeeping));

  return server;
}
