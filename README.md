<div align="center">
  <img src="https://pocker.kiruhak11.ru/pwa/icon.svg" width="88" height="88" alt="Pocker Dealer Desk">
  <h1>Pocker Dealer Desk</h1>
  <p><strong>Покерный вечер, где приложение берёт на себя рутину.</strong></p>
  <p>Домашние столы, онлайн-комнаты, друзья и мини-игры — в одной игровой платформе.</p>
  <p>
    <a href="https://pocker.kiruhak11.ru"><strong>Открыть игру</strong></a>
    &nbsp;·&nbsp;
    <a href="#быстрый-запуск">Запустить локально</a>
    &nbsp;·&nbsp;
    <a href="#технологии">Технологии</a>
  </p>
  <p>
    <img alt="Nuxt 4" src="https://img.shields.io/badge/Nuxt-4-00DC82?logo=nuxtdotjs&logoColor=white">
    <img alt="Vue 3" src="https://img.shields.io/badge/Vue-3-42B883?logo=vuedotjs&logoColor=white">
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white">
    <img alt="Docker" src="https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white">
    <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white">
  </p>
</div>

**Pocker Dealer Desk** — веб-платформа для игры в покер с друзьями и за общими онлайн-столами. В проекте также есть мини-игры, аккаунты, виртуальные фишки, автоматические игровые боты и отдельная оболочка для Yandex Games.

Интерфейс приложения написан на Nuxt и Vue. Сервер хранит состояние игры и отвечает за игровые действия, расчёты и финансовый журнал; клиенты получают обновления онлайн-комнат по WebSocket.

## Возможности

- **Покер:** локальный стол для игры на одном устройстве и PUBLIC/PRIVATE онлайн-комнаты. Поддерживаются зрители, подключение между раздачами, переподключение, таймер хода, общие и побочные банки, all-in, split pots, история игры и синхронизация по WebSocket.
- **Онлайн-стек:** бай-ин, пополнение и вывод фишек между раздачами. Операции защищены транзакциями и идемпотентностью, а движения фишек записываются в журнал.
- **Игровой процесс:** серверная логика раздач, проверка действий, расчёт победителей, рейтинги, достижения и прогнозы зрителей.
- **Мини-игры:** Mines, Rocket, Blackjack и Jackpot. Результат и списание виртуальных фишек обрабатываются сервером.
- **Автоматические боты:** серверный оркестратор распределяет ботов между онлайн-покером и Rocket. Их действия проходят через обычные игровые правила и учёт.
- **Аккаунт и сообщество:** профиль, друзья и приглашения, история кошелька, лидерборды, ежедневные бонусы и Telegram-интеграция.
- **Yandex Games:** отдельная игровая оболочка с гостевой и авторизованной сессиями платформы и поддержкой рекламных наград.
- **Установка как приложение:** PWA-манифест и сценарии установки для поддерживаемых браузеров.

Игровые балансы и ставки внутри игр — виртуальные фишки. Сервер проверяет игровые действия и рассчитывает результаты; операции с балансом используют транзакции и защиту от повторного списания. Платёжные интеграции для цифровых продуктов требуют отдельной конфигурации и не должны включаться локальными тестовыми секретами.

## Технологии

- Nuxt 4, Vue 3, TypeScript и Pinia
- Nitro API и WebSocket
- PostgreSQL и Prisma ORM
- Redis для координации runtime-задач и временного состояния
- Docker Compose; PgBouncer в production-like конфигурации
- Node.js 22

## Быстрый запуск

Нужны Docker с Compose plugin и Git.

```bash
git clone https://github.com/kiruhak11/pockerdeeler.git
cd pockerdeeler
cp .env.example .env
docker compose up --build
```

После запуска приложение будет доступно по адресу [http://localhost:3000](http://localhost:3000). В dev-конфигурации Compose запускаются PostgreSQL, Redis, Adminer и приложение; приложение ожидает базу, генерирует Prisma Client и применяет локальные миграции.

Для входа в PostgreSQL через Adminer откройте [http://localhost:8080](http://localhost:8080). Локальные значения подключения перечислены в `.env.example`.

> Значения и секреты из `.env.example` предназначены только для локальной разработки. Перед внешним доступом замените секреты и задайте отдельную безопасную конфигурацию.

## Запуск приложения без Docker

Можно запустить PostgreSQL и Redis отдельно, а Nuxt — локально. Например, поднимите зависимости через Compose:

```bash
cp .env.example .env
docker compose up -d postgres redis
npm ci
npm run db:generate
```

Для процесса, запущенного на хосте, используйте адреса `localhost`, а не имена Compose-сервисов:

```bash
DATABASE_URL='postgresql://poker:poker@localhost:5432/pokerdb?schema=public' \
DIRECT_DATABASE_URL='postgresql://poker:poker@localhost:5432/pokerdb?schema=public' \
REDIS_URL='redis://localhost:6379' \
npm run db:migrate

DATABASE_URL='postgresql://poker:poker@localhost:5432/pokerdb?schema=public' \
DIRECT_DATABASE_URL='postgresql://poker:poker@localhost:5432/pokerdb?schema=public' \
REDIS_URL='redis://localhost:6379' \
npm run dev -- --host 127.0.0.1
```

Задайте собственные `JWT_SECRET` и `ROOM_SECRET_PEPPER` в локальном `.env`. Не используйте production-учётные данные для разработки или тестов.

## Проверки и команды

```bash
npm run typecheck       # проверка типов
npm run build           # production-сборка приложения
npm test                # legacy, poker/online и Telegram-наборы
npm run test:legacy     # unit-тесты общей игровой и прикладной логики
npm run test:poker      # poker, online rooms и lobby
npm run test:telegram   # Telegram lifecycle
npm run test:integration # интеграционные сценарии online poker
npm run db:generate     # генерация Prisma Client
npm run db:migrate      # локальная разработка схемы Prisma
npm run db:migrate:deploy # применение уже созданных миграций
```

Для интеграционных и database-dependent тестов нужны отдельные тестовые PostgreSQL и Redis. Не направляйте тестовую конфигурацию на production. `test:poker` включает тесты онлайн-комнат и требует Redis; настройте тестовые подключения согласно используемому тестовому окружению.

## Конфигурация

Начните с `.env.example`; полный список опциональных интеграций и переменных там сгруппирован по назначению. Основные параметры:

| Переменная | Назначение |
| --- | --- |
| `DATABASE_URL` | Подключение приложения к PostgreSQL; в production-like режиме — через PgBouncer. |
| `DIRECT_DATABASE_URL` | Прямое подключение к PostgreSQL для Prisma migrations. |
| `REDIS_URL` | Redis для координации и временного состояния. |
| `JWT_SECRET` | Подпись сессий аккаунта. |
| `ROOM_SECRET_PEPPER` | Защита секретов игровых комнат. |
| `NUXT_PUBLIC_APP_URL` | Публичный URL приложения. |
| `BOT_ORCHESTRATOR_ENABLED` | Явный флаг автоматической активности ботов; включается только точным значением `true`. По умолчанию выключен. |
| `BOT_ORCHESTRATOR_ROCKET_CHANCE` | Необязательная настройка участия ботов в Rocket, если задана для окружения. |
| `YANDEX_GAMES_SECRET` | Серверный секрет проверки авторизации Yandex Games; не добавляйте к нему префикс `NUXT_PUBLIC_`. |
| `YOOKASSA_SECRET_KEY`, `SMS_RU_API_ID`, `TELEGRAM_BOT_TOKEN` | Серверные ключи соответствующих внешних интеграций. |

Никогда не коммитьте `.env`, ключи, токены, подписи или пользовательские данные. В клиентскую конфигурацию `NUXT_PUBLIC_*` можно помещать только значения, которые допустимо раскрывать браузеру.

## Структура проекта

```text
app/                 страницы, Vue-компоненты, composables и клиентские платформы
server/api/          HTTP endpoints Nitro
server/services/     игровая логика, аккаунты, боты и учёт
server/ws/           WebSocket/runtime онлайн-комнат
prisma/              схема PostgreSQL и последовательные миграции
tests/               unit, API, online, integration и lifecycle-тесты
scripts/             локальные и эксплуатационные вспомогательные скрипты
public/              статические ресурсы, PWA и графика
```

## Разработка схемы и миграции

При разработке изменяйте Prisma schema и создавайте миграцию командой `npm run db:migrate` на локальной базе. Для окружения, в котором миграция уже создана и проверена, используйте `npm run db:migrate:deploy`.

Production-выкладка требует отдельного проверенного release-процесса: резервной копии PostgreSQL, проверки миграций и возможности переключить только приложение на предыдущий образ. Не используйте `prisma db push` для production и не удаляйте volumes с данными.

## Вклад в проект

1. Создайте отдельную ветку для изменения.
2. Не включайте секреты, локальные `.env`, Android signing-файлы и артефакты сборки.
3. Для затронутой области запустите соответствующие целевые тесты и `npm run typecheck`; перед полноценным pull request — подходящий общий набор проверок.
4. Опишите поведение, влияние на данные и необходимые миграции в pull request.

Перед отправкой проверьте `git status` и убедитесь, что в commit не попали локальные или сгенерированные файлы.
