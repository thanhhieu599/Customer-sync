/**
 * NHIỀU MÁY NHÂN VIÊN dùng chung 1 Sapo Omni + 1 Sapo Web (không có máy chủ riêng).
 * Mỗi máy: Chrome riêng, đăng nhập Omni riêng, bản sao danh bạ riêng.
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadExtension } = require('./ext-harness');
const { tick } = require('./harness');

const orderPuts = srv => srv.calls.filter(c => c.startsWith('put ') && /\/orders\//.test(c));

/** Cửa hàng chung + n máy. Máy đầu tiên tạo dữ liệu, các máy sau dùng chung Sapo. */
async function office(roles, cfg) {
  const first = loadExtension();
  const sapo = { web: first.web, omni: first.omni, connector: first.connector };
  sapo.omni.ignoreSince = true; sapo.omni.newestFirst = true;          // như Omni thật
  const goc = sapo.omni.add({ name: 'CÔNG TY TNHH SAMTEC VIỆT NAM', phone_number: '0945198545', sale_order: { order_purchases: 7 } });
  const hv = sapo.omni.add({ name: 'CÔNG TY TNHH TM DV THIẾT BỊ ĐIỆN HÙNG VƯƠNG', phone_number: '0969458080', sale_order: { order_purchases: 3 } });
  for (let i = 0; i < 60; i++) { tick(3600 * 1000); sapo.omni.add({ name: 'KH ' + i, phone_number: '09' + String(10000000 + i) }); }
  const machines = roles.map((role, i) => i === 0 ? first : loadExtension({ shareWith: sapo }));
  for (let i = 0; i < machines.length; i++) {
    const m = machines[i];
    m.openOmniTab();
    await m.configure(Object.assign({ syncCustomers: false, dryRun: false, role: roles[i] }, cfg || {}));
    tick(5 * 60000);
    await m.send({ cmd: 'runFull' });                                  // mỗi máy quét lần đầu vào giờ khác nhau
  }
  return { sapo, machines, goc, hv };
}

test('nhiều máy: máy A tạo khách lên Web, máy B (bản sao chưa cập nhật) chọn cùng khách → KHÔNG tạo trùng', async () => {
  const { sapo, machines: [A, B], goc } = await office(['staff', 'staff']);
  const before = sapo.web.db.size;
  const ra = await A.send({ cmd: 'pushOmniToWeb', omniId: goc.id });
  assert.ok(ra.ok && ra.created, ra.error);
  tick(30000);                                                          // 30 giây sau, B chưa có lượt đồng bộ nào
  const rb = await B.send({ cmd: 'pushOmniToWeb', omniId: goc.id });
  assert.ok(rb.ok && rb.existed, 'B nhận ra khách đã có trên Web: ' + JSON.stringify(rb));
  assert.strictEqual(rb.web_id, ra.web_id, 'B chọn đúng khách A vừa tạo');
  assert.strictEqual(sapo.web.db.size, before + 1, 'chỉ 1 khách trên Web');
  // Khung gợi ý của B giờ cũng hiện "Đã có trên Web"
  const s = await B.send({ cmd: 'searchOmni', q: 'samtec' });
  assert.strictEqual(s.items[0].web_id, ra.web_id);
});

test('nhiều máy: không kiểm tra được Sapo Web (mất mạng) → KHÔNG tạo mù, báo thử lại', async () => {
  const { sapo, machines: [A], goc } = await office(['staff']);
  const orig = sapo.web.handle;
  sapo.web.handle = (m, u, b) => m === 'get' ? [503, '{}'] : orig(m, u, b);
  const before = sapo.web.db.size;
  const r = await A.send({ cmd: 'pushOmniToWeb', omniId: goc.id });
  sapo.web.handle = orig;
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Chưa kiểm tra được Sapo Web/);
  assert.strictEqual(sapo.web.db.size, before);
});

test('nhiều máy: MÁY NHÂN VIÊN không đọc đơn, không chuyển đơn, không hiện thông báo đồng bộ', async () => {
  const { sapo, machines: [S], goc } = await office(['staff']);
  const r1 = await S.send({ cmd: 'pushOmniToWeb', omniId: goc.id });
  sapo.connector.run();
  sapo.connector.webOrder(Number(r1.web_id));
  sapo.omni.calls.length = 0; S.state.notes.length = 0;
  const r = await S.run();
  assert.ok(r.ok, r.error);
  assert.ok(!sapo.omni.calls.some(c => /orders/.test(c)), 'không đọc đơn');
  assert.deepStrictEqual(orderPuts(sapo.omni), []);
  assert.strictEqual(S.state.notes.length, 0, 'không thông báo');
  assert.match(r.summary, /\[MÁY NHÂN VIÊN\]/);
});

test('nhiều máy: 1 máy chính + 3 máy nhân viên → đơn Web được chuyển đúng 1 lần (chỉ máy chính làm)', async () => {
  const { sapo, machines, goc } = await office(['staff', 'server', 'staff', 'staff']);
  const [S1, M, S2, S3] = machines;
  const r1 = await S1.send({ cmd: 'pushOmniToWeb', omniId: goc.id });   // sale ở máy S1 chọn SAMTEC
  sapo.connector.run();                                                // Sapo sinh bản dội tag Web
  const o = sapo.connector.webOrder(Number(r1.web_id), { code: 'SON06500' });
  for (const m of [S1, S2, S3]) await m.run();
  assert.notStrictEqual(sapo.omni.orders.get(o.id).customer_id, goc.id, 'máy nhân viên không chuyển');
  await M.run();
  assert.strictEqual(sapo.omni.orders.get(o.id).customer_id, goc.id, 'máy chính chuyển về khách gốc');
  for (const m of machines) await m.run();
  assert.strictEqual(orderPuts(sapo.omni).length, 1, 'đúng 1 lệnh chuyển');
});

test('nhiều máy: 2 máy chính cùng bật chuyển đơn → vẫn đúng, đơn không bị chuyển 2 lần', async () => {
  const { sapo, machines: [M1, M2], hv } = await office(['server', 'server']);
  const w = sapo.web.add({ first_name: 'Hùng Vương', phone: '+84969458080' });
  const o = sapo.connector.webOrder(w.id);
  await M1.run(); await M2.run(); await M1.run(); await M2.run();
  assert.strictEqual(sapo.omni.orders.get(o.id).customer_id, hv.id);
  assert.strictEqual(orderPuts(sapo.omni).length, 1, 'máy sau thấy đơn đã đúng → bỏ qua');
});

test('nhiều máy: tải lên Omni khi 5 máy cùng chạy định kỳ – mỗi máy nhân viên chỉ 1 lệnh/lượt', async () => {
  const { sapo, machines } = await office(['server', 'staff', 'staff', 'staff', 'staff']);
  for (const m of machines) await m.run();                             // lượt chuyển chế độ "đọc khách mới"
  sapo.omni.calls.length = 0;
  for (const m of machines) await m.run();
  const perStaff = sapo.omni.calls.length;
  assert.strictEqual(perStaff, 4 * 1 + 2, '4 máy nhân viên × 1 lệnh + máy chính 2 lệnh (khách + đơn)');
});

test('nhiều máy: máy nhân viên quét toàn bộ 1 lần/ngày, lệch giờ ngẫu nhiên riêng từng máy', async () => {
  const { machines: [S] } = await office(['staff']);
  await S.run();
  S.state.store.machine = { jitterMin: 45 };                           // máy này lệch 45 phút
  tick(24 * 3600 * 1000 + 30 * 60000);
  await S.configure({ role: 'staff', fullScanHour: (new Date(Date.now()).getHours() + 12) % 24 });
  let r = await S.run();
  assert.strictEqual(r.mode, 'incremental', '24 giờ 30 phút: chưa tới giờ của máy này');
  tick(20 * 60000);
  r = await S.run();
  assert.strictEqual(r.mode, 'full', 'quá 24 giờ 45 phút: quét toàn bộ');
});

test('nhiều máy: mỗi máy tự sinh khoảng lệch riêng (0–120 phút) và giữ cố định', async () => {
  const { machines } = await office(['staff', 'staff', 'staff']);
  const j = machines.map(m => m.state.store.machine && m.state.store.machine.jitterMin);
  j.forEach(x => assert.ok(x >= 0 && x <= 120));
  await machines[0].run();
  assert.strictEqual(machines[0].state.store.machine.jitterMin, j[0], 'không đổi giữa các lượt');
});

test('chuyển đơn: chọn xét 72 giờ → đơn 48 giờ trước vẫn được chuyển (máy chính tắt qua cuối tuần)', async () => {
  const { sapo, machines: [M], hv } = await office(['server'], { orderWindowHours: 72 });
  const w = sapo.web.add({ first_name: 'Hùng Vương', phone: '+84969458080' });
  const o = sapo.connector.webOrder(w.id);
  tick(48 * 3600 * 1000);                                               // máy chính tắt 2 ngày
  await M.run();
  assert.strictEqual(sapo.omni.orders.get(o.id).customer_id, hv.id);
});

test('chuyển đơn: xét 24 giờ (mặc định) → đơn 48 giờ trước KHÔNG tự chuyển', async () => {
  const { sapo, machines: [M] } = await office(['server']);
  const w = sapo.web.add({ first_name: 'Hùng Vương', phone: '+84969458080' });
  const o = sapo.connector.webOrder(w.id);
  const before = o.customer_id;
  tick(48 * 3600 * 1000);
  await M.run();
  assert.strictEqual(sapo.omni.orders.get(o.id).customer_id, before);
});

test('nhiều máy: máy nhân viên KHÔNG hiện thông báo đồng bộ kể cả khi bật đẩy khách hàng loạt', async () => {
  const { sapo, machines: [S] } = await office(['staff'], { syncCustomers: true, maxCreate: 5 });
  sapo.omni.add({ name: 'Khách mới', phone_number: '0912345678' });
  S.state.notes.length = 0;
  const r = await S.run();
  assert.ok(r.stats.createdWeb > 0, 'có tạo khách');
  assert.strictEqual(S.state.notes.length, 0, 'không thông báo trên máy nhân viên');
});
