// Пересоздаёт локальную базу и заново добавляет тестовых пользователей.
// Сервер перед этим нужно остановить: на Windows открытый файл базы не удалить.
import { rmSync } from 'node:fs';
import { openDb, DB_PATH } from '../src/db.js';
import { seed, TEST_USERS } from '../src/seed.js';

try {
  for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });
} catch (err) {
  console.error(`Не удалось удалить ${DB_PATH}: ${err.code ?? err.message}. Остановите сервер и повторите.`);
  process.exit(1);
}

const db = openDb();
await seed(db);
db.close();

console.log(`База пересоздана: ${DB_PATH}`);
for (const { login, password } of TEST_USERS) console.log(`  ${login} / ${password}`);
