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
    .addItem('Bật tự động (mỗi 10 phút)', 'installTrigger')
    .addItem('Tắt tự động', 'removeTriggers')
    .addToUi();
}

// ---------- Cấu hình ----------
function getConfig_() {
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
    skipOmniGroupIds: String(p.SKIP_OMNI_GROUP_IDS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
    alertEmail: p.ALERT_EMAIL || ''
  };
  var missing = [];
  if (!cfg.webBase) missing.push('WEB_BASE_URL');
  if (!cfg.webKey) missing.push('WEB_API_KEY');
  if (!cfg.webSecret) missing.push('WEB_API_SECRET');
  if (!cfg.omniBase) missing.push('OMNI_BASE_URL');
  if (cfg.omniAuthMode === 'token' ? !cfg.omniToken : !(cfg.omniKey && cfg.omniSecret)) {
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
  var cfg = getConfig_();
  var c = clients_(cfg);
  var out = [];
  [['Sapo Web', c.web, SyncCore.fromWeb], ['Sapo Omni', c.omni, SyncCore.fromOmni]].forEach(function (x) {
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
    var result = SyncCore.plan({ omni: omniList, web: webList, rows: rows, now: now, cfg: cfg });
    var s0 = result.stats;
    if (s0.orphans > Math.max(5, 0.2 * (s0.pairs + s0.orphans))) {
      throw new Error('Có ' + s0.orphans + ' cặp bị mất 1 bên trong 1 lượt (bất thường). ' +
        'Đã dừng, không thay đổi gì. Kiểm tra API key / quyền truy cập rồi chạy lại.');
    }
    var done = executeActions_(result.actions, rows, c, cfg, now, log, started);
    if (!cfg.dryRun) saveRows_(rows);
    var s = result.stats;
    var summary = (cfg.dryRun ? '[CHẠY THỬ] ' : '') +
      'Omni ' + omniList.length + ' khách, Web ' + webList.length + ' khách | cặp: ' + s.pairs +
      ', Omni→Web: ' + s.o2w + ', Web→Omni: ' + s.w2o + ', xung đột: ' + s.conflicts +
      ', ghép mới: ' + s.linked + ', tạo trên Web: ' + s.createdWeb + ', tạo trên Omni: ' + s.createdOmni +
      ', bản dội: ' + s.echoes + ', bản trùng: ' + s.dups + ', chờ: ' + s.pending +
      ', mất 1 bên: ' + s.orphans + ', bỏ qua: ' + s.skipped + ', để lượt sau: ' + (s.deferred + done.deferred) +
      ' | lỗi: ' + done.errors + ' | API: ' + (c.omni.calls + c.web.calls) + ' lệnh, ' +
      Math.round((Date.now() - started) / 1000) + 's';
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

var TIME_BUDGET_MS = 4.5 * 60 * 1000; // Apps Script giới hạn 6 phút/lượt

function executeActions_(actions, rows, c, cfg, now, log, started) {
  var dry = cfg.dryRun;
  var errors = 0, deferred = 0;
  var tag = dry ? '[THỬ] ' : '';

  function findRow(omniId, webId) {
    for (var i = 0; i < rows.length; i++) {
      if ((omniId && rows[i].omni_id === omniId) || (webId && rows[i].web_id === webId)) return rows[i];
    }
    return null;
  }
  function removeRow(r) { var i = rows.indexOf(r); if (i >= 0) rows.splice(i, 1); }
  function upsertPair(o, w, hashO, hashW, extra) {
    var r = findRow(o.id, null) || findRow(null, w.id);
    if (!r) { r = {}; rows.push(r); }
    r.omni_id = o.id; r.web_id = w.id; r.status = 'pair';
    r.hash_o = hashO; r.hash_w = hashW;
    r.linked_at = r.linked_at || now;
    r.first_seen = r.first_seen || '';
    r.omni_code = o.code || r.omni_code || ''; r.name = o.name || w.name; r.phone = o.phone || w.phone;
    r.note = extra || ''; r.updated_at = now;
  }

  for (var i = 0; i < actions.length; i++) {
    var a = actions[i];
    if (Date.now() - started > TIME_BUDGET_MS) { deferred += actions.length - i; break; }
    try {
      switch (a.type) {
        case 'set_hash': {
          var r0 = findRow(a.omni_id, a.web_id);
          if (r0) { r0.hash_o = a.hash_o; r0.hash_w = a.hash_w; r0.updated_at = now; }
          break;
        }
        case 'push_o2w': {
          var hw1 = SyncCore.hashOf(a.omni);
          if (!dry) {
            var nw = c.web.updateCustomer(a.web.id, SyncCore.toWebPayload(a.omni, a.web));
            if (nw) hw1 = SyncCore.hashOf(SyncCore.fromWeb(nw));
          }
          var r1 = findRow(a.omni.id, a.web.id);
          if (r1) { r1.hash_o = SyncCore.hashOf(a.omni); r1.hash_w = hw1; r1.name = a.omni.name; r1.phone = a.omni.phone; r1.updated_at = now; }
          log.add('INFO', tag + 'Omni → Web' + (a.conflict ? ' (xung đột, Omni mới hơn)' : ''), a.omni.id, a.web.id, a.omni.name, diff_(a.web, a.omni));
          break;
        }
        case 'push_w2o': {
          var ho2 = SyncCore.hashOf(a.web);
          if (!dry) {
            var no = c.omni.updateCustomer(a.omni.id, SyncCore.toOmniPayload(a.web, a.omni));
            if (no) ho2 = SyncCore.hashOf(SyncCore.fromOmni(no));
          }
          var r2 = findRow(a.omni.id, a.web.id);
          if (r2) { r2.hash_o = ho2; r2.hash_w = SyncCore.hashOf(a.web); r2.name = a.web.name; r2.phone = a.web.phone; r2.updated_at = now; }
          log.add('INFO', tag + 'Web → Omni' + (a.conflict ? ' (xung đột, Web mới hơn)' : ''), a.omni.id, a.web.id, a.web.name, diff_(a.omni, a.web));
          break;
        }
        case 'link': {
          var hw3 = SyncCore.hashOf(a.web);
          if (a.needPush && !dry) {
            var nw3 = c.web.updateCustomer(a.web.id, SyncCore.toWebPayload(a.omni, a.web));
            hw3 = nw3 ? SyncCore.hashOf(SyncCore.fromWeb(nw3)) : SyncCore.hashOf(a.omni);
          }
          upsertPair(a.omni, a.web, SyncCore.hashOf(a.omni), hw3, 'ghép theo SĐT/MST/email');
          log.add('INFO', tag + 'Ghép cặp' + (a.needPush ? ' + cập nhật Web theo Omni' : ''), a.omni.id, a.web.id, a.omni.name,
                  a.needPush ? diff_(a.web, a.omni) : '');
          break;
        }
        case 'create_web': {
          var wid = 'THỬ-' + a.omni.id, hw4 = SyncCore.hashOf(a.omni);
          if (!dry) {
            var cw = c.web.createCustomer(SyncCore.toWebPayload(a.omni, null));
            wid = String(cw.id); hw4 = SyncCore.hashOf(SyncCore.fromWeb(cw));
          }
          upsertPair(a.omni, { id: wid, name: a.omni.name, phone: a.omni.phone }, SyncCore.hashOf(a.omni), hw4, 'tạo trên Web từ Omni');
          log.add('INFO', tag + 'Tạo khách trên Web', a.omni.id, wid, a.omni.name, (a.omni.phone || '') + ' ' + (a.omni.email || ''));
          break;
        }
        case 'create_omni': {
          var oid = 'THỬ-' + a.web.id, ho5 = SyncCore.hashOf(a.web), code = '';
          if (!dry) {
            var co = c.omni.createCustomer(SyncCore.toOmniPayload(a.web, null));
            oid = String(co.id); code = co.code || ''; ho5 = SyncCore.hashOf(SyncCore.fromOmni(co));
          }
          var pend = findRow(null, a.web.id); if (pend) removeRow(pend);
          upsertPair({ id: oid, code: code, name: a.web.name, phone: a.web.phone }, a.web, ho5, SyncCore.hashOf(a.web), 'tạo trên Omni từ Web');
          log.add('INFO', tag + 'Tạo khách trên Omni', oid, a.web.id, a.web.name, (a.web.phone || '') + ' ' + (a.web.email || ''));
          break;
        }
        case 'pending': {
          rows.push({ omni_id: '', web_id: a.web.id, status: 'pending_web', first_seen: now,
                      name: a.web.name, phone: a.web.phone, note: 'chờ Sapo tự tạo bên Omni', updated_at: now });
          log.add('INFO', tag + 'Khách Web mới, chờ Sapo tạo bên Omni', '', a.web.id, a.web.name, a.web.phone || a.web.email);
          break;
        }
        case 'mark_echo': {
          var status = a.echo ? 'echo' : 'dup';
          if (a.deletable && !dry) { c.omni.deleteCustomer(a.omni.id); status = 'echo_deleted'; }
          rows.push({ omni_id: a.omni.id, web_id: '', status: status, omni_code: a.omni.code, name: a.omni.name,
                      phone: a.omni.phone, note: 'trùng với Omni ' + a.pair.omni_id + ' / Web ' + a.pair.web_id, updated_at: now });
          log.add(a.echo ? 'INFO' : 'WARN',
                  tag + (status === 'echo_deleted' ? 'Xóa bản dội trên Omni' : a.echo ? 'Bản dội do Sapo tạo (giữ nguyên)' : 'Khách trùng có sẵn trên Omni (không đồng bộ)'),
                  a.omni.id, a.pair.web_id, a.omni.name, 'bản chính: Omni ' + a.pair.omni_id + ', số đơn bản này: ' + a.omni.orders);
          break;
        }
        case 'mark_web_dup': {
          rows.push({ omni_id: '', web_id: a.web.id, status: 'dup_web', name: a.web.name, phone: a.web.phone,
                      note: 'trùng với Web ' + a.pair.web_id, updated_at: now });
          log.add('WARN', tag + 'Tài khoản Web trùng (không đồng bộ)', a.pair.omni_id, a.web.id, a.web.name, 'bản chính: Web ' + a.pair.web_id);
          break;
        }
        case 'orphan': {
          var r8 = findRow(a.omni_id, a.web_id);
          if (r8) { r8.status = 'orphan'; r8.note = 'đã bị xóa bên ' + (a.missing === 'omni' ? 'Omni' : 'Web'); r8.updated_at = now; }
          log.add('WARN', tag + 'Mất 1 bên của cặp', a.omni_id, a.web_id, r8 ? r8.name : '', 'khách đã bị xóa bên ' + (a.missing === 'omni' ? 'Omni' : 'Web') + ', ngừng đồng bộ cặp này');
          break;
        }
        case 'drop_row': {
          var r9 = findRow(null, a.web_id); if (r9) removeRow(r9);
          break;
        }
      }
    } catch (e) {
      errors++;
      var who = a.omni || a.web || {};
      log.add('ERROR', tag + a.type, a.omni ? a.omni.id : a.omni_id, a.web ? a.web.id : a.web_id, who.name || '', e.message);
    }
  }
  return { errors: errors, deferred: deferred };
}

/** Mô tả ngắn các trường thay đổi để ghi nhật ký */
function diff_(from, to) {
  var labels = { name: 'Tên', phone: 'SĐT', email: 'Email', tax: 'MST', address: 'Địa chỉ' };
  return Object.keys(labels).filter(function (k) { return (from[k] || '') !== (to[k] || ''); })
    .map(function (k) { return labels[k] + ': "' + (from[k] || '') + '" → "' + (to[k] || '') + '"'; }).join('; ');
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
  removeTriggers();
  ScriptApp.newTrigger('runSync').timeBased().everyMinutes(10).create();
  var msg = 'Đã bật đồng bộ tự động mỗi 10 phút.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* trình soạn thảo */ }
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runSync') ScriptApp.deleteTrigger(t);
  });
}
