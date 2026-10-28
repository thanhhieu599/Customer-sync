const test = require('node:test');
const assert = require('node:assert');
const { loadExtension } = require('./ext-harness');
const { tick } = require('./harness');

function writes(srv) { return srv.calls.filter(c => !c.startsWith('get ')); }
function pairs(ext) { return ext.rows().filter(r => r.status === 'pair'); }

function seed(ext) {
  const O1 = ext.omni.add({ name: 'CÔNG TY TNHH TM DV THIẾT BỊ ĐIỆN HÙNG VƯƠNG', phone_number: '0969458080', sale_order: { order_purchases: 3 } });
  const O2 = ext.omni.add({ name: 'Intel Products Vietnam', phone_number: '0281234567', email: 'purchasing@intel.example' });
  const W1 = ext.web.add({ first_name: 'Jabil Việt Nam', phone: '0909000111', email: 'buyer@jabil.example' });
  ext.connector.run();
  return { O1, O2, W1 };
}

test('tiện ích: đồng bộ 2 chiều qua tab Omni đang đăng nhập, rồi ổn định', async () => {
  const ext = loadExtension();
  ext.openOmniTab();
  const { O2, W1 } = seed(ext);
  await ext.configure({});
  let r = await ext.run();
  assert.ok(r.ok, r.error);
  assert.strictEqual(pairs(ext).length, 3, 'Hùng Vương + Intel tạo lên Web, Jabil ghép với bản Sapo tạo');
  assert.strictEqual(ext.web.db.size, 3);
  ext.connector.run();
  await ext.run();
  // Sửa 2 chiều
  ext.omni.edit(O2.id, { email: 'procurement@intel.example' });
  ext.web.edit(W1.id, { first_name: 'Jabil Vietnam Co., Ltd' });
  await ext.run();
  const intelWeb = [...ext.web.db.values()].find(w => /Intel/.test(w.first_name));
  assert.strictEqual(intelWeb.email, 'procurement@intel.example');
  const jabilOmniId = Number(pairs(ext).find(p => p.web_id === String(W1.id)).omni_id);
  assert.strictEqual(ext.omni.db.get(jabilOmniId).name, 'Jabil Vietnam Co., Ltd');
  // Ổn định: không ghi gì
  ext.web.calls.length = 0; ext.omni.calls.length = 0;
  await ext.run();
  assert.deepStrictEqual(writes(ext.web), []);
  assert.deepStrictEqual(writes(ext.omni), []);
  assert.strictEqual(ext.status().state, 'ok');
  assert.strictEqual(ext.state.badge, '');
});

test('tiện ích: chưa mở tab Omni → tự mở tab ghim rồi chạy', async () => {
  const ext = loadExtension();
  seed(ext);
  await ext.configure({});
  const r = await ext.run();
  assert.ok(r.ok, r.error);
  assert.strictEqual(ext.state.tabs.length, 1);
  assert.ok(ext.state.tabs[0].pinned);
});

test('tiện ích: hết phiên đăng nhập Omni → dừng an toàn, báo đăng nhập lại; đăng nhập lại thì chạy tiếp', async () => {
  const ext = loadExtension();
  ext.openOmniTab();
  seed(ext);
  await ext.configure({ alertWebhook: 'https://script.google.com/macros/s/abc/exec' });
  await ext.run();
  const before = JSON.stringify(ext.rows());
  ext.state.loggedIn = false;
  ext.web.add({ first_name: 'Samsung SEV', phone: '0222111222' });
  ext.web.calls.length = 0; ext.omni.calls.length = 0;
  const r = await ext.run();
  assert.strictEqual(r.ok, false);
  assert.ok(r.session);
  assert.strictEqual(ext.status().state, 'session');
  assert.strictEqual(ext.state.badge, '🔑');
  assert.ok(ext.state.notes.some(n => /đăng nhập lại/.test(n.title)));
  assert.ok(ext.state.webhook.some(w => /đăng nhập lại/.test(w.subject)), 'gửi email cảnh báo');
  assert.strictEqual(JSON.stringify(ext.rows()), before, 'không đổi bảng ghép');
  assert.deepStrictEqual(writes(ext.web), [], 'không ghi gì lên Web');
  // Đăng nhập lại
  ext.state.loggedIn = true;
  ext.connector.run();
  const r2 = await ext.run();
  assert.ok(r2.ok, r2.error);
  assert.ok(pairs(ext).some(p => p.name === 'Samsung SEV'));
  assert.strictEqual(ext.status().state, 'ok');
});

test('tiện ích: hết phiên GIỮA lượt (đang ghi) → dừng ngay, không đánh dấu lỗi tạo khách', async () => {
  const ext = loadExtension();
  ext.openOmniTab();
  for (let i = 0; i < 5; i++) ext.web.add({ first_name: 'Web ' + i, phone: '091100000' + i });
  ext.omni.add({ name: 'Gốc', phone_number: '0900000000' });
  await ext.configure({ pendingTimeoutMin: 5 });
  await ext.run();                       // ghi nhận khách Web đang chờ
  tick(10 * 60000);
  const orig = ext.omni.handle; let n = 0;
  ext.omni.handle = (m, u, b) => { if (m === 'post' && ++n === 2) ext.state.loggedIn = false; return orig(m, u, b); };
  const r = await ext.run();
  assert.ok(r.session, 'dừng vì hết phiên');
  assert.strictEqual(ext.rows().filter(x => x.status === 'create_failed').length, 0);
  // "Gốc" (lượt trước) + 2 khách tạo xong trước khi hết phiên (lệnh thứ 2 thành công rồi mới bị đăng xuất)
  assert.strictEqual(pairs(ext).length, 3, 'khách tạo xong TRƯỚC khi hết phiên vẫn được lưu vào bảng ghép');
  // Đăng nhập lại → làm nốt, không tạo trùng
  ext.state.loggedIn = true; ext.omni.handle = orig;
  const r2 = await ext.run();
  assert.ok(r2.ok, r2.error);
  assert.strictEqual(pairs(ext).length, 6, 'Gốc + 5 khách Web');
  const names = [...ext.omni.db.values()].map(c => c.name).filter(n => /^Web /.test(n));
  assert.strictEqual(new Set(names).size, names.length, 'không có khách trùng trên Omni');
});

test('tiện ích: CHẠY THỬ không ghi gì; sai API key Web báo rõ ràng', async () => {
  const ext = loadExtension();
  ext.openOmniTab();
  seed(ext);
  await ext.configure({ dryRun: true });
  ext.web.calls.length = 0; ext.omni.calls.length = 0;
  const r = await ext.run();
  assert.ok(r.ok);
  assert.deepStrictEqual(writes(ext.web), []); assert.deepStrictEqual(writes(ext.omni), []);
  assert.strictEqual(ext.rows().length, 0);
  assert.ok(ext.log().some(l => /\[THỬ\] Tạo khách trên Web/.test(l.action)));

  await ext.configure({ webKey: 'sai' });
  const t = await ext.send({ cmd: 'selfTest' });
  assert.match(t.text, /❌ Sapo Web: .*API key Sapo Web sai/);
  assert.match(t.text, /✅ Sapo Omni \(qua tab đăng nhập\): kết nối OK\. Tổng khách: 3/);
});

test('tiện ích: bật tự động → hẹn giờ đúng chu kỳ; báo thức kích hoạt lượt chạy; tắt thì hủy hẹn giờ', async () => {
  const ext = loadExtension();
  ext.openOmniTab();
  seed(ext);
  await ext.configure({ intervalMin: 15 });
  let r = await ext.send({ cmd: 'setEnabled', enabled: true });
  assert.ok(r.ok);
  assert.strictEqual(ext.state.alarms['dt-sapo-sync'].periodInMinutes, 15);
  await ext.fireAlarm();
  assert.strictEqual(pairs(ext).length, 3);
  assert.strictEqual(ext.status().trigger, 'alarm');
  r = await ext.send({ cmd: 'setEnabled', enabled: false });
  assert.ok(!ext.state.alarms['dt-sapo-sync']);
  assert.strictEqual(ext.state.badge, 'OFF');
});

test('tiện ích: không cho bật tự động khi cấu hình thiếu', async () => {
  const ext = loadExtension();
  const r = await ext.send({ cmd: 'setEnabled', enabled: true });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Địa chỉ Sapo Web/);
});

test('tiện ích: chống chạy chồng 2 lượt cùng lúc', async () => {
  const ext = loadExtension();
  ext.openOmniTab(); seed(ext);
  await ext.configure({});
  const [a, b] = await Promise.all([ext.send({ cmd: 'runNow' }), ext.send({ cmd: 'runNow' })]);
  assert.ok((a.ok && b.skipped) || (b.ok && a.skipped), 'một lượt chạy, một lượt bỏ qua');
  assert.strictEqual(ext.web.db.size, 3, 'không tạo trùng');
});


test('tiện ích: hết phiên kiểu Sapo trả thẳng trang HTML (không chuyển hướng) → vẫn nhận ra', async () => {
  const ext = loadExtension();
  ext.openOmniTab(); seed(ext);
  await ext.configure({});
  await ext.run();
  ext.state.loggedIn = false; ext.state.loginMode = 'html';
  const r = await ext.run();
  assert.ok(r.session, 'nhận ra hết phiên');
  assert.strictEqual(ext.status().state, 'session');
});

test('tiện ích: Chrome cho tab Omni "ngủ đông" → tự tải lại tab rồi chạy; đặt cờ cấm ngủ đông', async () => {
  const ext = loadExtension();
  const t = ext.openOmniTab(); seed(ext);
  await ext.configure({});
  t.discarded = true; t.status = 'unloaded';
  const r = await ext.run();
  assert.ok(r.ok, r.error);
  assert.strictEqual(ext.state.reloads, 1, 'đã tải lại tab');
  assert.strictEqual(t.autoDiscardable, false, 'cấm Chrome cho tab Omni ngủ đông');
  assert.strictEqual(pairs(ext).length, 3);
});

test('tiện ích: tab Omni bị treo không trả lời → lượt chạy KHÔNG treo theo, dừng và tạm nghỉ', { timeout: 20000 }, async () => {
  const ext = loadExtension();
  ext.openOmniTab(); seed(ext);
  await ext.configure({});
  await ext.run();
  ext.state.tabFrozen = true;
  const r = await ext.run();
  assert.ok(r.overload, 'kết thúc lượt, không chờ mãi');
  assert.strictEqual(ext.status().state, 'paused');
  assert.ok(!ext.state.store.lock, 'đã nhả khóa');
});

test('tiện ích: lượt bị bỏ qua (đang tạm nghỉ) vẫn ghi "kiểm tra gần nhất" để popup biết hệ thống còn chạy', async () => {
  const ext = loadExtension();
  ext.openOmniTab(); seed(ext);
  await ext.configure({});
  await ext.send({ cmd: 'setEnabled', enabled: true });
  ext.state.store.pausedUntil = Date.now() + 3600 * 1000;
  await ext.fireAlarm();
  assert.ok(ext.status().lastCheckAt, 'có thời điểm kiểm tra');
  assert.match(ext.status().lastCheckMessage, /tạm nghỉ/);
});

test('tiện ích: đồng bộ có thay đổi → hiện thông báo; không có gì mới → không làm phiền', async () => {
  const ext = loadExtension();
  ext.openOmniTab(); seed(ext);
  await ext.configure({});
  await ext.run();
  assert.ok(ext.state.notes.some(n => /Đã đồng bộ \d+ khách hàng/.test(n.title)));
  ext.connector.run(); await ext.run();
  const before = ext.state.notes.length;
  await ext.run();
  assert.strictEqual(ext.state.notes.length, before, 'không có thay đổi thì không thông báo');
});

test('tiện ích: đang BẬT tự động mà mất lịch chạy → tiến trình nền khởi động lại tự tạo lịch', async () => {
  const ext = loadExtension();
  await ext.configure({});
  await ext.send({ cmd: 'setEnabled', enabled: true });
  delete ext.state.alarms['dt-sapo-sync'];
  await ext.ctx.ensureSchedule();
  assert.ok(ext.state.alarms['dt-sapo-sync'], 'đã tạo lại lịch');
});
