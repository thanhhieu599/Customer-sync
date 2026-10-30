/**
 * Giả lập Google Apps Script + 2 máy chủ Sapo (Web, Omni) + bộ kết nối Sapo Web → Omni
 * để chạy thử toàn bộ hệ thống mà không chạm dữ liệu thật.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let clock = Date.parse('2026-10-28T08:00:00Z');
function tick(ms) { clock += ms || 1000; return new Date(clock).toISOString(); }
function nowIso() { return new Date(clock).toISOString(); }

// ---------- Máy chủ Sapo giả ----------
function makeServer(kind) {
  const db = new Map();
  let nextId = kind === 'web' ? 9000 : 818000000;
  let nextAddr = 1;
  let code = 2400;
  const srv = {
    kind, db, calls: [], failNext: 0,
    add(c) {
      const id = nextId++;
      const t = tick();
      const rec = Object.assign({ id, created_on: t, modified_on: t }, c);
      if (kind === 'omni') {
        rec.code = rec.code || 'CUZN0' + (code++);
        rec.status = 'active';
        rec.sale_order = rec.sale_order || { order_purchases: 0 };
        rec.addresses = (rec.addresses || []).map(a => Object.assign({ id: nextAddr++, status: 'active' }, a));
      } else {
        rec.orders_count = rec.orders_count || 0;
        rec.addresses = (rec.addresses || []).map(a => Object.assign({ id: nextAddr++ }, a));
        rec.default_address = rec.addresses[0] || null;
      }
      db.set(id, rec);
      return rec;
    },
    edit(id, patch) {
      const rec = db.get(id);
      Object.assign(rec, patch, { modified_on: tick() });
      return rec;
    },
    callAt: [], ignoreSince: false, newestFirst: false, orders: new Map(), nextOrder: 1086079473, ignoreOrderCustomer: false,
    /** Thêm đơn trực tiếp trên Omni (vd. đơn tại quầy) */
    addOrder(customerId, extra) {
      const c = db.get(customerId);
      const o = Object.assign({ id: srv.nextOrder++, code: 'SON0' + (6000 + srv.orders.size), created_on: tick(), modified_on: clock && new Date(clock).toISOString(),
        status: 'finalized', channel: null, source_id: 1000001, total: 216000, customer_id: customerId,
        customer_data: c ? JSON.parse(JSON.stringify(c)) : null }, extra || {});
      if (c) c.sale_order.order_purchases += 1;
      srv.orders.set(o.id, o);
      return o;
    },
    handle(method, url, payload) {
      srv.calls.push(method + ' ' + url);
      srv.callAt.push(clock);
      if (srv.failNext > 0) { srv.failNext--; return [429, '{}']; }
      const u = new URL(url);
      const p = u.pathname.replace(/^\/admin\//, '');
      if (method === 'get' && p === 'customers.json') {
        const limit = Math.min(Number(u.searchParams.get('limit') || 50), kind === 'omni' ? 50 : 250);
        const page = Number(u.searchParams.get('page') || 1);
        let all = [...db.values()];
        if (srv.newestFirst) all = all.slice().sort((a, b) => b.id - a.id);   // như Sapo Omni thật: khách mới tạo lên đầu
        const since = u.searchParams.get('modified_on_min');
        if (since && !srv.ignoreSince) all = all.filter(c => Date.parse(c.modified_on) >= Date.parse(since));
        const slice = all.slice((page - 1) * limit, page * limit);
        const body = { customers: JSON.parse(JSON.stringify(slice)) };
        if (kind === 'omni') body.metadata = { total: all.length, page, limit };
        return [200, JSON.stringify(body)];
      }
      if (method === 'get' && p === 'customers/count.json') return [200, JSON.stringify({ count: db.size })];
      if (method === 'get' && p === 'orders.json' && u.searchParams.get('customer_id')) {
        const cid = Number(u.searchParams.get('customer_id'));
        const rec = db.get(cid);
        const n = rec ? (kind === 'omni' ? rec.sale_order.order_purchases : rec.orders_count) : 0;
        return [200, JSON.stringify({ metadata: { total: n }, orders: n ? [{ id: 1, customer_id: cid }] : [] })];
      }
      if (method === 'get' && p === 'orders.json') {            // như Omni thật: đơn mới tạo lên đầu
        const limit = Math.min(Number(u.searchParams.get('limit') || 20), 50);
        const page = Number(u.searchParams.get('page') || 1);
        const all = [...srv.orders.values()].sort((a, b) => b.id - a.id);
        return [200, JSON.stringify({ metadata: { total: all.length, page, limit }, orders: all.slice((page - 1) * limit, page * limit) })];
      }
      const mo = p.match(/^orders\/(\d+)\.json$/);
      if (mo && method === 'get') {
        const o = srv.orders.get(Number(mo[1]));
        return o ? [200, JSON.stringify({ order: o })] : [404, '{}'];
      }
      if (mo && method === 'put') {
        const o = srv.orders.get(Number(mo[1]));
        if (!o) return [404, '{}'];
        const body = JSON.parse(payload).order;
        if (body.customer_id != null && !srv.ignoreOrderCustomer) {
          const to = db.get(Number(body.customer_id));
          if (!to) return [422, '{"errors":{"customer_id":"not found"}}'];
          const from = db.get(o.customer_id);
          if (from) from.sale_order.order_purchases = Math.max(0, from.sale_order.order_purchases - 1);
          to.sale_order.order_purchases += 1;
          o.customer_id = to.id; o.customer_data = JSON.parse(JSON.stringify(to));
        }
        o.modified_on = tick();
        return [200, JSON.stringify({ order: o })];
      }
      const m = p.match(/^customers\/(\d+)\.json$/);
      if (method === 'post' && p === 'customers.json') {
        const c = JSON.parse(payload).customer;
        if (kind === 'web' && c.email && [...db.values()].some(x => x.email === c.email)) {
          return [422, '{"errors":{"email":["đã tồn tại"]}}'];
        }
        const rec = srv.add(c);
        return [201, JSON.stringify({ customer: rec })];
      }
      if (m && method === 'put') {
        const rec = db.get(Number(m[1]));
        if (!rec) return [404, '{}'];
        const c = JSON.parse(payload).customer;
        // Giống Omni thật: sửa khách bắt buộc kèm mã KH và tên (đã kiểm chứng trên cửa hàng D&T)
        if (kind === 'omni' && (!c.code || !c.name)) {
          return [422, JSON.stringify({ data_error: { status: 422, errors: Object.assign({},
            c.code ? {} : { code: 'must not be blank' }, c.name ? {} : { name: 'must not be blank' }) } })];
        }
        const addrs = c.addresses; delete c.addresses; delete c.id;
        Object.assign(rec, c);
        if (addrs) {
          addrs.forEach(a => {
            const ex = a.id && rec.addresses.find(x => x.id === a.id);
            if (ex) Object.assign(ex, a);
            else rec.addresses.push(Object.assign({ id: nextAddr++ }, a));
          });
          if (kind === 'web') rec.default_address = rec.addresses[0];
        }
        // Kiểm tra hệ thống chịu được việc Sapo tự định dạng lại SĐT (bật bằng srv.reformatPhone)
        if (kind === 'web' && srv.reformatPhone && rec.phone && rec.phone.startsWith('0')) rec.phone = '+84' + rec.phone.slice(1);
        rec.modified_on = tick();
        return [200, JSON.stringify({ customer: rec })];
      }
      if (m && method === 'delete') {
        const rec = db.get(Number(m[1]));
        if (!rec) return [404, '{}'];
        const orders = kind === 'omni' ? rec.sale_order.order_purchases : rec.orders_count;
        if (orders > 0) return [422, '{"errors":"Khách đã có đơn hàng"}'];
        db.delete(Number(m[1]));
        return [200, '{}'];
      }
      return [404, '{}'];
    }
  };
  return srv;
}

/** Bộ kết nối Sapo: mỗi khách Web mới → tạo thêm 1 khách bên Omni (không ghép theo SĐT) */
function makeConnector(web, omni) {
  const seen = new Set([...web.db.keys()]);
  const link = new Map();                         // khách Web → khách Omni do bộ kết nối tạo (bản dội)
  const toLocal = p => p && p.startsWith('+84') ? '0' + p.slice(3) : p;   // Omni lưu SĐT dạng 0…
  const conn = {
    link,
    run() {
      for (const w of web.db.values()) {
        if (seen.has(w.id)) continue;
        seen.add(w.id);
        const e = omni.add({
          name: [w.last_name, w.first_name].filter(Boolean).join(' '),
          phone_number: toLocal(w.phone), email: w.email, tags: ['Web'],
          addresses: w.default_address ? [{ address1: w.default_address.address1, phone_number: toLocal(w.phone) }] : []
        });
        link.set(w.id, e.id);
      }
    },
    /** Sale tạo đơn trên Sapo Web cho khách Web → Sapo đẩy đơn về Omni, gắn vào bản dội (giống thật) */
    webOrder(webCustomerId, extra) {
      conn.run();
      const omniId = link.get(webCustomerId);
      return omni.addOrder(omniId, Object.assign({ channel: 'Sapoweb', source_id: 1126437 }, extra || {}));
    }
  };
  return conn;
}

// ---------- Google Apps Script giả ----------
function makeSheet(name) {
  let data = [];
  const sh = {
    name, data: () => data,
    getLastRow: () => data.length,
    setFrozenRows() {},
    deleteRows(start, n) { data.splice(start - 1, n); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      const rng = {
        setValues(v) {
          for (let i = 0; i < nr; i++) {
            data[r - 1 + i] = data[r - 1 + i] || [];
            for (let j = 0; j < nc; j++) data[r - 1 + i][c - 1 + j] = v[i][j];
          }
          return rng;
        },
        getDisplayValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = data[r - 1 + i] || [];
            out.push(Array.from({ length: nc }, (_, j) => row[c - 1 + j] == null ? '' : String(row[c - 1 + j])));
          }
          return out;
        },
        clearContent() {
          for (let i = 0; i < nr; i++) if (data[r - 1 + i]) for (let j = 0; j < nc; j++) data[r - 1 + i][c - 1 + j] = '';
          while (data.length && data[data.length - 1].every(x => x === '' || x == null)) data.pop();
          return rng;
        },
        setNumberFormat() { return rng; },
        setFontWeight() { return rng; }
      };
      return rng;
    }
  };
  return sh;
}

function loadSystem(opts) {
  const web = makeServer('web');
  const omni = makeServer('omni');
  const sheets = {};
  const props = Object.assign({
    WEB_BASE_URL: 'https://dt.mysapo.net', WEB_API_KEY: 'k', WEB_API_SECRET: 's',
    OMNI_BASE_URL: 'https://trangthietbivn.mysapogo.com', OMNI_API_KEY: 'k2', OMNI_API_SECRET: 's2',
    DRY_RUN: 'false', MAX_CREATE_PER_RUN: '50', DELETE_ECHO: 'false', PENDING_WEB_TIMEOUT_MIN: '30', SYNC_CUSTOMERS: 'true'
  }, (opts && opts.props) || {});
  const mails = [];
  const ctx = {
    console,
    Date: class extends Date {
      constructor(...a) { if (a.length) super(...a); else super(clock); }
      static now() { return clock; }
      static parse(s) { return Date.parse(s); }
    },
    UrlFetchApp: {
      fetch(url, opt) {
        const srv = url.includes('mysapogo.com') ? omni : web;
        const [code, text] = srv.handle(opt.method, url, opt.payload);
        return { getResponseCode: () => code, getContentText: () => text };
      }
    },
    Utilities: { base64Encode: s => Buffer.from(s).toString('base64'), sleep: ms => { clock += ms; } },
    SpreadsheetApp: {
      getActive: () => ({
        getSheetByName: n => sheets[n] || null,
        insertSheet: n => (sheets[n] = makeSheet(n))
      }),
      getUi: () => { throw new Error('no ui'); }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperties: () => Object.assign({}, props),
        getProperty: k => props[k] == null ? null : props[k],
        setProperty: (k, v) => { props[k] = v; }
      })
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    MailApp: { sendEmail: (to, sub, body) => mails.push({ to, sub, body }) },
    Logger: { log() {} },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger() { return { timeBased: () => ({ everyMinutes: () => ({ create() {} }) }) }; } }
  };
  vm.createContext(ctx);
  if (opts && opts.bundle) {
    const f = path.join(__dirname, '..', 'dist', 'Code.gs');
    vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: 'Code.gs' });
  } else {
    const dir = path.join(__dirname, '..', 'apps-script');
    for (const f of ['Core.js', 'Engine.js', 'Api.js', 'Store.js', 'Main.js']) {
      vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
    }
  }
  const sys = {
    web, omni, sheets, props, mails, ctx,
    connector: makeConnector(web, omni),
    run() { tick(60000); ctx.runSync(); tick(60000); },
    mapRows() {
      const sh = sheets.Map; if (!sh) return [];
      const [head, ...rest] = sh.data();
      return rest.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
    },
    logRows() {
      const sh = sheets.Log; if (!sh) return [];
      const [head, ...rest] = sh.data();
      return rest.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
    }
  };
  return sys;
}

function FakeDate() {
  return class extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock); }
    static now() { return clock; }
    static parse(s) { return Date.parse(s); }
  };
}

module.exports = { loadSystem, tick, nowIso, makeServer, makeConnector, makeSheet, FakeDate };
