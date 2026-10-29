// Ограничение неудачных попыток входа: после maxFailures ошибок за windowMs
// ключ (ip + логин) блокируется на blockMs.
//
// Попытка бронируется ДО проверки пароля (acquire) и закрывается после (release):
// иначе пачка параллельных запросов успевает пройти проверку, пока первые
// неудачи ещё не записаны.
export function createThrottle({ maxFailures = 5, windowMs = 10 * 60_000, blockMs = 60_000 } = {}) {
  const entries = new Map();

  const secondsLeft = (until, now) => Math.max(1, Math.ceil((until - now) / 1000));

  const stale = (entry, now) => entry.pending === 0 && entry.blockedUntil <= now && now - entry.firstAt > windowMs;

  function entryFor(key, now) {
    let entry = entries.get(key);
    if (!entry || stale(entry, now)) {
      entry = { failures: 0, pending: 0, firstAt: now, blockedUntil: 0 };
      entries.set(key, entry);
    }
    return entry;
  }

  return {
    // Занять попытку. 0 — можно проверять пароль, иначе сколько секунд ждать
    acquire(key, now = Date.now()) {
      const entry = entryFor(key, now);
      if (entry.blockedUntil > now) return secondsLeft(entry.blockedUntil, now);
      // все разрешённые попытки уже проверяются прямо сейчас
      if (entry.failures + entry.pending >= maxFailures) return 1;
      entry.pending += 1;
      return 0;
    },

    // Закрыть попытку: 'ok' — пароль верный, 'wrong' — неверный, 'error' — запрос не дошёл до проверки.
    // Вернёт секунды блокировки, если этой неудачей лимит исчерпан
    release(key, result, now = Date.now()) {
      const entry = entries.get(key);
      if (!entry) return 0;
      entry.pending = Math.max(0, entry.pending - 1);
      if (result === 'ok') {
        entry.failures = 0; // действующую блокировку успешный вход не снимает
        return 0;
      }
      if (result !== 'wrong') return 0;
      if (now - entry.firstAt > windowMs) {
        entry.failures = 0;
        entry.firstAt = now;
      }
      entry.failures += 1;
      if (entry.failures < maxFailures) return 0;
      entry.failures = 0;
      entry.firstAt = now;
      entry.blockedUntil = now + blockMs;
      return secondsLeft(entry.blockedUntil, now);
    },

    sweep(now = Date.now()) {
      for (const [key, entry] of entries) {
        if (stale(entry, now)) entries.delete(key);
      }
    },
  };
}
