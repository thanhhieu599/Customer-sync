/**
 * Store.js – lưu bảng ghép và nhật ký trên chính Google Sheet chứa script.
 *  - Sheet "Map": mỗi dòng là một cặp Omni ↔ Web (hoặc khách đang chờ / bản dội / bản trùng).
 *  - Sheet "Log": nhật ký mọi thay đổi, giữ tối đa LOG_MAX_ROWS dòng gần nhất.
 */
var MAP_SHEET = 'Map';
var LOG_SHEET = 'Log';
var LOG_MAX_ROWS = 5000;
var MAP_COLS = ['omni_id', 'web_id', 'status', 'hash_o', 'hash_w', 'linked_at', 'first_seen',
                'omni_code', 'name', 'phone', 'note', 'updated_at'];
var LOG_COLS = ['time', 'level', 'action', 'omni_id', 'web_id', 'name', 'detail'];

function sheet_(name, cols) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function loadRows_() {
  var sh = sheet_(MAP_SHEET, MAP_COLS);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, MAP_COLS.length).getDisplayValues();
  return values.filter(function (r) { return r[0] || r[1]; }).map(function (r) {
    var o = {};
    MAP_COLS.forEach(function (c, i) { o[c] = String(r[i] || ''); });
    return o;
  });
}

function saveRows_(rows) {
  var sh = sheet_(MAP_SHEET, MAP_COLS);
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, MAP_COLS.length).clearContent();
  if (!rows.length) return;
  var data = rows.map(function (o) { return MAP_COLS.map(function (c) { return o[c] == null ? '' : String(o[c]); }); });
  var rng = sh.getRange(2, 1, data.length, MAP_COLS.length);
  rng.setNumberFormat('@');             // giữ nguyên SĐT, ID dạng chữ (không mất số 0)
  rng.setValues(data);
}

function Logger_() { this.buf = []; }
Logger_.prototype.add = function (level, action, omniId, webId, name, detail) {
  this.buf.push([new Date().toISOString(), level, action, omniId || '', webId || '', name || '', detail || '']);
};
Logger_.prototype.flush = function () {
  if (!this.buf.length) return;
  var sh = sheet_(LOG_SHEET, LOG_COLS);
  var rng = sh.getRange(sh.getLastRow() + 1, 1, this.buf.length, LOG_COLS.length);
  rng.setNumberFormat('@');
  rng.setValues(this.buf);
  this.buf = [];
  var extra = sh.getLastRow() - 1 - LOG_MAX_ROWS;
  if (extra > 0) sh.deleteRows(2, extra);
};
