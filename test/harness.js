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
    handle(method, url, payload) {
      srv.calls.push(method + ' ' + url);
      if (srv.failNext > 0) { srv.failNext--; return [429, '{}']; }
      const u = new URL(url);
      const p = u.pathname.replace(/^\/admin\//, '');
      if (method === 'get' && p === 'customers.json') {
        const limit = Math.min(Number(u.searchParams.get('limit') || 50), kind === 'omni' ? 50 : 250);
        const page = Number(u.searchParams.get('page') || 1);
        const all = [...db.values()];
        const slice = all.slice((page - 1) * limit, page * limit);
        const body = { customers: JSON.parse(JSON.stringify(slice)) };
        if (kind === 'omni') body.metadata = { total: all.length, page, limit };
        return [200, JSON.stringify(body)];
      }
      if (method === 'get' && p === 'customers/count.json') return [200, JSON.stringify({ count: db.size })];
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
        // Sapo Web lưu SĐT dạng +84 → kiểm tra hệ thống chịu được việc định dạng lại
        if (kind === 'web' && rec.phone && rec.phone.startsWith('0')) rec.phone = '+84' + rec.phone.slice(1);
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
  return {
    run() {
      for (const w of web.db.values()) {
        if (seen.has(w.id)) continue;
        seen.add(w.id);
        omni.add({
          name: [w.last_name, w.first_name].filter(Boolean).join(' '),
          phone_number: w.phone, email: w.email,
          addresses: w.default_address ? [{ address1: w.default_address.address1, phone_number: w.phone }] : []
        });
      }
    }
  };
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
    DRY_RUN: 'false', MAX_CREATE_PER_RUN: '50', DELETE_ECHO: 'false', PENDING_WEB_TIMEOUT_MIN: '30'
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
  const dir = path.join(__dirname, '..', 'apps-script');
  for (const f of ['Core.js', 'Api.js', 'Store.js', 'Main.js']) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
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

module.exports = { loadSystem, tick, nowIso };
