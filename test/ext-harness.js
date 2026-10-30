/**
 * Giả lập Chrome (tab, storage, alarms, scripting, notifications) để chạy tiện ích D&T Sapo Sync
 * với 2 máy chủ Sapo giả. Tab Omni "đăng nhập" được mô phỏng bằng biến loggedIn.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeServer, makeConnector, tick, FakeDate } = require('./harness');

const OMNI = 'https://trangthietbivn.mysapogo.com';
const WEB = 'https://dt.mysapo.net';

function evented() {
  const ls = [];
  return { addListener: f => ls.push(f), removeListener: f => { const i = ls.indexOf(f); if (i >= 0) ls.splice(i, 1); },
           fire: (...a) => ls.slice().forEach(f => f(...a)), ls };
}

function loadExtension(opts = {}) {
  const web = makeServer('web');
  const omni = makeServer('omni');
  const state = { loggedIn: true, tabs: [], nextTab: 1, store: {}, alarms: {}, notes: [], badge: '', webhook: [] };
  const toResp = (code, text, extra = {}) => ({
    status: code, redirected: !!extra.redirected, url: extra.url || '', type: 'basic',
    text: async () => text
  });

  // fetch trong tiện ích (Sapo Web, webhook email)
  async function bgFetch(url, opt = {}) {
    if (url.startsWith(WEB)) {
      if (opt.headers && opt.headers.Authorization !== 'Basic ' + Buffer.from('k:s').toString('base64')) return toResp(401, '{"errors":"Invalid API key"}');
      const [code, text] = web.handle((opt.method || 'GET').toLowerCase(), url, opt.body);
      return toResp(code, text);
    }
    if (url.startsWith('https://script.google.com/')) { state.webhook.push(JSON.parse(opt.body)); return toResp(200, 'ok'); }
    throw new Error('Mạng bị chặn trong kiểm thử: ' + url);
  }
  // fetch BÊN TRONG tab Omni (đường dẫn tương đối, dùng phiên đăng nhập)
  async function pageFetch(url, opt = {}) {
    if (state.omniHang) { const e = new Error('The user aborted a request.'); e.name = 'AbortError'; throw e; }
    if (!state.loggedIn) {
      // 2 kiểu hết phiên: chuyển hướng sang trang đăng nhập, hoặc trả thẳng trang HTML tại chỗ
      return state.loginMode === 'html'
        ? toResp(200, '<!doctype html><html><body>Phiên làm việc đã hết hạn</body></html>', { url: OMNI + url })
        : toResp(200, '<!doctype html><title>Đăng nhập</title>', { redirected: true, url: 'https://accounts.sapo.vn/login' });
    }
    if (opt.credentials !== 'include') return toResp(401, '{}');
    const [code, text] = omni.handle((opt.method || 'GET').toLowerCase(), OMNI + url, opt.body);
    return toResp(code, text);
  }

  const onUpdated = evented(), onAlarm = evented(), onMessage = evented(), onInstalled = evented(), onStartup = evented(), onChanged = evented();
  const chrome = {
    storage: { local: {
      get: async keys => { const ks = typeof keys === 'string' ? [keys] : keys; const o = {};
        ks.forEach(k => { if (k in state.store) o[k] = JSON.parse(JSON.stringify(state.store[k])); }); return o; },
      set: async obj => { Object.assign(state.store, JSON.parse(JSON.stringify(obj))); },
      remove: async k => { delete state.store[k]; }
    }, onChanged },
    alarms: {
      create: async (n, o) => { state.alarms[n] = Object.assign({ name: n, scheduledTime: Date.now() + (o.delayInMinutes || o.periodInMinutes) * 60000 }, o); },
      get: async n => state.alarms[n] ? Object.assign({}, state.alarms[n]) : undefined,
      clear: async n => { delete state.alarms[n]; }, onAlarm
    },
    tabs: {
      query: async q => state.tabs.filter(t => t.url.startsWith(q.url.replace('/*', ''))),
      create: async o => {
        const t = { id: state.nextTab++, url: state.loggedIn ? o.url : 'https://accounts.sapo.vn/login', status: 'loading', pinned: o.pinned };
        state.tabs.push(t);
        setTimeout(() => { t.status = 'complete'; onUpdated.fire(t.id, { status: 'complete' }, t); }, 0);
        return { ...t };
      },
      get: async id => ({ ...state.tabs.find(t => t.id === id) }),
      update: async (id, props) => { const t = state.tabs.find(x => x.id === id); Object.assign(t, props); return { ...t }; },
      reload: async id => {
        const t = state.tabs.find(x => x.id === id);
        t.status = 'loading'; t.discarded = false; state.reloads = (state.reloads || 0) + 1;
        setTimeout(() => { t.status = 'complete'; onUpdated.fire(t.id, { status: 'complete' }, t); }, 0);
      },
      onUpdated
    },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        const tab = state.tabs.find(t => t.id === target.tabId);
        if (!tab) throw new Error('No tab with id: ' + target.tabId);
        if (tab.discarded) throw new Error('Cannot access contents of a discarded tab');
        if (state.tabFrozen) return new Promise(() => {});           // tab treo: không bao giờ trả lời
        // Như Chrome thật: hàm được chép sang tab và chạy độc lập (không thấy biến của tiện ích)
        const inTab = vm.runInNewContext('(' + func.toString() + ')', { fetch: pageFetch, JSON });
        return [{ result: await inTab(...args) }];
      }
    },
    notifications: { create: async (id, o) => { state.notes.push(o); } },
    action: { setBadgeText: async o => { state.badge = o.text; }, setBadgeBackgroundColor: async () => {} },
    runtime: { onMessage, onInstalled, onStartup }
  };

  const ctx = {
    console, chrome, fetch: bgFetch, btoa: s => Buffer.from(s, 'binary').toString('base64'),
    // Chờ ngắn (giãn cách, thử lại): tua đồng hồ giả rồi chạy ngay. Chờ dài (hết giờ chờ tab): chạy sau cùng, đúng thứ tự như thật.
    setTimeout: (f, ms) => {
      if (ms && ms <= 30000) { tick(ms); return { imm: setImmediate(f) }; }
      if (ms > 10 * 60000) return { never: true };              // chờ quá 10 phút: coi như không bao giờ hết giờ
      return { tmo: setTimeout(f, ms ? 300 : 0) };
    },
    clearTimeout: t => { if (!t) return; if (t.imm) clearImmediate(t.imm); if (t.tmo) clearTimeout(t.tmo); },
    Date: FakeDate(), Promise, JSON, Math, Object, Array, String, Number, Error, RegExp, isNaN
  };
  ctx.self = ctx;
  ctx.importScripts = (...files) => files.forEach(f =>
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'chrome-extension', f), 'utf8'), ctx, { filename: f }));
  vm.createContext(ctx);
  ctx.importScripts('background.js');

  const ext = {
    web, omni, state, ctx, connector: makeConnector(web, omni),
    /** Gửi lệnh như popup/trang cài đặt */
    send: msg => new Promise(res => { onMessage.ls[0](msg, {}, res); }),
    configure: async (cfg) => ext.send({ cmd: 'saveConfig', config: Object.assign(
      { webBase: WEB, webKey: 'k', webSecret: 's', omniBase: OMNI, dryRun: false, maxCreate: 50, syncCustomers: true }, cfg) }),
    openOmniTab: () => { const t = { id: state.nextTab++, url: OMNI + '/admin/dashboard', status: 'complete', pinned: true }; state.tabs.push(t); return t; },
    fireAlarm: async () => { tick(60000); onAlarm.fire({ name: 'dt-sapo-sync' }); await new Promise(r => setTimeout(r, 50)); await ext.idle(); },
    run: async () => { tick(60000); const r = await ext.send({ cmd: 'runNow' }); tick(60000); return r; },
    idle: async () => { for (let i = 0; i < 200 && state.store.lock; i++) await new Promise(r => setTimeout(r, 5)); },
    rows: () => state.store.rows || [],
    log: () => state.store.log || [],
    status: () => state.store.status || {}
  };
  return ext;
}

module.exports = { loadExtension, OMNI, WEB };
