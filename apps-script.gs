/**
 * Doterra Event — Google Sheets backend (Apps Script Web App)
 *
 * Что делает:
 *   • doPost  — принимает новую запись от бота, отметку оплаты, отметку «заявил об оплате»
 *               и сохранение message_id уведомления в группе.
 *   • doGet   — отдаёт настройки (вкладка «Настройки») и полный список записей (action=list).
 *
 * Это единственный источник правды для бота на Cloud Run (локального файла там нет).
 *
 * Как поставить / обновить:
 *   1. Открой свою Google-таблицу → Расширения → Apps Script.
 *   2. Замени весь код этим, сохрани (Cmd+S).
 *   3. Deploy → Manage deployments → у текущего деплоя «Edit» (карандаш) →
 *      Version: New version → Deploy. URL (…/exec) остаётся прежним.
 *      (Если деплоишь впервые: Deploy → New deployment → Web app,
 *       Execute as: Me, Who has access: Anyone → скопируй Web app URL.)
 *
 * Вкладки «Записи» и «Настройки» создаются автоматически при первом обращении.
 */

var SHEET_REG = 'Записи';
var SHEET_CFG = 'Настройки';

// Колонки вкладки «Записи» (1-индекс).
var COL_TS = 1, COL_NAME = 2, COL_MENTOR = 3, COL_DATE = 4, COL_PART = 5,
    COL_USERNAME = 6, COL_USERID = 7, COL_PAID = 8, COL_ID = 9,
    COL_CLAIMED = 10, COL_MSGID = 11;
var REG_HEADERS = ['Время', 'Фамилия Имя', 'Наставник', 'День', 'Участие',
                   'Username', 'UserID', 'Оплачено', 'ID', 'Заявил', 'MsgID'];

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function ensureSheets_() {
  var ss = ss_();
  var reg = ss.getSheetByName(SHEET_REG);
  if (!reg) {
    reg = ss.insertSheet(SHEET_REG);
    reg.appendRow(REG_HEADERS);
    reg.setFrozenRows(1);
  }
  ensureHeaders_(reg);
  var cfg = ss.getSheetByName(SHEET_CFG);
  if (!cfg) {
    cfg = ss.insertSheet(SHEET_CFG);
    cfg.appendRow(['Настройка', 'Значение']);
    cfg.appendRow(['eventName', 'Doterra Event']);
    cfg.appendRow(['mentors', 'Серебро, Золото, Бронза, Платина']);
    cfg.appendRow(['dates', 'Понедельник, Среда, Пятница']);
    cfg.appendRow(['price', '1 500 ₽']);
    cfg.appendRow(['payDetails', 'Перевод по СБП: +7 900 000-00-00 (Сбербанк), получатель Имя Ф.']);
    cfg.setFrozenRows(1);
  }
  return { reg: reg, cfg: cfg };
}

// Добавляет недостающие столбцы (для таблиц, созданных старой версией).
function ensureHeaders_(reg) {
  for (var c = 1; c <= REG_HEADERS.length; c++) {
    if (reg.getRange(1, c).getValue() !== REG_HEADERS[c - 1]) {
      reg.getRange(1, c).setValue(REG_HEADERS[c - 1]);
    }
  }
}

function readConfig_() {
  var cfg = ensureSheets_().cfg;
  var out = {};
  var last = cfg.getLastRow();
  if (last >= 2) {
    var rows = cfg.getRange(2, 1, last - 1, 2).getValues();
    rows.forEach(function (r) {
      if (r[0]) out[String(r[0]).trim()] = String(r[1]).trim();
    });
  }
  function toList(s) { return (s || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean); }
  return {
    eventName: out.eventName || 'Doterra Event',
    mentors: toList(out.mentors),
    dates: toList(out.dates),
    price: out.price || '',
    payDetails: out.payDetails || ''
  };
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Превращает строку таблицы в объект записи (как ждёт бот).
function rowToReg_(r) {
  return {
    ts: r[COL_TS - 1],
    name: r[COL_NAME - 1],
    mentor: r[COL_MENTOR - 1],
    date: r[COL_DATE - 1],
    sub: String(r[COL_PART - 1]) === 'абонемент',
    username: r[COL_USERNAME - 1],
    userId: r[COL_USERID - 1],
    paid: String(r[COL_PAID - 1]).toLowerCase() === 'да',
    id: r[COL_ID - 1],
    claimed: String(r[COL_CLAIMED - 1]).toLowerCase() === 'да',
    groupMsgId: r[COL_MSGID - 1] ? Number(r[COL_MSGID - 1]) : null
  };
}

function listRegs_() {
  var reg = ensureSheets_().reg;
  var last = reg.getLastRow();
  if (last < 2) return [];
  var values = reg.getRange(2, 1, last - 1, REG_HEADERS.length).getValues();
  return values.map(rowToReg_);
}

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'config';
  if (action === 'list') {
    var list = listRegs_();
    var day = e && e.parameter && e.parameter.day;
    if (day) list = list.filter(function (x) {
      return String(x.date).toLowerCase() === String(day).toLowerCase();
    });
    return json_({ ok: true, list: list });
  }
  return json_({ ok: true, config: readConfig_() });
}

// Находит номер строки по ID записи (или 0, если нет).
function findRow_(reg, id) {
  var last = reg.getLastRow();
  if (last < 2) return 0;
  var ids = reg.getRange(2, COL_ID, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return 0;
}

function setCell_(id, col, value) {
  var reg = ensureSheets_().reg;
  var row = findRow_(reg, id);
  if (!row) return { ok: false, error: 'запись не найдена' };
  reg.getRange(row, col).setValue(value);
  return { ok: true, row: row };
}

// Удалить строку записи по ID.
function deleteRow_(id) {
  var reg = ensureSheets_().reg;
  var row = findRow_(reg, id);
  if (!row) return { ok: false, error: 'запись не найдена' };
  reg.deleteRow(row);
  return { ok: true };
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    if (data.action === 'setPaid')     return json_(setCell_(data.id, COL_PAID, data.paid ? 'да' : 'нет'));
    if (data.action === 'setClaimed')  return json_(setCell_(data.id, COL_CLAIMED, data.claimed ? 'да' : 'нет'));
    if (data.action === 'setGroupMsg') return json_(setCell_(data.id, COL_MSGID, data.groupMsgId || ''));
    if (data.action === 'delete')      return json_(deleteRow_(data.id));

    // Защита: неизвестное действие не должно создавать мусорную строку.
    if (data.action) return json_({ ok: false, error: 'неизвестное действие: ' + data.action });

    // Новая запись.
    var reg = ensureSheets_().reg;
    reg.appendRow([
      data.ts || new Date().toISOString(),
      data.name || '',
      data.mentor || '',
      data.date || '',
      data.sub ? 'абонемент' : 'оплата',
      data.username || '',
      data.userId || '',
      data.sub ? '—' : 'нет',
      data.id || '',
      'нет',
      data.groupMsgId || ''
    ]);
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}
