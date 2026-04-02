# Poker Online

## Запуск

```bash
npm install
npm start
```

По умолчанию сервер стартует на \(PORT=3000\).

## Тесты и линт

```bash
npm test
npm run lint
```

## Хранение данных пользователей (важно)

Файл `data/users.json` содержит хэши паролей и токены. Не коммить его и не публикуй.

Можно вынести хранилище из папки проекта:

```bash
POKER_DATA_DIR="/absolute/path/to/poker-data" npm start
```

## TTL для токенов (опционально)

По умолчанию токены истекают через 24 часа. Чтобы настроить TTL:

```bash
AUTH_TOKEN_TTL_HOURS=24 npm start
```

## Production заметки (deploy-ready)

- Не храни `users.json` внутри репозитория/контейнера без volume.
- Задай `SOCKET_IO_CORS_ORIGIN` (иначе браузерный доступ с домена может быть заблокирован).
- Ограничения и защита:
  - HTTP rate-limit через `RATE_LIMIT_PER_MINUTE`
  - безопасные заголовки через `helmet`

