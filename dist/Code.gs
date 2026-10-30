/**
 * Đồng bộ khách hàng 2 chiều Sapo Omni <-> Sapo Web
 * TỆP TỰ SINH từ apps-script/ bằng lệnh: npm run build. Không sửa trực tiếp.
 */

// ======================= Core.js =======================
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

  // ---------- Thu gọn bản ghi để lưu bản sao cục bộ (chỉ giữ trường cần cho đồng bộ) ----------
  function slimAddress(a, phoneKey) {
    if (!a) return null;
    var o = { id: a.id, address1: a.address1 || '' };
    o[phoneKey] = a[phoneKey] || '';
    if (a.status) o.status = a.status;
    if (a['default'] === true) o['default'] = true;
    if (a.primary === true) o.primary = true;
    return o;
  }
  function trimOmni(c) {
    var addr = pickAddress(c.addresses);
    return {
      id: c.id, code: c.code || '', name: c.name || '', phone_number: c.phone_number || '', email: c.email || '',
      customer_group_id: c.customer_group_id == null ? null : c.customer_group_id, status: c.status || 'active',
      created_on: c.created_on || '', modified_on: c.modified_on || '',
      sale_order: { order_purchases: Number((c.sale_order && c.sale_order.order_purchases) || 0) },
      addresses: addr ? [slimAddress(addr, 'phone_number')] : []
    };
  }
  function trimWeb(c) {
    var addr = c.default_address || pickAddress(c.addresses);
    return {
      id: c.id, first_name: c.first_name || '', last_name: c.last_name || '', phone: c.phone || '', email: c.email || '',
      tags: c.tags || '', orders_count: Number(c.orders_count || 0),
      created_on: c.created_on || '', modified_on: c.modified_on || '',
      default_address: slimAddress(addr, 'phone')
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
    var linkOnly = !!cfg.linkOnly;   // CHỈ GHÉP: không tạo / không sửa khách ở bên nào
    var stats = { webOnly: 0, omniOnly: 0, pairs: 0, unchanged: 0, o2w: 0, w2o: 0, conflicts: 0, linked: 0,
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
          if (cfg.noOrphans) return;   // lượt chỉ đọc thay đổi: chưa đủ căn cứ kết luận khách đã bị xóa
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
        if (ho === hw || linkOnly) {
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
                       pushWeb: !linkOnly && hashOf(merged) !== hashOf(w),
                       pushOmni: !linkOnly && hashOf(merged) !== hashOf(o) });
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
      if (linkOnly) { stats.webOnly++; return; }        // khách chỉ có trên Web: để nguyên, không tạo sang Omni
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
      if (linkOnly) { stats.omniOnly++; return; }       // khách chỉ có trên Omni: để nguyên, không đẩy lên Web
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

  /**
   * Bản chuẩn (nguồn) → payload Sapo Web. existing = bản Web hiện có (khi cập nhật).
   * SĐT gửi dạng 0xxxxxxxxx – đúng định dạng khách hiện có trên Sapo Web của D&T (vd. 0918826446),
   * để ô tìm kiếm khách của Sapo Web tìm được bằng SĐT quen thuộc.
   */
  function toWebPayload(src, existing) {
    var phone = normPhone(src.phone);
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

  /**
   * Bản chuẩn (nguồn) → payload Sapo Omni. existing = bản Omni hiện có (khi cập nhật).
   * Omni bắt buộc gửi kèm mã KH (code) và tên (name) khi sửa, nếu thiếu sẽ báo 422
   * "code/name must not be blank" (đã kiểm chứng trên cửa hàng thật).
   */
  function toOmniPayload(src, existing) {
    var c = {
      name: src.name || (existing && existing.name) || src.phone || src.email,
      phone_number: src.phone || null,
      email: src.email || null
    };
    if (existing && existing.code) c.code = existing.code;
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
    fromOmni: fromOmni, fromWeb: fromWeb, trimOmni: trimOmni, trimWeb: trimWeb, hashOf: hashOf, keysOf: keysOf, diff: diff,
    mergeForLink: mergeForLink, plan: plan, toWebPayload: toWebPayload, toOmniPayload: toOmniPayload,
    mergeWebTags: mergeWebTags
  };
})();


// ======================= Engine.js =======================
/**
 * Engine.js – thực thi kế hoạch đồng bộ. Dùng chung cho:
 *  - Google Apps Script (gọi Sapo kiểu đồng bộ, UrlFetchApp)
 *  - Tiện ích Chrome (gọi Sapo kiểu bất đồng bộ, fetch)
 *
 * Phần thực thi viết dạng generator: mỗi khi cần gọi Sapo, nó "yield" một yêu cầu
 *   { side: 'web'|'omni', op: 'create'|'update'|'delete', id, payload }
 * và nhận lại kết quả (bản ghi khách hàng Sapo trả về). Bên gọi tự quyết định gọi đồng bộ hay bất đồng bộ.
 */
var SyncEngine = (function () {
  var FIELD_LABELS = { name: 'Tên', phone: 'SĐT', email: 'Email', address: 'Địa chỉ' };

  function describe(d) {
    return d.map(function (x) { return FIELD_LABELS[x.field] + ': "' + x.from + '" → "' + x.to + '"'; }).join('; ');
  }
  function diffText(from, to) { return describe(SyncCore.diff(from, to)); }

  /** Kiểm tra an toàn trước khi chạy + lập kế hoạch. Lỗi → throw (không thay đổi gì). */
  function prepare(omniList, webList, rows, cfg, now) {
    var pairCount = rows.filter(function (r) { return r.status === 'pair'; }).length;
    if (!omniList.length || (!webList.length && pairCount > 0)) {
      throw new Error('Sapo ' + (!omniList.length ? 'Omni' : 'Web') + ' trả về 0 khách hàng (bất thường). ' +
        'Đã dừng, không thay đổi gì. Kiểm tra API key / quyền truy cập / phiên đăng nhập.');
    }
    var result = SyncCore.plan({ omni: omniList, web: webList, rows: rows, now: now, cfg: cfg });
    var s = result.stats;
    if (s.orphans > Math.max(5, 0.2 * (s.pairs + s.orphans))) {
      throw new Error('Có ' + s.orphans + ' cặp bị mất 1 bên trong 1 lượt (bất thường). ' +
        'Đã dừng, không thay đổi gì. Kiểm tra API key / quyền truy cập rồi chạy lại.');
    }
    return result;
  }

  function summary(cfg, omniCount, webCount, s, done, calls, seconds) {
    if (cfg.linkOnly) {
      return (cfg.dryRun ? '[CHẠY THỬ] ' : '') + '[CHỈ GHÉP] ' +
        'Omni ' + omniCount + ' khách, Web ' + webCount + ' khách | đã ghép: ' + (s.pairs + s.linked) +
        ' (mới: ' + s.linked + '), chỉ có trên Web: ' + s.webOnly + ', chỉ có trên Omni: ' + s.omniOnly +
        ', bản dội: ' + s.echoes + ', bản trùng trên Omni: ' + s.dups + ', không có SĐT/email: ' + s.skipped +
        ' | lỗi: ' + done.errors + ' | API: ' + calls + ' lệnh, ' + seconds + 's';
    }
    return (cfg.dryRun ? '[CHẠY THỬ] ' : '') +
      'Omni ' + omniCount + ' khách, Web ' + webCount + ' khách | cặp: ' + s.pairs +
      ', Omni→Web: ' + s.o2w + ', Web→Omni: ' + s.w2o + ', xung đột: ' + s.conflicts +
      ', ghép mới: ' + s.linked + ', tạo trên Web: ' + s.createdWeb + ', tạo trên Omni: ' + s.createdOmni +
      ', bản dội: ' + s.echoes + ', bản trùng: ' + s.dups + ', chờ: ' + s.pending +
      ', mất 1 bên: ' + s.orphans + ', bỏ qua: ' + s.skipped + ', để lượt sau: ' + (s.deferred + done.deferred) +
      ' | lỗi: ' + done.errors + ', cảnh báo: ' + done.warnings + ' | API: ' + calls + ' lệnh, ' + seconds + 's';
  }

  /**
   * @param ctx { actions, rows, cfg, now, log: {add(level, action, omniId, webId, name, detail)},
   *              clock: function() → ms, budgetMs }
   * Kết quả trả về (return của generator): { errors, deferred, warnings }
   */
  function* execute(ctx) {
    var actions = ctx.actions, rows = ctx.rows, cfg = ctx.cfg, now = ctx.now, log = ctx.log;
    var dry = cfg.dryRun;
    var errors = 0, deferred = 0, warnings = 0;
    var tag = dry ? '[THỬ] ' : '';
    var H = SyncCore.hashOf;
    var started = ctx.clock();

    function findRow(omniId, webId) {
      for (var i = 0; i < rows.length; i++) {
        if ((omniId && rows[i].omni_id === omniId) || (webId && rows[i].web_id === webId)) return rows[i];
      }
      return null;
    }
    function removeRow(r) { var i = rows.indexOf(r); if (i >= 0) rows.splice(i, 1); }
    function upsertPair(o, w, hashO, hashW, note) {
      var r = findRow(o.id, null) || findRow(null, w.id);
      if (!r) { r = {}; rows.push(r); }
      if (r.status !== 'pair') r.linked_at = now;
      r.omni_id = o.id; r.web_id = w.id; r.status = 'pair';
      r.hash_o = hashO; r.hash_w = hashW;
      r.first_seen = '';
      r.omni_code = o.code || r.omni_code || ''; r.name = o.name || w.name; r.phone = o.phone || w.phone;
      r.note = note || ''; r.updated_at = now;
    }
    /** Sau khi ghi: Sapo có lưu đủ các trường không? Không đủ thì cảnh báo (không ghi lặp lại). */
    function checkAccepted(expected, savedRaw, from, sideLabel, omniId, webId) {
      if (!savedRaw) return;
      var d = SyncCore.diff(expected, from(savedRaw));
      if (!d.length) return;
      warnings++;
      log.add('WARN', tag + sideLabel + ' không lưu đúng dữ liệu đã gửi', omniId, webId, expected.name, describe(d));
    }
    function req(side, op, id, payload) { return { side: side, op: op, id: id, payload: payload }; }

    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      if (ctx.clock() - started > ctx.budgetMs) { deferred += actions.length - i; break; }
      try {
        switch (a.type) {
          case 'set_hash': {
            var r0 = findRow(a.omni_id, a.web_id);
            if (r0) { r0.hash_o = a.hash_o; r0.hash_w = a.hash_w; r0.updated_at = now; }
            break;
          }
          case 'push_o2w': {
            var hw1 = H(a.omni);
            if (!dry) {
              var nw = yield req('web', 'update', a.web.id, SyncCore.toWebPayload(a.omni, a.web));
              if (nw) { hw1 = H(SyncCore.fromWeb(nw)); checkAccepted(a.omni, nw, SyncCore.fromWeb, 'Sapo Web', a.omni.id, a.web.id); }
            }
            var r1 = findRow(a.omni.id, a.web.id);
            if (r1) { r1.hash_o = H(a.omni); r1.hash_w = hw1; r1.name = a.omni.name; r1.phone = a.omni.phone; r1.updated_at = now; }
            log.add('INFO', tag + 'Omni → Web' + (a.conflict ? ' (xung đột, Omni sửa sau)' : ''), a.omni.id, a.web.id, a.omni.name, diffText(a.web, a.omni));
            break;
          }
          case 'push_w2o': {
            var ho2 = H(a.web);
            if (!dry) {
              var no = yield req('omni', 'update', a.omni.id, SyncCore.toOmniPayload(a.web, a.omni));
              if (no) { ho2 = H(SyncCore.fromOmni(no)); checkAccepted(a.web, no, SyncCore.fromOmni, 'Sapo Omni', a.omni.id, a.web.id); }
            }
            var r2 = findRow(a.omni.id, a.web.id);
            if (r2) { r2.hash_o = ho2; r2.hash_w = H(a.web); r2.name = a.web.name; r2.phone = a.web.phone; r2.updated_at = now; }
            log.add('INFO', tag + 'Web → Omni' + (a.conflict ? ' (xung đột, Web sửa sau)' : ''), a.omni.id, a.web.id, a.web.name, diffText(a.omni, a.web));
            break;
          }
          case 'link': {
            // Gộp lần đầu: Omni làm chuẩn, trường Omni trống thì lấy từ Web; ghi phần khác biệt sang 2 bên
            var m = a.merged, hoL = H(a.omni), hwL = H(a.web);
            if (a.pushWeb) {
              hwL = H(m);
              if (!dry) {
                var nwL = yield req('web', 'update', a.web.id, SyncCore.toWebPayload(m, a.web));
                if (nwL) { hwL = H(SyncCore.fromWeb(nwL)); checkAccepted(m, nwL, SyncCore.fromWeb, 'Sapo Web', a.omni.id, a.web.id); }
              }
            }
            if (a.pushOmni) {
              hoL = H(m);
              if (!dry) {
                var noL = yield req('omni', 'update', a.omni.id, SyncCore.toOmniPayload(m, a.omni));
                if (noL) { hoL = H(SyncCore.fromOmni(noL)); checkAccepted(m, noL, SyncCore.fromOmni, 'Sapo Omni', a.omni.id, a.web.id); }
              }
            }
            upsertPair(a.omni, a.web, hoL, hwL, 'ghép theo SĐT/email');
            var parts = [];
            if (a.pushWeb) parts.push('Web: ' + diffText(a.web, m));
            if (a.pushOmni) parts.push('Omni: ' + diffText(a.omni, m));
            log.add('INFO', tag + 'Ghép cặp' + (parts.length ? ' + bổ sung dữ liệu' : ''), a.omni.id, a.web.id, a.omni.name, parts.join(' | '));
            break;
          }
          case 'create_web': {
            var wid = 'THỬ-' + a.omni.id, hw4 = H(a.omni);
            if (!dry) {
              var cw = yield req('web', 'create', null, SyncCore.toWebPayload(a.omni, null));
              wid = String(cw.id); hw4 = H(SyncCore.fromWeb(cw));
              checkAccepted(a.omni, cw, SyncCore.fromWeb, 'Sapo Web', a.omni.id, wid);
            }
            upsertPair(a.omni, { id: wid, name: a.omni.name, phone: a.omni.phone }, H(a.omni), hw4, 'tạo trên Web từ Omni');
            log.add('INFO', tag + 'Tạo khách trên Web', a.omni.id, wid, a.omni.name, (a.omni.phone || '') + ' ' + (a.omni.email || ''));
            break;
          }
          case 'create_omni': {
            var oid = 'THỬ-' + a.web.id, ho5 = H(a.web), code = '';
            if (!dry) {
              var co = yield req('omni', 'create', null, SyncCore.toOmniPayload(a.web, null));
              oid = String(co.id); code = co.code || ''; ho5 = H(SyncCore.fromOmni(co));
              checkAccepted(a.web, co, SyncCore.fromOmni, 'Sapo Omni', oid, a.web.id);
            }
            upsertPair({ id: oid, code: code, name: a.web.name, phone: a.web.phone }, a.web, ho5, H(a.web), 'tạo trên Omni từ Web');
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
            if (a.deletable && !dry) {
              // Hỏi lại Sapo ngay trước khi xóa: có đơn hàng thì KHÔNG xóa (số liệu lưu sẵn có thể đã cũ)
              var hasOrders = yield req('omni', 'has_orders', a.omni.id, null);
              if (hasOrders) {
                log.add('WARN', 'Không xóa bản dội vì đã có đơn hàng', a.omni.id, a.pair.web_id, a.omni.name, 'bản chính: Omni ' + a.pair.omni_id);
              } else {
                yield req('omni', 'delete', a.omni.id, null); status = 'echo_deleted';
              }
            }
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
        if (e && e.fatal) throw e;                 // lỗi nghiêm trọng (vd. hết phiên đăng nhập) → dừng cả lượt
        errors++;
        var who = a.omni || a.web || {};
        // Tạo khách thất bại: ghi lại để 24 giờ sau mới thử lại
        if (a.type === 'create_web' || a.type === 'create_omni') {
          var key = a.type === 'create_web' ? findRow(a.omni.id, null) : findRow(null, a.web.id);
          if (!key) { key = {}; rows.push(key); }
          key.omni_id = a.type === 'create_web' ? a.omni.id : '';
          key.web_id = a.type === 'create_omni' ? a.web.id : '';
          key.status = 'create_failed'; key.name = who.name; key.phone = who.phone;
          key.note = 'Sapo từ chối, thử lại sau 24 giờ: ' + String(e.message).slice(0, 200); key.updated_at = now;
        }
        log.add('ERROR', tag + a.type, a.omni ? a.omni.id : a.omni_id, a.web ? a.web.id : a.web_id, who.name || '', e.message);
      }
    }
    return { errors: errors, deferred: deferred, warnings: warnings };
  }

  /** Chạy generator với client gọi đồng bộ (Apps Script) */
  function runSync(gen, clients) {
    var step = gen.next();
    while (!step.done) {
      var r = step.value, out, err = null;
      try { out = call(clients, r); } catch (e) { err = e; }
      step = err ? gen.throw(err) : gen.next(out);
    }
    return step.value;
  }

  /** Chạy generator với client gọi bất đồng bộ (tiện ích Chrome) */
  async function runAsync(gen, clients) {
    var step = gen.next();
    while (!step.done) {
      var r = step.value, out, err = null;
      try { out = await call(clients, r); } catch (e) { err = e; }
      step = err ? gen.throw(err) : gen.next(out);
    }
    return step.value;
  }

  function call(clients, r) {
    var c = clients[r.side];
    if (r.op === 'create') return c.createCustomer(r.payload);
    if (r.op === 'update') return c.updateCustomer(r.id, r.payload);
    if (r.op === 'delete') return c.deleteCustomer(r.id);
    if (r.op === 'has_orders') return c.hasOrders(r.id);
    throw new Error('Thao tác không hợp lệ: ' + r.op);
  }

  return { prepare: prepare, summary: summary, execute: execute, runSync: runSync, runAsync: runAsync,
           describe: describe, diffText: diffText };
})();


// ======================= Api.js =======================
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
  this.minGapMs = opts.minGapMs == null ? 600 : opts.minGapMs; // tối đa ~1,6 lệnh/giây, nhẹ cho Sapo
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
    var j;
    try { j = this.request('get', path); }
    catch (e) {
      // Một số máy chủ Sapo giới hạn số khách/trang thấp hơn → tự hạ xuống 50 và đọc lại từ đầu
      if (page === 1 && limit === 250 && /HTTP 4(00|22)/.test(e.message)) { limit = 50; page = 0; continue; }
      throw e;
    }
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

/** Khách đã có đơn hàng chưa (hỏi trực tiếp Sapo) */
SapoClient.prototype.hasOrders = function (id) {
  var j = this.request('get', 'orders.json?customer_id=' + id + '&limit=1&page=1');
  var total = j.metadata && j.metadata.total != null ? j.metadata.total : (j.orders || []).length;
  return total > 0;
};

SapoClient.prototype.deleteCustomer = function (id) {
  return this.request('delete', 'customers/' + id + '.json');
};

// ======================= Store.js =======================
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

// ======================= Main.js =======================
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
