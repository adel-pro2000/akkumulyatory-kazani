/**
 * Уведомления в Telegram о сообщениях из чата на сайте «Аккумуляторы Усады».
 *
 * Работает как веб-приложение Google Apps Script. Ключ бота хранится в свойствах
 * скрипта (Настройки проекта → Свойства скрипта), а не в коде и не на сайте.
 *
 *   TG_TOKEN    ключ бота от @BotFather (добавляете вы)
 *   TG_CHAT_ID  куда слать уведомления (заполнит функция setup)
 *
 * Пошаговая инструкция: notify/README.md
 */

var REPLY = { call: 'позвонить', wa: 'в WhatsApp', tg: 'в Telegram', mx: 'в MAX' };

/* Сайт присылает сюда сообщение из чата */
function doPost(e) {
  try {
    var d;
    try { d = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
    catch (x) { return out_({ ok: false, error: 'bad_json' }); }

    if (d.hp) return out_({ ok: true }); // скрытое поле заполняют только спам-боты

    var text = clean_(d.text, 2000);
    var contact = clean_(d.contact, 80);
    var name = clean_(d.name, 80);
    if (!text) return out_({ ok: false, error: 'empty' });

    // Защита от спама: не больше 120 сообщений в час всего и 15 за 10 минут с одного контакта
    if (!limit_('all', 120, 3600) || !limit_('c:' + contact, 15, 600)) return out_({ ok: false, error: 'rate' });

    return out_({ ok: notify_(d, text, contact, name) });
  } catch (err) {
    console.error(err);
    return out_({ ok: false, error: 'server' });
  }
}

/* Проверка, что веб-приложение работает: откройте его адрес в браузере */
function doGet() {
  return out_({ ok: true, service: 'akb-usady-notify' });
}

/* Запустите один раз после того, как нажали «Начать» в своём боте */
function setup() {
  var p = PropertiesService.getScriptProperties();
  var token = p.getProperty('TG_TOKEN');
  if (!token) throw new Error('Добавьте свойство TG_TOKEN: Настройки проекта → Свойства скрипта');

  var me = tg_(token, 'getMe', {});
  if (!me.ok) throw new Error('Telegram не принял ключ бота: ' + (me.description || 'проверьте TG_TOKEN'));

  var up = tg_(token, 'getUpdates', {});
  var chats = (up.result || [])
    .map(function (u) { return u.message || u.my_chat_member; })
    .filter(function (m) { return m && m.chat && m.chat.type === 'private'; })
    .map(function (m) { return m.chat; });
  if (!chats.length) {
    throw new Error('Откройте бота @' + me.result.username + ' в Telegram, нажмите «Начать» и запустите setup ещё раз');
  }

  var chat = chats[chats.length - 1];
  p.setProperty('TG_CHAT_ID', String(chat.id));
  tg_(token, 'sendMessage', {
    chat_id: chat.id,
    text: 'Уведомления с сайта «Аккумуляторы Усады» подключены. Сюда будут приходить сообщения из чата на сайте.'
  });
  console.log('Готово. Уведомления будут приходить в Telegram: ' + (chat.first_name || '') + ' ' + (chat.username ? '@' + chat.username : ''));
}

/* Пробное уведомление, можно запускать сколько угодно */
function testMessage() {
  var r = doPost({ postData: { contents: JSON.stringify({
    name: 'Проверка', contact: '+7 900 000-00-00', reply: 'wa',
    text: 'Тестовое сообщение с сайта. Если вы его видите, уведомления работают.',
    time: new Date().toISOString()
  }) } });
  console.log(r.getContent());
}

/* ---------- внутренние функции ---------- */

function notify_(d, text, contact, name) {
  var p = PropertiesService.getScriptProperties();
  var token = p.getProperty('TG_TOKEN');
  var chat = p.getProperty('TG_CHAT_ID');
  if (!token || !chat) throw new Error('Не заданы TG_TOKEN или TG_CHAT_ID: запустите setup');

  var lines = ['<b>Новое сообщение с сайта</b>', ''];
  if (name) lines.push('Имя: ' + esc_(name));
  if (contact) lines.push('Контакт: ' + esc_(contact));
  if (REPLY[d.reply]) lines.push('Просит ответить: ' + REPLY[d.reply]);
  lines.push('', esc_(text));
  var t = d.time ? new Date(d.time) : new Date();
  if (!isNaN(t)) lines.push('', '<i>' + Utilities.formatDate(t, 'Europe/Moscow', 'dd.MM.yyyy HH:mm') + '</i>');

  var buttons = [];
  var digits = String(contact).replace(/\D/g, '');
  if (digits.length === 11 && digits.charAt(0) === '8') digits = '7' + digits.slice(1);
  if (digits.length === 10) digits = '7' + digits;
  if (digits.length === 11 && !/[A-Za-z]/.test(contact)) {
    buttons.push({ text: 'Ответить в WhatsApp', url: 'https://wa.me/' + digits });
    buttons.push({ text: 'Telegram', url: 'https://t.me/+' + digits });
  } else if (/^@?[A-Za-z][A-Za-z0-9_]{3,31}$/.test(contact)) {
    buttons.push({ text: 'Ответить в Telegram', url: 'https://t.me/' + contact.replace(/^@/, '') });
  }

  var body = { chat_id: chat, text: lines.join('\n'), parse_mode: 'HTML', disable_web_page_preview: true };
  if (buttons.length) body.reply_markup = { inline_keyboard: [buttons] };
  var res = tg_(token, 'sendMessage', body);
  if (!res.ok) console.error('Telegram: ' + res.description);
  return res.ok === true;
}

function tg_(token, method, body) {
  var r = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true
  });
  try { return JSON.parse(r.getContentText()); }
  catch (e) { return { ok: false, description: r.getContentText().slice(0, 200) }; }
}

function limit_(key, max, seconds) {
  var cache = CacheService.getScriptCache();
  var k = 'rl:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, key));
  var n = Number(cache.get(k) || 0);
  if (n >= max) return false;
  cache.put(k, String(n + 1), seconds);
  return true;
}

function clean_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function esc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
