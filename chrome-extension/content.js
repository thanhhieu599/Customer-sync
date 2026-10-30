/**
 * content.js – chạy trên trang quản trị Sapo Web.
 * Gắn khung "Khách hàng từ Sapo Omni" cạnh ô "Tìm kiếm khách hàng…" (trang tạo / sửa đơn hàng, đơn nháp).
 * Tìm trong bản sao danh sách Omni mà tiện ích đã lưu → gõ phím không gửi lệnh nào tới Omni.
 */
(function () {
  if (window.__dtOmniSuggest) return;
  window.__dtOmniSuggest = true;

  var SELECTOR = 'input[placeholder*="m kiếm khách hàng"], input[placeholder*="m kiem khach hang"]';
  var panel = null, input = null, items = [], active = -1, timer = null, seq = 0, canCreate = false;

  function send(msg) {
    return new Promise(function (res) {
      try { chrome.runtime.sendMessage(msg, function (r) { res(r || { ok: false, error: 'Tiện ích không phản hồi' }); }); }
      catch (e) { res({ ok: false, error: 'Tiện ích vừa được cập nhật – tải lại trang (F5)' }); }
    });
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function ensurePanel() {
    if (panel) return panel;
    panel = el('div', 'dt-omni-panel');
    panel.setAttribute('data-dt-omni', '1');
    panel.hidden = true;
    // Bấm vào khung không làm ô tìm kiếm mất tiêu điểm
    panel.addEventListener('mousedown', function (e) { e.preventDefault(); });
    document.body.appendChild(panel);
    window.addEventListener('resize', place, true);
    window.addEventListener('scroll', place, true);
    return panel;
  }

  /** Đặt khung bên TRÁI ô tìm kiếm (không che danh sách gợi ý của Sapo); thiếu chỗ thì đặt phía dưới */
  function place() {
    if (!panel || panel.hidden || !input) return;
    var r = input.getBoundingClientRect();
    var w = 380;
    if (r.left - w - 12 >= 8) { panel.style.left = (r.left - w - 12) + 'px'; panel.style.top = r.top + 'px'; }
    else { panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px'; panel.style.top = (r.bottom + 260) + 'px'; }
  }

  function header(sub) {
    var h = el('div', 'dt-omni-head');
    var t = el('span', null, 'Khách hàng từ Sapo Omni ');
    t.appendChild(el('small', null, sub || ''));
    var x = el('button', 'dt-omni-close', '×');
    x.title = 'Đóng';
    x.addEventListener('click', hide);
    h.appendChild(t); h.appendChild(x);
    return h;
  }

  function showMessage(text, kind) {
    ensurePanel();
    panel.textContent = '';
    panel.appendChild(header('D&T Sapo Sync'));
    panel.appendChild(el('div', 'dt-omni-msg' + (kind ? ' dt-' + kind : ''), text));
    panel.hidden = false; place();
  }

  function render(list, q) {
    ensurePanel();
    items = list; active = -1;
    panel.textContent = '';
    panel.appendChild(header(list.length ? list.length + ' kết quả · ↑↓ Enter để chọn' : ''));
    if (!list.length) {
      panel.appendChild(el('div', 'dt-omni-msg', 'Không thấy khách Omni nào khớp "' + q + '".'));
    }
    list.forEach(function (it, i) {
      var row = el('div', 'dt-omni-item');
      var name = el('div', 'dt-omni-name', it.name || '(không tên)');
      name.appendChild(el('span', 'dt-omni-badge ' + (it.web_id ? 'dt-on' : 'dt-off'), it.web_id ? 'Đã có trên Web' : 'Chưa có trên Web'));
      row.appendChild(name);
      row.appendChild(el('div', 'dt-omni-sub', [it.phone, it.email].filter(Boolean).join(' · ') || 'Chưa có SĐT/email'));
      row.appendChild(el('div', 'dt-omni-sub', 'Mã ' + (it.code || '—') + ' · ' + it.orders + ' đơn' + (it.address ? ' · ' + it.address : '')));
      row.addEventListener('click', function () { choose(i); });
      panel.appendChild(row);
    });
    panel.hidden = false; place();
  }

  function hide() { if (panel) panel.hidden = true; }

  function highlight(i) {
    var rows = panel ? panel.querySelectorAll('.dt-omni-item') : [];
    rows.forEach(function (r, k) { r.classList.toggle('dt-active', k === i); });
    if (rows[i]) rows[i].scrollIntoView({ block: 'nearest' });
    active = i;
  }

  /** Điền giá trị vào ô tìm kiếm của Sapo như người dùng gõ, để Sapo tự hiện khách tương ứng */
  function typeIntoSapo(value) {
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, value);
    ['input', 'keydown', 'keyup', 'change'].forEach(function (t) {
      var ev = t.indexOf('key') === 0 ? new KeyboardEvent(t, { bubbles: true, key: 'a' }) : new Event(t, { bubbles: true });
      input.dispatchEvent(ev);
    });
  }

  async function choose(i) {
    var it = items[i];
    if (!it) return;
    if (it.web_id) {
      typeIntoSapo(it.web_phone || it.phone || it.web_email || it.email);
      showMessage('Đã điền "' + (it.web_phone || it.phone || it.web_email || it.email) + '" – chọn "' + it.name +
                  '" trong danh sách của Sapo ngay bên phải.', 'ok');
      return;
    }
    if (!canCreate) {
      showMessage('"' + it.name + '" chưa có trên Sapo Web. Bấm "Thêm mới khách hàng" của Sapo và nhập SĐT ' +
                  (it.phone || '(chưa có)') + (it.email ? ', email ' + it.email : '') + ' giống trên Omni.', 'err');
      return;
    }
    if (!it.phone && !it.email) { showMessage('Khách này chưa có SĐT hoặc email trên Omni. Bổ sung trên Omni trước để tránh tạo trùng.', 'err'); return; }
    if (!confirm('Tạo khách "' + it.name + '" trên Sapo Web từ dữ liệu Sapo Omni?\n\n' +
                 [it.phone, it.email, it.address].filter(Boolean).join('\n'))) return;
    showMessage('Đang tạo khách trên Sapo Web…');
    var r = await send({ cmd: 'pushOmniToWeb', omniId: it.omni_id });
    if (!r.ok) { showMessage('Không tạo được: ' + r.error, 'err'); return; }
    var key = r.phone || r.email;
    // Chờ Sapo cập nhật chỉ mục tìm kiếm một chút rồi mới điền
    setTimeout(function () { typeIntoSapo(key); }, 1200);
    showMessage((r.created ? 'Đã tạo' : 'Đã có sẵn') + ' khách "' + it.name + '" trên Sapo Web. Đang điền "' + key +
                '" – chọn khách trong danh sách của Sapo. (Nếu chưa hiện, gõ lại SĐT sau vài giây.)', 'ok');
  }

  async function search() {
    var q = input.value.trim();
    if (q.length < 2) { hide(); return; }
    var my = ++seq;
    var r = await send({ cmd: 'searchOmni', q: q, limit: 8 });
    if (my !== seq) return;                       // đã gõ tiếp, bỏ kết quả cũ
    if (!r.ok) { showMessage(r.error, 'err'); return; }
    canCreate = !!r.canCreate;
    if (!r.ready) { showMessage('Chưa có danh sách khách Omni. Mở tiện ích D&T Sapo Sync → Cài đặt → "Quét toàn bộ ngay".', 'err'); return; }
    render(r.items, q);
  }

  function attach(inp) {
    if (inp.getAttribute('data-dt-omni')) return;
    inp.setAttribute('data-dt-omni', '1');
    inp.addEventListener('input', function (e) {
      if (!e.isTrusted) return;                   // bỏ qua giá trị do chính tiện ích điền
      input = inp; clearTimeout(timer); timer = setTimeout(search, 200);
    });
    inp.addEventListener('focus', function () { input = inp; if (inp.value.trim().length >= 2 && items.length) { panel.hidden = false; place(); } });
    inp.addEventListener('blur', function () { setTimeout(function () { if (document.activeElement !== inp) hide(); }, 250); });
    inp.addEventListener('keydown', function (e) {
      if (!panel || panel.hidden || !items.length || !e.isTrusted) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); highlight(Math.min(items.length - 1, active + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(Math.max(0, active - 1)); }
      else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); e.stopPropagation(); choose(active); }
      else if (e.key === 'Escape') hide();
    }, true);
  }

  // Sapo Web là ứng dụng 1 trang: ô tìm kiếm xuất hiện/biến mất khi chuyển trang → theo dõi liên tục
  function scan() { document.querySelectorAll(SELECTOR).forEach(attach); }
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
