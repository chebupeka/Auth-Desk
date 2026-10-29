import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DB_PATH } from './src/db.js';
import { seed, TEST_USERS } from './src/seed.js';
import { createApp } from './src/app.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const db = openDb();
const added = await seed(db);
const server = createApp({ db, publicDir: path.join(ROOT, 'public') });

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Порт ${PORT} уже занят. Укажите другой через переменную окружения PORT.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const host = HOST === '127.0.0.1' || HOST === '0.0.0.0' ? 'localhost' : HOST;
  const { login, password } = TEST_USERS[0];
  console.log(`\n  Бумажный вход: http://${host}:${PORT}`);
  console.log(`  База данных:   ${DB_PATH}${added ? ` (добавлено тестовых пользователей: ${added})` : ''}`);
  console.log(`  Тестовый вход: ${login} / ${password}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
