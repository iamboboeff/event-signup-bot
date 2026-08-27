/**
 * API записи на диагностику для связанной Google Таблицы.
 *
 * Перед публикацией добавьте в свойства скрипта DOCTOR_API_SECRET — длинную
 * случайную строку. Тот же секрет задаётся боту в DOCTOR_SHEET_SECRET.
 */

const DOCTOR_COLUMNS = {
  DATE: 1,
  TIME: 2,
  STATUS: 3,
  PATIENT_NAME: 6,
  CONSULTANT: 7
};

function doGet() {
  return jsonResponse_({ ok: true, service: "doctor-schedule" });
}

function doPost(event) {
  try {
    const input = JSON.parse((event && event.postData && event.postData.contents) || "{}");
    assertAuthorized_(input.secret);

    if (input.action === "slots") {
      return jsonResponse_({ ok: true, slots: listFreeSlots_() });
    }
    if (input.action === "book") {
      return jsonResponse_(bookSlot_(input));
    }
    return jsonResponse_({ ok: false, code: "UNKNOWN_ACTION", error: "Неизвестное действие" });
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    return jsonResponse_({
      ok: false,
      code: error && error.code ? error.code : "INTERNAL_ERROR",
      error: error && error.publicMessage ? error.publicMessage : "Ошибка сервиса расписания"
    });
  }
}

function listFreeSlots_() {
  const slots = [];
  scheduleSheets_().forEach(sheet => {
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    const values = sheet.getRange(2, 1, lastRow - 1, DOCTOR_COLUMNS.CONSULTANT).getDisplayValues();
    values.forEach((row, index) => {
      const date = cleanText_(row[DOCTOR_COLUMNS.DATE - 1], 40);
      const time = cleanText_(row[DOCTOR_COLUMNS.TIME - 1], 20);
      const status = normalize_(row[DOCTOR_COLUMNS.STATUS - 1]);
      if (status !== "свободно" || !date || !isTime_(time)) return;
      slots.push({
        id: `${sheet.getSheetId()}:${index + 2}`,
        date,
        time
      });
    });
  });
  return slots.sort((a, b) => slotSortKey_(a).localeCompare(slotSortKey_(b))).slice(0, 50);
}

function bookSlot_(input) {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(10000)) throw publicError_("LOCK_TIMEOUT", "Попробуйте выбрать слот ещё раз");

  try {
    const slot = parseSlotId_(input.slotId);
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()
      .find(item => item.getSheetId() === slot.sheetId);
    if (!sheet || slot.row < 2 || slot.row > sheet.getLastRow()) {
      throw publicError_("SLOT_NOT_FOUND", "Слот не найден");
    }

    const date = cleanText_(sheet.getRange(slot.row, DOCTOR_COLUMNS.DATE).getDisplayValue(), 40);
    const time = cleanText_(sheet.getRange(slot.row, DOCTOR_COLUMNS.TIME).getDisplayValue(), 20);
    const status = normalize_(sheet.getRange(slot.row, DOCTOR_COLUMNS.STATUS).getDisplayValue());
    if (date !== cleanText_(input.expectedDate, 40) || time !== cleanText_(input.expectedTime, 20)) {
      throw publicError_("SLOT_CHANGED", "Дата или время слота изменились");
    }
    if (status !== "свободно") {
      throw publicError_("SLOT_UNAVAILABLE", "Этот слот уже занят");
    }

    const patientName = safeCellText_(input.patientName, 160);
    const consultant = safeCellText_(input.consultant, 120);
    if (patientName.length < 2 || !consultant) {
      throw publicError_("INVALID_BOOKING", "Не заполнены данные записи");
    }

    sheet.getRange(slot.row, DOCTOR_COLUMNS.STATUS).setValue("Занято");
    sheet.getRange(slot.row, DOCTOR_COLUMNS.PATIENT_NAME).setValue(patientName);
    sheet.getRange(slot.row, DOCTOR_COLUMNS.CONSULTANT).setValue(consultant);
    SpreadsheetApp.flush();

    return { ok: true, slot: { id: input.slotId, date, time } };
  } finally {
    lock.releaseLock();
  }
}

function scheduleSheets_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheets().filter(sheet => {
    if (sheet.getLastColumn() < DOCTOR_COLUMNS.STATUS) return false;
    const headers = sheet.getRange(1, 1, 1, DOCTOR_COLUMNS.STATUS).getDisplayValues()[0];
    return normalize_(headers[DOCTOR_COLUMNS.TIME - 1]) === "время" &&
      normalize_(headers[DOCTOR_COLUMNS.STATUS - 1]) === "статус";
  });
}

function assertAuthorized_(secret) {
  const expected = PropertiesService.getScriptProperties().getProperty("DOCTOR_API_SECRET") || "";
  if (!expected || String(secret || "") !== expected) {
    throw publicError_("UNAUTHORIZED", "Доступ запрещён");
  }
}

function parseSlotId_(value) {
  const match = /^(\d+):(\d+)$/.exec(String(value || ""));
  if (!match) throw publicError_("SLOT_NOT_FOUND", "Некорректный слот");
  return { sheetId: Number(match[1]), row: Number(match[2]) };
}

function normalize_(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru");
}

function cleanText_(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, maxLength);
}

function safeCellText_(value, maxLength) {
  const text = cleanText_(value, maxLength);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function isTime_(value) {
  return /^\d{1,2}:\d{2}(?::\d{2})?$/.test(value);
}

function slotSortKey_(slot) {
  const match = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/.exec(slot.date);
  if (!match) return `${slot.date}|${slot.time}`;
  return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}|${slot.time}`;
}

function publicError_(code, message) {
  const error = new Error(message);
  error.code = code;
  error.publicMessage = message;
  return error;
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
