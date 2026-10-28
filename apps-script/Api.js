/**
 * Api.js – gọi API Sapo Web (mysapo.net) và Sapo Omni (mysapogo.com).
 * Hai hệ thống cùng kiểu đường dẫn /admin/customers.json nhưng khác cấu trúc dữ liệu.
 */

/**
 * @param {Object} opts
 *   name: 'web' | 'omni'
 *   base: 'https://tencuahang.mysapo.net' hoặc 'https://tencuahang.mysapogo.com'
 *   authMode: 'basic' (API key + secret) | 'token' (X-Sapo-Access-Token)
 *   key, secret, token
 */
function SapoClient(opts) {
  this.name = opts.name;
  this.base = String(opts.base || '').replace(/\/+$/, '') + '/admin/';
  this.authMode = opts.authMode || 'basic';
  this.key = opts.key || '';
  this.secret = opts.secret || '';
  this.token = opts.token || '';
  this.minGapMs = opts.minGapMs == null ? 350 : opts.minGapMs; // ~3 lệnh/giây
  this.lastCall = 0;
  this.calls = 0;
}

SapoClient.prototype.headers_ = function () {
  if (this.authMode === 'token') return { 'X-Sapo-Access-Token': this.token };
  return { Authorization: 'Basic ' + Utilities.base64Encode(this.key + ':' + this.secret) };
};

SapoClient.prototype.request = function (method, path, body) {
  var opt = { method: method, headers: this.headers_(), muteHttpExceptions: true, followRedirects: false };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  var url = this.base + path;
  for (var attempt = 0; attempt < 5; attempt++) {
    var wait = this.minGapMs - (Date.now() - this.lastCall);
    if (wait > 0) Utilities.sleep(wait);
    this.lastCall = Date.now();
    this.calls++;
    var res = UrlFetchApp.fetch(url, opt);
    var code = res.getResponseCode();
    if (code === 429 || code >= 500) {           // quá giới hạn hoặc lỗi máy chủ → chờ rồi thử lại
      Utilities.sleep(1500 * Math.pow(2, attempt));
      continue;
    }
    var text = res.getContentText();
    if (code >= 300 && code < 400) {
      throw new Error('[' + this.name + '] ' + method.toUpperCase() + ' ' + path +
        ' → HTTP ' + code + ' (bị chuyển hướng: sai key, hết hạn đăng nhập hoặc không có quyền)');
    }
    if (code >= 400) {
      throw new Error('[' + this.name + '] ' + method.toUpperCase() + ' ' + path +
        ' → HTTP ' + code + ': ' + text.slice(0, 300));
    }
    if (!text) return {};
    try { return JSON.parse(text); }
    catch (e) {
      throw new Error('[' + this.name + '] ' + path + ' không trả về JSON: ' + text.slice(0, 200));
    }
  }
  throw new Error('[' + this.name + '] ' + method.toUpperCase() + ' ' + path + ' thất bại sau 5 lần thử');
};

/** Đọc toàn bộ khách hàng, tự lật trang */
SapoClient.prototype.listCustomers = function () {
  var limit = 250, all = [], seen = {}, total = null;
  for (var page = 1; page <= 400; page++) {
    var path = 'customers.json?limit=' + limit + '&page=' + page;
    if (this.name === 'web') {
      path += '&fields=id,first_name,last_name,email,phone,tags,addresses,default_address,' +
              'orders_count,created_on,modified_on';
    }
    var j = this.request('get', path);
    var list = j.customers || [];
    var fresh = 0;
    list.forEach(function (c) { if (!seen[c.id]) { seen[c.id] = true; all.push(c); fresh++; } });
    total = j.metadata && j.metadata.total != null ? j.metadata.total : null;
    if (!list.length || !fresh) break;                 // hết dữ liệu hoặc API lặp lại trang cũ
    if (total != null) { if (all.length >= total) break; }
    else if (list.length < limit) break;
  }
  // An toàn: đọc thiếu khách thì dừng, tránh hiểu nhầm là khách đã bị xóa
  var expected = total;
  if (expected == null) expected = this.request('get', 'customers/count.json').count;
  if (expected != null && all.length < expected) {
    throw new Error('[' + this.name + '] chỉ đọc được ' + all.length + '/' + expected + ' khách, dừng để an toàn');
  }
  return all;
};

SapoClient.prototype.createCustomer = function (payload) {
  return this.request('post', 'customers.json', payload).customer;
};

SapoClient.prototype.updateCustomer = function (id, payload) {
  return this.request('put', 'customers/' + id + '.json', payload).customer;
};

SapoClient.prototype.deleteCustomer = function (id) {
  return this.request('delete', 'customers/' + id + '.json');
};
