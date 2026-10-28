/**
 * Core.js – logic đồng bộ thuần (không gọi mạng, không đọc Sheet).
 * Chạy được trong Google Apps Script và trong Node (để kiểm thử).
 *
 * Ý tưởng:
 *  - Mỗi khách được quy về "bản chuẩn" (canonical): tên, SĐT, email, địa chỉ.
 *  - Khách 2 bên được ghép theo SĐT, sau đó đến email.
 *  - Bảng ghép (rows) lưu cặp Omni ↔ Web và mã băm của lần đồng bộ cuối ở mỗi bên.
 *  - Mỗi lần chạy, plan() so sánh dữ liệu hiện tại với bảng ghép và trả về
 *    danh sách hành động (actions). Main.js mới là nơi thực thi.
 */
var SyncCore = (function () {
  var FIELDS = ['name', 'phone', 'email', 'address'];
  var RETRY_FAILED_MS = 24 * 3600 * 1000;

  // ---------- Chuẩn hóa ----------
  function normText(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  /** Đưa SĐT về dạng 0xxxxxxxxx để so sánh */
  function normPhone(p) {
    var s = String(p == null ? '' : p).replace(/\D/g, '');
    if (s.indexOf('84') === 0 && s.length >= 11) s = '0' + s.slice(2); // +84 / 84 → 0
    if (s.length === 9 && s.charAt(0) !== '0') s = '0' + s;            // mất số 0 đầu do Excel
    return s.length >= 9 && s.length <= 11 ? s : '';
  }

  /** Dạng quốc tế +84… để ghi lên Sapo Web */
  function intlPhone(p) {
    var s = normPhone(p);
    return s ? '+84' + s.slice(1) : '';
  }

  function normEmail(e) {
    var s = normText(e).toLowerCase();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : '';
  }

  function ts(s) {
    var t = Date.parse(s);
    return isNaN(t) ? 0 : t;
  }

  // ---------- Đọc bản ghi từ 2 hệ thống ----------
  function pickAddress(list) {
    if (!list || !list.length) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && (list[i]['default'] === true || list[i].primary === true)) return list[i];
    }
    for (var j = 0; j < list.length; j++) {
      if (list[j] && (!list[j].status || list[j].status === 'active')) return list[j];
    }
    return list[0];
  }

  /** Khách Sapo Omni (mysapogo.com) → bản chuẩn */
  function fromOmni(c) {
    var addr = pickAddress(c.addresses);
    return {
      side: 'omni',
      id: String(c.id),
      code: c.code || '',
      name: normText(c.name),
      phone: normPhone(c.phone_number || (addr && addr.phone_number)),
      email: normEmail(c.email),
      address: normText(addr && addr.address1),
      addressId: addr && addr.id ? String(addr.id) : '',
      groupId: c.customer_group_id != null ? String(c.customer_group_id) : '',
      orders: Number((c.sale_order && c.sale_order.order_purchases) || 0),
      created: c.created_on || '',
      modified: c.modified_on || c.created_on || '',
      active: !c.status || c.status === 'active'
    };
  }

  /** Khách Sapo Web (mysapo.net) → bản chuẩn */
  function fromWeb(c) {
    var addr = c.default_address || pickAddress(c.addresses);
    return {
      side: 'web',
      id: String(c.id),
      // Hệ thống ghi cả tên vào first_name. Khách tự đăng ký có thể tách họ (last_name) / tên.
      name: normText([c.last_name, c.first_name].filter(Boolean).join(' ')),
      phone: normPhone(c.phone || (addr && addr.phone)),
      email: normEmail(c.email),
      address: normText(addr && addr.address1),
      addressId: addr && addr.id ? String(addr.id) : '',
      tags: String(c.tags || ''),
      orders: Number(c.orders_count || 0),
      created: c.created_on || '',
      modified: c.modified_on || c.created_on || ''
    };
  }

  // ---------- Băm & khóa ghép ----------
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return 'h' + ('0000000' + h.toString(16)).slice(-8);   // tiền tố chữ: Sheet không hiểu nhầm là số
  }

  /** Mã băm chỉ tính trên các trường được đồng bộ */
  function hashOf(r) {
    return fnv1a(JSON.stringify([r.name.toLowerCase(), r.phone, r.email, r.address.toLowerCase()]));
  }

  /** Khóa ghép theo thứ tự ưu tiên: SĐT → email */
  function keysOf(r) {
    var k = [];
    if (r.phone) k.push('p:' + r.phone);
    if (r.email) k.push('e:' + r.email);
    return k;
  }

  /** Gộp khi ghép lần đầu: lấy Omni làm chuẩn, trường Omni trống thì giữ giá trị Web */
  function mergeForLink(o, w) {
    var m = {};
    for (var k in o) m[k] = o[k];
    FIELDS.forEach(function (f) { if (!o[f] && w[f]) m[f] = w[f]; });
    return m;
  }

  /** Liệt kê trường khác nhau: [{field, from, to}] */
  function diff(from, to) {
    return FIELDS.filter(function (f) { return (from[f] || '') !== (to[f] || ''); })
      .map(function (f) { return { field: f, from: from[f] || '', to: to[f] || '' }; });
  }

  // ---------- Lập kế hoạch ----------
  /**
   * @param {Object} input
   *   omni: [raw Omni customer], web: [raw Web customer]
   *   rows: [{omni_id, web_id, status, hash_o, hash_w, linked_at, first_seen}]
   *   now: ISO string
   *   cfg: {maxCreate, pendingTimeoutMin, deleteEcho, skipOmniGroupIds: []}
   * @return {{actions: Array, stats: Object}}
   */
  function plan(input) {
    var cfg = input.cfg || {};
    var now = input.now || new Date().toISOString();
    var maxCreate = cfg.maxCreate == null ? 20 : cfg.maxCreate;
    var timeoutMs = (cfg.pendingTimeoutMin == null ? 30 : cfg.pendingTimeoutMin) * 60000;
    var skipGroups = {};
    (cfg.skipOmniGroupIds || []).forEach(function (g) { skipGroups[String(g)] = true; });

    var O = {}, W = {};
    (input.omni || []).forEach(function (c) { var r = fromOmni(c); O[r.id] = r; });
    (input.web || []).forEach(function (c) { var r = fromWeb(c); W[r.id] = r; });

    var claimedO = {}, claimedW = {};
    var pendingByWeb = {};
    var pairIndex = {};      // khóa → thông tin cặp đã ghép (để nhận diện bản dội / bản trùng)
    var actions = [];
    var stats = { pairs: 0, unchanged: 0, o2w: 0, w2o: 0, conflicts: 0, linked: 0,
                  createdWeb: 0, createdOmni: 0, echoes: 0, dups: 0, pending: 0,
                  orphans: 0, skipped: 0, deferred: 0 };
    var budget = maxCreate;

    function indexPair(o, w, linkedAt) {
      // Mốc nhận diện bản dội: Sapo sinh bản dội ngay khi khách Web xuất hiện,
      // nên lấy mốc sớm hơn giữa lúc ghép và lúc khách Web được tạo.
      var since = linkedAt || '';
      if (w && w.created && (!since || ts(w.created) < ts(since))) since = w.created;
      var info = { omni_id: o ? o.id : '', web_id: w ? w.id : '', linked_at: linkedAt || '', echo_since: since };
      [o, w].forEach(function (r) {
        if (!r) return;
        keysOf(r).forEach(function (k) { if (!pairIndex[k]) pairIndex[k] = info; });
      });
    }

    // A. Các dòng đã có trong bảng ghép
    (input.rows || []).forEach(function (row) {
      var st = row.status;
      if (st === 'pair') {
        var o = O[row.omni_id], w = W[row.web_id];
        if (row.omni_id) claimedO[row.omni_id] = true;
        if (row.web_id) claimedW[row.web_id] = true;
        if (!o || !w) {
          stats.orphans++;
          actions.push({ type: 'orphan', omni_id: row.omni_id, web_id: row.web_id,
                         missing: !o ? 'omni' : 'web' });
          return;
        }
        stats.pairs++;
        indexPair(o, w, row.linked_at);
        var ho = hashOf(o), hw = hashOf(w);
        // Mỗi bên có mã băm riêng của lần đồng bộ cuối → biết bên nào vừa sửa,
        // kể cả khi Sapo tự định dạng lại dữ liệu sau khi ghi.
        var oChanged = ho !== row.hash_o, wChanged = hw !== row.hash_w;
        if (!oChanged && !wChanged) { stats.unchanged++; return; }
        if (ho === hw) {
          stats.unchanged++;
          actions.push({ type: 'set_hash', omni_id: o.id, web_id: w.id, hash_o: ho, hash_w: hw });
          return;
        }
        var dir;
        if (oChanged && !wChanged) dir = 'o2w';
        else if (wChanged && !oChanged) dir = 'w2o';
        else { dir = ts(o.modified) >= ts(w.modified) ? 'o2w' : 'w2o'; stats.conflicts++; }
        var conflict = oChanged && wChanged;
        if (dir === 'o2w') { stats.o2w++; actions.push({ type: 'push_o2w', omni: o, web: w, conflict: conflict }); }
        else { stats.w2o++; actions.push({ type: 'push_w2o', omni: o, web: w, conflict: conflict }); }
      } else if (st === 'pending_web') {
        pendingByWeb[row.web_id] = row;
      } else if (st === 'create_failed') {
        // Tạo khách bị Sapo từ chối: tạm gác 24 giờ để không chiếm suất tạo mới của khách khác
        if (ts(now) - ts(row.updated_at) < RETRY_FAILED_MS) {
          if (row.omni_id) claimedO[row.omni_id] = true;
          if (row.web_id) claimedW[row.web_id] = true;
        } else if (row.web_id && !row.omni_id) {
          pendingByWeb[row.web_id] = { first_seen: '1970-01-01T00:00:00Z' };   // thử tạo lại ngay
        }
      } else {
        // echo / dup / echo_deleted / dup_web / orphan: đã xử lý, chỉ giữ chỗ
        if (row.omni_id) claimedO[row.omni_id] = true;
        if (row.web_id) claimedW[row.web_id] = true;
      }
    });

    // Dòng chờ mà khách Web đã bị xóa
    Object.keys(pendingByWeb).forEach(function (wid) {
      if (!W[wid]) actions.push({ type: 'drop_row', web_id: wid });
    });

    // Chỉ mục mọi khách Omni chưa ghép có SĐT/email (kể cả nhóm bị loại, kể cả ngừng hoạt động),
    // để khách Web luôn tìm được bản tương ứng và không bị tạo trùng bên Omni.
    var freeOmniByKey = {};
    Object.keys(O).forEach(function (id) {
      if (claimedO[id]) return;
      keysOf(O[id]).forEach(function (k) { (freeOmniByKey[k] = freeOmniByKey[k] || []).push(O[id]); });
    });

    function pickMaster(list) {
      // Ưu tiên: đang hoạt động → nhiều đơn hơn → tạo sớm hơn
      return list.slice().sort(function (a, b) {
        if (a.active !== b.active) return a.active ? -1 : 1;
        if (b.orders !== a.orders) return b.orders - a.orders;
        return ts(a.created) - ts(b.created);
      })[0];
    }

    function byCreated(a, b) { return ts(a.created) - ts(b.created) || (a.id < b.id ? -1 : 1); }

    // B. Khách Web chưa ghép → tìm khách Omni tương ứng
    Object.keys(W).map(function (id) { return W[id]; }).sort(byCreated).forEach(function (w) {
      if (claimedW[w.id]) return;
      var keys = keysOf(w);
      var cands = [];
      keys.forEach(function (k) {
        (freeOmniByKey[k] || []).forEach(function (o) {
          if (!claimedO[o.id] && cands.indexOf(o) < 0) cands.push(o);
        });
      });
      if (cands.length) {
        var o = pickMaster(cands);
        claimedO[o.id] = true; claimedW[w.id] = true;
        indexPair(o, w, now);
        stats.linked++;
        var merged = mergeForLink(o, w);
        actions.push({ type: 'link', omni: o, web: w, merged: merged,
                       pushWeb: hashOf(merged) !== hashOf(w),
                       pushOmni: hashOf(merged) !== hashOf(o) });
        return;
      }
      // Trùng với một cặp đã có (2 tài khoản Web cùng SĐT/email)
      for (var i = 0; i < keys.length; i++) {
        if (pairIndex[keys[i]]) {
          claimedW[w.id] = true; stats.dups++;
          actions.push({ type: 'mark_web_dup', web: w, pair: pairIndex[keys[i]] });
          return;
        }
      }
      if (!keys.length) { stats.skipped++; return; }
      var pend = pendingByWeb[w.id];
      if (!pend) {
        stats.pending++;
        actions.push({ type: 'pending', web: w });
      } else if (ts(now) - ts(pend.first_seen) >= timeoutMs) {
        // Bộ kết nối Sapo không tự tạo khách bên Omni → hệ thống tự tạo
        if (budget > 0) {
          budget--; stats.createdOmni++;
          claimedW[w.id] = true;
          indexPair(null, w, now);
          actions.push({ type: 'create_omni', web: w });
        } else stats.deferred++;
      } else {
        stats.pending++;
      }
    });

    // C. Khách Omni chưa ghép → bản dội / bản trùng / tạo mới trên Web
    Object.keys(O).map(function (id) { return O[id]; }).sort(byCreated).forEach(function (o) {
      if (claimedO[o.id]) return;
      var keys = keysOf(o);
      if (!keys.length) { stats.skipped++; return; }
      // Kiểm tra bản dội TRƯỚC khi lọc nhóm: bản dội thường rơi vào nhóm mặc định
      for (var i = 0; i < keys.length; i++) {
        var p = pairIndex[keys[i]];
        if (p && p.omni_id !== o.id) {
          claimedO[o.id] = true;
          // Bản dội: Sapo tự sinh SAU khi có khách Web. Bản trùng cũ: có từ trước.
          var isEcho = !!p.echo_since && ts(o.created) >= ts(p.echo_since);
          if (isEcho) stats.echoes++; else stats.dups++;
          actions.push({ type: 'mark_echo', omni: o, pair: p, echo: isEcho,
                         deletable: isEcho && !!cfg.deleteEcho && o.orders === 0 });
          return;
        }
      }
      if (!o.active || skipGroups[o.groupId]) { stats.skipped++; return; }
      if (budget <= 0) { stats.deferred++; return; }
      budget--; stats.createdWeb++;
      claimedO[o.id] = true;
      indexPair(o, null, now);
      actions.push({ type: 'create_web', omni: o });
    });

    return { actions: actions, stats: stats };
  }

  // ---------- Dựng dữ liệu gửi lên API ----------
  /** Giữ nguyên tag của khách, chỉ thay tag omni:<mã KH> */
  function mergeWebTags(oldTags, omniCode) {
    var keep = String(oldTags || '').split(',').map(function (t) { return t.trim(); })
      .filter(function (t) { return t && !/^omni\s*:/i.test(t); });
    if (omniCode) keep.push('omni:' + omniCode);
    return keep.join(', ');
  }

  /** Bản chuẩn (nguồn) → payload Sapo Web. existing = bản Web hiện có (khi cập nhật) */
  function toWebPayload(src, existing) {
    var phone = intlPhone(src.phone);
    var c = {
      first_name: src.name,
      last_name: '',
      phone: phone || null,
      email: src.email || null
    };
    var tags = mergeWebTags(existing ? existing.tags : '', src.code || '');
    if (!existing || tags !== existing.tags) c.tags = tags;
    if (src.address || phone) {
      var a = { address1: src.address || '', phone: phone, country: 'Vietnam',
                first_name: src.name, last_name: '' };
      if (existing && existing.addressId) a.id = Number(existing.addressId);
      c.addresses = [a];
    }
    if (existing) c.id = Number(existing.id);
    return { customer: c };
  }

  /** Bản chuẩn (nguồn) → payload Sapo Omni. existing = bản Omni hiện có (khi cập nhật) */
  function toOmniPayload(src, existing) {
    var c = {
      name: src.name,
      phone_number: src.phone || null,
      email: src.email || null
    };
    if (src.address || src.phone) {
      var a = { address1: src.address || '', phone_number: src.phone || '', country: 'Việt Nam' };
      if (existing && existing.addressId) a.id = Number(existing.addressId);
      c.addresses = [a];
    }
    if (existing) c.id = Number(existing.id);
    return { customer: c };
  }

  return {
    FIELDS: FIELDS,
    normPhone: normPhone, intlPhone: intlPhone, normEmail: normEmail, normText: normText,
    fromOmni: fromOmni, fromWeb: fromWeb, hashOf: hashOf, keysOf: keysOf, diff: diff,
    mergeForLink: mergeForLink, plan: plan, toWebPayload: toWebPayload, toOmniPayload: toOmniPayload,
    mergeWebTags: mergeWebTags
  };
})();

if (typeof module !== 'undefined') module.exports = SyncCore;
