/**
 * Main.js – điều khiển đồng bộ khách hàng 2 chiều Sapo Omni ↔ Sapo Web.
 *
 * Cấu hình đặt trong: Apps Script → Cài đặt dự án (bánh răng) → Thuộc tính tập lệnh.
 * Xem README.md để biết danh sách khóa cấu hình.
 */

// ---------- Menu trên Google Sheet ----------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Đồng bộ Sapo')
    .addItem('1. Kiểm tra kết nối', 'selfTest')
    .addItem('2. Chạy đồng bộ 1 lần', 'runSync')
    .addSeparator()
    .addItem('Bật tự động', 'installTrigger')
    .addItem('Tắt tự động', 'removeTriggers')
    .addToUi();
}

// ---------- Cấu hình ----------
function getConfig_(opts) {
  opts = opts || {};
  var p = PropertiesService.getScriptProperties().getProperties();
  function bool(v, d) { return v == null || v === '' ? d : String(v).toLowerCase() === 'true'; }
  function num(v, d) { var n = Number(v); return v == null || v === '' || isNaN(n) ? d : n; }
  var cfg = {
    webBase: p.WEB_BASE_URL,                       // https://tencuahang.mysapo.net
    webKey: p.WEB_API_KEY, webSecret: p.WEB_API_SECRET,
    omniBase: p.OMNI_BASE_URL,                     // https://trangthietbivn.mysapogo.com
    omniAuthMode: p.OMNI_AUTH_MODE || 'basic',     // basic | token
    omniKey: p.OMNI_API_KEY, omniSecret: p.OMNI_API_SECRET, omniToken: p.OMNI_ACCESS_TOKEN,
    dryRun: bool(p.DRY_RUN, true),                 // mặc định CHỈ CHẠY THỬ
    maxCreate: num(p.MAX_CREATE_PER_RUN, 10),
    pendingTimeoutMin: num(p.PENDING_WEB_TIMEOUT_MIN, 30),
    deleteEcho: bool(p.DELETE_ECHO, false),        // chỉ bật khi phép thử A đạt
    linkOnly: !bool(p.SYNC_CUSTOMERS, false),      // mặc định CHỈ GHÉP khách, không tạo / không sửa
    skipOmniGroupIds: String(p.SKIP_OMNI_GROUP_IDS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
    alertEmail: p.ALERT_EMAIL || '',
    intervalMin: num(p.SYNC_INTERVAL_MIN, 10)
  };
  if ([5, 10, 15, 30].indexOf(cfg.intervalMin) < 0) throw new Error('SYNC_INTERVAL_MIN chỉ nhận 5, 10, 15 hoặc 30');
  var missing = [];
  if (!cfg.webBase) missing.push('WEB_BASE_URL');
  if (!cfg.webKey) missing.push('WEB_API_KEY');
  if (!cfg.webSecret) missing.push('WEB_API_SECRET');
  if (!cfg.omniBase) missing.push('OMNI_BASE_URL');
  cfg.omniReady = cfg.omniAuthMode === 'token' ? !!cfg.omniToken : !!(cfg.omniKey && cfg.omniSecret);
  if (!cfg.omniReady && !opts.allowMissingOmni) {
    missing.push(cfg.omniAuthMode === 'token' ? 'OMNI_ACCESS_TOKEN' : 'OMNI_API_KEY / OMNI_API_SECRET');
  }
  if (missing.length) throw new Error('Thiếu cấu hình: ' + missing.join(', '));
  return cfg;
}

function clients_(cfg) {
  return {
    web: new SapoClient({ name: 'web', base: cfg.webBase, authMode: 'basic', key: cfg.webKey, secret: cfg.webSecret }),
    omni: new SapoClient({ name: 'omni', base: cfg.omniBase, authMode: cfg.omniAuthMode,
                           key: cfg.omniKey, secret: cfg.omniSecret, token: cfg.omniToken })
  };
}

// ---------- Kiểm tra kết nối ----------
function selfTest() {
  var cfg = getConfig_({ allowMissingOmni: true });
  var c = clients_(cfg);
  var out = [];
  [['Sapo Web', c.web, SyncCore.fromWeb], ['Sapo Omni', c.omni, SyncCore.fromOmni]].forEach(function (x) {
    if (x[0] === 'Sapo Omni' && !cfg.omniReady) {
      out.push('⏳ Sapo Omni: chưa có API key (thêm OMNI_API_KEY / OMNI_API_SECRET khi Sapo cấp)');
      return;
    }
    try {
      var j = x[1].request('get', 'customers.json?limit=1&page=1');
      var list = j.customers || [];
      var total = j.metadata && j.metadata.total != null ? j.metadata.total : null;
      if (total == null) {
        try { total = x[1].request('get', 'customers/count.json').count; } catch (e) { total = '(không rõ)'; }
      }
      var sample = list.length ? x[2](list[0]) : null;
      out.push('✅ ' + x[0] + ': kết nối OK. Tổng khách: ' + total +
               (sample ? '\n   Mẫu: ' + sample.name + ' | ' + (sample.phone || '-') + ' | ' + (sample.email || '-') : ''));
    } catch (e) {
      out.push('❌ ' + x[0] + ': ' + e.message);
    }
  });
  out.push('\nChế độ: ' + (cfg.dryRun ? 'CHẠY THỬ (không ghi dữ liệu)' : 'CHẠY THẬT') +
           ' | Tạo tối đa mỗi lần: ' + cfg.maxCreate + ' | Xóa bản dội: ' + (cfg.deleteEcho ? 'BẬT' : 'TẮT'));
  var msg = out.join('\n');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* chạy từ trình soạn thảo */ }
  return msg;
}

// ---------- Đồng bộ ----------
var TIME_BUDGET_MS = 4.5 * 60 * 1000; // Apps Script giới hạn 6 phút/lượt

function runSync() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { Logger.log('Đang có lượt đồng bộ khác chạy, bỏ qua.'); return; }
  var log = new Logger_();
  var started = Date.now();
  try {
    var cfg = getConfig_();
    var c = clients_(cfg);
    var now = new Date().toISOString();
    var omniList = c.omni.listCustomers();
    var webList = c.web.listCustomers();
    var rows = loadRows_();
    var result = SyncEngine.prepare(omniList, webList, rows, cfg, now);
    var gen = SyncEngine.execute({ actions: result.actions, rows: rows, cfg: cfg, now: now, log: log,
                                   clock: function () { return Date.now(); },
                                   budgetMs: TIME_BUDGET_MS - (Date.now() - started) });
    var done = SyncEngine.runSync(gen, c);
    if (!cfg.dryRun) saveRows_(rows);
    var summary = SyncEngine.summary(cfg, omniList.length, webList.length, result.stats, done,
                                     c.omni.calls + c.web.calls, Math.round((Date.now() - started) / 1000));
    log.add(done.errors ? 'WARN' : 'INFO', 'TÓM TẮT', '', '', '', summary);
    Logger.log(summary);
    if (done.errors) alert_(cfg, 'Đồng bộ Sapo có ' + done.errors + ' lỗi', summary + '\n\nXem chi tiết ở sheet Log.');
  } catch (e) {
    log.add('ERROR', 'DỪNG', '', '', '', e.message);
    Logger.log(e.stack || e.message);
    try { alert_(getConfig_(), 'Đồng bộ Sapo bị dừng', e.message); } catch (e2) { /* thiếu cấu hình */ }
  } finally {
    log.flush();
    lock.releaseLock();
  }
}

// ---------- Cảnh báo email (tối đa 1 email/giờ) ----------
function alert_(cfg, subject, body) {
  if (!cfg || !cfg.alertEmail) return;
  var props = PropertiesService.getScriptProperties();
  var last = Number(props.getProperty('LAST_ALERT_AT') || 0);
  if (Date.now() - last < 3600 * 1000) return;
  MailApp.sendEmail(cfg.alertEmail, subject, body);
  props.setProperty('LAST_ALERT_AT', String(Date.now()));
}

// ---------- Hẹn giờ tự động ----------
function installTrigger() {
  var cfg = getConfig_();
  removeTriggers();
  ScriptApp.newTrigger('runSync').timeBased().everyMinutes(cfg.intervalMin).create();
  var msg = 'Đã bật đồng bộ tự động mỗi ' + cfg.intervalMin + ' phút.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* trình soạn thảo */ }
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runSync') ScriptApp.deleteTrigger(t);
  });
}
