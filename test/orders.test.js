/**
 * Chuyển đơn từ Sapo Web về đúng khách gốc trên Omni.
 * Mô phỏng đúng hành vi thật (kiểm chứng 30/10/2026 trên đơn SON06378):
 *  - Đơn Web về Omni: kênh "Sapoweb", nguồn 1126437, gắn vào khách bản dội mang tag "Web"
 *  - Omni cho đổi khách trên đơn đã chốt qua PUT { order: { id, customer_id } } → 200
 *  - Sapo Web lưu SĐT +84…, Omni lưu 0…
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadExtension } = require('./ext-harness');
const { tick } = require('./harness');

const orderPuts = ext => ext.omni.calls.filter(c => c.startsWith('put ') && /\/orders\//.test(c));
const logs = (ext, re) => ext.log().filter(l => re.test(l.action));

async function shop(cfg) {
  const ext = loadExtension();
  ext.omni.ignoreSince = true; ext.omni.newestFirst = true;          // như Omni thật
  ext.openOmniTab();
  const goc = ext.omni.add({ name: 'CÔNG TY TNHH TM DV THIẾT BỊ ĐIỆN HÙNG VƯƠNG', phone_number: '0969458080', sale_order: { order_purchases: 3 } });
  const web = ext.web.add({ first_name: 'Hùng Vương', phone: '+84969458080' });
  ext.connector.run();                                               // Sapo sinh bản dội (tag Web)
  const echoId = ext.connector.link.get(web.id);
  await ext.configure(Object.assign({ syncCustomers: false, dryRun: false }, cfg || {}));
  await ext.run();                                                   // quét toàn bộ lần đầu
  return { ext, goc, web, echoId };
}

test('chuyển đơn: đơn Web gắn vào bản dội → tự chuyển về khách gốc, đọc lại xác nhận, báo cho người dùng', async () => {
  const { ext, goc, web, echoId } = await shop();
  const o = ext.connector.webOrder(web.id, { code: 'SON06400', total: 216000 });
  assert.strictEqual(o.customer_id, echoId, 'giống thật: đơn về bản dội');
  const r = await ext.run();
  assert.ok(r.ok, r.error);
  assert.strictEqual(ext.omni.orders.get(o.id).customer_id, goc.id, 'đơn đã về khách gốc');
  assert.strictEqual(ext.omni.db.get(goc.id).sale_order.order_purchases, 4, 'khách gốc +1 đơn');
  assert.strictEqual(ext.omni.db.get(echoId).sale_order.order_purchases, 0, 'bản dội 0 đơn');
  assert.strictEqual(r.fix.moved, 1);
  assert.match(r.summary, /đã chuyển về khách gốc: 1/);
  const l = logs(ext, /^Đã chuyển đơn về khách gốc$/);
  assert.strictEqual(l.length, 1);
  assert.match(l[0].detail, /SON06400.*216\.000đ.*→ "CÔNG TY TNHH TM DV THIẾT BỊ ĐIỆN HÙNG VƯƠNG"/);
  assert.ok(ext.state.notes.some(n => /Đã chuyển 1 đơn Web về đúng khách gốc/.test(n.title)));
  // Đúng dạng lệnh đã kiểm chứng trên Omni thật
  assert.strictEqual(orderPuts(ext).length, 1);
});

test('chuyển đơn: lượt sau KHÔNG xử lý lại đơn đã chuyển (không gửi lệnh thừa)', async () => {
  const { ext, web } = await shop();
  ext.connector.webOrder(web.id);
  await ext.run();
  ext.omni.calls.length = 0;
  await ext.run(); await ext.run();
  assert.deepStrictEqual(orderPuts(ext), []);
});

test('chuyển đơn: CHẠY THỬ chỉ ghi "Sẽ chuyển…", không đổi đơn', async () => {
  const { ext, web, echoId } = await shop({ dryRun: true });
  const o = ext.connector.webOrder(web.id, { code: 'SON06401' });
  const r = await ext.run();
  assert.strictEqual(ext.omni.orders.get(o.id).customer_id, echoId, 'đơn giữ nguyên');
  assert.deepStrictEqual(orderPuts(ext), []);
  assert.match(r.summary, /sẽ chuyển về khách gốc: 1/);
  assert.ok(logs(ext, /\[THỬ\] Sẽ chuyển đơn về khách gốc/).some(l => /SON06401/.test(l.detail)));
});

test('chuyển đơn: khách hoàn toàn mới (chưa có hồ sơ gốc) → giữ nguyên đơn', async () => {
  const { ext } = await shop();
  const moi = ext.web.add({ first_name: 'Khách mới', phone: '+84983503360' });
  const o = ext.connector.webOrder(moi.id);
  const before = o.customer_id;
  const r = await ext.run();
  assert.strictEqual(ext.omni.orders.get(o.id).customer_id, before);
  assert.strictEqual(r.fix.noMaster, 1);
  assert.deepStrictEqual(orderPuts(ext), []);
});

test('chuyển đơn: 2 hồ sơ gốc cùng SĐT (không rõ đâu là gốc) → KHÔNG chuyển, cảnh báo xem tay', async () => {
  const { ext, web, echoId } = await shop();
  ext.omni.add({ name: 'Hùng Vương (hồ sơ 2)', phone_number: '0969458080' });
  await ext.send({ cmd: 'runFull' });
  const o = ext.connector.webOrder(web.id, { code: 'SON06402' });
  const r = await ext.run();
  assert.strictEqual(ext.omni.orders.get(o.id).customer_id, echoId, 'không đoán bừa');
  assert.strictEqual(r.fix.ambiguous, 1);
  const w = logs(ext, /Đơn Web cần xem tay/);
  assert.strictEqual(w.length, 1);
  assert.match(w[0].detail, /SON06402.*2 hồ sơ/);
  assert.strictEqual(ext.status().state, 'warn');
  await ext.run(); await ext.run();
  assert.strictEqual(logs(ext, /Đơn Web cần xem tay/).length, 1, 'chỉ báo 1 lần, không lặp lại mỗi 10 phút');
});

test('chuyển đơn: chỉ xét đơn Web; đơn tại quầy và đơn cũ hơn 24 giờ không đụng tới', async () => {
  const { ext, goc, web, echoId } = await shop();
  const old = ext.connector.webOrder(web.id, { code: 'SON06300' });
  tick(25 * 3600 * 1000);
  const pos = ext.omni.addOrder(echoId, { code: 'SON06403', channel: null, source_id: 1000001 });
  await ext.send({ cmd: 'runFull' });
  assert.strictEqual(ext.omni.orders.get(old.id).customer_id, echoId, 'đơn cũ hơn 24 giờ giữ nguyên');
  assert.strictEqual(ext.omni.orders.get(pos.id).customer_id, echoId, 'đơn không phải từ Web giữ nguyên');
  assert.deepStrictEqual(orderPuts(ext), []);
  assert.ok(goc);
});

test('chuyển đơn: khách Web chỉ có email (không SĐT) → khớp theo email', async () => {
  const ext = loadExtension();
  ext.omni.ignoreSince = true; ext.omni.newestFirst = true;
  ext.openOmniTab();
  const goc = ext.omni.add({ name: 'Công ty DT – Hóa đơn', phone_number: '', email: 'hoadon.congtydt@gmail.com', sale_order: { order_purchases: 5 } });
  const web = ext.web.add({ first_name: 'Hóa Đơn CTY DT', email: 'HoaDon.CongTyDT@gmail.com' });
  await ext.configure({ syncCustomers: false });
  await ext.run();
  const o = ext.connector.webOrder(web.id);
  await ext.run();
  assert.strictEqual(ext.omni.orders.get(o.id).customer_id, goc.id);
});

test('chuyển đơn: Omni nhận lệnh nhưng KHÔNG lưu → báo lỗi, không ghi nhớ, lượt sau thử lại', async () => {
  const { ext, goc, web } = await shop();
  const o = ext.connector.webOrder(web.id, { code: 'SON06404' });
  ext.omni.ignoreOrderCustomer = true;
  const r = await ext.run();
  assert.strictEqual(r.fix.errors, 1);
  assert.ok(logs(ext, /Chuyển đơn chưa thành công/).length === 1);
  assert.strictEqual(ext.status().state, 'error');
  ext.omni.ignoreOrderCustomer = false;
  await ext.run();
  assert.strictEqual(ext.omni.orders.get(o.id).customer_id, goc.id, 'lượt sau thử lại thành công');
});

test('chuyển đơn: Omni quá tải khi đang chuyển → dừng ngay, tạm nghỉ; đơn đã chuyển xong được ghi nhớ', async () => {
  const { ext, goc, web } = await shop();
  const o1 = ext.connector.webOrder(web.id, { code: 'SON06405' });
  const o2 = ext.connector.webOrder(web.id, { code: 'SON06406' });
  const orig = ext.omni.handle; let puts = 0;
  ext.omni.handle = (m, u, b) => (m === 'put' && /orders/.test(u) && ++puts > 1) ? [503, '{}'] : orig(m, u, b);
  const r = await ext.run();
  assert.ok(r.overload);
  assert.strictEqual(ext.status().state, 'paused');
  const movedIds = [o1, o2].filter(o => ext.omni.orders.get(o.id).customer_id === goc.id);
  assert.strictEqual(movedIds.length, 1, 'đơn thứ nhất đã chuyển');
  ext.omni.handle = orig;
  tick(61 * 60000);
  ext.omni.calls.length = 0;
  await ext.run();
  assert.strictEqual(ext.omni.orders.get(o1.id).customer_id, goc.id);
  assert.strictEqual(ext.omni.orders.get(o2.id).customer_id, goc.id);
  assert.strictEqual(orderPuts(ext).length, 1, 'chỉ chuyển nốt đơn còn lại, không gửi lại đơn đã xong');
});

test('chuyển đơn: hết phiên đăng nhập giữa chừng → dừng, báo đăng nhập lại, không đánh dấu sai', async () => {
  const { ext, goc, web } = await shop();
  const o = ext.connector.webOrder(web.id);
  const orig = ext.omni.handle;
  // Phiên hết hạn ngay sau khi đọc danh sách đơn → lệnh chuyển đơn gặp trang đăng nhập
  ext.omni.handle = (m, u, b) => { const res = orig(m, u, b); if (m === 'get' && /\/orders\.json\?limit/.test(u)) ext.state.loggedIn = false; return res; };
  ext.state.loginMode = 'html';
  const r = await ext.run();
  ext.omni.handle = orig;
  assert.ok(r.session, 'dừng vì hết phiên');
  assert.notStrictEqual(ext.omni.orders.get(o.id).customer_id, goc.id, 'chưa chuyển');
  assert.ok(!(ext.state.store.orderFix || {})[String(o.id)], 'không ghi nhớ đơn chưa chuyển');
  ext.state.loggedIn = true;
  const r2 = await ext.run();
  assert.ok(r2.ok, r2.error);
  assert.strictEqual(ext.omni.orders.get(o.id).customer_id, goc.id);
});

test('chuyển đơn: TẮT trong cài đặt → không đọc đơn, không đổi đơn', async () => {
  const { ext, web, echoId } = await shop({ fixOrders: false });
  const o = ext.connector.webOrder(web.id);
  ext.omni.calls.length = 0;
  await ext.run();
  assert.strictEqual(ext.omni.orders.get(o.id).customer_id, echoId);
  assert.ok(!ext.omni.calls.some(c => /orders\.json/.test(c)));
});

test('chuyển đơn: mỗi lượt chỉ thêm 1 lệnh đọc danh sách đơn (nhẹ cho Omni)', async () => {
  const { ext, web } = await shop();
  for (let i = 0; i < 30; i++) { tick(60000); ext.omni.addOrder(ext.connector.link.get(web.id), { channel: null }); }
  ext.omni.calls.length = 0;
  await ext.run();
  assert.strictEqual(ext.omni.calls.filter(c => /orders\.json/.test(c)).length, 1);
});

test('chuyển đơn: đơn Web đã nằm ở khách gốc (không phải bản dội) → không đụng tới', async () => {
  const { ext, goc } = await shop();
  const o = ext.omni.addOrder(goc.id, { channel: 'Sapoweb', source_id: 1126437 });
  const r = await ext.run();
  assert.strictEqual(ext.omni.orders.get(o.id).customer_id, goc.id);
  assert.deepStrictEqual(orderPuts(ext), []);
  assert.strictEqual(r.fix.ok, 1);
});

test('chuyển đơn: hồ sơ "gốc" lại được tạo SAU khách trên đơn → không chắc, không chuyển', async () => {
  const ext = loadExtension();
  ext.omni.ignoreSince = true; ext.omni.newestFirst = true;
  ext.openOmniTab();
  const web = ext.web.add({ first_name: 'Anh Tuấn', phone: '+84977000111' });
  ext.connector.run();                                      // khách Web có trên Omni từ trước (tag Web)
  const echoId = ext.connector.link.get(web.id);
  tick(3600 * 1000);
  ext.omni.add({ name: 'Anh Tuấn (nhập tay sau)', phone_number: '0977000111' });   // hồ sơ tạo SAU
  await ext.configure({ syncCustomers: false });
  await ext.run();
  const o = ext.connector.webOrder(web.id);
  const r = await ext.run();
  assert.strictEqual(ext.omni.orders.get(o.id).customer_id, echoId);
  assert.strictEqual(r.fix.ambiguous, 1);
});
