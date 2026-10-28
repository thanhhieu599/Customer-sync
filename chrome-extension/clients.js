/**
 * clients.js – cổng kết nối Sapo cho tiện ích Chrome.
 *  - OmniTabClient: gửi lệnh qua tab Sapo Omni đang đăng nhập (dùng phiên đăng nhập, không cần API key)
 *  - WebClient:     gọi API Sapo Web bằng API key
 */

/** Lỗi nghiêm trọng: dừng cả lượt (vd. hết phiên đăng nhập Omni) */
function FatalError(message, kind) {
  var e = new Error(message);
  e.fatal = true;
  e.kind = kind || 'fatal';
  return e;
}

function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

/** Hàm chạy BÊN TRONG tab Omni (giống hệt lệnh anh đã chạy ở Console) */
async function omniInPageFetch(method, url, body) {
  var opt = { method: method, credentials: 'include', headers: { 'Accept': 'application/json' } };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  var r = await fetch(url, opt);
  return { status: r.status, redirected: !!r.redirected, url: r.url || '', text: await r.text() };
}

// ---------------------------------------------------------------------------
function OmniTabClient(opts) {
  this.base = String(opts.base || '').replace(/\/+$/, '');
  this.host = this.base.replace(/^https?:\/\//, '');
  this.tabId = null;
  this.calls = 0;
  this.minGapMs = opts.minGapMs == null ? 300 : opts.minGapMs;
  this.lastCall = 0;
  this.retryBaseMs = opts.retryBaseMs == null ? 1500 : opts.retryBaseMs;
  this.attempts = opts.attempts || 5;
}

OmniTabClient.prototype.isLoginUrl_ = function (url) {
  return !url || url.indexOf(this.host) < 0 || /\/(login|signin|dang-nhap)|accounts\.sapo/i.test(url);
};

/** Tìm (hoặc mở) tab Omni đã đăng nhập */
OmniTabClient.prototype.ensureTab = async function () {
  var tabs = await chrome.tabs.query({ url: this.base + '/*' });
  var tab = tabs.find(function (t) { return t.status === 'complete'; }) || tabs[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: this.base + '/admin/dashboard', pinned: true, active: false });
    tab = await waitTabComplete_(tab.id, 60000);
  } else if (tab.status !== 'complete') {
    tab = await waitTabComplete_(tab.id, 60000);
  }
  if (this.isLoginUrl_(tab.url)) {
    throw FatalError('Phiên đăng nhập Sapo Omni đã hết hạn. Mở tab Sapo Omni và đăng nhập lại.', 'session');
  }
  this.tabId = tab.id;
  return tab;
};

function waitTabComplete_(tabId, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var done = false;
    var timer = setTimeout(function () {
      if (done) return; done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(FatalError('Tab Sapo Omni không tải xong sau ' + Math.round(timeoutMs / 1000) + ' giây', 'network'));
    }, timeoutMs);
    function listener(id, info, tab) {
      if (id !== tabId || info.status !== 'complete' || done) return;
      done = true; clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(tab);
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(function (t) {
      if (t.status === 'complete' && !done) {
        done = true; clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(t);
      }
    });
  });
}

OmniTabClient.prototype.request = async function (method, path, body) {
  if (!this.tabId) await this.ensureTab();
  var url = '/admin/' + path;
  var lastErr = '';
  for (var attempt = 0; attempt < this.attempts; attempt++) {
    var wait = this.minGapMs - (Date.now() - this.lastCall);
    if (wait > 0) await sleep(wait);
    this.lastCall = Date.now();
    this.calls++;
    var res;
    try {
      var out = await chrome.scripting.executeScript({
        target: { tabId: this.tabId }, func: omniInPageFetch, args: [method.toUpperCase(), url, body || null]
      });
      res = out && out[0] && out[0].result;
    } catch (e) {
      // Tab bị đóng / tải lại giữa chừng / trang lỗi mạng → chờ, mở lại tab rồi thử tiếp
      if (e && e.fatal) throw e;
      lastErr = e.message;
      this.tabId = null;
      await sleep(this.retryBaseMs * Math.pow(2, attempt));
      await this.ensureTab();
      continue;
    }
    if (!res) throw new Error('[omni] không nhận được phản hồi từ tab Omni');
    if (res.status === 401 || (res.redirected && this.isLoginUrl_(res.url)) || /^\s*</.test(res.text)) {
      throw FatalError('Phiên đăng nhập Sapo Omni đã hết hạn. Mở tab Sapo Omni và đăng nhập lại.', 'session');
    }
    if (res.status === 429 || res.status >= 500) { lastErr = 'HTTP ' + res.status; await sleep(this.retryBaseMs * Math.pow(2, attempt)); continue; }
    if (res.status === 403) throw FatalError('[omni] tài khoản đang đăng nhập không có quyền (HTTP 403): ' + res.text.slice(0, 200), 'permission');
    if (res.status >= 400) throw new Error('[omni] ' + method.toUpperCase() + ' ' + path + ' → HTTP ' + res.status + ': ' + res.text.slice(0, 300));
    if (!res.text) return {};
    try { return JSON.parse(res.text); }
    catch (e) { throw new Error('[omni] ' + path + ' không trả về JSON: ' + res.text.slice(0, 200)); }
  }
  throw FatalError('[omni] Không kết nối được Sapo Omni sau ' + this.attempts + ' lần thử (' + lastErr + '). ' +
                   'Kiểm tra mạng Internet và tab Sapo Omni.', 'network');
};

// ---------------------------------------------------------------------------
function WebClient(opts) {
  this.base = String(opts.base || '').replace(/\/+$/, '') + '/admin/';
  this.auth = 'Basic ' + btoa(String(opts.key || '') + ':' + String(opts.secret || ''));
  this.calls = 0;
  this.minGapMs = opts.minGapMs == null ? 350 : opts.minGapMs;
  this.lastCall = 0;
  this.retryBaseMs = opts.retryBaseMs == null ? 1500 : opts.retryBaseMs;
  this.attempts = opts.attempts || 5;
}

WebClient.prototype.request = async function (method, path, body) {
  var lastErr = '';
  for (var attempt = 0; attempt < this.attempts; attempt++) {
    var wait = this.minGapMs - (Date.now() - this.lastCall);
    if (wait > 0) await sleep(wait);
    this.lastCall = Date.now();
    this.calls++;
    var opt = { method: method.toUpperCase(), credentials: 'omit', redirect: 'manual',
                headers: { Authorization: this.auth, Accept: 'application/json' } };
    if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    var r;
    try { r = await fetch(this.base + path, opt); }
    catch (e) { lastErr = e.message; await sleep(this.retryBaseMs * Math.pow(2, attempt)); continue; }   // rớt mạng → thử lại
    var text = await r.text();
    if (r.status === 429 || r.status >= 500) { lastErr = 'HTTP ' + r.status; await sleep(this.retryBaseMs * Math.pow(2, attempt)); continue; }
    if (r.status === 401 || r.status === 403 || r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) {
      throw FatalError('[web] API key Sapo Web sai hoặc thiếu quyền (HTTP ' + r.status + ')', 'permission');
    }
    if (r.status >= 400) throw new Error('[web] ' + method.toUpperCase() + ' ' + path + ' → HTTP ' + r.status + ': ' + text.slice(0, 300));
    if (!text) return {};
    try { return JSON.parse(text); }
    catch (e) { throw new Error('[web] ' + path + ' không trả về JSON: ' + text.slice(0, 200)); }
  }
  throw FatalError('[web] Không kết nối được Sapo Web sau ' + this.attempts + ' lần thử (' + lastErr + '). ' +
                   'Kiểm tra mạng Internet và địa chỉ Sapo Web.', 'network');
};

// ---------- Dùng chung cho 2 cổng ----------
function attachCustomerMethods_(Client, name) {
  /** Đọc toàn bộ khách, tự lật trang, tự hạ số khách/trang, dừng nếu đọc thiếu */
  Client.prototype.listCustomers = async function () {
    var limit = 250, all = [], seen = {}, total = null;
    for (var page = 1; page <= 400; page++) {
      var path = 'customers.json?limit=' + limit + '&page=' + page;
      if (name === 'web') {
        path += '&fields=id,first_name,last_name,email,phone,tags,addresses,default_address,orders_count,created_on,modified_on';
      }
      var j;
      try { j = await this.request('get', path); }
      catch (e) {
        if (!e.fatal && page === 1 && limit === 250 && /HTTP 4(00|22)/.test(e.message)) { limit = 50; page = 0; continue; }
        throw e;
      }
      var list = j.customers || [];
      var fresh = 0;
      list.forEach(function (c) { if (!seen[c.id]) { seen[c.id] = true; all.push(c); fresh++; } });
      total = j.metadata && j.metadata.total != null ? j.metadata.total : null;
      if (!list.length || !fresh) break;
      if (total != null) { if (all.length >= total) break; }
      else if (list.length < limit) break;
    }
    var expected = total;
    if (expected == null) expected = (await this.request('get', 'customers/count.json')).count;
    if (expected != null && all.length < expected) {
      throw new Error('[' + name + '] chỉ đọc được ' + all.length + '/' + expected + ' khách, dừng để an toàn');
    }
    return all;
  };
  Client.prototype.countCustomers = async function () {
    var j = await this.request('get', 'customers.json?limit=1&page=1');
    if (j.metadata && j.metadata.total != null) return { total: j.metadata.total, sample: (j.customers || [])[0] };
    var c = await this.request('get', 'customers/count.json');
    return { total: c.count, sample: (j.customers || [])[0] };
  };
  Client.prototype.createCustomer = async function (payload) {
    return (await this.request('post', 'customers.json', payload)).customer;
  };
  Client.prototype.updateCustomer = async function (id, payload) {
    return (await this.request('put', 'customers/' + id + '.json', payload)).customer;
  };
  Client.prototype.deleteCustomer = async function (id) {
    return this.request('delete', 'customers/' + id + '.json');
  };
}
attachCustomerMethods_(OmniTabClient, 'omni');
attachCustomerMethods_(WebClient, 'web');
