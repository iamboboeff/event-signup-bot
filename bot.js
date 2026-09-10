require("dotenv").config();
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { Bot, InlineKeyboard, Keyboard, webhookCallback } = require("grammy");

// ---------- env ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("✖ Нет BOT_TOKEN. Скопируй .env.example в .env и вставь токен от @BotFather.");
  process.exit(1);
}
// Значения по умолчанию зашиты в код (тестовый проект): если переменная окружения
// не задана — берём захардкоженное. НЕ секреты, поэтому в публичном репо это ок.
// (BOT_TOKEN сюда НЕ пишем — его Telegram отозвёт, если найдёт в открытом репо.)
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || "-1003634961399";
const ADMIN_IDS = (process.env.ADMIN_IDS || "1350559985").split(",").map(s => s.trim()).filter(Boolean);
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || "")
  .split(",")
  .map(s => s.trim().replace(/^@/, "").toLowerCase())
  .filter(Boolean);

function normalizePublicUrl(value) {
  const url = String(value || "").trim().replace(/\/$/, "");
  if (!url) return "";
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

// Хостинг может передать WEBHOOK_URL уже с путём: Bothost подставляет
// https://<домен>/webhook. Отрезаем его, иначе setWebhook получит /webhook/webhook
// (Telegram будет слать апдейты в никуда), а ссылка на админку — /webhook/admin.
function webhookOrigin(value) {
  return normalizePublicUrl(String(value || "").trim().replace(/\/+$/, "").replace(/\/webhook$/i, ""));
}

function resolveAdminWebappUrl(env = process.env) {
  const explicit = normalizePublicUrl(env.ADMIN_WEBAPP_URL);
  if (explicit) return explicit;
  const publicUrl = webhookOrigin(env.WEBHOOK_URL) || normalizePublicUrl(env.DOMAIN);
  return publicUrl ? `${publicUrl}/admin` : "";
}

// Если публичный webhook не задан, бот работает через long polling.
const WEBHOOK_URL = webhookOrigin(process.env.WEBHOOK_URL);
// Bothost передаёт DOMAIN автоматически после подключения домена.
const ADMIN_WEBAPP_URL = resolveAdminWebappUrl();
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || (BOT_TOKEN.split(":")[1] || "secret").slice(0, 16);
const PORT = Number(process.env.PORT) || 8080;
const WEBHOOK_PATH = "/webhook";
const DOCTOR_SHEET_WEBAPP_URL = normalizePublicUrl(process.env.DOCTOR_SHEET_WEBAPP_URL);
const DOCTOR_SHEET_SECRET = String(process.env.DOCTOR_SHEET_SECRET || "").trim();
const DOCTOR_PROGRAM_NAME = "диагностика с доктором";

// ---------- storage ----------
// config.json хранит только исходные значения. Все изменения из админки и
// заявки лежат отдельно, поэтому обновление кода их не перезаписывает.
const DEFAULT_CONFIG_PATH = path.join(__dirname, "config.json");
const DEFAULT_ADMINS_PATH = path.join(__dirname, "admins.json");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const ADMINS_PATH = path.join(DATA_DIR, "admins.json");
const ADMIN_MODES_PATH = path.join(DATA_DIR, "admin-modes.json");
const SESSIONS_PATH = path.join(DATA_DIR, "sessions.json");
const REGS_PATH = path.join(DATA_DIR, "registrations.json");
const LEGACY_REGS_PATH = path.join(__dirname, "registrations.json");
const ADMIN_HTML_PATH = path.join(__dirname, "admin.html");

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch (e) { return fallback; }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = filePath + ".tmp";
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  fs.renameSync(tempPath, filePath);
}

function loadConfig() {
  const defaults = readJson(DEFAULT_CONFIG_PATH, {});
  const saved = readJson(CONFIG_PATH, null);
  return normalizeConfig(saved || defaults, defaults);
}

function normalizeConfig(config, fallback = readJson(DEFAULT_CONFIG_PATH, {})) {
  const source = config && typeof config === "object" ? config : {};
  const normalized = { ...fallback, ...source };
  ["cities", "programs", "mentors", "dates"].forEach(key => {
    if (!Array.isArray(source[key]) || !source[key].length) normalized[key] = fallback[key];
  });
  return normalized;
}

function saveConfig(config) {
  const normalized = normalizeConfig(config);
  writeJsonAtomic(CONFIG_PATH, normalized);
  return normalized;
}

function normalizeAdminStore(store) {
  const source = store && typeof store === "object" ? store : {};
  return {
    ids: [...new Set((Array.isArray(source.ids) ? source.ids : [])
      .map(value => String(value).trim())
      .filter(value => /^\d+$/.test(value)))],
    usernames: [...new Set((Array.isArray(source.usernames) ? source.usernames : [])
      .map(value => String(value).trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean))]
  };
}

function loadAdmins() {
  const saved = readJson(ADMINS_PATH, null);
  if (saved) return normalizeAdminStore(saved);

  const defaults = normalizeAdminStore(readJson(DEFAULT_ADMINS_PATH, {}));
  const initial = normalizeAdminStore({
    ids: [...defaults.ids, ...ADMIN_IDS],
    usernames: [...defaults.usernames, ...ADMIN_USERNAMES]
  });
  writeJsonAtomic(ADMINS_PATH, initial);
  return initial;
}

function saveAdmins(admins) {
  const normalized = normalizeAdminStore(admins);
  writeJsonAtomic(ADMINS_PATH, normalized);
  return normalized;
}

function loadAdminModes() {
  const ids = readJson(ADMIN_MODES_PATH, []);
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.map(value => Number(value)).filter(Number.isSafeInteger))];
}

function saveAdminModes(modes) {
  writeJsonAtomic(ADMIN_MODES_PATH, [...modes]);
}

const REGISTRATION_STEPS = new Set(["city", "program", "name", "mentor", "doctor_slot", "date", "sub"]);
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeSessionStore(store, now = Date.now()) {
  if (!store || typeof store !== "object" || Array.isArray(store)) return [];
  return Object.entries(store).flatMap(([userId, session]) => {
    if (!/^\d+$/.test(userId) || !session || typeof session !== "object") return [];
    if (!REGISTRATION_STEPS.has(session.step) || !session.draft || typeof session.draft !== "object") return [];
    const updatedAt = Date.parse(session.updatedAt || "");
    if (!Number.isFinite(updatedAt) || now - updatedAt > SESSION_TTL_MS || updatedAt > now + 60_000) return [];
    return [[Number(userId), { step: session.step, draft: { ...session.draft }, updatedAt: session.updatedAt }]];
  });
}

function loadSessions() {
  return new Map(normalizeSessionStore(readJson(SESSIONS_PATH, {})));
}

function saveSessions(sessions) {
  writeJsonAtomic(SESSIONS_PATH, Object.fromEntries(sessions));
}

function loadRegs() {
  const current = readJson(REGS_PATH, null);
  if (current) return current;
  const legacy = readJson(LEGACY_REGS_PATH, []);
  writeJsonAtomic(REGS_PATH, legacy);
  return legacy;
}
function saveRegs(regs) {
  writeJsonAtomic(REGS_PATH, regs);
}

async function getConfig() {
  return loadConfig();
}

async function getRegs() {
  return loadRegs();
}

async function getReg(id) {
  const regs = await getRegs();
  return regs.find(r => String(r.id) === String(id)) || null;
}

// Создать новую запись.
async function createReg(reg) {
  const regs = loadRegs();
  regs.push(reg);
  saveRegs(regs);
}

// Обновить одно поле записи (оплата / заявил об оплате / message_id в группе).
async function updateReg(id, field, value) {
  const regs = loadRegs();
  const reg = regs.find(r => String(r.id) === String(id));
  if (reg) { reg[field] = value; saveRegs(regs); }
}

// Удалить запись целиком (выбранного участника).
async function deleteReg(id) {
  const regs = loadRegs().filter(r => String(r.id) !== String(id));
  saveRegs(regs);
}

// ---------- bot ----------
const bot = new Bot(BOT_TOKEN);
const sessions = loadSessions(); // userId -> { step, draft, updatedAt }
const adminModes = new Set(loadAdminModes()); // действует до /adminoff, включая перезапуск

function setSession(userId, session) {
  session.updatedAt = new Date().toISOString();
  sessions.set(userId, session);
  saveSessions(sessions);
}

function saveSession(userId, session) {
  setSession(userId, session);
}

function deleteSession(userId) {
  if (!sessions.delete(userId)) return;
  saveSessions(sessions);
}

const MOSCOW_REGISTRATION_CLOSED_MESSAGE = "Запись на мероприятия в Москве откроется позже";
const PROGRAM_COMING_SOON_MESSAGE = "Скоро…";

function normalizeChoice(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru");
}

function registrationStopMessage(type, value) {
  const choice = normalizeChoice(value);
  if (type === "city" && choice === "москва") return MOSCOW_REGISTRATION_CLOSED_MESSAGE;
  if (type === "program" && choice === "привычка быть счастливой") return PROGRAM_COMING_SOON_MESSAGE;
  return null;
}

function isDoctorProgram(value) {
  return normalizeChoice(value) === DOCTOR_PROGRAM_NAME;
}

function isDoctorScheduleConfigured() {
  return /^https:\/\//i.test(DOCTOR_SHEET_WEBAPP_URL) && DOCTOR_SHEET_SECRET.length >= 16;
}

function normalizeDoctorSlots(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap(slot => {
    if (!slot || typeof slot !== "object") return [];
    const normalized = {
      id: String(slot.id || "").trim(),
      date: String(slot.date || "").trim(),
      time: String(slot.time || "").trim()
    };
    if (!normalized.id || !normalized.date || !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(normalized.time)) return [];
    if (normalized.id.length > 80 || normalized.date.length > 40 || seen.has(normalized.id)) return [];
    seen.add(normalized.id);
    return [normalized];
  }).slice(0, 50);
}

function doctorSlotLabel(slot) {
  return `${slot.date} · ${slot.time.replace(/:00$/, "")}`;
}

async function callDoctorSchedule(url, secret, action, payload = {}, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, secret, ...payload }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (!result || result.ok !== true) {
      const error = new Error(result && result.error ? result.error : "Сервис расписания вернул ошибку");
      error.code = result && result.code ? result.code : "SCHEDULE_ERROR";
      throw error;
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function doctorScheduleRequest(action, payload) {
  if (!isDoctorScheduleConfigured()) {
    const error = new Error("Расписание врача не подключено");
    error.code = "SCHEDULE_NOT_CONFIGURED";
    throw error;
  }
  return callDoctorSchedule(
    DOCTOR_SHEET_WEBAPP_URL,
    DOCTOR_SHEET_SECRET,
    action,
    payload
  );
}

function doctorSlotsKeyboard(slots) {
  const keyboard = new InlineKeyboard();
  slots.forEach((slot, index) => keyboard.text(doctorSlotLabel(slot), `doctor_slot:${index}`).row());
  keyboard.text("🔄 Обновить слоты", "doctor_refresh:0");
  return keyboard;
}

async function refreshDoctorSlots(ctx, session, editMessage = false, prefix = "") {
  const result = await doctorScheduleRequest("slots");
  const slots = normalizeDoctorSlots(result.slots);
  session.draft.doctorSlots = slots;
  session.step = "doctor_slot";
  saveSession(ctx.from.id, session);

  const text = slots.length
    ? `${prefix}Выберите свободные дату и время:`
    : `${prefix}Свободных слотов пока нет. Можно обновить расписание позже.`;
  const options = { reply_markup: doctorSlotsKeyboard(slots) };
  if (editMessage) await ctx.editMessageText(text, options);
  else await ctx.reply(text, options);
}

function choiceKeyboard(items, prefix, onePerRow = false) {
  const k = new InlineKeyboard();
  items.forEach((item, i) => {
    if (i > 0 && (onePerRow || i % 2 === 0)) k.row();
    k.text(item, prefix + ":" + i);
  });
  return k;
}

// Постоянное меню снизу — всегда на виду (не надо печатать /start).
// Список записавшихся участникам не показываем — он только для админа в группе (/list).
const mainMenu = new Keyboard()
  .text("📝 Записаться")
  .resized().persistent();

// Обычный пользователь видит только запись. Полное меню Telegram включается
// персонально в личном чате после успешной команды /admin.
const PUBLIC_BOT_COMMANDS = [
  { command: "start", description: "📝 Записаться" }
];
const ADMIN_BOT_COMMANDS = [
  { command: "start", description: "📝 Записаться" },
  { command: "list", description: "📋 Список записавшихся" },
  { command: "admin", description: "⚙️ Открыть админ-панель" },
  { command: "adminoff", description: "🚪 Выключить режим администратора" },
  { command: "addadmin", description: "➕ Добавить администратора" },
  { command: "kickadmin", description: "➖ Удалить администратора" },
  { command: "id", description: "🆔 Показать Telegram ID" }
];

function privateChatCommandScope(ctx) {
  return { type: "chat", chat_id: ctx.chat.id };
}

async function showAdminCommandMenu(ctx) {
  await bot.api.setMyCommands(ADMIN_BOT_COMMANDS, { scope: privateChatCommandScope(ctx) });
}

async function hideAdminCommandMenu(ctx) {
  await bot.api.deleteMyCommands({ scope: privateChatCommandScope(ctx) });
}

// Начать новую запись (из /start или по кнопке «Записаться»).
async function startRegistration(ctx) {
  // Запись ведём только в личном чате с ботом — в группе анкету не запускаем.
  if (ctx.chat.type !== "private") {
    await ctx.reply(`Чтобы записаться, напишите боту в личные сообщения: https://t.me/${ctx.me.username}`);
    return;
  }
  if (isAdminMode(ctx.from)) {
    await ctx.reply("Сейчас включён режим администратора. Чтобы записаться как пользователь, отправьте /adminoff.");
    return;
  }
  const cfg = await getConfig();
  setSession(ctx.from.id, { step: "city", draft: {} });
  await ctx.reply(
    `Здравствуйте! Это запись на «${cfg.eventName}».\n\nСначала выберите город:`,
    { reply_markup: choiceKeyboard(cfg.cities, "city") }
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
      const route = [r.city, r.program, r.mentor].filter(Boolean).join(" — ");
      msg += `${i + 1}. ${r.name}${route ? " — " + route : ""} — ${r.sub ? "абонемент" : "оплата"}${pending}\n`;
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
  if (!isAdmin(ctx.from)) {
    await ctx.reply("📋 Список записавшихся доступен только администратору.", { reply_markup: menu });
    return;
  }
  const view = await buildListView(arg);
  if (!view) { await ctx.reply("Записей пока нет.", { reply_markup: menu }); return; }
  // Инлайн-кнопки 🗑 позволяют удалить выбранного участника прямо из списка.
  await ctx.reply(view.text, { reply_markup: view.keyboard });
}

// Администраторы задаются только явным белым списком. Telegram ID надёжнее:
// username можно поменять или передать другому аккаунту.
function isAdmin(user) {
  if (!user) return false;
  const id = typeof user === "object" ? user.id : user;
  const username = typeof user === "object" && user.username
    ? user.username.replace(/^@/, "").toLowerCase()
    : "";
  const admins = loadAdmins();
  return ADMIN_IDS.includes(String(id)) ||
    admins.ids.includes(String(id)) ||
    (!!username && (ADMIN_USERNAMES.includes(username) || admins.usernames.includes(username)));
}

function isAdminMode(user) {
  if (!user || !adminModes.has(user.id)) return false;
  if (isAdmin(user)) return true;
  adminModes.delete(user.id);
  saveAdminModes(adminModes);
  bot.api.deleteMyCommands({ scope: { type: "chat", chat_id: user.id } }).catch(() => {});
  return false;
}

function parseAdminTarget(value) {
  const raw = String(value || "").trim();
  if (/^\d+$/.test(raw)) return { type: "id", value: raw };
  const username = raw.replace(/^@/, "").toLowerCase();
  if (/^[a-z0-9_]{5,32}$/.test(username)) return { type: "username", value: username };
  return null;
}

function adminTargetLabel(target) {
  return target.type === "id" ? `ID ${target.value}` : `@${target.value}`;
}

async function requireAdminCommandAccess(ctx) {
  if (ctx.chat.type !== "private") {
    await ctx.reply("Управлять администраторами можно только в личном чате с ботом.");
    return false;
  }
  if (!isAdmin(ctx.from)) {
    await ctx.reply("У вас нет прав для управления администраторами.");
    return false;
  }
  return true;
}

// Текст уведомления о записи (для группы) с учётом статуса оплаты.
function groupNoteText(reg, priceText) {
  let t = `🔔 Запись\n${reg.name}`;
  if (reg.city) t += `\nГород: ${reg.city}`;
  if (reg.program) t += `\nНаправление: ${reg.program}`;
  t += `\nДата: ${reg.date}\nНаставник: ${reg.mentor}`;
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
  if (!isAdmin(ctx.from)) {
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
      const booking = reg.program
        ? `на «${reg.program}»${reg.city ? " (" + reg.city + ")" : ""}`
        : `на «${reg.date}»`;
      await bot.api.sendMessage(
        reg.userId,
        `✅ Ваша оплата подтверждена. Бронь ${booking} подтверждена. До встречи!`
      );
      await bot.api.sendMessage(
        reg.userId,
        "Чтобы записать ещё одного человека — нажмите «📝 Записаться».",
        { reply_markup: mainMenu }
      );
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
  if (!isAdmin(ctx.from)) {
    await ctx.answerCallbackQuery({ text: "Удалять записи может только администратор.", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  const id = data.split(":")[1];
  const reg = await getReg(id);
  if (!reg) { await ctx.reply("Запись не найдена (возможно, уже удалена)."); return; }
  await ctx.reply(
    `Удалить запись?\n${[reg.name, reg.city, reg.program, reg.date, reg.mentor].filter(Boolean).join(" — ")}`,
    {
      reply_markup: new InlineKeyboard()
        .text("🗑 Да, удалить", `delok:${reg.id}`)
        .text("↩️ Отмена", "delcancel")
    }
  );
}

// Админ подтвердил удаление — убираем запись и карточку из группы.
async function handleDeleteConfirm(ctx, data) {
  if (!isAdmin(ctx.from)) {
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

bot.command("admin", async (ctx) => {
  if (ctx.chat.type !== "private") {
    await ctx.reply("Админ-панель открывается только в личном чате с ботом.");
    return;
  }
  if (!isAdmin(ctx.from)) {
    await ctx.reply("У вас нет доступа к админ-панели.");
    return;
  }
  adminModes.add(ctx.from.id);
  saveAdminModes(adminModes);
  deleteSession(ctx.from.id);
  try { await showAdminCommandMenu(ctx); }
  catch (e) { console.error("Не удалось показать меню администратора:", e.message); }

  if (!/^https:\/\//i.test(ADMIN_WEBAPP_URL)) {
    await ctx.reply(
      "Режим администратора включён, но веб-панель пока не подключена. " +
      "Укажите её HTTPS-адрес в ADMIN_WEBAPP_URL. Для выхода отправьте /adminoff."
    );
    return;
  }

  await ctx.reply(
    "Режим администратора включён. Здесь можно менять все настройки бота. Для выхода отправьте /adminoff.",
    { reply_markup: new InlineKeyboard().webApp("⚙️ Открыть админ-панель", ADMIN_WEBAPP_URL) }
  );
});

bot.command("adminoff", async (ctx) => {
  adminModes.delete(ctx.from.id);
  saveAdminModes(adminModes);
  deleteSession(ctx.from.id);
  if (ctx.chat.type === "private") {
    try { await hideAdminCommandMenu(ctx); }
    catch (e) { console.error("Не удалось скрыть меню администратора:", e.message); }
  }
  await ctx.reply("Режим администратора выключен. Теперь бот работает для вас как обычно.", {
    reply_markup: ctx.chat.type === "private" ? mainMenu : { remove_keyboard: true }
  });
});

bot.command("addadmin", async (ctx) => {
  if (!(await requireAdminCommandAccess(ctx))) return;
  const target = parseAdminTarget(ctx.match);
  if (!target) {
    await ctx.reply("Укажите Telegram ID или username.\n\nПримеры:\n/addadmin 123456789\n/addadmin @username");
    return;
  }

  const admins = loadAdmins();
  const key = target.type === "id" ? "ids" : "usernames";
  const protectedList = target.type === "id" ? ADMIN_IDS : ADMIN_USERNAMES;
  if (admins[key].includes(target.value) || protectedList.includes(target.value)) {
    await ctx.reply(`${adminTargetLabel(target)} уже является администратором.`);
    return;
  }

  admins[key].push(target.value);
  saveAdmins(admins);
  await ctx.reply(
    `✅ ${adminTargetLabel(target)} добавлен в администраторы.` +
    (target.type === "username" ? "\nДля более надёжного доступа лучше добавить Telegram ID." : "")
  );
});

bot.command("kickadmin", async (ctx) => {
  if (!(await requireAdminCommandAccess(ctx))) return;
  const target = parseAdminTarget(ctx.match);
  if (!target) {
    await ctx.reply("Укажите Telegram ID или username.\n\nПримеры:\n/kickadmin 123456789\n/kickadmin @username");
    return;
  }

  const protectedList = target.type === "id" ? ADMIN_IDS : ADMIN_USERNAMES;
  if (protectedList.includes(target.value)) {
    await ctx.reply(`${adminTargetLabel(target)} задан в настройках сервера и защищён от удаления.`);
    return;
  }

  const admins = loadAdmins();
  const key = target.type === "id" ? "ids" : "usernames";
  const before = admins[key].length;
  admins[key] = admins[key].filter(value => value !== target.value);
  if (admins[key].length === before) {
    await ctx.reply(`${adminTargetLabel(target)} не найден в изменяемом списке администраторов.`);
    return;
  }

  saveAdmins(admins);
  if (target.type === "id") {
    const removedId = Number(target.value);
    adminModes.delete(removedId);
    saveAdminModes(adminModes);
    bot.api.deleteMyCommands({ scope: { type: "chat", chat_id: removedId } }).catch(() => {});
  }
  await ctx.reply(`✅ ${adminTargetLabel(target)} удалён из администраторов.`);
});

// Помощник: узнать chat_id (для группы) и свой user id.
bot.command("id", async (ctx) => {
  await ctx.reply(`chat_id: ${ctx.chat.id}\nваш user id: ${ctx.from.id}`);
});

// Список записавшихся (по желанию — на конкретный день: /list Понедельник)
bot.command("list", async (ctx) => {
  await showList(ctx, (ctx.match || "").trim());
});

// Текст: кнопки меню или ввод имени (после выбора города и направления)
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();

  // Кнопки постоянного меню — работают в любой момент
  if (text === "📝 Записаться") { await startRegistration(ctx); return; }
  if (text === "📋 Список на день") { await showList(ctx, ""); return; }

  // Ввод анкеты (Фамилия Имя) принимаем только в личном чате.
  if (ctx.chat.type !== "private") return;

  if (isAdminMode(ctx.from)) {
    await ctx.reply("Вы в режиме администратора. Откройте панель через /admin или отправьте /adminoff для обычного режима.");
    return;
  }

  const s = sessions.get(ctx.from.id);
  if (!s) { await ctx.reply("Нажмите «📝 Записаться», чтобы оформить заявку.", { reply_markup: mainMenu }); return; }
  if (s.step !== "name") return; // на шагах с кнопками ждём нажатия, текст игнорируем

  if (text.length < 2) { await ctx.reply("Пожалуйста, введите Фамилию и Имя:"); return; }
  s.draft.name = text;
  s.step = "mentor";
  saveSession(ctx.from.id, s);
  const cfg = await getConfig();
  const label = isDoctorProgram(s.draft.program) && isDoctorScheduleConfigured()
    ? "Выберите консультанта:"
    : "Выберите наставника:";
  await ctx.reply(label, { reply_markup: choiceKeyboard(cfg.mentors, "mentor") });
});

// Шаги анкеты с кнопками
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

  // Шаги анкеты — только в личном чате.
  if (ctx.chat.type !== "private") { await ctx.answerCallbackQuery(); return; }

  if (isAdminMode(ctx.from)) {
    await ctx.answerCallbackQuery({ text: "Сначала выключите режим администратора: /adminoff", show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery();
  const s = sessions.get(ctx.from.id);
  const cfg = await getConfig();
  const [type, idxStr] = ctx.callbackQuery.data.split(":");
  const idx = parseInt(idxStr, 10);

  const selectedChoice = type === "city"
    ? cfg.cities[idx]
    : type === "program" ? cfg.programs[idx] : null;
  const stopMessage = selectedChoice && registrationStopMessage(type, selectedChoice);
  if (stopMessage && (!s || s.step === type)) {
    const label = type === "city" ? "Город" : "Направление";
    await ctx.editMessageText(`${label}: ${selectedChoice}`);
    deleteSession(ctx.from.id);
    await ctx.reply(stopMessage, { reply_markup: mainMenu });
    return;
  }

  if (!s) { await ctx.reply("Нажмите «📝 Записаться», чтобы начать.", { reply_markup: mainMenu }); return; }

  if (type === "city" && s.step === "city" && cfg.cities[idx]) {
    s.draft.city = cfg.cities[idx];
    await ctx.editMessageText(`Город: ${s.draft.city}`);
    s.step = "program";
    saveSession(ctx.from.id, s);
    await ctx.reply("Выберите направление:", {
      reply_markup: choiceKeyboard(cfg.programs, "program", true)
    });

  } else if (type === "program" && s.step === "program" && cfg.programs[idx]) {
    s.draft.program = cfg.programs[idx];
    await ctx.editMessageText(`Направление: ${s.draft.program}`);
    s.step = "name";
    saveSession(ctx.from.id, s);
    await ctx.reply("Напишите вашу Фамилию и Имя:", { reply_markup: mainMenu });

  } else if (type === "mentor" && s.step === "mentor" && cfg.mentors[idx]) {
    s.draft.mentor = cfg.mentors[idx];
    if (isDoctorProgram(s.draft.program) && isDoctorScheduleConfigured()) {
      s.step = "doctor_slot";
      saveSession(ctx.from.id, s);
      await ctx.editMessageText(`Консультант: ${s.draft.mentor}`);
      try {
        await refreshDoctorSlots(ctx, s);
      } catch (error) {
        console.error("Не удалось получить расписание врача:", error.message);
        await ctx.reply("Не удалось загрузить расписание. Попробуйте обновить слоты.", {
          reply_markup: doctorSlotsKeyboard([])
        });
      }
    } else {
      s.step = "date";
      saveSession(ctx.from.id, s);
      await ctx.editMessageText(`Наставник: ${s.draft.mentor}`);
      await ctx.reply("Выберите дату:", { reply_markup: choiceKeyboard(cfg.dates, "date") });
    }

  } else if (type === "doctor_refresh" && s.step === "doctor_slot") {
    try {
      await refreshDoctorSlots(ctx, s, true);
    } catch (error) {
      console.error("Не удалось обновить расписание врача:", error.message);
      await ctx.reply("Расписание временно недоступно. Попробуйте ещё раз чуть позже.", {
        reply_markup: doctorSlotsKeyboard([])
      });
    }

  } else if (type === "doctor_slot" && s.step === "doctor_slot") {
    const slots = normalizeDoctorSlots(s.draft.doctorSlots);
    const slot = slots[idx];
    if (!slot) {
      await refreshDoctorSlots(ctx, s, true, "Список слотов изменился. ");
      return;
    }

    try {
      const result = await doctorScheduleRequest("book", {
        slotId: slot.id,
        expectedDate: slot.date,
        expectedTime: slot.time,
        patientName: s.draft.name,
        consultant: s.draft.mentor
      });
      const booked = result.slot || slot;
      await ctx.editMessageText(`Дата и время: ${doctorSlotLabel(booked)}`);
      deleteSession(ctx.from.id);
      await ctx.reply(
        `Вы записаны на диагностику с доктором ✅\n\n` +
        `Дата и время: ${doctorSlotLabel(booked)}\n` +
        `Консультант: ${s.draft.mentor}`,
        { reply_markup: mainMenu }
      );
    } catch (error) {
      if (["SLOT_UNAVAILABLE", "SLOT_CHANGED", "SLOT_NOT_FOUND"].includes(error.code)) {
        await refreshDoctorSlots(ctx, s, true, "Этот слот уже недоступен. ");
        return;
      }
      console.error("Не удалось забронировать слот врача:", error.message);
      await ctx.reply("Не удалось завершить запись. Выберите слот ещё раз или обновите расписание.", {
        reply_markup: doctorSlotsKeyboard(slots)
      });
    }

  } else if (type === "date" && s.step === "date" && cfg.dates[idx]) {
    s.draft.date = cfg.dates[idx];
    s.step = "sub";
    saveSession(ctx.from.id, s);
    await ctx.editMessageText(`Дата: ${s.draft.date}`);
    const k = new InlineKeyboard().text("Да", "sub:1").text("Нет", "sub:0");
    await ctx.reply("Вы участвуете по абонементу?", { reply_markup: k });

  } else if (type === "sub" && s.step === "sub") {
    s.draft.sub = idx === 1;
    await ctx.editMessageText(`По абонементу: ${s.draft.sub ? "Да" : "Нет"}`);
    await finish(ctx, s.draft);
    deleteSession(ctx.from.id);
  }
});

async function finish(ctx, draft) {
  const cfg = await getConfig();
  const reg = {
    id: Date.now(),
    name: draft.name,
    city: draft.city,
    program: draft.program,
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
    await ctx.reply(
      "Чтобы записать ещё одного человека — нажмите «📝 Записаться».",
      { reply_markup: mainMenu }
    );
  } else {
    await ctx.reply(
      `Стоимость участия — ${cfg.price}.\nОплата переводом по реквизитам ниже. После перевода нажмите «Я оплатил(а)» 👇\n\n${cfg.payDetails}`,
      { reply_markup: new InlineKeyboard().text("✅ Я оплатил(а)", `claim:${reg.id}`) }
    );
  }

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
    await bot.api.setMyCommands(PUBLIC_BOT_COMMANDS);
    const cfg = await getConfig();
    await bot.api.setMyDescription(
      `Бот для записи на мероприятие «${cfg.eventName}». Нажмите «Старт», чтобы оформить заявку.`
    );
  } catch (e) {
    console.error("Не удалось задать меню/описание:", e.message);
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(payload));
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 64 * 1024) reject(new Error("Слишком большой запрос"));
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error("Некорректный JSON")); }
    });
    req.on("error", reject);
  });
}

// Проверка initData по алгоритму Telegram Web Apps. Клиентский user.id никогда
// не используется без этой подписи.
function validateTelegramInitData(initData) {
  if (!initData || typeof initData !== "string") return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) return null;
  params.delete("hash");

  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const expectedHash = crypto.createHmac("sha256", secretKey).update(checkString).digest("hex");
  const received = Buffer.from(receivedHash, "hex");
  const expected = Buffer.from(expectedHash, "hex");
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;

  const authDate = Number(params.get("auth_date"));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authDate) || authDate > now + 300 || now - authDate > 24 * 60 * 60) return null;

  try {
    const user = JSON.parse(params.get("user") || "null");
    return user && user.id ? user : null;
  } catch (e) {
    return null;
  }
}

function authenticateAdminRequest(req) {
  const user = validateTelegramInitData(req.headers["x-telegram-init-data"]);
  if (!user || !isAdminMode(user)) return null;
  return user;
}

function sanitizeConfigInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Некорректные настройки");
  const listKeys = ["cities", "programs", "dates", "mentors"];
  const result = {};

  listKeys.forEach(key => {
    if (!Array.isArray(input[key])) throw new Error(`Поле «${key}» должно быть списком`);
    const values = [...new Set(input[key].map(value => String(value).trim()).filter(Boolean))];
    if (!values.length) throw new Error("В каждом разделе нужен хотя бы один вариант");
    if (values.length > 40 || values.some(value => value.length > 120)) throw new Error("Слишком много вариантов или слишком длинный текст");
    result[key] = values;
  });

  result.eventName = String(input.eventName || "").trim();
  result.price = String(input.price || "").trim();
  result.payDetails = String(input.payDetails || "").trim();
  if (!result.eventName) throw new Error("Укажите название мероприятия");
  if (result.eventName.length > 120 || result.price.length > 80 || result.payDetails.length > 1200) {
    throw new Error("Одно из полей содержит слишком длинный текст");
  }
  return result;
}

async function handleHttpRequest(req, res, webhookHandle) {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;

  if (req.method === "POST" && pathname === WEBHOOK_PATH && webhookHandle) {
    try {
      await webhookHandle(req, res);
    } catch (e) {
      console.error("Ошибка webhook:", e.message);
      if (!res.headersSent) sendJson(res, 500, { ok: false });
    }
    return;
  }

  if (req.method === "GET" && (pathname === "/admin" || pathname === "/admin/")) {
    try {
      const html = fs.readFileSync(ADMIN_HTML_PATH);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer"
      });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Админ-панель недоступна");
    }
    return;
  }

  if (pathname === "/api/admin/config") {
    const admin = authenticateAdminRequest(req);
    if (!admin) {
      sendJson(res, 403, { ok: false, error: "Доступ не подтверждён" });
      return;
    }

    if (req.method === "GET") {
      sendJson(res, 200, { ok: true, config: loadConfig() });
      return;
    }

    if (req.method === "PUT") {
      try {
        const input = await readRequestJson(req);
        const config = saveConfig(sanitizeConfigInput(input));
        console.log(`✓ Настройки обновил администратор ${admin.id}${admin.username ? " (@" + admin.username + ")" : ""}`);
        setupBotMeta().catch(e => console.error("Не удалось обновить описание бота:", e.message));
        sendJson(res, 200, { ok: true, config });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
      }
      return;
    }

    sendJson(res, 405, { ok: false, error: "Метод не поддерживается" });
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("ok");
}

async function startApp() {
  await bot.init();
  await setupBotMeta();
  let webhookHandle = null;

  if (WEBHOOK_URL) {
    webhookHandle = webhookCallback(bot, "http", { secretToken: WEBHOOK_SECRET });
  } else {
    await bot.api.deleteWebhook().catch(() => {});
    bot.start();
    console.log("✓ Бот запущен (long-polling). Меню и кнопки активны.");
  }

  const server = http.createServer((req, res) => {
    handleHttpRequest(req, res, webhookHandle).catch(error => {
      console.error("Ошибка HTTP-сервера:", error.message);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "Внутренняя ошибка" });
    });
  });
  server.listen(PORT, async () => {
    console.log(`✓ HTTP-сервер и админ-панель слушают порт ${PORT}`);
    if (WEBHOOK_URL) {
      try {
        const url = WEBHOOK_URL.replace(/\/$/, "") + WEBHOOK_PATH;
        await bot.api.setWebhook(url, { secret_token: WEBHOOK_SECRET });
        console.log(`✓ Webhook установлен: ${url}`);
      } catch (e) {
        console.error("Не удалось установить webhook:", e.message);
      }
    }
  });
}

if (require.main === module) {
  startApp().catch(error => {
    console.error("Не удалось запустить бота:", error);
    process.exit(1);
  });
}

module.exports = {
  ADMIN_BOT_COMMANDS,
  PUBLIC_BOT_COMMANDS,
  callDoctorSchedule,
  doctorSlotLabel,
  isAdmin,
  isDoctorProgram,
  normalizeConfig,
  normalizeDoctorSlots,
  normalizeSessionStore,
  parseAdminTarget,
  registrationStopMessage,
  resolveAdminWebappUrl,
  sanitizeConfigInput,
  validateTelegramInitData
};
