/**
 * Kiểm thử cơ chế BẢO VỆ SAPO OMNI (sau sự cố Omni chậm/sập tạm thời khi chạy thử).
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadExtension } = require('./ext-harness');
const { tick, nowIso } = require('./harness');

const omniGets = ext => ext.omni.calls.filter(c => c.startsWith('get '));
const omniWrites = ext => ext.omni.calls.filter(c => !c.startsWith('get '));
const pairs = ext => ext.rows().filter(r => r.status === 'pair');
function resetCalls(ext) { ext.omni.calls.length = 0; ext.omni.callAt.length = 0; ext.web.calls.length = 0; }

/** Cửa hàng có n khách, tạo rải rác (mỗi khách cách nhau 1 giờ) như dữ liệu thật */
function bigShop(ext, n) {
  for (let i = 0; i < n; i++) {
    tick(3600 * 1000);
    ext.omni.add({ name: 'KH ' + i, phone_number: '09' + String(10000000 + i), customer_group_id: 579639 });
  }
}

test('bảo vệ: lượt đầu quét toàn bộ; các lượt sau chỉ hỏi "khách nào thay đổi" → 1 lệnh Omni/lượt khi không có gì mới', async () => {
  const ext = loadExtension();
  ext.openOmniTab();
  bigShop(ext, 600);
  await ext.configure({ skipOmniGroupIds: '579639' });
  const r1 = await ext.run();
  assert.strictEqual(r1.mode, 'full');
  resetCalls(ext);
  const r2 = await ext.run();
  assert.strictEqual(r2.mode, 'incremental');
  assert.strictEqual(omniGets(ext).length, 1, 'chỉ 1 lệnh đọc Omni (trước đây: ' + Math.ceil(600 / 50) + '+ lệnh mỗi lượt)');
  assert.match(omniGets(ext)[0], /modified_on_min=/);
  assert.deepStrictEqual(omniWrites(ext), []);
});

test('bảo vệ: giữa 2 lệnh Omni luôn cách nhau ít nhất 1,5 giây, kể cả khi quét toàn bộ', async () => {
  const ext = loadExtension();
  ext.openOmniTab();
  bigShop(ext, 300);
  await ext.configure({});
  await ext.run();
  const t = ext.omni.callAt;
  assert.ok(t.length >= 6, 'quét 300 khách = nhiều trang');
  for (let i = 1; i < t.length; i++) assert.ok(t[i] - t[i - 1] >= 1500, `lệnh ${i} cách lệnh trước ${t[i] - t[i - 1]}ms`);
  assert.ok(ext.omni.calls.every(c => !/limit=250/.test(c) || !c.startsWith('get https://trangthietbivn')), 'Omni đọc trang nhỏ 50 khách');
});

test('bảo vệ: thay đổi giữa 2 lượt vẫn được đồng bộ đúng khi chỉ đọc thay đổi', async () => {
  const ext = loadExtension();
  ext.openOmniTab();
  const O = ext.omni.add({ name: 'Intel', phone_number: '0281234567' });
  await ext.configure({});
  await ext.run(); ext.connector.run(); await ext.run();
  ext.omni.edit(O.id, { email: 'buyer@intel.example' });
  const W = ext.web.add({ first_name: 'Foxconn', phone: '0333444555' }); ext.connector.run();
  resetCalls(ext);
  const r = await ext.run();
  assert.strictEqual(r.mode, 'incremental');
  const intelWeb = [...ext.web.db.values()].find(w => w.first_name === 'Intel');
  assert.strictEqual(intelWeb.email, 'buyer@intel.example');
  assert.ok(pairs(ext).some(p => p.web_id === String(W.id)), 'khách Web mới được ghép');
});

test('bảo vệ: Omni quá tải (503) → dừng sau tối đa 2 lần, tạm nghỉ 60 phút, báo động; hết giờ nghỉ mới chạy lại', async () => {
  const ext = loadExtension();
  ext.openOmniTab();
  bigShop(ext, 100);
  await ext.configure({});
  await ext.run();
  await ext.send({ cmd: 'setEnabled', enabled: true });
  const orig = ext.omni.handle;
  ext.omni.handle = (m, u, b) => [503, '{"error":"Service Unavailable"}'];
  resetCalls(ext);
  const r = await ext.run();
  assert.ok(r.overload);
  assert.ok(ext.omni.calls.length <= 2, 'chỉ gửi ' + ext.omni.calls.length + ' lệnh rồi dừng (trước đây: thử lại tới 5 lần mỗi lệnh)');
  assert.strictEqual(ext.status().state, 'paused');
  assert.strictEqual(ext.state.badge, '⏸');
  assert.ok(ext.state.notes.some(n => /tạm nghỉ/.test(n.title)));
  // Trong giờ nghỉ: báo thức không gửi lệnh nào
  ext.omni.handle = orig;
  resetCalls(ext);
  await ext.fireAlarm();
  assert.strictEqual(ext.omni.calls.length, 0, 'không làm phiền Omni khi đang nghỉ');
  // Hết giờ nghỉ → chạy lại bình thường
  tick(61 * 60000);
  await ext.fireAlarm();
  assert.strictEqual(ext.status().state, 'ok');
});

test('bảo vệ: Omni treo không phản hồi → mỗi lệnh tối đa 30 giây, dừng và tạm nghỉ', async () => {
  const ext = loadExtension();
  ext.openOmniTab();
  bigShop(ext, 10);
  await ext.configure({});
  await ext.run();
  ext.state.omniHang = true;
  const r = await ext.run();
  assert.ok(r.overload);
  assert.match(r.error, /chậm hoặc lỗi/);
  assert.strictEqual(ext.status().state, 'paused');
});

test('bảo vệ: Sapo bỏ qua bộ lọc "thay đổi" → chỉ đọc 1 trang rồi dừng, chuyển sang quét toàn bộ mỗi 6 giờ', async () => {
  const ext = loadExtension();
  ext.openOmniTab();
  bigShop(ext, 400);
  await ext.configure({});
  await ext.run();                                  // quét toàn bộ lần đầu
  ext.omni.ignoreSince = true;
  resetCalls(ext);
  const r = await ext.run();
  assert.ok(r.ok);
  assert.strictEqual(omniGets(ext).length, 1, 'phát hiện ngay từ trang đầu, không đọc hết 8 trang');
  assert.strictEqual(ext.status().state, 'warn');
  // Báo thức trong 6 giờ tới: không chạm vào Omni
  await ext.send({ cmd: 'setEnabled', enabled: true });
  resetCalls(ext);
  await ext.fireAlarm(); await ext.fireAlarm();
  assert.strictEqual(ext.omni.calls.length, 0);
  // Sau 6 giờ: quét toàn bộ 1 lần
  tick(6 * 3600 * 1000);
  await ext.fireAlarm();
  assert.strictEqual(ext.status().lastMode, 'full');
});

test('bảo vệ: quét toàn bộ ban đêm đúng giờ cài đặt; chỉ lượt quét toàn bộ mới kết luận "khách đã bị xóa"', async () => {
  const ext = loadExtension();
  ext.openOmniTab();
  const W = ext.web.add({ first_name: 'Jabil', phone: '0909000111' }); ext.connector.run();
  ext.omni.add({ name: 'Intel', phone_number: '0281234567' });
  await ext.configure({});
  await ext.run(); ext.connector.run(); await ext.run();
  ext.web.db.delete(W.id);                          // ai đó xóa khách trên Web
  let r = await ext.run();
  assert.strictEqual(r.mode, 'incremental');
  assert.strictEqual(ext.rows().filter(x => x.status === 'orphan').length, 0, 'lượt thường không kết luận');
  tick(21 * 3600 * 1000);
  const hour = new Date(Date.parse(nowIso()) + 60000).getHours();
  await ext.configure({ fullScanHour: hour });
  r = await ext.run();
  assert.strictEqual(r.mode, 'full');
  assert.strictEqual(ext.rows().filter(x => x.status === 'orphan').length, 1, 'quét toàn bộ mới phát hiện');
});

test('bảo vệ: xóa bản dội luôn hỏi lại Sapo có đơn hàng không (số liệu lưu sẵn có thể đã cũ)', async () => {
  const ext = loadExtension();
  ext.openOmniTab();
  ext.omni.add({ name: 'Intel', phone_number: '0281234567' });
  await ext.configure({ deleteEcho: true });
  await ext.run();                                  // tạo Intel lên Web
  ext.connector.run();                              // Sapo sinh bản dội (0 đơn)
  const echo = [...ext.omni.db.values()].pop();
  // Ngay trước lượt chạy, bản dội phát sinh đơn – nhưng bản sao cục bộ chưa biết
  const origH = ext.omni.handle;
  ext.omni.handle = (m, u, b) => { if (m === 'get' && /orders\.json/.test(u)) echo.sale_order.order_purchases = 1; return origH(m, u, b); };
  await ext.run();
  assert.ok(ext.omni.db.has(echo.id), 'KHÔNG xóa khách đã có đơn');
  assert.ok(ext.log().some(l => /Không xóa bản dội vì đã có đơn hàng/.test(l.action)));
});

test('bảo vệ: trần 60 lệnh ghi Omni mỗi lượt → dừng êm, lượt sau làm tiếp, không trùng', async () => {
  const ext = loadExtension();
  ext.openOmniTab();
  ext.omni.add({ name: 'Gốc', phone_number: '0900000000' });
  for (let i = 0; i < 80; i++) ext.web.add({ first_name: 'Web ' + i, phone: '0911' + String(100000 + i) });
  await ext.configure({ maxCreate: 200, pendingTimeoutMin: 10 });
  await ext.run();                                  // ghi nhận 80 khách Web đang chờ
  tick(11 * 60000);
  resetCalls(ext);
  const r = await ext.run();
  assert.ok(r.partial, 'dừng êm do chạm trần');
  assert.strictEqual(omniWrites(ext).length, 60);
  assert.strictEqual(ext.status().state, 'ok');
  await ext.run();
  assert.strictEqual(pairs(ext).filter(p => /^Web /.test(p.name)).length, 80);
  const names = [...ext.omni.db.values()].map(c => c.name).filter(n => /^Web /.test(n));
  assert.strictEqual(new Set(names).size, 80, 'không trùng');
});

/** Giống hệt Omni thật của D&T (kiểm chứng 29/10): bỏ qua modified_on_min, trả khách mới tạo lên đầu */
function realOmni(ext) { ext.omni.ignoreSince = true; ext.omni.newestFirst = true; }

test('Omni thật: bỏ qua bộ lọc nhưng xếp khách mới lên đầu → mỗi lượt chỉ 1 lệnh đọc trang đầu, vẫn chạy tiếp', async () => {
  const ext = loadExtension();
  realOmni(ext);
  ext.openOmniTab();
  bigShop(ext, 400);
  await ext.configure({ skipOmniGroupIds: '579639' });
  await ext.run();                                   // quét toàn bộ lần đầu
  resetCalls(ext);
  const r = await ext.run();                         // phát hiện + chuyển chế độ
  assert.ok(r.ok, r.error);
  assert.strictEqual(omniGets(ext).length, 1);
  assert.ok(ext.log().some(l => /chuyển sang đọc khách mới tạo/.test(l.action)));
  assert.notStrictEqual(ext.status().state, 'warn', 'không báo cảnh báo – đây là chế độ hoạt động bình thường');
  resetCalls(ext);
  const r2 = await ext.run();
  assert.strictEqual(r2.mode, 'incremental');
  assert.strictEqual(omniGets(ext).length, 1, 'chỉ đọc trang đầu');
  assert.doesNotMatch(omniGets(ext)[0], /modified_on_min/);
});

test('Omni thật: khách MỚI tạo trên Omni được bắt ngay lượt kế tiếp (gợi ý + ghép + đẩy lên Web)', async () => {
  const ext = loadExtension();
  realOmni(ext);
  ext.openOmniTab();
  bigShop(ext, 200);
  await ext.configure({ skipOmniGroupIds: '579639' });
  await ext.run(); await ext.run();                  // quét đầu + chuyển chế độ
  tick(3600 * 1000);
  const fresh = ext.omni.add({ name: 'Samsung Display Vietnam', phone_number: '0222333444', customer_group_id: 2 });
  resetCalls(ext);
  await ext.run();
  assert.strictEqual(omniGets(ext).length, 1);
  const s = await ext.send({ cmd: 'searchOmni', q: 'samsung' });
  assert.strictEqual(s.items[0].omni_id, String(fresh.id), 'có ngay trong khung gợi ý');
  assert.ok(pairs(ext).some(p => p.omni_id === String(fresh.id)), 'đã đẩy lên Web và ghép cặp');
});

test('Omni thật: sửa thông tin khách CŨ trên Omni → cập nhật ở lượt quét toàn bộ (mỗi 6 giờ), không sót', async () => {
  const ext = loadExtension();
  realOmni(ext);
  ext.openOmniTab();
  const old = ext.omni.add({ name: 'Intel', phone_number: '0281234567' });
  bigShop(ext, 120);
  await ext.configure({});
  await ext.run(); ext.connector.run(); await ext.run();
  ext.omni.edit(old.id, { email: 'buyer@intel.example' });
  await ext.run();                                   // lượt thường: chưa thấy (khách cũ không nằm trang đầu)
  tick(6 * 3600 * 1000);
  const r = await ext.run();
  assert.strictEqual(r.mode, 'full', 'đủ 6 giờ → quét toàn bộ');
  const intelWeb = [...ext.web.db.values()].find(w => w.first_name === 'Intel');
  assert.strictEqual(intelWeb.email, 'buyer@intel.example', 'đã cập nhật lên Web');
});

test('Omni thật: chiều Web → Omni vẫn cập nhật trong vòng 10 phút (Sapo Web hỗ trợ lọc theo thay đổi)', async () => {
  const ext = loadExtension();
  realOmni(ext);
  ext.openOmniTab();
  const W = ext.web.add({ first_name: 'Jabil', phone: '0909000111' }); ext.connector.run();
  bigShop(ext, 60);
  await ext.configure({});
  await ext.run(); await ext.run();
  ext.web.edit(W.id, { email: 'new@jabil.example' });
  const r = await ext.run();
  assert.strictEqual(r.mode, 'incremental');
  const jabilOmni = [...ext.omni.db.values()].find(c => c.name === 'Jabil');
  assert.strictEqual(jabilOmni.email, 'new@jabil.example');
});
