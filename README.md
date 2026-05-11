# Poker Dealer Desk

Nuxt 4 приложение для дилера покера с двумя режимами:

- `Local Mode`: локальный калькулятор раздач (без backend, `localStorage`).
- `Online Room Mode`: онлайн-комнаты с серверно-авторитетной логикой, PostgreSQL и WebSocket-синхронизацией.

## Технологии

- Nuxt 4
- Vue 3 Composition API
- TypeScript
- SCSS
- Pinia
- Nitro API + WebSocket
- Prisma ORM
- PostgreSQL
- Docker / Docker Compose
- PgBouncer (production-like)

## Что уже реализовано

### Local Mode

- Создание игры, настройка игроков, стеков и мест.
- Автоназначение мест, если позиция не задана.
- Настройки стола: `small blind`, `big blind`, быстрые повышения.
- Автопроставление малого/большого блайнда при старте игры и новой раздачи.
- Полный цикл действий: `check`, `bet`, `call`, `raise`, `fold`, `all-in`.
- Undo последнего действия на основе snapshot.
- История раздач.
- Сохранение/восстановление из `localStorage`.
- Запрет изменения состава игроков после старта игры.

### Online Room Mode (MVP)

- Создание комнаты (`/api/rooms/create`) и короткого room code.
- Вход игроков по коду (`/api/rooms/[code]/join`).
- Серверная проверка токенов игрока и `dealerSecret`.
- Серверно-авторитетная обработка покерных действий в транзакциях.
- Идемпотентность действий через `clientRequestId` + уникальный индекс.
- Snapshot в БД перед действием/распределением банка.
- Undo дилера через восстановление snapshot.
- Realtime обновление состояния комнаты по WebSocket (`room_state_updated`).
- Хранение комнат, игроков, раздач, действий и истории в PostgreSQL.

## Структура

```text
app/
  pages/
    index.vue
    setup.vue
    game.vue
    history.vue
    create.vue
    room/[code]/join.vue
    room/[code]/dealer.vue
    room/[code]/player.vue
    room/[code]/table.vue
  components/
  composables/
  stores/
  types/
  utils/

server/
  api/rooms/**
  db/client.ts
  services/**
  ws/**
  routes/ws/room/[code].ts

prisma/
  schema.prisma
  migrations/

Dockerfile
docker-compose.yml
docker-compose.prod.yml
docker-compose-prod.yml
pgbouncer/pgbouncer.ini
scripts/wait-for-db.sh
scripts/migrate.sh
```

## Переменные окружения

Скопируйте шаблон:

```bash
cp .env.example .env
```

Ключевые переменные:

- `DATABASE_URL`: URL приложения к БД.
  - В production-like режиме указывает на PgBouncer.
- `DIRECT_DATABASE_URL`: прямой URL к PostgreSQL.
  - Используется для миграций.

Пример production-like:

- `DATABASE_URL=postgresql://...@pgbouncer:5432/...`
- `DIRECT_DATABASE_URL=postgresql://...@postgres:5432/...`

## Запуск без Docker (локально)

Нужен локальный PostgreSQL.

```bash
npm install
npm run db:generate
npm run db:migrate
npm run dev
```

## Запуск dev через Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

Сервисы в `docker-compose.yml`:

- `app`
- `postgres`
- `redis`
- `adminer`

## Production-like запуск (с PgBouncer)

Доступны оба имени файла:

- `docker-compose.prod.yml`
- `docker-compose-prod.yml`

Запуск:

```bash
cp .env.example .env
docker compose -f docker-compose.prod.yml up --build -d
```

Сервисы:

- `app`
- `postgres`
- `pgbouncer`
- `redis`

### Зачем PgBouncer

PgBouncer уменьшает нагрузку на PostgreSQL и стабилизирует большое число коротких подключений.
В проекте используется `pool_mode=transaction`.

### Prisma + PgBouncer

- Приложение подключается через `DATABASE_URL` (PgBouncer).
- Миграции выполняются через `DIRECT_DATABASE_URL` (прямой PostgreSQL).
- В `DATABASE_URL` для Prisma добавлен `pgbouncer=true`.

## Миграции

Локально:

```bash
npm run db:migrate
```

В production-like контейнере при старте `app`:

- выполняется `./scripts/migrate.sh`
- внутри скрипта используется `DIRECT_DATABASE_URL`.

## Полезные команды

Проверка типов:

```bash
npm run typecheck
```

Сборка:

```bash
npm run build
```

Логи app (docker):

```bash
docker compose logs -f app
```

Логи production-like:

```bash
docker compose -f docker-compose.prod.yml logs -f
```

Сброс dev БД (удаление volume):

```bash
docker compose down -v
```

## API (основные endpoints)

- `POST /api/rooms/create`
- `POST /api/rooms/[code]/join`
- `GET /api/rooms/[code]/state`
- `POST /api/rooms/[code]/start-game`
- `POST /api/rooms/[code]/start-hand`
- `POST /api/rooms/[code]/action`
- `POST /api/rooms/[code]/dealer-action`
- `POST /api/rooms/[code]/finish-hand`
- `POST /api/rooms/[code]/distribute-pot`
- `POST /api/rooms/[code]/undo`
- `POST /api/rooms/[code]/leave`

## Инварианты покер-логики

- Стеки игроков не уходят в минус.
- Банк формируется из внесённых фишек (`totalCommitted`).
- Распределение банка не теряет фишки.
- Поддержаны all-in и side-pots (вынесено в расчётный модуль).

