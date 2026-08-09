# event-signup-bot

Телеграм-бот записи на мероприятие: выбор города и направления, анкета участника, список записавшихся,
уведомления администраторам о новых заявках и подтверждение оплаты вручную.
Настройки меняются в закрытой веб-админке внутри Telegram, данные хранятся
в папке `data` на сервере без Google Sheets.

Стек: Node.js + [grammy](https://grammy.dev). Работает в двух режимах:
- **long-polling** — если `WEBHOOK_URL` не задан (проще всего для VPS);
- **webhook** — если задан `WEBHOOK_URL`.

## Быстрый старт (локально)

```bash
cp .env.example .env      # вставь BOT_TOKEN, ADMIN_IDS, GROUP_CHAT_ID и т.д.
npm install
npm start
```

Как узнать `GROUP_CHAT_ID` и `ADMIN_IDS`: добавь бота в группу и отправь `/id` —
бот пришлёт нужные id.

Администратор отправляет `/admin`, открывает веб-панель и меняет название,
города, направления, даты, наставников, стоимость и реквизиты. Команда
`/adminoff` возвращает обычный пользовательский режим. Доступ проверяется по
`ADMIN_IDS` и, при необходимости, `ADMIN_USERNAMES`.

Администраторы могут управлять доступом прямо в личном чате с ботом:

- `/addadmin @username` или `/addadmin 123456789` — добавить администратора;
- `/kickadmin @username` или `/kickadmin 123456789` — удалить администратора.

Серверный список из `ADMIN_IDS`/`ADMIN_USERNAMES` защищён от удаления и служит
резервным доступом. Для постоянных прав рекомендуется использовать Telegram ID:
username пользователь может изменить.

## Переменные окружения

Все описаны в [`.env.example`](.env.example). Ключевые:

| Переменная | Назначение |
|---|---|
| `BOT_TOKEN` | токен от @BotFather (обязательно) |
| `ADMIN_IDS` | ID админов через запятую; рекомендуемый способ выдачи доступа |
| `ADMIN_USERNAMES` | Дополнительный список username без `@` через запятую |
| `GROUP_CHAT_ID` | группа для уведомлений о новых записях |
| `ADMIN_WEBAPP_URL` | полный HTTPS-адрес админки; например `https://bot.example.com/admin` |
| `DATA_DIR` | папка постоянных данных; по умолчанию `./data` |
| `WEBHOOK_URL` | публичный URL — включает режим webhook; пусто = long-polling |

`.env`, папка `data` и логи в git не попадают (см. `.gitignore`).

## Развёртывание на сервере (VPS, бесперебойно)

Для самого бота в режиме long-polling публичный URL не нужен. Для встроенной
веб-админки нужен HTTPS-домен, который проксирует запросы на порт бота, и
`ADMIN_WEBAPP_URL=https://ваш-домен/admin`.

```bash
git clone https://github.com/iamboboeff/event-signup-bot.git
cd event-signup-bot
npm install --omit=dev
cp .env.example .env && nano .env   # заполни переменные
```

Держать процесс живым удобнее всего через **systemd**:

```ini
# /etc/systemd/system/event-bot.service
[Unit]
Description=Event signup Telegram bot
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/USER/event-signup-bot
ExecStart=/usr/bin/node bot.js
Restart=always
RestartSec=5
EnvironmentFile=/home/USER/event-signup-bot/.env
Environment=DATA_DIR=/home/USER/event-bot-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now event-bot
sudo systemctl status event-bot        # проверить
journalctl -u event-bot -f             # смотреть логи
```

После `git pull` обновление применяется через `sudo systemctl restart event-bot`.

Альтернатива — [pm2](https://pm2.keymetrics.io): `pm2 start bot.js --name event-bot && pm2 save && pm2 startup`.

> Важно: локальный диск Cloud Run непостоянный. Для хранения данных внутри
> самого бота используйте VPS или подключённый постоянный диск. Иначе настройки
> и заявки могут исчезнуть при пересоздании контейнера.

## Файлы

- `bot.js` — сам бот (анкета, список, уведомления, подтверждение оплаты).
- `admin.html` — закрытая веб-панель настроек внутри Telegram.
- `admins.json` — начальный список администраторов для первого запуска.
- `config.json` — исходные настройки для первого запуска.
- `data/admins.json` — изменяемый список администраторов (создаётся автоматически).
- `data/config.json` — актуальные настройки из админки (создаётся автоматически).
- `data/registrations.json` — заявки (создаётся автоматически).
- `Dockerfile` — контейнер для webhook-режима; папке `data` нужен постоянный диск.
- `server.js` / `index.html` — прототип веб-анкеты (не обязателен для бота).
