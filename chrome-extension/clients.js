/**
 * clients.js – cổng kết nối Sapo cho tiện ích Chrome.
 *  - OmniTabClient: gửi lệnh qua tab Sapo Omni đang đăng nhập (dùng phiên đăng nhập, không cần API key)
 *  - WebClient:     gọi API Sapo Web bằng API key
 *
 * NGUYÊN TẮC BẢO VỆ SAPO OMNI (rút ra sau sự cố Omni chậm/sập tạm thời khi chạy thử):
 *  1. Giãn cách tối thiểu 1,5 giây giữa 2 lệnh Omni (nhẹ hơn một nhân viên thao tác).
 *  2. Mỗi lệnh chờ tối đa 30 giây, quá thì hủy.
 *  3. Thấy Omni quá tải (429 / 5xx / quá thời gian) 2 lần trong 1 lượt → DỪNG NGAY, không thử dồn dập.
 *  4. Giới hạn số lệnh GHI lên Omni mỗi lượt; phần còn lại để lượt sau.
 *  5. Đọc danh sách theo trang nhỏ (50 khách), chỉ đọc khách THAY ĐỔI (modified_on_min) khi có thể.
 */

/** Lỗi nghiêm trọng: dừng cả lượt. kind: session | overload | network | permission | budget */
function FatalError(message, kind) {
  var e = new Error(message);
  e.fatal = true;
  e.kind = kind || 'fatal';
  return e;
}

function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

/** Hàm chạy BÊN TRONG tab Omni (giống hệt lệnh anh đã chạy ở Console). Không dùng biến bên ngoài. */
async function omniInPageFetch(method, url, body, timeoutMs) {
  var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
  try {
    var opt = { method: method, credentials: 'include', headers: { 'Accept': 'application/json' } };
    if (ctrl) opt.signal = ctrl.signal;
    if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    var r = await fetch(url, opt);
    return { status: r.status, redirected: !!r.redirected, url: r.url || '', text: await r.text() };
  } catch (e) {
    return { status: 0, timeout: !!(e && e.name === 'AbortError'), error: String(e && e.message || e), text: '' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
function OmniTabClient(opts) {
  this.base = String(opts.base || '').replace(/\/+$/, '');
  this.host = this.base.replace(/^https?:\/\//, '');
  this.tabId = null;
  this.calls = 0;
  this.minGapMs = opts.minGapMs == null ? 1500 : opts.minGapMs;
  this.timeoutMs = opts.timeoutMs || 30000;
  this.lastCall = 0;
  this.retryWaitMs = opts.retryWaitMs == null ? 10000 : opts.retryWaitMs;
  this.maxOverload = opts.maxOverload || 2;     // số lần quá tải cho phép trong 1 lượt
  this.overloadHits = 0;
  this.maxWrites = opts.maxWrites || 60;         // trần số lệnh GHI lên Omni mỗi lượt
  this.writes = 0;
  this.pageSize = opts.pageSize || 50;
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

OmniTabClient.prototype.overload_ = function (why) {
  this.overloadHits++;
  if (this.overloadHits >= this.maxOverload) {
    throw FatalError('Sapo Omni đang phản hồi chậm hoặc lỗi (' + why + '). Tiện ích dừng ngay để không làm Omni nặng thêm ' +
                     'và sẽ tạm nghỉ trước khi thử lại.', 'overload');
  }
};

OmniTabClient.prototype.request = async function (method, path, body) {
  if (!this.tabId) await this.ensureTab();
  var url = '/admin/' + path;
  for (var attempt = 0; attempt < 2; attempt++) {
    if (method.toLowerCase() !== 'get' && attempt === 0) {
      if (this.writes >= this.maxWrites) {
        throw FatalError('Đã dùng hết ' + this.maxWrites + ' lệnh ghi Omni cho lượt này, phần còn lại để lượt sau.', 'budget');
      }
      this.writes++;
    }
    var wait = this.minGapMs - (Date.now() - this.lastCall);
    if (wait > 0) await sleep(wait);
    this.lastCall = Date.now();
    this.calls++;
    var res;
    try {
      var out = await chrome.scripting.executeScript({
        target: { tabId: this.tabId }, func: omniInPageFetch,
        args: [method.toUpperCase(), url, body || null, this.timeoutMs]
      });
      res = out && out[0] && out[0].result;
    } catch (e) {
      // Tab bị đóng / đang tải lại / trang lỗi mạng → mở lại tab 1 lần
      if (attempt === 0) { this.tabId = null; await sleep(this.retryWaitMs); await this.ensureTab(); continue; }
      throw FatalError('[omni] Không gửi được lệnh qua tab Sapo Omni (' + e.message + '). Kiểm tra mạng và tab Omni.', 'network');
    }
    if (!res) throw FatalError('[omni] Không nhận được phản hồi từ tab Sapo Omni', 'network');
    if (res.status === 0) {                                   // quá thời gian / rớt mạng
      this.overload_(res.timeout ? 'quá ' + Math.round(this.timeoutMs / 1000) + ' giây không phản hồi' : res.error);
      await sleep(this.retryWaitMs); continue;
    }
    if (res.status === 401 || (res.redirected && this.isLoginUrl_(res.url)) || /^\s*</.test(res.text)) {
      throw FatalError('Phiên đăng nhập Sapo Omni đã hết hạn. Mở tab Sapo Omni và đăng nhập lại.', 'session');
    }
    if (res.status === 429 || res.status >= 500) {
      this.overload_('HTTP ' + res.status);
      await sleep(this.retryWaitMs); continue;
    }
    if (res.status === 403) throw FatalError('[omni] Tài khoản đang đăng nhập không có quyền (HTTP 403): ' + res.text.slice(0, 200), 'permission');
    if (res.status >= 400) throw new Error('[omni] ' + method.toUpperCase() + ' ' + path + ' → HTTP ' + res.status + ': ' + res.text.slice(0, 300));
    if (!res.text) return {};
    try { return JSON.parse(res.text); }
    catch (e) { throw new Error('[omni] ' + path + ' không trả về JSON: ' + res.text.slice(0, 200)); }
  }
  throw FatalError('[omni] Sapo Omni không phản hồi ổn định, dừng lượt này.', 'overload');
};

// ---------------------------------------------------------------------------
function WebClient(opts) {
  this.base = String(opts.base || '').replace(/\/+$/, '') + '/admin/';
  this.auth = 'Basic ' + btoa(String(opts.key || '') + ':' + String(opts.secret || ''));
  this.calls = 0;
  this.minGapMs = opts.minGapMs == null ? 600 : opts.minGapMs;   // Sapo Web: tối đa ~2 lệnh/giây
  this.timeoutMs = opts.timeoutMs || 30000;
  this.lastCall = 0;
  this.retryWaitMs = opts.retryWaitMs == null ? 5000 : opts.retryWaitMs;
  this.attempts = opts.attempts || 3;
  this.pageSize = opts.pageSize || 250;
}

WebClient.prototype.request = async function (method, path, body) {
  var lastErr = '';
  for (var attempt = 0; attempt < this.attempts; attempt++) {
    var wait = this.minGapMs - (Date.now() - this.lastCall);
    if (wait > 0) await sleep(wait);
    this.lastCall = Date.now();
    this.calls++;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, this.timeoutMs) : null;
    var opt = { method: method.toUpperCase(), credentials: 'omit', redirect: 'manual',
                headers: { Authorization: this.auth, Accept: 'application/json' } };
    if (ctrl) opt.signal = ctrl.signal;
    if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    var r, text;
    try { r = await fetch(this.base + path, opt); text = await r.text(); }
    catch (e) { lastErr = e.message; if (timer) clearTimeout(timer); await sleep(this.retryWaitMs * (attempt + 1)); continue; }
    if (timer) clearTimeout(timer);
    if (r.status === 429 || r.status >= 500) { lastErr = 'HTTP ' + r.status; await sleep(this.retryWaitMs * (attempt + 1)); continue; }
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
  /**
   * Đọc danh sách khách, tự lật trang.
   * opts.since (ISO): chỉ lấy khách thay đổi từ thời điểm này (modified_on_min).
   * Trả về { list, honored }: honored = false nếu Sapo bỏ qua bộ lọc thời gian (trả cả khách cũ).
   */
  Client.prototype.listCustomers = async function (opts) {
    opts = opts || {};
    var limit = this.pageSize, all = [], seen = {}, total = null;
    var since = opts.since ? new Date(opts.since).toISOString().replace(/\.\d{3}Z$/, 'Z') : '';
    for (var page = 1; page <= 400; page++) {
      var path = 'customers.json?limit=' + limit + '&page=' + page;
      if (since) path += '&modified_on_min=' + encodeURIComponent(since);
      if (name === 'web') {
        path += '&fields=id,first_name,last_name,email,phone,tags,addresses,default_address,orders_count,created_on,modified_on';
      }
      var j = await this.request('get', path);
      var list = j.customers || [];
      var fresh = 0;
      list.forEach(function (c) { if (!seen[c.id]) { seen[c.id] = true; all.push(c); fresh++; } });
      total = j.metadata && j.metadata.total != null ? j.metadata.total : null;
      if (!list.length || !fresh) break;
      if (total != null) { if (all.length >= total) break; }
      else if (list.length < limit) break;
      // Đọc lọc theo thời gian mà trang đầu đã có khách cũ → Sapo bỏ qua bộ lọc: dừng sớm, không đọc hết
      if (since && page === 1 && !honored_(all, since)) return { list: all, honored: false, partial: true };
    }
    if (!since) {
      var expected = total;
      if (expected == null) expected = (await this.request('get', 'customers/count.json')).count;
      if (expected != null && all.length < expected) {
        throw new Error('[' + name + '] chỉ đọc được ' + all.length + '/' + expected + ' khách, dừng để an toàn');
      }
    }
    return { list: all, honored: since ? honored_(all, since) : true };
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
  Client.prototype.hasOrders = async function (id) {
    var j = await this.request('get', 'orders.json?customer_id=' + id + '&limit=1&page=1');
    var total = j.metadata && j.metadata.total != null ? j.metadata.total : (j.orders || []).length;
    return total > 0;
  };
}

/** Sapo có tôn trọng bộ lọc "chỉ khách thay đổi từ thời điểm since" không (cho phép lệch 2 phút) */
function honored_(list, since) {
  var min = Date.parse(since) - 120000;
  return list.every(function (c) { var t = Date.parse(c.modified_on || c.created_on || ''); return !isNaN(t) && t >= min; });
}

attachCustomerMethods_(OmniTabClient, 'omni');
attachCustomerMethods_(WebClient, 'web');
