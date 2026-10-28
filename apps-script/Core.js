/**
 * Core.js – logic đồng bộ thuần (không gọi mạng, không đọc Sheet).
 * Chạy được trong Google Apps Script và trong Node (để kiểm thử).
 *
 * Ý tưởng:
 *  - Mỗi khách được quy về "bản chuẩn" (canonical): tên, SĐT, email, MST, địa chỉ.
 *  - Bảng ghép (rows) lưu cặp Omni ↔ Web và mã băm (hash) của lần đồng bộ cuối.
 *  - Mỗi lần chạy, plan() so sánh dữ liệu hiện tại với bảng ghép và trả về
 *    danh sách hành động (actions). Main.js mới là nơi thực thi.
 */
var SyncCore = (function () {
  // ---------- Chuẩn hóa ----------
  function normText(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function normPhone(p) {
    var s = String(p == null ? '' : p).replace(/\D/g, '');
    if (s.indexOf('84') === 0 && s.length >= 11) s = '0' + s.slice(2); // +84 / 84 → 0
    if (s.length === 9 && s.charAt(0) !== '0') s = '0' + s;            // mất số 0 đầu do Excel
    return s.length >= 9 ? s : '';
  }

  function normEmail(e) {
    var s = normText(e).toLowerCase();
    return s.indexOf('@') > 0 ? s : '';
  }

  function normTax(t) {
    // MST Việt Nam: 10 số, chi nhánh dạng 0312345678-001
    var s = String(t == null ? '' : t).replace(/[^\d-]/g, '').replace(/^-+|-+$/g, '');
    return s.replace(/\D/g, '').length >= 10 ? s : '';
  }

  // ---------- Đọc bản ghi từ 2 hệ thống ----------
  function firstAddress(list) {
    if (!list || !list.length) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && (list[i]['default'] || list[i].primary === true)) return list[i];
    }
    for (var j = 0; j < list.length; j++) {
      if (list[j] && (!list[j].status || list[j].status === 'active')) return list[j];
    }
    return list[0];
  }

  /** Khách Sapo Omni (mysapogo.com) → bản chuẩn */
  function fromOmni(c) {
    var addr = firstAddress(c.addresses);
    return {
      side: 'omni',
      id: String(c.id),
      code: c.code || '',
      name: normText(c.name),
      phone: normPhone(c.phone_number || (addr && addr.phone_number)),
      email: normEmail(c.email),
      tax: normTax(c.tax_number),
      address: normText(addr && addr.address1),
      addressId: addr && addr.id ? String(addr.id) : '',
      groupId: c.customer_group_id != null ? String(c.customer_group_id) : '',
      orders: Number((c.sale_order && c.sale_order.order_purchases) || 0),
      created: c.created_on || '',
      modified: c.modified_on || c.created_on || '',
      active: !c.status || c.status === 'active'
    };
  }

  /** Lấy MST từ tag dạng "MST:0312345678" (Sapo Web không có trường MST riêng) */
  function taxFromWebTags(tags) {
    var parts = String(tags || '').split(',');
    for (var i = 0; i < parts.length; i++) {
      var m = parts[i].trim().match(/^MST\s*:\s*(.+)$/i);
      if (m) return normTax(m[1]);
    }
    return '';
  }

  /** Khách Sapo Web (mysapo.net) → bản chuẩn */
  function fromWeb(c) {
    var addr = c.default_address || firstAddress(c.addresses);
    return {
      side: 'web',
      id: String(c.id),
      // Ghi lên Web: cả tên nằm trong first_name. Khách tự đăng ký có thể tách họ/tên.
      name: normText([c.last_name, c.first_name].filter(Boolean).join(' ')),
      phone: normPhone(c.phone || (addr && addr.phone)),
      email: normEmail(c.email),
      tax: taxFromWebTags(c.tags),
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
    return ('0000000' + h.toString(16)).slice(-8);
  }

  /** Mã băm chỉ tính trên các trường được đồng bộ */
  function hashOf(r) {
    return fnv1a(JSON.stringify([r.name.toLowerCase(), r.phone, r.email, r.tax, r.address.toLowerCase()]));
  }

  /** Khóa ghép theo thứ tự ưu tiên: SĐT → MST → email */
  function keysOf(r) {
    var k = [];
    if (r.phone) k.push('p:' + r.phone);
    if (r.tax) k.push('t:' + r.tax);
    if (r.email) k.push('e:' + r.email);
    return k;
  }

  function ts(s) {
    var t = Date.parse(s);
    return isNaN(t) ? 0 : t;
  }

  function newer(a, b) {
    return ts(a.modified) >= ts(b.modified) ? a : b;
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
    var pairIndex = {};      // khóa → {omni_id, web_id, linked_at}
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
        // Mỗi bên có mã băm riêng của lần đồng bộ cuối → phát hiện bên nào vừa sửa,
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
        else { dir = newer(o, w) === o ? 'o2w' : 'w2o'; stats.conflicts++; }
        if (dir === 'o2w') { stats.o2w++; actions.push({ type: 'push_o2w', omni: o, web: w, conflict: oChanged && wChanged }); }
        else { stats.w2o++; actions.push({ type: 'push_w2o', omni: o, web: w, conflict: oChanged && wChanged }); }
      } else if (st === 'pending_web') {
        pendingByWeb[row.web_id] = row;
      } else {
        // echo / dup / echo_deleted / dup_web / orphan: đã xử lý, chỉ giữ chỗ
        if (row.omni_id) claimedO[row.omni_id] = true;
        if (row.web_id) claimedW[row.web_id] = true;
      }
    });

    // Dòng chờ mà khách Web đã bị xóa
    Object.keys(pendingByWeb).forEach(function (wid) {
      if (!W[wid]) actions.push({ type: 'drop_row', web_id: wid, reason: 'web_deleted' });
    });

    // Chỉ mục khách Omni chưa ghép
    function eligibleOmni(o) {
      if (!o.active) return false;
      if (skipGroups[o.groupId]) return false;
      return keysOf(o).length > 0;
    }
    var freeOmniByKey = {};
    Object.keys(O).forEach(function (id) {
      var o = O[id];
      if (claimedO[id] || !eligibleOmni(o)) return;
      keysOf(o).forEach(function (k) { (freeOmniByKey[k] = freeOmniByKey[k] || []).push(o); });
    });

    function pickMaster(list) {
      // Ưu tiên bản có nhiều đơn hơn, sau đó bản tạo sớm hơn
      return list.slice().sort(function (a, b) {
        if (b.orders !== a.orders) return b.orders - a.orders;
        return ts(a.created) - ts(b.created);
      })[0];
    }

    function byCreated(a, b) { return ts(a.created) - ts(b.created); }

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
        actions.push({ type: 'link', omni: o, web: w, needPush: hashOf(o) !== hashOf(w),
                       replacesPending: !!pendingByWeb[w.id] });
        return;
      }
      // Trùng với một cặp đã có (2 tài khoản Web cùng SĐT)
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
        // Bộ kết nối Sapo không tự tạo khách bên Omni → tự tạo
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

    // C. Khách Omni chưa ghép → bản dội / trùng / tạo mới trên Web
    Object.keys(O).map(function (id) { return O[id]; }).sort(byCreated).forEach(function (o) {
      if (claimedO[o.id]) return;
      if (!eligibleOmni(o)) { stats.skipped++; return; }
      var keys = keysOf(o);
      for (var i = 0; i < keys.length; i++) {
        var p = pairIndex[keys[i]];
        if (p && p.omni_id !== o.id) {
          claimedO[o.id] = true;
          // Bản dội: Sapo tự sinh SAU khi cặp được ghép. Bản trùng cũ: có từ trước.
          var isEcho = !!p.echo_since && ts(o.created) >= ts(p.echo_since);
          if (isEcho) stats.echoes++; else stats.dups++;
          actions.push({ type: 'mark_echo', omni: o, pair: p, echo: isEcho,
                         deletable: isEcho && !!cfg.deleteEcho && o.orders === 0 });
          return;
        }
      }
      if (budget <= 0) { stats.deferred++; return; }
      budget--; stats.createdWeb++;
      claimedO[o.id] = true;
      indexPair(o, null, now);
      actions.push({ type: 'create_web', omni: o });
    });

    return { actions: actions, stats: stats };
  }

  // ---------- Dựng dữ liệu gửi lên API ----------
  function mergeWebTags(oldTags, tax, omniCode) {
    var keep = String(oldTags || '').split(',').map(function (t) { return t.trim(); })
      .filter(function (t) { return t && !/^MST\s*:/i.test(t) && !/^omni\s*:/i.test(t); });
    if (tax) keep.push('MST:' + tax);
    if (omniCode) keep.push('omni:' + omniCode);
    return keep.join(', ');
  }

  /** Bản chuẩn (nguồn) → payload Sapo Web. existing = bản Web hiện có (khi cập nhật) */
  function toWebPayload(src, existing) {
    var c = {
      first_name: src.name,
      last_name: '',
      phone: src.phone || null,
      email: src.email || null,
      tags: mergeWebTags(existing ? existing.tags : '', src.tax, src.code || '')
    };
    if (src.address || src.phone) {
      var a = { address1: src.address || '', phone: src.phone || '', country: 'Vietnam',
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
      email: src.email || null,
      tax_number: src.tax || null
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
    normPhone: normPhone, normEmail: normEmail, normTax: normTax, normText: normText,
    fromOmni: fromOmni, fromWeb: fromWeb, hashOf: hashOf, keysOf: keysOf,
    plan: plan, toWebPayload: toWebPayload, toOmniPayload: toOmniPayload,
    mergeWebTags: mergeWebTags
  };
})();

if (typeof module !== 'undefined') module.exports = SyncCore;
