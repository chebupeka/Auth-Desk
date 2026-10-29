import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './http.js';

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LOGIN_MIN = 3;
export const LOGIN_MAX = 32;
export const PASSWORD_MIN = 4;
export const PASSWORD_MAX = 128;

// Буквы любого алфавита, цифры и _ . -
const LOGIN_PATTERN = /^[\p{L}\p{N}_.-]+$/u;
const WRONG_CREDENTIALS = 'Неверный логин или пароль';

export const loginKey = (login) => login.toLowerCase();

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

function readCredentials(input, { strict }) {
  const login = typeof input.login === 'string' ? input.login.trim().normalize('NFC') : '';
  const password = typeof input.password === 'string' ? input.password : '';

  if (!login) throw new HttpError(400, 'впишите логин', { field: 'login' });
  if (!password) throw new HttpError(400, 'впишите пароль', { field: 'password' });
  if (password.length > PASSWORD_MAX) throw new HttpError(400, 'слишком длинный пароль', { field: 'password' });

  if (strict) {
    const length = [...login].length;
    if (length < LOGIN_MIN || length > LOGIN_MAX) {
      throw new HttpError(400, `от ${LOGIN_MIN} до ${LOGIN_MAX} символов`, { field: 'login' });
    }
    if (!LOGIN_PATTERN.test(login)) {
      throw new HttpError(400, 'только буквы, цифры и _ . -', { field: 'login' });
    }
    if (password.length < PASSWORD_MIN) {
      throw new HttpError(400, `минимум ${PASSWORD_MIN} символа`, { field: 'password' });
    }
  }
  return { login, password };
}

const isUniqueViolation = (err) => err?.errcode === 2067 || /UNIQUE constraint failed/i.test(err?.message ?? '');

export function createAuth(db) {
  const query = {
    userByKey: db.prepare('SELECT id, login, password_hash FROM users WHERE login_key = ?'),
    insertUser: db.prepare('INSERT INTO users (login, login_key, password_hash) VALUES (?, ?, ?)'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    sessionUser: db.prepare(`
      SELECT u.id, u.login FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  };

  // Хеш-пустышка: для несуществующего логина тоже считаем scrypt,
  // чтобы по времени ответа нельзя было угадать, есть ли такой пользователь.
  let dummyHash;

  return {
    async login(input) {
      const { login, password } = readCredentials(input, { strict: false });
      const user = query.userByKey.get(loginKey(login));
      dummyHash ??= await hashPassword(randomBytes(16).toString('hex'));
      const ok = await verifyPassword(password, user?.password_hash ?? dummyHash);
      if (!user || !ok) throw new HttpError(401, WRONG_CREDENTIALS);
      return { id: user.id, login: user.login };
    },

    async register(input) {
      const { login, password } = readCredentials(input, { strict: true });
      const key = loginKey(login);
      if (query.userByKey.get(key)) throw new HttpError(409, 'этот логин уже занят', { field: 'login' });
      const hash = await hashPassword(password);
      try {
        const { lastInsertRowid } = query.insertUser.run(login, key, hash);
        return { id: Number(lastInsertRowid), login };
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, 'этот логин уже занят', { field: 'login' });
        throw err;
      }
    },

    createSession(userId) {
      const token = randomBytes(32).toString('base64url');
      query.insertSession.run(hashToken(token), userId, Date.now() + SESSION_TTL_MS);
      return token;
    },

    userBySession(token) {
      if (!token) return null;
      const user = query.sessionUser.get(hashToken(token), Date.now());
      return user ? { id: user.id, login: user.login } : null;
    },

    destroySession(token) {
      if (token) query.deleteSession.run(hashToken(token));
    },

    purgeExpiredSessions() {
      query.purgeSessions.run(Date.now());
    },
  };
}
