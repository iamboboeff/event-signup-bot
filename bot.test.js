const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.BOT_TOKEN = "123456:TEST_TOKEN_FOR_LOCAL_CHECK";
process.env.ADMIN_IDS = "42";
process.env.ADMIN_USERNAMES = "editor";
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "event-signup-bot-test-"));
process.env.DATA_DIR = testDataDir;
after(() => fs.rmSync(testDataDir, { recursive: true, force: true }));

const {
  ADMIN_BOT_COMMANDS,
  PUBLIC_BOT_COMMANDS,
  callDoctorSchedule,
  datesForMentor,
  doctorSlotLabel,
  isAdmin,
  isDoctorProgram,
  normalizeConfig,
  normalizeSessionStore,
  normalizeDoctorSlots,
  parseAdminTarget,
  registrationStopMessage,
  resolveAdminWebappUrl,
  sanitizeConfigInput,
  validateTelegramInitData
} = require("./bot");

function signInitData(entries) {
  const params = new URLSearchParams(entries);
  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(checkString).digest("hex"));
  return params.toString();
}

test("Telegram Mini App signature is checked before trusting the user", () => {
  const initData = signInitData({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "test-query",
    user: JSON.stringify({ id: 42, first_name: "Test" })
  });
  assert.equal(validateTelegramInitData(initData).id, 42);
  assert.equal(validateTelegramInitData(initData.replace("Test", "Changed")), null);
});

test("admin allowlist accepts IDs and normalized usernames", () => {
  assert.equal(isAdmin({ id: 42 }), true);
  assert.equal(isAdmin({ id: 7, username: "Editor" }), true);
  assert.equal(isAdmin({ id: 8, username: "natalishkayeap" }), true);
  assert.equal(isAdmin({ id: 9, username: "olya_liquid_spirit" }), true);
  assert.equal(isAdmin({ id: 8, username: "guest" }), false);
});

test("admin command targets accept Telegram IDs and usernames", () => {
  assert.deepEqual(parseAdminTarget("123456789"), { type: "id", value: "123456789" });
  assert.deepEqual(parseAdminTarget("@New_Admin"), { type: "username", value: "new_admin" });
  assert.equal(parseAdminTarget("not a username"), null);
});

test("ordinary Telegram menu exposes only registration", () => {
  assert.deepEqual(PUBLIC_BOT_COMMANDS.map(item => item.command), ["start"]);
  assert.equal(ADMIN_BOT_COMMANDS.some(item => item.command === "admin"), true);
  assert.equal(ADMIN_BOT_COMMANDS.some(item => item.command === "addadmin"), true);
});

test("registration stops on the options the admin marked with a notice", () => {
  // Настройки по умолчанию: Москва и «Привычка Быть счастливой» закрыты.
  const config = normalizeConfig({});
  assert.equal(
    registrationStopMessage(config, "city", " Москва "),
    "Запись на мероприятия в Москве откроется позже"
  );
  assert.equal(
    registrationStopMessage(config, "program", "Привычка Быть счастливой"),
    "Скоро…"
  );
  assert.equal(registrationStopMessage(config, "city", "Питер"), null);
  assert.equal(registrationStopMessage(config, "program", "Занятия аромаклуба"), null);

  // Всё, что задано в админке, работает так же — включая наставников.
  const edited = normalizeConfig({
    ...config,
    notices: { cities: {}, programs: {}, mentors: { "Золото": "Наставник в отпуске" } }
  });
  assert.equal(registrationStopMessage(edited, "city", "Москва"), null);
  assert.equal(registrationStopMessage(edited, "mentor", "золото"), "Наставник в отпуске");
});

test("mentor keeps personal dates and falls back to the shared list", () => {
  const config = normalizeConfig({ mentorDates: { "Золото": ["Вторник", "Четверг"] } });
  assert.deepEqual(datesForMentor(config, "золото"), ["Вторник", "Четверг"]);
  assert.deepEqual(datesForMentor(config, "Серебро"), config.dates);
  assert.deepEqual(datesForMentor(config, "Удалённый наставник"), config.dates);
});

test("notices and mentor dates are dropped when their option disappears", () => {
  const config = normalizeConfig({
    cities: ["Питер"],
    mentors: ["Серебро"],
    notices: { cities: { "Москва": "Скоро" }, programs: {}, mentors: {} },
    mentorDates: { "Золото": ["Вторник"], "Серебро": [" ", ""] }
  });
  assert.deepEqual(config.notices.cities, {});
  assert.deepEqual(config.mentorDates, {});
});

test("doctor diagnostics program is detected regardless of spaces and case", () => {
  assert.equal(isDoctorProgram(" Диагностика   С ДОКТОРОМ "), true);
  assert.equal(isDoctorProgram("Занятия аромаклуба"), false);
});

test("doctor slots are sanitized, deduplicated and labelled", () => {
  const slots = normalizeDoctorSlots([
    { id: "123:4", date: "23.09.2026", time: "13:00:00", patientName: "must not leak" },
    { id: "123:4", date: "23.09.2026", time: "13:00:00" },
    { id: "", date: "23.09.2026", time: "14:00" },
    { id: "123:5", date: "23.09.2026", time: "not-a-time" }
  ]);
  assert.deepEqual(slots, [{ id: "123:4", date: "23.09.2026", time: "13:00:00" }]);
  assert.equal(doctorSlotLabel(slots[0]), "23.09.2026 · 13:00");
  assert.equal("patientName" in slots[0], false);
});

test("doctor schedule client posts the secret and reports API error codes", async () => {
  const requests = [];
  const fetchOk = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ ok: true, slots: [] }) };
  };
  await callDoctorSchedule("https://example.com/exec", "test-secret-123456", "slots", {}, fetchOk);
  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    action: "slots",
    secret: "test-secret-123456"
  });

  const fetchConflict = async () => ({
    ok: true,
    json: async () => ({ ok: false, code: "SLOT_UNAVAILABLE", error: "busy" })
  });
  await assert.rejects(
    callDoctorSchedule("https://example.com/exec", "test-secret-123456", "book", {}, fetchConflict),
    error => error.code === "SLOT_UNAVAILABLE"
  );
});

test("unfinished registration sessions survive restarts for up to 24 hours", () => {
  const now = Date.parse("2026-08-24T13:00:00.000Z");
  const sessions = normalizeSessionStore({
    "123": {
      step: "program",
      draft: { city: "Питер" },
      updatedAt: "2026-08-24T12:59:00.000Z"
    },
    "456": {
      step: "program",
      draft: { city: "Питер" },
      updatedAt: "2026-08-22T12:59:00.000Z"
    },
    invalid: { step: "city", draft: {}, updatedAt: "2026-08-24T12:59:00.000Z" }
  }, now);

  assert.deepEqual(sessions, [[123, {
    step: "program",
    draft: { city: "Питер" },
    updatedAt: "2026-08-24T12:59:00.000Z"
  }]]);
});

test("Bothost domain provides the admin panel URL without enabling a webhook", () => {
  assert.equal(
    resolveAdminWebappUrl({ DOMAIN: "event-signup.bothost.ru" }),
    "https://event-signup.bothost.ru/admin"
  );
  assert.equal(
    resolveAdminWebappUrl({ ADMIN_WEBAPP_URL: "https://admin.example.com/panel/" }),
    "https://admin.example.com/panel"
  );
});

test("WEBHOOK_URL с путём от хостинга не задваивает /webhook", () => {
  // Bothost подставляет WEBHOOK_URL уже вида https://<домен>/webhook.
  assert.equal(
    resolveAdminWebappUrl({ WEBHOOK_URL: "https://bot-123.bothost.tech/webhook" }),
    "https://bot-123.bothost.tech/admin"
  );
  assert.equal(
    resolveAdminWebappUrl({ WEBHOOK_URL: "https://bot-123.bothost.tech" }),
    "https://bot-123.bothost.tech/admin"
  );
});

test("admin config is trimmed, deduplicated and validated", () => {
  const config = sanitizeConfigInput({
    eventName: " Новое событие ",
    price: " 0 ₽ ",
    payDetails: "",
    cities: [" Москва ", "Москва"],
    programs: ["Аромаклуб"],
    dates: ["Сегодня"],
    mentors: ["Анна"]
  });
  assert.equal(config.eventName, "Новое событие");
  assert.deepEqual(config.cities, ["Москва"]);
  assert.throws(() => sanitizeConfigInput({ ...config, dates: [] }));
});

test("admin config keeps notices and mentor dates only for existing options", () => {
  const config = sanitizeConfigInput({
    eventName: "Событие",
    price: "",
    payDetails: "",
    cities: ["Москва", "Питер"],
    programs: ["Аромаклуб"],
    dates: ["Понедельник"],
    mentors: ["Анна", "Пётр"],
    notices: {
      cities: { " Москва ": "  Скоро…  ", "Казань": "Нет такого города" },
      programs: { "Аромаклуб": "   " },
      mentors: {}
    },
    mentorDates: {
      "Анна": [" Вторник ", "Вторник", ""],
      "Пётр": [],
      "Мария": ["Среда"]
    }
  });
  assert.deepEqual(config.notices.cities, { "Москва": "Скоро…" });
  assert.deepEqual(config.notices.programs, {});
  assert.deepEqual(config.mentorDates, { "Анна": ["Вторник"] });
  assert.throws(() => sanitizeConfigInput({
    ...config,
    notices: { ...config.notices, cities: { "Москва": "я".repeat(401) } }
  }));
});

test("admin page contains valid inline JavaScript", () => {
  const html = fs.readFileSync("admin.html", "utf8");
  assert.match(html, /id="brandGate"/);
  assert.doesNotMatch(html, /Откройте панель заново/);
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(source => source.trim());
  assert.equal(scripts.length, 1);
  scripts.forEach(source => assert.doesNotThrow(() => new Function(source)));
});
