/**
 * Уведомления в Telegram о сообщениях из чата на сайте «Аккумуляторы Усады».
 *
 * Работает как веб-приложение Google Apps Script. Ключ бота и номера получателей
 * хранятся в свойствах скрипта (Настройки проекта → Свойства скрипта),
 * а не в коде и не на сайте. Посетители сайта этих номеров не видят.
 *
 *   TG_TOKEN       ключ бота от @BotFather
 *   NOTIFY_PHONES  номера, которым можно получать заявки, через запятую:
 *                  79001112233, 79004445566
 *
 * Как подключить получателя: человек с номером из NOTIFY_PHONES открывает бота,
 * нажимает «Начать» и «Поделиться номером». Бот сверяет номер и подключает его
 * в течение минуты. Чужие номера бот не подключает.
 *
 * Ответ в чат на сайте: получатель смахивает заявку в Telegram (ответить на сообщение)
 * и пишет текст. Посетитель видит ответ в окне чата на сайте через несколько секунд.
 *
 * Пошаговая инструкция: notify/README.md
 */

var REPLY = { call: 'позвонить', wa: 'в WhatsApp', tg: 'в Telegram', mx: 'в MAX' };

/* ================= сообщения с сайта ================= */

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

    return out_({ ok: notify_(d, text, contact, name, sidOk_(d.sid)) });
  } catch (err) {
    console.error(err);
    return out_({ ok: false, error: 'server' });
  }
}

/* Чат на сайте спрашивает ответы менеджера; без параметров — проверка, что всё работает */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var sid = sidOk_(p.sid);
  if (!sid) return out_({ ok: true, service: 'akb-usady-notify' });
  if (!limit_('g:' + sid, 30, 60)) return out_({ ok: false, error: 'rate' });
  var c = CacheService.getScriptCache();
  if (!c.get('polled')) { c.put('polled', '1', 8); try { poll_(1500); } catch (x) { console.error(x); } }
  var after = Number(p.after) || 0;
  return out_({ ok: true, replies: replies_(sid).filter(function (r) { return r.at > after; }) });
}

/* ================= настройка ================= */

/* Запустите один раз после того, как добавили TG_TOKEN и NOTIFY_PHONES */
function setup() {
  var token = prop_('TG_TOKEN');
  if (!token) throw new Error('Добавьте свойство TG_TOKEN: Настройки проекта → Свойства скрипта');
  if (!allowedPhones_().length) throw new Error('Добавьте свойство NOTIFY_PHONES: номера получателей через запятую, например 79001112233, 79004445566');

  var me = tg_(token, 'getMe', {});
  if (!me.ok) throw new Error('Telegram не принял ключ бота: ' + (me.description || 'проверьте TG_TOKEN'));
  tg_(token, 'deleteWebhook', {});

  migrateOldChat_();
  startPolling_();
  pollBot();

  console.log('Бот: @' + me.result.username + ' (https://t.me/' + me.result.username + ')');
  console.log('Номера, которым можно получать заявки: ' + allowedPhones_().map(mask_).join(', '));
  status();
  console.log('Каждый получатель: откройте бота, нажмите «Начать», затем «Поделиться номером». Бот ответит в течение минуты.');
}

/* Кто сейчас получает заявки */
function status() {
  var chats = chats_();
  var phones = allowedPhones_();
  var waiting = phones.filter(function (p) { return !chats.some(function (c) { return c.phone === p; }); });
  console.log('Получают заявки: ' + (chats.length ? chats.map(function (c) { return (c.name || 'без имени') + ' ' + mask_(c.phone); }).join(', ') : 'пока никто'));
  if (waiting.length) console.log('Ещё не подключились: ' + waiting.map(mask_).join(', '));
}

/* Пробное уведомление всем получателям */
function testMessage() {
  var r = doPost({ postData: { contents: JSON.stringify({
    name: 'Проверка', contact: '+7 900 000-00-00', reply: 'wa',
    text: 'Тестовое сообщение с сайта. Если вы его видите, уведомления работают.',
    time: new Date().toISOString()
  }) } });
  console.log(r.getContent());
}

/* ================= бот: подключение получателей ================= */

/* Запускается автоматически раз в минуту: подключает получателей и забирает ответы для сайта */
function pollBot() { poll_(5000); }

function poll_(waitMs) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs)) return;
  try {
    var token = prop_('TG_TOKEN'); if (!token) return;
    var offset = Number(prop_('TG_OFFSET') || 0);
    var up = tg_(token, 'getUpdates', { offset: offset, timeout: 0, allowed_updates: ['message'] });
    if (!up.ok) { console.error('getUpdates: ' + up.description); return; }

    (up.result || []).forEach(function (u) {
      offset = Math.max(offset, u.update_id + 1);
      var m = u.message;
      if (!m || !m.chat || m.chat.type !== 'private' || !m.from) return;
      handle_(token, m);
    });
    setProp_('TG_OFFSET', String(offset));
    cleanup_();
  } finally {
    lock.releaseLock();
  }
}

function handle_(token, m) {
  var chats = chats_();
  var mine = chats.filter(function (c) { return String(c.id) === String(m.chat.id); })[0];

  // Ответ получателя на заявку уходит в чат на сайте
  if (mine && m.reply_to_message) {
    var tag = /#site_([a-z0-9]{12,32})/.exec(String(m.reply_to_message.text || m.reply_to_message.caption || ''));
    if (tag) {
      if (!m.text) return say_(token, m.chat.id, 'В чат на сайте можно ответить только текстом.');
      addReply_(tag[1], { id: m.chat.id + '_' + m.message_id, at: m.date * 1000, text: String(m.text).slice(0, 2000) });
      say_(token, m.chat.id, 'Ответ отправлен в чат на сайте. Посетитель увидит его, пока сайт открыт, или когда снова зайдёт на сайт.');
      chats.forEach(function (c) {
        if (String(c.id) !== String(m.chat.id)) say_(token, c.id, (mine.name || 'Коллега') + ' ответил посетителю #site_' + tag[1] + ':\n' + m.text);
      });
      return;
    }
  }

  if (m.contact) {
    if (String(m.contact.user_id) !== String(m.from.id)) {
      return say_(token, m.chat.id, 'Нужен ваш собственный номер. Нажмите кнопку «Поделиться номером» ниже.', shareKb_());
    }
    var phone = digits_(m.contact.phone_number);
    if (allowedPhones_().indexOf(phone) < 0) {
      return say_(token, m.chat.id, 'Этот номер не подключён к заявкам с сайта. Если это ошибка, попросите владельца сайта добавить номер.', { remove_keyboard: true });
    }
    chats = chats.filter(function (c) { return String(c.id) !== String(m.chat.id) && c.phone !== phone; });
    chats.push({ id: m.chat.id, phone: phone, name: m.from.first_name || '' });
    saveChats_(chats);
    return say_(token, m.chat.id, 'Готово. Заявки с сайта «Аккумуляторы Усады» будут приходить сюда.', { remove_keyboard: true });
  }

  var t = String(m.text || '').trim();
  if (/^\/stop/.test(t)) {
    if (mine) saveChats_(chats.filter(function (c) { return c !== mine; }));
    return say_(token, m.chat.id, 'Вы больше не получаете заявки с сайта. Чтобы снова подключиться, отправьте /start.', { remove_keyboard: true });
  }
  if (mine) return say_(token, m.chat.id, 'Вы получаете заявки с сайта. Чтобы ответить посетителю в чат на сайте, смахните сообщение с заявкой влево и напишите ответ. Отключиться от заявок: /stop.');
  return say_(token, m.chat.id, 'Здравствуйте! Это бот заявок с сайта «Аккумуляторы Усады». Чтобы получать заявки, нажмите кнопку «Поделиться номером» ниже.', shareKb_());
}

function shareKb_() {
  return { keyboard: [[{ text: 'Поделиться номером', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };
}

/* ================= отправка заявки ================= */

function notify_(d, text, contact, name, sid) {
  var token = prop_('TG_TOKEN');
  var chats = chats_();
  if (!token || !chats.length) throw new Error('Нет получателей: запустите setup и подключите номера через бота');

  var lines = ['<b>Новое сообщение с сайта</b>', ''];
  if (name) lines.push('Имя: ' + esc_(name));
  if (contact) lines.push('Контакт: ' + esc_(contact));
  if (REPLY[d.reply]) lines.push('Просит ответить: ' + REPLY[d.reply]);
  lines.push('', esc_(text));
  var t = d.time ? new Date(d.time) : new Date();
  if (!isNaN(t)) lines.push('', '<i>' + Utilities.formatDate(t, 'Europe/Moscow', 'dd.MM.yyyy HH:mm') + '</i>');
  if (sid) lines.push('', '<i>Ответить в чат на сайте: смахните это сообщение влево и напишите ответ.</i>', '#site_' + sid);

  var buttons = [];
  var dg = digits_(contact);
  if (dg && !/[A-Za-z]/.test(contact)) {
    buttons.push({ text: 'Ответить в WhatsApp', url: 'https://wa.me/' + dg });
    buttons.push({ text: 'Telegram', url: 'https://t.me/+' + dg });
  } else if (/^@?[A-Za-z][A-Za-z0-9_]{3,31}$/.test(contact)) {
    buttons.push({ text: 'Ответить в Telegram', url: 'https://t.me/' + contact.replace(/^@/, '') });
  }

  var body = { text: lines.join('\n'), parse_mode: 'HTML', disable_web_page_preview: true };
  if (buttons.length) body.reply_markup = { inline_keyboard: [buttons] };

  var delivered = 0, keep = [];
  chats.forEach(function (c) {
    body.chat_id = c.id;
    var res = tg_(token, 'sendMessage', body);
    if (res.ok) { delivered++; keep.push(c); return; }
    console.error('Telegram (' + mask_(c.phone) + '): ' + res.description);
    if (res.error_code !== 403) keep.push(c); // 403: получатель заблокировал бота, убираем его
  });
  if (keep.length !== chats.length) saveChats_(keep);
  return delivered > 0;
}

/* ================= ответы для сайта ================= */

function sidOk_(v) { v = String(v || '').toLowerCase(); return /^[a-z0-9]{12,32}$/.test(v) ? v : ''; }
function replies_(sid) {
  try { var a = JSON.parse(prop_('r_' + sid) || '[]'); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function addReply_(sid, r) {
  var a = replies_(sid);
  if (a.some(function (x) { return x.id === r.id; })) return;
  a.push(r); a = a.slice(-30);
  var s = JSON.stringify(a);
  while (s.length > 8500 && a.length > 1) { a.shift(); s = JSON.stringify(a); }
  setProp_('r_' + sid, s);
}
/* Раз в 6 часов удаляет переписки старше 14 дней */
function cleanup_() {
  var c = CacheService.getScriptCache();
  if (c.get('cleaned')) return;
  c.put('cleaned', '1', 21600);
  var props = PropertiesService.getScriptProperties(), all = props.getProperties(), old = Date.now() - 14 * 864e5;
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('r_') !== 0) return;
    try { var a = JSON.parse(all[k]); if (!a.length || a[a.length - 1].at < old) props.deleteProperty(k); }
    catch (e) { props.deleteProperty(k); }
  });
}

/* ================= служебное ================= */

function chats_() {
  try { var a = JSON.parse(prop_('TG_CHATS') || '[]'); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function saveChats_(a) { setProp_('TG_CHATS', JSON.stringify(a)); }
function allowedPhones_() {
  return String(prop_('NOTIFY_PHONES') || '').split(/[,;\n]+/).map(digits_).filter(Boolean);
}
/* Совместимость с первой версией скрипта, где был один получатель в TG_CHAT_ID */
function migrateOldChat_() {
  var old = prop_('TG_CHAT_ID');
  if (!old) return;
  var chats = chats_();
  if (!chats.some(function (c) { return String(c.id) === String(old); })) chats.push({ id: old, phone: '', name: 'из прошлой настройки' });
  saveChats_(chats);
  PropertiesService.getScriptProperties().deleteProperty('TG_CHAT_ID');
}
function startPolling_() {
  stopPolling_();
  ScriptApp.newTrigger('pollBot').timeBased().everyMinutes(1).create();
}
function stopPolling_() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'pollBot') ScriptApp.deleteTrigger(t); });
}
function say_(token, chatId, text, markup) {
  var b = { chat_id: chatId, text: text };
  if (markup) b.reply_markup = markup;
  return tg_(token, 'sendMessage', b);
}
function tg_(token, method, body) {
  var r = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true
  });
  try { return JSON.parse(r.getContentText()); }
  catch (e) { return { ok: false, description: r.getContentText().slice(0, 200) }; }
}
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function setProp_(k, v) { PropertiesService.getScriptProperties().setProperty(k, v); }
function digits_(v) {
  var d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length === 11 && d.charAt(0) === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return d.length === 11 ? d : '';
}
function mask_(p) { return p ? '+' + p.slice(0, 1) + ' ' + p.slice(1, 4) + ' ***-**-' + p.slice(-2) : 'номер не указан'; }
/* Счётчик в окне фиксированной длины: в каждом новом окне начинается с нуля */
function limit_(key, max, seconds) {
  var cache = CacheService.getScriptCache();
  var win = Math.floor(Date.now() / 1000 / seconds);
  var k = 'rl2:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, key)) + ':' + win;
  var n = Number(cache.get(k) || 0);
  if (n >= max) return false;
  cache.put(k, String(n + 1), seconds + 5);
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
