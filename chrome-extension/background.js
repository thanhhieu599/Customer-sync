/**
 * background.js – tiến trình nền của tiện ích "D&T Sapo Sync".
 * Hẹn giờ chạy đồng bộ, giữ trạng thái, cảnh báo, và nhận lệnh từ popup / trang cài đặt.
 */
importScripts('lib/core.js', 'lib/engine.js', 'clients.js');

var ALARM = 'dt-sapo-sync';
var LOG_MAX = 5000;
var RUN_BUDGET_MS = 4 * 60 * 1000;
var LOCK_STALE_MS = 15 * 60 * 1000;

var DEFAULT_CONFIG = {
  webBase: '', webKey: '', webSecret: '',
  omniBase: 'https://trangthietbivn.mysapogo.com',
  dryRun: true, maxCreate: 10, pendingTimeoutMin: 30, deleteEcho: false,
  skipOmniGroupIds: '', intervalMin: 10, enabled: false, alertWebhook: ''
};

// ---------- Lưu trữ ----------
async function getConfig() {
  var s = await chrome.storage.local.get('config');
  return Object.assign({}, DEFAULT_CONFIG, s.config || {});
}

function engineCfg(cfg) {
  return {
    dryRun: !!cfg.dryRun,
    maxCreate: Number(cfg.maxCreate) || 0,
    pendingTimeoutMin: Number(cfg.pendingTimeoutMin) || 30,
    deleteEcho: !!cfg.deleteEcho,
    skipOmniGroupIds: String(cfg.skipOmniGroupIds || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean)
  };
}

function validateConfig(cfg) {
  var missing = [];
  if (!/^https:\/\/[^/]+\.mysapo\.net$/.test(String(cfg.webBase).replace(/\/+$/, ''))) missing.push('Địa chỉ Sapo Web (dạng https://xxxxx.mysapo.net)');
  if (!cfg.webKey) missing.push('API Key Sapo Web');
  if (!cfg.webSecret) missing.push('Secret Sapo Web');
  if (!/^https:\/\/[^/]+\.mysapogo\.com$/.test(String(cfg.omniBase).replace(/\/+$/, ''))) missing.push('Địa chỉ Sapo Omni (dạng https://xxxxx.mysapogo.com)');
  if ([5, 10, 15, 30, 60].indexOf(Number(cfg.intervalMin)) < 0) missing.push('Chu kỳ chạy (5/10/15/30/60 phút)');
  if (missing.length) throw new Error('Thiếu hoặc sai cấu hình: ' + missing.join(', '));
}

/** quick = true: kiểm tra kết nối, chỉ thử 2 lần để người dùng có kết quả nhanh */
function makeClients(cfg, quick) {
  var o = quick ? { attempts: 2, retryBaseMs: 1000 } : {};
  return {
    web: new WebClient(Object.assign({ base: cfg.webBase, key: cfg.webKey, secret: cfg.webSecret }, o)),
    omni: new OmniTabClient(Object.assign({ base: cfg.omniBase }, o))
  };
}

async function appendLog(entries) {
  if (!entries.length) return;
  var s = await chrome.storage.local.get('log');
  var log = (s.log || []).concat(entries);
  if (log.length > LOG_MAX) log = log.slice(log.length - LOG_MAX);
  await chrome.storage.local.set({ log: log });
}

function LogBuffer() { this.items = []; }
LogBuffer.prototype.add = function (level, action, omniId, webId, name, detail) {
  this.items.push({ time: new Date().toISOString(), level: level, action: action,
                    omni_id: omniId || '', web_id: webId || '', name: name || '', detail: detail || '' });
};

// ---------- Trạng thái & cảnh báo ----------
var BADGE = {
  ok: ['', '#16a34a'], running: ['…', '#2563eb'], warn: ['!', '#d97706'],
  error: ['X', '#dc2626'], session: ['🔑', '#dc2626'], off: ['OFF', '#6b7280']
};

async function setStatus(state, message, extra) {
  var st = Object.assign({ state: state, message: message || '', at: new Date().toISOString() }, extra || {});
  var prev = (await chrome.storage.local.get('status')).status || {};
  if (state === 'running') { st.lastSummary = prev.lastSummary; st.lastRunAt = prev.lastRunAt; }
  await chrome.storage.local.set({ status: Object.assign({}, prev, st) });
  var b = BADGE[state] || BADGE.ok;
  await chrome.action.setBadgeText({ text: b[0] });
  await chrome.action.setBadgeBackgroundColor({ color: b[1] });
}

async function alertUser(kind, title, message) {
  var s = await chrome.storage.local.get('lastAlert');
  var last = s.lastAlert || {};
  // Cùng loại cảnh báo: tối đa 1 lần/giờ; chạy tốt trở lại thì đặt lại
  if (last.kind === kind && Date.now() - (last.at || 0) < 3600 * 1000) return;
  await chrome.storage.local.set({ lastAlert: { kind: kind, at: Date.now() } });
  try {
    await chrome.notifications.create('dt-sync-' + Date.now(), {
      type: 'basic', iconUrl: 'icon128.png', title: title, message: String(message).slice(0, 300), priority: 2
    });
  } catch (e) { /* thông báo bị tắt trên máy */ }
  var cfg = await getConfig();
  if (cfg.alertWebhook) {
    try {
      await fetch(cfg.alertWebhook, { method: 'POST', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ subject: title, body: message }) });
    } catch (e) { /* bỏ qua lỗi gửi email */ }
  }
}

// ---------- Khóa chống chạy chồng ----------
// Cờ trong bộ nhớ đặt NGAY (không chờ) để 2 lệnh đến cùng lúc không cùng lọt qua;
// khóa trong storage phòng trường hợp tiến trình nền bị Chrome khởi động lại giữa lượt.
var RUNNING = false;
async function acquireLock() {
  if (RUNNING) return false;
  RUNNING = true;
  var s = await chrome.storage.local.get('lock');
  if (s.lock && Date.now() - s.lock < LOCK_STALE_MS) { RUNNING = false; return false; }
  await chrome.storage.local.set({ lock: Date.now() });
  return true;
}
async function releaseLock() { await chrome.storage.local.remove('lock'); RUNNING = false; }

// ---------- Một lượt đồng bộ ----------
async function runSync(trigger) {
  if (!(await acquireLock())) return { skipped: true, message: 'Đang có lượt khác chạy' };
  var log = new LogBuffer();
  var started = Date.now();
  var outcome, rows = null, ecfg = null, executing = false;
  try {
    var cfg = await getConfig();
    validateConfig(cfg);
    await setStatus('running', 'Đang đồng bộ...');
    var c = makeClients(cfg);
    var now = new Date().toISOString();
    await c.omni.ensureTab();
    var omniList = await c.omni.listCustomers();
    var webList = await c.web.listCustomers();
    rows = (await chrome.storage.local.get('rows')).rows || [];
    ecfg = engineCfg(cfg);
    var result = SyncEngine.prepare(omniList, webList, rows, ecfg, now);
    var gen = SyncEngine.execute({ actions: result.actions, rows: rows, cfg: ecfg, now: now, log: log,
                                   clock: function () { return Date.now(); },
                                   budgetMs: RUN_BUDGET_MS - (Date.now() - started) });
    executing = true;
    var done = await SyncEngine.runAsync(gen, c);
    if (!ecfg.dryRun) await chrome.storage.local.set({ rows: rows });
    var summary = SyncEngine.summary(ecfg, omniList.length, webList.length, result.stats, done,
                                     c.omni.calls + c.web.calls, Math.round((Date.now() - started) / 1000));
    log.add(done.errors ? 'WARN' : 'INFO', 'TÓM TẮT', '', '', '', summary);
    var state = done.errors ? 'error' : (done.warnings ? 'warn' : 'ok');
    await setStatus(state, done.errors ? done.errors + ' lỗi, xem nhật ký' : (done.warnings ? done.warnings + ' cảnh báo' : 'Hoạt động tốt'),
                    { lastSummary: summary, lastRunAt: new Date().toISOString(), trigger: trigger || '' });
    if (done.errors) await alertUser('errors', 'Đồng bộ Sapo có ' + done.errors + ' lỗi', summary);
    else await chrome.storage.local.remove('lastAlert');
    outcome = { ok: true, summary: summary, stats: result.stats, done: done };
  } catch (e) {
    var isSession = e && e.kind === 'session';
    // Dừng giữa lượt: vẫn lưu những việc ĐÃ làm xong để lượt sau không làm lại
    if (executing && rows && ecfg && !ecfg.dryRun) await chrome.storage.local.set({ rows: rows });
    log.add('ERROR', 'DỪNG', '', '', '', e.message);
    await setStatus(isSession ? 'session' : 'error', e.message, { lastRunAt: new Date().toISOString() });
    await alertUser(isSession ? 'session' : 'stopped',
                    isSession ? 'Cần đăng nhập lại Sapo Omni' : 'Đồng bộ Sapo bị dừng', e.message);
    outcome = { ok: false, error: e.message, session: isSession };
  } finally {
    await appendLog(log.items);
    await releaseLock();
  }
  return outcome;
}

// ---------- Kiểm tra kết nối ----------
async function selfTest() {
  var cfg = await getConfig();
  var lines = [];
  try { validateConfig(cfg); } catch (e) { return { ok: false, text: '❌ ' + e.message }; }
  var c = makeClients(cfg, true);
  var ok = true;
  try {
    var w = await c.web.countCustomers();
    var ws = w.sample ? SyncCore.fromWeb(w.sample) : null;
    lines.push('✅ Sapo Web: kết nối OK. Tổng khách: ' + w.total + (ws ? ' | Mẫu: ' + ws.name : ''));
  } catch (e) { ok = false; lines.push('❌ Sapo Web: ' + e.message); }
  try {
    await c.omni.ensureTab();
    var o = await c.omni.countCustomers();
    var os = o.sample ? SyncCore.fromOmni(o.sample) : null;
    lines.push('✅ Sapo Omni (qua tab đăng nhập): kết nối OK. Tổng khách: ' + o.total + (os ? ' | Mẫu: ' + os.name : ''));
  } catch (e) { ok = false; lines.push('❌ Sapo Omni: ' + e.message); }
  lines.push('Chế độ: ' + (cfg.dryRun ? 'CHẠY THỬ (không ghi dữ liệu)' : 'CHẠY THẬT') +
             ' | Tạo tối đa mỗi lượt: ' + cfg.maxCreate + ' | Tự động: ' + (cfg.enabled ? 'BẬT, mỗi ' + cfg.intervalMin + ' phút' : 'TẮT'));
  return { ok: ok, text: lines.join('\n') };
}

// ---------- Hẹn giờ ----------
async function applySchedule() {
  var cfg = await getConfig();
  await chrome.alarms.clear(ALARM);
  if (cfg.enabled) {
    await chrome.alarms.create(ALARM, { periodInMinutes: Number(cfg.intervalMin) || 10, delayInMinutes: 1 });
    var st = (await chrome.storage.local.get('status')).status;
    if (!st || st.state === 'off') await setStatus('ok', 'Đã bật tự động, chờ lượt chạy đầu tiên');
  } else {
    await setStatus('off', 'Đang tắt tự động');
  }
}

chrome.alarms.onAlarm.addListener(function (a) { if (a.name === ALARM) runSync('alarm'); });
chrome.runtime.onInstalled.addListener(function () { applySchedule(); });
chrome.runtime.onStartup.addListener(function () { applySchedule(); });

// ---------- Nhận lệnh từ popup / trang cài đặt ----------
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  (async function () {
    switch (msg && msg.cmd) {
      case 'runNow': return runSync('manual');
      case 'selfTest': return selfTest();
      case 'saveConfig': {
        var cur = await getConfig();
        var next = Object.assign({}, cur, msg.config || {});
        if (next.enabled) validateConfig(next);
        await chrome.storage.local.set({ config: next });
        await applySchedule();
        return { ok: true };
      }
      case 'setEnabled': {
        var cfg = await getConfig();
        cfg.enabled = !!msg.enabled;
        if (cfg.enabled) validateConfig(cfg);
        await chrome.storage.local.set({ config: cfg });
        await applySchedule();
        return { ok: true };
      }
      case 'resetMap': {
        await chrome.storage.local.set({ rows: [] });
        await appendLog([{ time: new Date().toISOString(), level: 'WARN', action: 'XÓA BẢNG GHÉP', omni_id: '', web_id: '', name: '', detail: 'Người dùng xóa bảng ghép' }]);
        return { ok: true };
      }
      default: return { ok: false, error: 'Lệnh không hợp lệ' };
    }
  })().then(sendResponse, function (e) { sendResponse({ ok: false, error: e.message }); });
  return true;   // trả lời bất đồng bộ
});
