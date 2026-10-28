var FIELDS = ['webBase', 'webKey', 'webSecret', 'omniBase', 'dryRun', 'maxCreate', 'intervalMin', 'fullScanHour',
              'skipOmniGroupIds', 'pendingTimeoutMin', 'deleteEcho', 'alertWebhook'];
(function () {
  var sel = document.getElementById('fullScanHour');
  for (var h = 0; h < 24; h++) { var o = document.createElement('option'); o.value = String(h); o.textContent = h + ' giờ'; sel.appendChild(o); }
})();
var STATUS = { pair: 'Đang đồng bộ', pending_web: 'Chờ Sapo tạo bên Omni', echo: 'Bản dội (bỏ qua)', echo_deleted: 'Bản dội đã xóa',
               dup: 'Trùng trên Omni (bỏ qua)', dup_web: 'Trùng trên Web (bỏ qua)', orphan: 'Mất 1 bên', create_failed: 'Tạo lỗi, thử lại sau 24h' };
function $(id) { return document.getElementById(id); }
function send(cmd, extra) { return chrome.runtime.sendMessage(Object.assign({ cmd: cmd }, extra || {})); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function fmt(t) { return t ? new Date(t).toLocaleString('vi-VN') : ''; }

// ---- Thẻ ----
document.querySelectorAll('[data-tab]').forEach(function (b) {
  b.onclick = function () {
    document.querySelectorAll('[data-tab]').forEach(function (x) { x.classList.toggle('on', x === b); });
    ['settings', 'log', 'map'].forEach(function (id) { $(id).hidden = id !== b.dataset.tab; });
    if (b.dataset.tab === 'log') renderLog();
    if (b.dataset.tab === 'map') renderMap();
  };
});

// ---- Cài đặt ----
async function loadConfig() {
  var cfg = (await chrome.storage.local.get('config')).config || {};
  var d = { omniBase: 'https://trangthietbivn.mysapogo.com', dryRun: true, maxCreate: 10, intervalMin: 10, fullScanHour: 2, pendingTimeoutMin: 30, deleteEcho: false };
  FIELDS.forEach(function (f) { var v = cfg[f] != null ? cfg[f] : d[f]; $(f).value = v == null ? '' : String(v); });
}
function readForm() {
  var c = {};
  FIELDS.forEach(function (f) { c[f] = $(f).value.trim(); });
  c.webBase = c.webBase.replace(/\/admin.*$/, '').replace(/\/+$/, '');
  c.omniBase = c.omniBase.replace(/\/admin.*$/, '').replace(/\/+$/, '');
  c.dryRun = c.dryRun === 'true'; c.deleteEcho = c.deleteEcho === 'true';
  c.maxCreate = Number(c.maxCreate) || 0; c.intervalMin = Number(c.intervalMin) || 10;
  c.pendingTimeoutMin = Number(c.pendingTimeoutMin) || 30;
  c.fullScanHour = Number(c.fullScanHour);
  if ([10, 15, 30, 60].indexOf(c.intervalMin) < 0) c.intervalMin = 10;
  return c;
}
$('save').onclick = async function () {
  var c = readForm();
  if (!c.dryRun && !confirm('Chuyển sang CHẠY THẬT: tiện ích sẽ ghi dữ liệu lên Sapo. Anh/chị đã chạy thử và kiểm tra nhật ký chưa?')) return;
  var r = await send('saveConfig', { config: c });
  $('saved').textContent = r && r.ok ? 'Đã lưu lúc ' + new Date().toLocaleTimeString('vi-VN') : 'Lỗi: ' + (r && r.error);
};
$('test').onclick = async function () {
  await send('saveConfig', { config: readForm() });
  $('testOut').hidden = false; $('testOut').textContent = 'Đang kiểm tra…';
  var r = await send('selfTest'); $('testOut').textContent = r.text || r.error;
};
$('run').onclick = async function () {
  this.disabled = true; $('testOut').hidden = false; $('testOut').textContent = 'Đang chạy đồng bộ…';
  var r = await send('runNow'); this.disabled = false;
  $('testOut').textContent = r.skipped ? r.message : (r.ok ? r.summary : 'DỪNG: ' + r.error);
};

$('runFull').onclick = async function () {
  if (!confirm('Quét toàn bộ đọc lại toàn bộ khách hàng 2 bên (vài phút, chậm rãi). Nên làm ngoài giờ làm việc. Tiếp tục?')) return;
  this.disabled = true; $('testOut').hidden = false; $('testOut').textContent = 'Đang quét toàn bộ (chậm rãi để không làm nặng Sapo)…';
  var r = await send('runFull'); this.disabled = false;
  $('testOut').textContent = r.skipped ? r.message : (r.ok ? r.summary : 'DỪNG: ' + r.error);
};

// ---- Nhật ký ----
async function renderLog() {
  var log = ((await chrome.storage.local.get('log')).log || []).slice().reverse();
  var lv = $('logLevel').value;
  if (lv === 'TÓM TẮT') log = log.filter(function (l) { return l.action === 'TÓM TẮT' || l.action === 'DỪNG'; });
  else if (lv) log = log.filter(function (l) { return l.level === lv; });
  $('logCount').textContent = log.length + ' dòng (mới nhất ở trên)';
  $('logBody').innerHTML = log.slice(0, 1500).map(function (l) {
    return '<tr class="lv-' + esc(l.level) + '"><td>' + fmt(l.time) + '</td><td>' + esc(l.level) + '</td><td>' + esc(l.action) +
      '</td><td>' + esc(l.omni_id) + '</td><td>' + esc(l.web_id) + '</td><td>' + esc(l.name) + '</td><td>' + esc(l.detail) + '</td></tr>';
  }).join('');
}
$('logRefresh').onclick = renderLog; $('logLevel').onchange = renderLog;

// ---- Bảng ghép ----
async function renderMap() {
  var rows = (await chrome.storage.local.get('rows')).rows || [];
  var q = $('mapSearch').value.trim().toLowerCase();
  if (q) rows = rows.filter(function (r) { return [r.name, r.phone, r.omni_id, r.web_id, r.omni_code].join(' ').toLowerCase().indexOf(q) >= 0; });
  var count = {}; rows.forEach(function (r) { count[r.status] = (count[r.status] || 0) + 1; });
  $('mapCount').textContent = rows.length + ' dòng · ' + Object.keys(count).map(function (k) { return (STATUS[k] || k) + ': ' + count[k]; }).join(' · ');
  $('mapBody').innerHTML = rows.slice(0, 3000).map(function (r) {
    return '<tr><td>' + esc(STATUS[r.status] || r.status) + '</td><td>' + esc(r.omni_id) + '</td><td>' + esc(r.omni_code) + '</td><td>' + esc(r.web_id) +
      '</td><td>' + esc(r.name) + '</td><td>' + esc(r.phone) + '</td><td>' + esc(r.note) + '</td><td>' + fmt(r.updated_at) + '</td></tr>';
  }).join('');
}
$('mapRefresh').onclick = renderMap; $('mapSearch').oninput = renderMap;
$('mapReset').onclick = async function () {
  if (!confirm('Xóa toàn bộ bảng ghép? Lượt sau hệ thống sẽ ghép lại từ đầu theo SĐT/email. Chỉ làm khi được hướng dẫn.')) return;
  await send('resetMap'); renderMap();
};

// ---- Xuất CSV (mở được bằng Excel, giữ tiếng Việt) ----
function downloadCsv(name, cols, rows) {
  var q = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
  var csv = '﻿' + [cols.map(q).join(',')].concat(rows.map(function (r) { return cols.map(function (c) { return q(r[c]); }).join(','); })).join('\r\n');
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = name; a.click();
}
$('logCsv').onclick = async function () {
  downloadCsv('nhat-ky-dong-bo.csv', ['time', 'level', 'action', 'omni_id', 'web_id', 'name', 'detail'], (await chrome.storage.local.get('log')).log || []);
};
$('mapCsv').onclick = async function () {
  downloadCsv('bang-ghep-omni-web.csv', ['status', 'omni_id', 'omni_code', 'web_id', 'name', 'phone', 'note', 'linked_at', 'updated_at'], (await chrome.storage.local.get('rows')).rows || []);
};

// ---- Trạng thái ----
async function renderStatus() {
  var st = (await chrome.storage.local.get('status')).status || {};
  $('status').textContent = (st.message || 'chưa chạy') + (st.lastRunAt ? ' · lượt gần nhất ' + fmt(st.lastRunAt) : '');
}
chrome.storage.onChanged.addListener(renderStatus);
loadConfig(); renderStatus();
