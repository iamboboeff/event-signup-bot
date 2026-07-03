require("dotenv").config();
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Bot, InlineKeyboard, Keyboard, webhookCallback } = require("grammy");

// ---------- env ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("✖ Нет BOT_TOKEN. Скопируй .env.example в .env и вставь токен от @BotFather.");
  process.exit(1);
}
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || "";
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
const SHEET_URL = process.env.SHEET_WEBAPP_URL || ""; // веб-приложение Apps Script (Google Sheets)
// Публичный адрес сервиса (Cloud Run). Если задан — бот работает через webhook, иначе long-polling.
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || (BOT_TOKEN.split(":")[1] || "secret").slice(0, 16);
const PORT = Number(process.env.PORT) || 8080;
const WEBHOOK_PATH = "/webhook";

// ---------- storage (v1: локальные файлы; шаг 2 — Google Sheets) ----------
const CONFIG_PATH = path.join(__dirname, "config.json");
const REGS_PATH = path.join(__dirname, "registrations.json");

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}
function loadRegs() {
  try { return JSON.parse(fs.readFileSync(REGS_PATH, "utf8")); }
  catch (e) { return []; }
}
function saveRegs(regs) {
  fs.writeFileSync(REGS_PATH, JSON.stringify(regs, null, 2));
}

// Настройки: если задан Google Sheet — берём оттуда (кэш 30с), иначе локальный config.json.
let _cfgCache = null, _cfgCacheAt = 0;
async function getConfig() {
  if (SHEET_URL) {
    if (_cfgCache && Date.now() - _cfgCacheAt < 30000) return _cfgCache;
    try {
      const res = await fetch(SHEET_URL);
      const data = await res.json();
      if (data && data.ok && data.config && Array.isArray(data.config.mentors) && data.config.mentors.length) {
        _cfgCache = data.config;
        _cfgCacheAt = Date.now();
        return _cfgCache;
      }
    } catch (e) {
      console.error("Настройки из таблицы недоступны, использую локальные:", e.message);
    }
  }
  return loadConfig();
}

// На Cloud Run локального диска нет — источник правды это Google Sheet.
// Локальный файл используется только если SHEET_URL не задан (для разработки на маке).
const useSheet = !!SHEET_URL;

async function postSheet(payload) {
  await fetch(SHEET_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

// Все записи (из таблицы, либо из локального файла).
async function getRegs() {
  if (!useSheet) return loadRegs();
  try {
    const res = await fetch(SHEET_URL + "?action=list");
    const data = await res.json();
    if (data && data.ok && Array.isArray(data.list)) {
      return data.list.map(r => ({
        id: Number(r.id),
        name: r.name,
        mentor: r.mentor,
        date: r.date,
        sub: !!r.sub,
        userId: r.userId ? Number(r.userId) : null,
        username: r.username || "",
        paid: !!r.paid,
        claimed: !!r.claimed,
        groupMsgId: r.groupMsgId ? Number(r.groupMsgId) : null,
        ts: r.ts
      }));
    }
  } catch (e) {
    console.error("Список из таблицы недоступен:", e.message);
  }
  return [];
}

async function getReg(id) {
  const regs = await getRegs();
  return regs.find(r => String(r.id) === String(id)) || null;
}

// Создать новую запись.
async function createReg(reg) {
  if (useSheet) {
    try { await postSheet(reg); }
    catch (e) { console.error("Не удалось записать в таблицу:", e.message); }
  } else {
    const regs = loadRegs();
    regs.push(reg);
    saveRegs(regs);
  }
}

// Обновить одно поле записи (оплата / заявил об оплате / message_id в группе).
async function updateReg(id, field, value) {
  if (useSheet) {
    const actions = { paid: "setPaid", claimed: "setClaimed", groupMsgId: "setGroupMsg" };
    try { await postSheet({ action: actions[field], id, [field]: value }); }
    catch (e) { console.error("Не удалось обновить запись в таблице:", e.message); }
  } else {
    const regs = loadRegs();
    const reg = regs.find(r => String(r.id) === String(id));
    if (reg) { reg[field] = value; saveRegs(regs); }
  }
}

// Удалить запись целиком (выбранного участника).
async function deleteReg(id) {
  if (useSheet) {
    try { await postSheet({ action: "delete", id }); }
    catch (e) { console.error("Не удалось удалить запись из таблицы:", e.message); }
  } else {
    const regs = loadRegs().filter(r => String(r.id) !== String(id));
    saveRegs(regs);
  }
}

// ---------- bot ----------
const bot = new Bot(BOT_TOKEN);
const sessions = new Map(); // userId -> { step, draft }

function choiceKeyboard(items, prefix) {
  const k = new InlineKeyboard();
  items.forEach((item, i) => {
    k.text(item, prefix + ":" + i);
    if ((i + 1) % 2 === 0) k.row();
  });
  return k;
}

// Постоянное меню снизу — всегда на виду (не надо печатать /start).
// Список записавшихся участникам не показываем — он только для админа в группе (/list).
const mainMenu = new Keyboard()
  .text("📝 Записаться")
  .resized().persistent();

// Начать новую запись (из /start или по кнопке «Записаться»).
async function startRegistration(ctx) {
  // Запись ведём только в личном чате с ботом — в группе анкету не запускаем.
  if (ctx.chat.type !== "private") {
    await ctx.reply(`Чтобы записаться, напишите боту в личные сообщения: https://t.me/${ctx.me.username}`);
    return;
  }
  const cfg = await getConfig();
  sessions.set(ctx.from.id, { step: "name", draft: {} });
  await ctx.reply(
    `Здравствуйте! Это запись на «${cfg.eventName}».\n\nНапишите вашу Фамилию и Имя:`,
    { reply_markup: mainMenu }
  );
}

// Собирает текст списка и инлайн-кнопки удаления (для админа).
// Показываем: абонемент, подтверждённую оплату и «заявил об оплате» (с пометкой ожидания).
// Возвращает { text, keyboard } или null, если записей нет.
async function buildListView(arg) {
  const regs = (await getRegs()).filter(r => r.sub || r.paid || r.claimed);
  const filtered = arg
    ? regs.filter(r => r.date.toLowerCase() === arg.toLowerCase())
    : regs;
  if (!filtered.length) return null;

  const byDay = {};
  filtered.forEach(r => { (byDay[r.date] = byDay[r.date] || []).push(r); });
  let msg = "";
  const kb = new InlineKeyboard();
  for (const day of Object.keys(byDay)) {
    const list = byDay[day];
    msg += `📋 ${day} (${list.length}):\n`;
    list.forEach((r, i) => {
      const pending = !r.sub && !r.paid && r.claimed ? " (ожидание оплаты)" : "";
      msg += `${i + 1}. ${r.name} — ${r.mentor} — ${r.sub ? "абонемент" : "оплата"}${pending}\n`;
      kb.text(`🗑 ${r.name}`, `del:${r.id}`).row();
    });
    msg += "\n";
  }
  return { text: msg.trim(), keyboard: kb };
}

// Показать список записавшихся (всех или на конкретный день).
// Доступно только администратору (в группе или в личке админа) — участникам список не выдаём.
async function showList(ctx, arg) {
  // В группе участникам не нужна клавиатура «Записаться» — заодно убираем залипшее меню.
  const menu = ctx.chat.type === "private" ? mainMenu : { remove_keyboard: true };
  if (!(await isAdmin(ctx.from.id))) {
    await ctx.reply("📋 Список записавшихся доступен только администратору.", { reply_markup: menu });
    return;
  }
  const view = await buildListView(arg);
  if (!view) { await ctx.reply("Записей пока нет.", { reply_markup: menu }); return; }
  // Инлайн-кнопки 🗑 позволяют удалить выбранного участника прямо из списка.
  await ctx.reply(view.text, { reply_markup: view.keyboard });
}

// Кто может отмечать оплату: указан в ADMIN_IDS ИЛИ состоит в группе (любой участник).
async function isAdmin(userId) {
  if (ADMIN_IDS.includes(String(userId))) return true;
  if (GROUP_CHAT_ID) {
    try {
      const m = await bot.api.getChatMember(GROUP_CHAT_ID, userId);
      // любой, кто реально в группе (не вышел и не удалён)
      return m.status !== "left" && m.status !== "kicked";
    } catch (e) { /* ignore */ }
  }
  return false;
}

// Текст уведомления о записи (для группы) с учётом статуса оплаты.
function groupNoteText(reg, priceText) {
  let t = `🔔 Запись\n${reg.name} → ${reg.date}\nНаставник: ${reg.mentor}`;
  if (reg.sub) {
    t += `\nУчастие: по абонементу (бесплатно)`;
  } else {
    t += `\nУчастие: оплата ${priceText}`;
    if (reg.paid) t += `\n✅ Оплачено${reg.paidBy ? " · отметил " + reg.paidBy : ""}`;
    else if (reg.claimed) t += `\n🙋 Сообщил(а) об оплате — проверьте и подтвердите`;
    else t += `\n⏳ Оплата ожидается`;
  }
  return t;
}

// Кнопка отметки оплаты (только для платных записей).
function payKeyboard(reg) {
  if (reg.sub) return undefined;
  return new InlineKeyboard().text(
    reg.paid ? "↩️ Отменить отметку" : "✅ Отметить оплаченным",
    `pay:${reg.paid ? 0 : 1}:${reg.id}`
  );
}

// Админ нажал кнопку оплаты в группе.
async function handlePayToggle(ctx, data) {
  if (!(await isAdmin(ctx.from.id))) {
    await ctx.answerCallbackQuery({ text: "Отмечать оплату может только администратор.", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();

  const paid = data.split(":")[1] === "1";
  const id = data.split(":")[2];
  const reg = await getReg(id);
  if (!reg) {
    try { await ctx.answerCallbackQuery({ text: "Запись не найдена.", show_alert: true }); } catch (e) {}
    return;
  }

  reg.paid = paid;
  reg.paidBy = paid ? (ctx.from.username ? "@" + ctx.from.username : (ctx.from.first_name || "админ")) : "";
  await updateReg(reg.id, "paid", paid);

  const cfg = await getConfig();
  try {
    await ctx.editMessageText(groupNoteText(reg, cfg.price), { reply_markup: payKeyboard(reg) });
  } catch (e) { /* сообщение могли удалить */ }

  // сообщить записавшемуся
  if (paid && reg.userId) {
    try {
      await bot.api.sendMessage(reg.userId, `✅ Ваша оплата подтверждена. Вы записаны на «${reg.date}». До встречи!`);
    } catch (e) { /* пользователь мог не начинать диалог с ботом */ }
  }
}

// Пользователь нажал «Я оплатил(а)» — помечаем заявку и сообщаем админу.
async function handlePaidClaim(ctx, data) {
  await ctx.answerCallbackQuery({ text: "Спасибо! Передали администратору на проверку." });
  const id = data.split(":")[1];
  const reg = await getReg(id);
  if (!reg) return;
  reg.claimed = true;
  await updateReg(reg.id, "claimed", true);

  // убрать кнопку у пользователя
  try {
    await ctx.editMessageText("Спасибо! Сообщение об оплате отправлено администратору — подтвердим после проверки. ✅");
  } catch (e) { /* ignore */ }

  // Только теперь уведомляем админа в группе — с кнопкой подтверждения оплаты.
  if (GROUP_CHAT_ID) {
    const cfg = await getConfig();
    if (reg.groupMsgId) {
      // на случай повторного нажатия — просто обновляем статус существующего сообщения
      try {
        await bot.api.editMessageText(GROUP_CHAT_ID, reg.groupMsgId, groupNoteText(reg, cfg.price), { reply_markup: payKeyboard(reg) });
      } catch (e) { /* ignore */ }
    } else {
      try {
        const sent = await bot.api.sendMessage(GROUP_CHAT_ID, groupNoteText(reg, cfg.price), { reply_markup: payKeyboard(reg) });
        reg.groupMsgId = sent.message_id;
        await updateReg(reg.id, "groupMsgId", sent.message_id);
      } catch (e) { console.error("Не удалось отправить в группу:", e.message); }
    }
  }
}

// Админ нажал 🗑 у участника в списке — спрашиваем подтверждение.
async function handleDeletePrompt(ctx, data) {
  if (!(await isAdmin(ctx.from.id))) {
    await ctx.answerCallbackQuery({ text: "Удалять записи может только администратор.", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  const id = data.split(":")[1];
  const reg = await getReg(id);
  if (!reg) { await ctx.reply("Запись не найдена (возможно, уже удалена)."); return; }
  await ctx.reply(
    `Удалить запись?\n${reg.name} — ${reg.date} — ${reg.mentor}`,
    {
      reply_markup: new InlineKeyboard()
        .text("🗑 Да, удалить", `delok:${reg.id}`)
        .text("↩️ Отмена", "delcancel")
    }
  );
}

// Админ подтвердил удаление — убираем запись и карточку из группы.
async function handleDeleteConfirm(ctx, data) {
  if (!(await isAdmin(ctx.from.id))) {
    await ctx.answerCallbackQuery({ text: "Удалять записи может только администратор.", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  const id = data.split(":")[1];
  const reg = await getReg(id);
  if (!reg) { try { await ctx.editMessageText("Запись уже удалена."); } catch (e) {} return; }
  await deleteReg(reg.id);
  if (GROUP_CHAT_ID && reg.groupMsgId) {
    try { await bot.api.deleteMessage(GROUP_CHAT_ID, reg.groupMsgId); } catch (e) { /* могли удалить вручную */ }
  }
  try { await ctx.editMessageText(`🗑 Удалено: ${reg.name} — ${reg.date}`); } catch (e) { /* ignore */ }
}

bot.command("start", (ctx) => startRegistration(ctx));

// Помощник: узнать chat_id (для группы) и свой user id.
bot.command("id", async (ctx) => {
  await ctx.reply(`chat_id: ${ctx.chat.id}\nваш user id: ${ctx.from.id}`);
});

// Список записавшихся (по желанию — на конкретный день: /list Понедельник)
bot.command("list", async (ctx) => {
  await showList(ctx, (ctx.match || "").trim());
});

// Текст: кнопки меню или ввод имени (шаг 1)
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();

  // Кнопки постоянного меню — работают в любой момент
  if (text === "📝 Записаться") { await startRegistration(ctx); return; }
  if (text === "📋 Список на день") { await showList(ctx, ""); return; }

  // Ввод анкеты (Фамилия Имя) принимаем только в личном чате.
  if (ctx.chat.type !== "private") return;

  const s = sessions.get(ctx.from.id);
  if (!s) { await ctx.reply("Нажмите «📝 Записаться», чтобы оформить заявку.", { reply_markup: mainMenu }); return; }
  if (s.step !== "name") return; // на шагах с кнопками ждём нажатия, текст игнорируем

  if (text.length < 2) { await ctx.reply("Пожалуйста, введите Фамилию и Имя:"); return; }
  s.draft.name = text;
  s.step = "mentor";
  const cfg = await getConfig();
  await ctx.reply("Выберите наставника:", { reply_markup: choiceKeyboard(cfg.mentors, "mentor") });
});

// Шаги 2–4: кнопки
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (data.startsWith("pay:")) return handlePayToggle(ctx, data);
  if (data.startsWith("claim:")) return handlePaidClaim(ctx, data);
  if (data.startsWith("delok:")) return handleDeleteConfirm(ctx, data);
  if (data === "delcancel") {
    await ctx.answerCallbackQuery();
    try { await ctx.editMessageText("Удаление отменено."); } catch (e) {}
    return;
  }
  if (data.startsWith("del:")) return handleDeletePrompt(ctx, data);

  // Шаги анкеты (наставник/дата/абонемент) — только в личном чате.
  if (ctx.chat.type !== "private") { await ctx.answerCallbackQuery(); return; }

  await ctx.answerCallbackQuery();
  const s = sessions.get(ctx.from.id);
  const cfg = await getConfig();
  const [type, idxStr] = ctx.callbackQuery.data.split(":");
  const idx = parseInt(idxStr, 10);

  if (!s) { await ctx.reply("Нажмите «📝 Записаться», чтобы начать.", { reply_markup: mainMenu }); return; }

  if (type === "mentor" && s.step === "mentor") {
    s.draft.mentor = cfg.mentors[idx];
    s.step = "date";
    await ctx.editMessageText(`Наставник: ${s.draft.mentor}`);
    await ctx.reply("Выберите дату:", { reply_markup: choiceKeyboard(cfg.dates, "date") });

  } else if (type === "date" && s.step === "date") {
    s.draft.date = cfg.dates[idx];
    s.step = "sub";
    await ctx.editMessageText(`Дата: ${s.draft.date}`);
    const k = new InlineKeyboard().text("Да", "sub:1").text("Нет", "sub:0");
    await ctx.reply("Вы участвуете по абонементу?", { reply_markup: k });

  } else if (type === "sub" && s.step === "sub") {
    s.draft.sub = idx === 1;
    await ctx.editMessageText(`По абонементу: ${s.draft.sub ? "Да" : "Нет"}`);
    await finish(ctx, s.draft);
    sessions.delete(ctx.from.id);
  }
});

async function finish(ctx, draft) {
  const cfg = await getConfig();
  const reg = {
    id: Date.now(),
    name: draft.name,
    mentor: draft.mentor,
    date: draft.date,
    sub: draft.sub,
    userId: ctx.from.id,
    username: ctx.from.username || "",
    ts: new Date().toISOString()
  };
  await createReg(reg);

  if (draft.sub) {
    await ctx.reply("Отлично! По абонементу участие бесплатное.\nВы записаны ✅");
  } else {
    await ctx.reply(
      `Стоимость участия — ${cfg.price}.\nОплата переводом по реквизитам ниже. После перевода нажмите «Я оплатил(а)» 👇\n\n${cfg.payDetails}`,
      { reply_markup: new InlineKeyboard().text("✅ Я оплатил(а)", `claim:${reg.id}`) }
    );
  }

  // список участникам не показываем — только подсказываем, как записать ещё одного
  await ctx.reply(
    "Чтобы записать ещё одного человека — нажмите «📝 Записаться».",
    { reply_markup: mainMenu }
  );

  // Уведомление в группу: для абонемента — сразу (запись подтверждена, оплаты нет).
  // Для платных уведомление НЕ шлём здесь — оно уйдёт только после нажатия «Я оплатил(а)».
  if (GROUP_CHAT_ID && reg.sub) {
    try {
      const sent = await bot.api.sendMessage(GROUP_CHAT_ID, groupNoteText(reg, cfg.price), { reply_markup: payKeyboard(reg) });
      reg.groupMsgId = sent.message_id;
      await updateReg(reg.id, "groupMsgId", sent.message_id);
    } catch (e) { console.error("Не удалось отправить в группу:", e.message); }
  }
}

bot.catch((err) => console.error("Ошибка бота:", err));

async function setupBotMeta() {
  try {
    await bot.api.setMyCommands([
      { command: "start", description: "📝 Записаться на мероприятие" },
      { command: "list", description: "📋 Список записавшихся" }
    ]);
    const cfg = await getConfig();
    await bot.api.setMyDescription(
      `Бот для записи на мероприятие «${cfg.eventName}». Нажмите «Старт», чтобы оформить заявку.`
    );
  } catch (e) {
    console.error("Не удалось задать меню/описание:", e.message);
  }
}

(async () => {
  if (WEBHOOK_URL) {
    // Режим Cloud Run: HTTP-сервер + webhook. ctx.me нужен синхронно, поэтому init() заранее.
    await bot.init();
    await setupBotMeta();
    const handle = webhookCallback(bot, "http", { secretToken: WEBHOOK_SECRET });
    const server = http.createServer(async (req, res) => {
      if (req.method === "POST" && req.url === WEBHOOK_PATH) {
        try {
          await handle(req, res);
        } catch (e) {
          console.error("Ошибка webhook:", e.message);
          if (!res.headersSent) { res.statusCode = 500; res.end(); }
        }
      } else {
        res.statusCode = 200; res.end("ok"); // health check для Cloud Run
      }
    });
    server.listen(PORT, async () => {
      console.log(`✓ HTTP-сервер слушает порт ${PORT}`);
      try {
        const url = WEBHOOK_URL.replace(/\/$/, "") + WEBHOOK_PATH;
        await bot.api.setWebhook(url, { secret_token: WEBHOOK_SECRET });
        console.log(`✓ Webhook установлен: ${url}`);
      } catch (e) {
        console.error("Не удалось установить webhook:", e.message);
      }
    });
  } else {
    // Локальная разработка: long-polling.
    await bot.api.deleteWebhook().catch(() => {});
    await setupBotMeta();
    bot.start();
    console.log("✓ Бот запущен (long-polling). Меню и кнопки активны.");
  }
})();
