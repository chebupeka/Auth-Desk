import { hashPassword, loginKey } from './auth.js';

export const TEST_USERS = [
  { login: 'test', password: 'test' },
  { login: 'anna', password: 'anna2026' },
  { login: 'ivan', password: 'ivan2026' },
];

// Добавляет тестовых пользователей, которых ещё нет в базе. Возвращает число добавленных.
export async function seed(db) {
  const exists = db.prepare('SELECT 1 FROM users WHERE login_key = ?');
  const insert = db.prepare('INSERT INTO users (login, login_key, password_hash) VALUES (?, ?, ?)');
  let added = 0;
  for (const { login, password } of TEST_USERS) {
    if (exists.get(loginKey(login))) continue;
    insert.run(login, loginKey(login), await hashPassword(password));
    added += 1;
  }
  return added;
}
