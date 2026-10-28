/**
 * background.js – tiến trình nền của tiện ích "D&T Sapo Sync".
 *
 * Cách chạy nhẹ nhàng với Sapo Omni:
 *  - Giữ BẢN SAO danh sách khách 2 bên trong máy (chrome.storage).
 *  - Mỗi lượt định kỳ chỉ hỏi Sapo "khách nào thay đổi từ lần trước" (thường 1–2 lệnh).
 *  - Quét toàn bộ chỉ 1 lần/ngày vào giờ đêm (mặc định 2 giờ sáng) để đối soát.
 *  - Omni chậm / lỗi → dừng ngay, tạm nghỉ (mặc định 60 phút) rồi mới thử lại.
 */
importScripts('lib/core.js', 'lib/engine.js', 'clients.js');

var ALARM = 'dt-sapo-sync';
var LOG_MAX = 5000;
var RUN_BUDGET_MS = 4 * 60 * 1000;
var LOCK_STALE_MS = 15 * 60 * 1000;
var INCR_OVERLAP_MS = 10 * 60 * 1000;   // đọc lùi 10 phút để không sót thay đổi
var FULL_EVERY_MS = 20 * 3600 * 1000;    // quét toàn bộ tối đa 1 lần/ngày

var DEFAULT_CONFIG = {
  webBase: '', webKey: '', webSecret: '',
  omniBase: 'https://trangthietbivn.mysapogo.com',
  dryRun: true, maxCreate: 10, pendingTimeoutMin: 30, deleteEcho: false,
  skipOmniGroupIds: '', intervalMin: 10, enabled: false, alertWebhook: '',
  fullScanHour: 2, pauseMin: 60, fallbackFullHours: 6
};

// ---------- Cấu hình ----------
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
  if ([10, 15, 30, 60].indexOf(Number(cfg.intervalMin)) < 0) missing.push('Chu kỳ chạy (10/15/30/60 phút)');
  var h = Number(cfg.fullScanHour);
  if (!(h >= 0 && h <= 23)) missing.push('Giờ quét toàn bộ (0–23)');
  if (missing.length) throw new Error('Thiếu hoặc sai cấu hình: ' + missing.join(', '));
}

/** quick = true: kiểm tra kết nối, chờ ngắn để người dùng có kết quả nhanh */
function makeClients(cfg, quick) {
  var o = quick ? { retryWaitMs: 1000, attempts: 2 } : {};
  return {
    web: new WebClient(Object.assign({ base: cfg.webBase, key: cfg.webKey, secret: cfg.webSecret }, o)),
    omni: new OmniTabClient(Object.assign({ base: cfg.omniBase }, o))
  };
}

// ---------- Nhật ký ----------
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
  ok: ['', '#16a34a'], running: ['…', '#2563eb'], warn: ['!', '#d97706'], paused: ['⏸', '#d97706'],
  error: ['X', '#dc2626'], session: ['🔑', '#dc2626'], off: ['OFF', '#6b7280']
};

async function setStatus(state, message, extra) {
  var prev = (await chrome.storage.local.get('status')).status || {};
  var st = Object.assign({}, prev, { state: state, message: message || '', at: new Date().toISOString() }, extra || {});
  await chrome.storage.local.set({ status: st });
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

// ---------- Bản sao danh sách khách ----------
function emptyCache() { return { omni: {}, web: {}, lastFullAt: '', incr: { omni: null, web: null } }; }

async function loadCache() {
  var c = (await chrome.storage.local.get('cache')).cache;
  return c && c.omni && c.web ? c : emptyCache();
}

function values(map) { return Object.keys(map).map(function (k) { return map[k]; }); }

/** Mốc "đọc thay đổi từ": thay đổi mới nhất đã biết, lùi 10 phút cho chắc */
function sinceFor(map, lastFullAt) {
  var max = 0;
  Object.keys(map).forEach(function (k) {
    var t = Date.parse(map[k].modified_on || map[k].created_on || '');
    if (!isNaN(t) && t > max) max = t;
  });
  if (!max) max = Date.parse(lastFullAt) || Date.now();
  return new Date(max - INCR_OVERLAP_MS).toISOString();
}

/** Bọc client: mọi kết quả ghi lên Sapo được cập nhật ngay vào bản sao */
function cachingClients(c, cache) {
  function wrap(side, client, trim) {
    return {
      createCustomer: async function (p) {
        var r = await client.createCustomer(p);
        if (r && r.id != null) cache[side][r.id] = trim(r);
        return r;
      },
      updateCustomer: async function (id, p) {
        var r = await client.updateCustomer(id, p);
        if (r && r.id != null) {
          var prev = cache[side][r.id];
          var t = trim(r);
          // Phản hồi sửa có thể thiếu số đơn hàng → giữ số cũ
          if (side === 'omni' && !r.sale_order && prev) t.sale_order = prev.sale_order;
          if (side === 'web' && r.orders_count == null && prev) t.orders_count = prev.orders_count;
          cache[side][r.id] = t;
        }
        return r;
      },
      deleteCustomer: async function (id) { var r = await client.deleteCustomer(id); delete cache[side][id]; return r; },
      hasOrders: function (id) { return client.hasOrders(id); }
    };
  }
  return { omni: wrap('omni', c.omni, SyncCore.trimOmni), web: wrap('web', c.web, SyncCore.trimWeb) };
}

/** Quyết định lượt này quét toàn bộ, đọc thay đổi, hay bỏ qua */
function decideMode(trigger, cache, cfg, nowMs) {
  var lastFull = Date.parse(cache.lastFullAt) || 0;
  if (trigger === 'full' || !lastFull) return 'full';
  var nightly = nowMs - lastFull >= FULL_EVERY_MS && new Date(nowMs).getHours() === Number(cfg.fullScanHour);
  if (nightly) return 'full';
  var unsupported = cache.incr.omni === false || cache.incr.web === false;
  if (unsupported) {
    if (nowMs - lastFull >= Number(cfg.fallbackFullHours) * 3600 * 1000) return 'full';
    return trigger === 'manual' ? 'full' : 'skip';
  }
  return 'incremental';
}

// ---------- Một lượt đồng bộ ----------
async function runSync(trigger) {
  if (!(await acquireLock())) return { skipped: true, message: 'Đang có lượt khác chạy' };
  var log = new LogBuffer();
  var started = Date.now();
  var outcome, rows = null, ecfg = null, executing = false, cache = null, c = null;
  try {
    var cfg = await getConfig();
    validateConfig(cfg);
    var paused = (await chrome.storage.local.get('pausedUntil')).pausedUntil || 0;
    if (trigger === 'alarm' && paused > Date.now()) {
      return { skipped: true, message: 'Đang tạm nghỉ đến ' + new Date(paused).toLocaleTimeString('vi-VN') };
    }
    cache = await loadCache();
    var mode = decideMode(trigger, cache, cfg, Date.now());
    if (mode === 'skip') {
      var next = new Date((Date.parse(cache.lastFullAt) || 0) + Number(cfg.fallbackFullHours) * 3600 * 1000);
      return { skipped: true, message: 'Sapo không hỗ trợ đọc theo thay đổi; lượt quét toàn bộ kế tiếp lúc ' + next.toLocaleString('vi-VN') };
    }
    await setStatus('running', mode === 'full' ? 'Đang quét toàn bộ (đối soát)...' : 'Đang đồng bộ thay đổi...');
    c = makeClients(cfg);
    var now = new Date().toISOString();
    await c.omni.ensureTab();

    if (mode === 'full') {
      var fo = await c.omni.listCustomers();
      var fw = await c.web.listCustomers();
      cache.omni = {}; fo.list.forEach(function (x) { cache.omni[x.id] = SyncCore.trimOmni(x); });
      cache.web = {}; fw.list.forEach(function (x) { cache.web[x.id] = SyncCore.trimWeb(x); });
      cache.lastFullAt = now;
      log.add('INFO', 'Quét toàn bộ', '', '', '', 'Omni ' + fo.list.length + ' khách, Web ' + fw.list.length + ' khách');
    } else {
      var sides = [['omni', c.omni, SyncCore.trimOmni], ['web', c.web, SyncCore.trimWeb]];
      for (var i = 0; i < sides.length; i++) {
        var side = sides[i][0];
        var res = await sides[i][1].listCustomers({ since: sinceFor(cache[side], cache.lastFullAt) });
        if (!res.honored) {
          cache.incr[side] = false;
          await chrome.storage.local.set({ cache: cache });
          log.add('WARN', 'Sapo ' + (side === 'omni' ? 'Omni' : 'Web') + ' không hỗ trợ đọc theo thay đổi', '', '', '',
                  'Chuyển sang quét toàn bộ mỗi ' + cfg.fallbackFullHours + ' giờ để giảm tải');
          await setStatus('warn', 'Sapo không hỗ trợ đọc theo thay đổi: đồng bộ mỗi ' + cfg.fallbackFullHours + ' giờ',
                          { lastRunAt: new Date().toISOString() });
          outcome = { ok: true, summary: 'Chuyển sang quét toàn bộ mỗi ' + cfg.fallbackFullHours + ' giờ' };
          return outcome;
        }
        cache.incr[side] = true;
        res.list.forEach(function (x) { cache[side][x.id] = sides[i][2](x); });
      }
    }

    rows = (await chrome.storage.local.get('rows')).rows || [];
    ecfg = engineCfg(cfg);
    // Mất 1 bên chỉ được xác định khi vừa quét toàn bộ (bản sao đầy đủ, mới nhất)
    if (mode !== 'full') ecfg.noOrphans = true;
    var result = SyncEngine.prepare(values(cache.omni), values(cache.web), rows, ecfg, now);
    var gen = SyncEngine.execute({ actions: result.actions, rows: rows, cfg: ecfg, now: now, log: log,
                                   clock: function () { return Date.now(); },
                                   budgetMs: RUN_BUDGET_MS - (Date.now() - started) });
    executing = true;
    var done = await SyncEngine.runAsync(gen, cachingClients(c, cache));
    if (!ecfg.dryRun) await chrome.storage.local.set({ rows: rows });
    await chrome.storage.local.set({ cache: cache });
    var summary = (mode === 'full' ? '[QUÉT TOÀN BỘ] ' : '') +
      SyncEngine.summary(ecfg, values(cache.omni).length, values(cache.web).length, result.stats, done,
                         c.omni.calls + c.web.calls, Math.round((Date.now() - started) / 1000));
    log.add(done.errors ? 'WARN' : 'INFO', 'TÓM TẮT', '', '', '', summary);
    var state = done.errors ? 'error' : (done.warnings ? 'warn' : 'ok');
    await setStatus(state, done.errors ? done.errors + ' lỗi, xem nhật ký' : (done.warnings ? done.warnings + ' cảnh báo' : 'Hoạt động tốt'),
                    { lastSummary: summary, lastRunAt: new Date().toISOString(), trigger: trigger || '', lastMode: mode });
    await chrome.storage.local.remove('pausedUntil');
    if (done.errors) await alertUser('errors', 'Đồng bộ Sapo có ' + done.errors + ' lỗi', summary);
    else await chrome.storage.local.remove('lastAlert');
    outcome = { ok: true, mode: mode, summary: summary, stats: result.stats, done: done, omniCalls: c.omni.calls };
  } catch (e) {
    var kind = e && e.kind;
    // Dừng giữa lượt: vẫn lưu những việc ĐÃ làm xong để lượt sau không làm lại
    if (executing && rows && ecfg && !ecfg.dryRun) await chrome.storage.local.set({ rows: rows });
    if (executing && cache) await chrome.storage.local.set({ cache: cache });
    if (kind === 'budget') {
      log.add('INFO', 'TÓM TẮT', '', '', '', e.message);
      await setStatus('ok', 'Còn việc, sẽ làm tiếp ở lượt sau', { lastRunAt: new Date().toISOString(), lastSummary: e.message });
      outcome = { ok: true, partial: true, summary: e.message };
    } else {
      log.add('ERROR', 'DỪNG', '', '', '', e.message);
      if (kind === 'overload') {
        var cfg2 = await getConfig();
        var until = Date.now() + Number(cfg2.pauseMin || 60) * 60000;
        await chrome.storage.local.set({ pausedUntil: until });
        await setStatus('paused', 'Sapo Omni đang chậm/lỗi – tạm nghỉ đến ' + new Date(until).toLocaleTimeString('vi-VN'),
                        { lastRunAt: new Date().toISOString() });
        await alertUser('overload', 'Sapo Omni đang chậm – tiện ích tạm nghỉ', e.message);
      } else {
        var isSession = kind === 'session';
        await setStatus(isSession ? 'session' : 'error', e.message, { lastRunAt: new Date().toISOString() });
        await alertUser(isSession ? 'session' : 'stopped',
                        isSession ? 'Cần đăng nhập lại Sapo Omni' : 'Đồng bộ Sapo bị dừng', e.message);
      }
      outcome = { ok: false, error: e.message, session: kind === 'session', overload: kind === 'overload' };
    }
  } finally {
    await appendLog(log.items);
    await releaseLock();
  }
  return outcome;
}

// ---------- Kiểm tra kết nối (nhẹ: mỗi bên 1 lệnh) ----------
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
             ' | Tạo tối đa mỗi lượt: ' + cfg.maxCreate + ' | Tự động: ' + (cfg.enabled ? 'BẬT, mỗi ' + cfg.intervalMin + ' phút' : 'TẮT') +
             ' | Quét toàn bộ lúc ' + cfg.fullScanHour + ' giờ');
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
      case 'runFull': return runSync('full');
      case 'selfTest': return selfTest();
      case 'resume': { await chrome.storage.local.remove('pausedUntil'); await setStatus('ok', 'Đã bỏ tạm nghỉ'); return { ok: true }; }
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
        await chrome.storage.local.set({ rows: [], cache: emptyCache() });
        await appendLog([{ time: new Date().toISOString(), level: 'WARN', action: 'XÓA BẢNG GHÉP', omni_id: '', web_id: '', name: '', detail: 'Người dùng xóa bảng ghép và bản sao danh sách' }]);
        return { ok: true };
      }
      default: return { ok: false, error: 'Lệnh không hợp lệ' };
    }
  })().then(sendResponse, function (e) { sendResponse({ ok: false, error: e.message }); });
  return true;   // trả lời bất đồng bộ
});
