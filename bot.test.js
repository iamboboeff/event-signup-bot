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
  cityStopMessage,
  doctorSlotLabel,
  findOption,
  groupNoteText,
  isAdmin,
  isDoctorProgram,
  normalizeConfig,
  normalizeSessionStore,
  normalizeDoctorSlots,
  parseAdminTarget,
  registrationPrice,
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

test("settings saved before the split by city move into every city without losses", () => {
  const config = normalizeConfig({
    eventName: "Аромаклуб",
    price: "2 000 ₽",
    payDetails: "СБП",
    cities: ["Питер", "Москва"],
    programs: ["Аромаклуб", "Привычка Быть счастливой"],
    mentors: ["Наталья", "Ольга"],
    dates: ["Вторник", "Четверг"],
    notices: { cities: { "Москва": "Позже" }, programs: { "привычка быть счастливой": "Скоро…" }, mentors: {} },
    mentorDates: { "Ольга": ["Среда"] }
  });
  assert.deepEqual(config.cities.map(city => city.name), ["Питер", "Москва"]);
  ["programs", "mentors", "dates", "notices", "mentorDates", "price", "payDetails"].forEach(key => assert.equal(key in config, false));

  const moscow = findOption(config.cities, "москва");
  assert.equal(cityStopMessage(moscow), "Позже");
  assert.equal(findOption(moscow.programs, "Привычка Быть счастливой").notice, "Скоро…");
  // Общая стоимость переезжает в каждое направление: платными они были и раньше.
  const { paid, price, payDetails } = findOption(moscow.programs, "Аромаклуб");
  assert.deepEqual({ paid, price, payDetails }, { paid: true, price: "2 000 ₽", payDetails: "СБП" });
  assert.deepEqual(findOption(moscow.mentors, "Наталья").dates, ["Вторник", "Четверг"]);
  assert.deepEqual(findOption(moscow.mentors, "Ольга").dates, ["Среда"]);

  // Копии независимы: правка Москвы не задевает Питер.
  findOption(moscow.mentors, "Наталья").dates.push("Суббота");
  assert.deepEqual(findOption(findOption(config.cities, "Питер").mentors, "Наталья").dates, ["Вторник", "Четверг"]);
});

test("settings saved before notices existed keep Moscow and the upcoming program closed", () => {
  const config = normalizeConfig({
    eventName: "Аромаклуб",
    cities: ["Питер", "Москва"],
    programs: ["Привычка Быть счастливой"],
    mentors: ["Анна"],
    dates: ["Понедельник"]
  });
  const piter = findOption(config.cities, "Питер");
  assert.equal(cityStopMessage(findOption(config.cities, "Москва")), "Запись на мероприятия в Москве откроется позже");
  assert.equal(cityStopMessage(piter), null);
  assert.equal(findOption(piter.programs, "Привычка Быть счастливой").notice, "Скоро…");
});

test("every city keeps its own programs, mentors and dates", () => {
  const config = normalizeConfig({
    eventName: "Аромаклуб",
    cities: [
      { name: "Питер", programs: [{ name: "Аромаклуб" }], mentors: [{ name: "Серебро", dates: ["Понедельник"] }] },
      {
        name: "Москва",
        programs: [{ name: "Привычка" }, { name: " привычка " }],
        mentors: [{ name: "Наталья", dates: ["Вторник, 19:00", " Вторник, 19:00 ", ""] }]
      },
      { name: "" }
    ]
  });
  assert.deepEqual(config.cities.map(city => city.name), ["Питер", "Москва"]);
  const moscow = findOption(config.cities, "Москва");
  assert.deepEqual(moscow.programs.map(program => program.name), ["Привычка"]);
  assert.deepEqual(findOption(moscow.mentors, "наталья").dates, ["Вторник, 19:00"]);
  assert.equal(findOption(moscow.mentors, "Серебро"), null);
});

test("programs saved with a shared price stay paid on the same terms", () => {
  // Так лежат настройки, сохранённые после разделения по городам, но до оплаты по направлениям.
  const saved = {
    eventName: "Аромаклуб",
    price: "1 500 ₽",
    payDetails: "СБП",
    cities: [{
      name: "Питер",
      programs: [{ name: "Аромаклуб" }, { name: "Открытая встреча", paid: false, price: "100 ₽", payDetails: "СБП" }],
      mentors: [{ name: "Анна", dates: ["Пн"] }]
    }]
  };
  const config = normalizeConfig(saved);
  assert.equal("price" in config, false);
  assert.equal("payDetails" in config, false);
  assert.deepEqual(config.cities[0].programs, [
    { name: "Аромаклуб", notice: "", paid: true, price: "1 500 ₽", payDetails: "СБП" },
    { name: "Открытая встреча", notice: "", paid: false, price: "", payDetails: "" }
  ]);

  // Панель, открытая до обновления, присылает то же самое — сохранение не делает направления бесплатными.
  assert.deepEqual(sanitizeConfigInput(saved).cities[0].programs, config.cities[0].programs);
});

test("a city without programs or mentors does not open registration", () => {
  const city = { name: "Казань", notice: "", programs: [], mentors: [{ name: "Анна", notice: "", dates: ["Пн"] }] };
  assert.equal(cityStopMessage(city), "Запись в этом городе пока не открыта.");
  assert.equal(cityStopMessage({ ...city, notice: "Скоро…" }), "Скоро…");
  assert.equal(cityStopMessage({ ...city, programs: [{ name: "Аромаклуб", notice: "" }] }), null);
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

test("admin config is trimmed and validated city by city", () => {
  const config = sanitizeConfigInput({
    eventName: " Новое событие ",
    cities: [{
      name: " Москва ",
      notice: "  ",
      programs: [
        { name: " Аромаклуб ", notice: " Скоро… ", paid: true, price: " 1 500 ₽ ", payDetails: " СБП " },
        { name: "Открытая встреча", notice: "", paid: false, price: "100 ₽", payDetails: "СБП" }
      ],
      mentors: [{ name: "Анна", dates: [" Вторник, 19:00 ", "Вторник, 19:00", ""] }]
    }]
  });
  assert.equal(config.eventName, "Новое событие");
  assert.deepEqual(config.cities, [{
    name: "Москва",
    notice: "",
    programs: [
      { name: "Аромаклуб", notice: "Скоро…", paid: true, price: "1 500 ₽", payDetails: "СБП" },
      { name: "Открытая встреча", notice: "", paid: false, price: "", payDetails: "" }
    ],
    mentors: [{ name: "Анна", notice: "", dates: ["Вторник, 19:00"] }]
  }]);

  // Строки с вложенными списками не выбрасываем молча — сохранение падает с понятной причиной.
  const [moscow] = config.cities;
  assert.throws(() => sanitizeConfigInput({ ...config, cities: [] }), /хотя бы один город/);
  assert.throws(() => sanitizeConfigInput({ ...config, cities: [moscow, { ...moscow, name: "москва" }] }), /указан дважды/);
  assert.throws(() => sanitizeConfigInput({ ...config, cities: [{ ...moscow, mentors: [{ name: " ", dates: ["Пн"] }] }] }), /без имени/);
  assert.throws(() => sanitizeConfigInput({ ...config, cities: [{ ...moscow, notice: "я".repeat(401) }] }), /длиннее/);

  // Платное направление без стоимости или реквизитов оставило бы участника без инструкции.
  const [aroma] = moscow.programs;
  const withProgram = program => ({ ...config, cities: [{ ...moscow, programs: [program] }] });
  assert.throws(() => sanitizeConfigInput(withProgram({ ...aroma, price: " " })), /укажите стоимость/);
  assert.throws(() => sanitizeConfigInput(withProgram({ ...aroma, payDetails: "" })), /как оплатить/);
});

test("free and paid registrations are announced with the right terms", () => {
  const reg = { name: "Анна", city: "Питер", program: "Аромаклуб", mentor: "Серебро", date: "Пн" };
  const free = groupNoteText({ ...reg, free: true }, "");
  assert.match(free, /Участие: бесплатное направление/);
  assert.doesNotMatch(free, /Оплата/);
  assert.match(groupNoteText(reg, "2 000 ₽"), /Участие: оплата 2 000 ₽\n⏳ Оплата ожидается/);

  const cfg = normalizeConfig({
    eventName: "Аромаклуб",
    cities: [{ name: "Питер", programs: [{ name: "Аромаклуб", paid: true, price: "2 000 ₽", payDetails: "СБП" }], mentors: [] }]
  });
  // Заявка помнит стоимость на момент записи, а заявки до оплаты по направлениям берут её из направления.
  assert.equal(registrationPrice({ ...reg, price: "1 500 ₽" }, cfg), "1 500 ₽");
  assert.equal(registrationPrice(reg, cfg), "2 000 ₽");
});

test("default settings pass the same validation as the admin panel", () => {
  const config = sanitizeConfigInput(JSON.parse(fs.readFileSync("config.json", "utf8")));
  assert.equal(cityStopMessage(findOption(config.cities, "Москва")), "Запись на мероприятия в Москве откроется позже");
  assert.equal(cityStopMessage(findOption(config.cities, "Питер")), null);
  const aroma = findOption(findOption(config.cities, "Питер").programs, "Занятия аромаклуба");
  assert.deepEqual([aroma.paid, aroma.price], [true, "1 500 ₽"]);
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
