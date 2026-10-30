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

if (typeof module !== 'undefined') module.exports = SyncEngine;
