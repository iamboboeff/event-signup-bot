# event-signup-bot

Телеграм-бот записи на мероприятие: анкета участника, список записавшихся,
уведомления администраторам о новых заявках и подтверждение оплаты вручную.
Источник правды — Google Sheets (через веб-приложение Apps Script);
локальные `config.json`/`registrations.json` используются как fallback при разработке.

Стек: Node.js + [grammy](https://grammy.dev). Работает в двух режимах:
- **long-polling** — если `WEBHOOK_URL` не задан (проще всего для VPS);
- **webhook** — если задан `WEBHOOK_URL` (Cloud Run и т.п.).

## Быстрый старт (локально)

```bash
cp .env.example .env      # вставь BOT_TOKEN, ADMIN_IDS, GROUP_CHAT_ID и т.д.
npm install
npm start
```

Как узнать `GROUP_CHAT_ID` и `ADMIN_IDS`: добавь бота в группу и отправь `/id` —
бот пришлёт нужные id.

## Переменные окружения

Все описаны в [`.env.example`](.env.example). Ключевые:

| Переменная | Назначение |
|---|---|
| `BOT_TOKEN` | токен от @BotFather (обязательно) |
| `ADMIN_IDS` | id админов через запятую (подтверждают оплату) |
| `GROUP_CHAT_ID` | группа для уведомлений о новых записях |
| `SHEET_WEBAPP_URL` | URL веб-приложения Apps Script (источник правды) |
| `WEBHOOK_URL` | публичный URL — включает режим webhook; пусто = long-polling |

`.env`, `registrations.json` и логи в git не попадают (см. `.gitignore`).

## Развёртывание на сервере (VPS, бесперебойно)

Режим long-polling — не нужен ни публичный URL, ни nginx.

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

## Файлы

- `bot.js` — сам бот (анкета, список, уведомления, подтверждение оплаты).
- `apps-script.gs` — код Google Apps Script (веб-приложение над таблицей).
- `config.json` — локальные настройки (менторы и т.п.) для разработки без таблицы.
- `Dockerfile` — для деплоя в Cloud Run (webhook-режим).
- `server.js` / `index.html` — прототип веб-анкеты (не обязателен для бота).
