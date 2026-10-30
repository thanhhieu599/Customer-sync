/**
 * Chế độ CHỈ GHÉP (mặc định từ v1.5): không tạo / không sửa khách ở bên nào,
 * chỉ ghi nhận "khách Web nào là khách gốc nào trên Omni" – nền tảng để chuyển đơn về đúng khách.
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadExtension } = require('./ext-harness');

const writes = srv => srv.calls.filter(c => !c.startsWith('get '));

async function realData() {
  const ext = loadExtension();
  ext.omni.ignoreSince = true; ext.omni.newestFirst = true;     // như Omni thật
  ext.openOmniTab();
  // Omni lưu SĐT dạng 0…, Web lưu dạng +84… (đúng như dữ liệu thật D&T)
  const hv = ext.omni.add({ name: 'CÔNG TY TNHH TM DV THIẾT BỊ ĐIỆN HÙNG VƯƠNG', phone_number: '0969458080', sale_order: { order_purchases: 3 } });
  const th = ext.omni.add({ name: 'Thanh Hiếu', phone_number: '0823242051', email: 'thabhhieu782022@gmail.com' });
  const onlyOmni = ext.omni.add({ name: 'Khách quầy', phone_number: '0911000222' });
  const wHv = ext.web.add({ first_name: 'Hùng Vương', phone: '+84969458080' });
  const wTh = ext.web.add({ first_name: 'Thanh Hiếu', phone: '+84823242051' });
  const onlyWeb = ext.web.add({ first_name: 'Khách web mới', phone: '+84983503360' });
  ext.connector.run();                                          // Sapo sinh bản dội cho 3 khách Web
  await ext.configure({ syncCustomers: false, dryRun: false });
  return { ext, hv, th, onlyOmni, wHv, wTh, onlyWeb };
}

test('chỉ ghép: SĐT Web +84… vẫn ghép đúng khách gốc Omni 0…; KHÔNG ghi gì lên Sapo', async () => {
  const { ext, hv, th, wHv, wTh } = await realData();
  ext.web.calls.length = 0; ext.omni.calls.length = 0;
  const r = await ext.run();
  assert.ok(r.ok, r.error);
  assert.deepStrictEqual(writes(ext.web), [], 'không ghi lên Web');
  assert.deepStrictEqual(writes(ext.omni), [], 'không ghi lên Omni');
  const pairs = ext.rows().filter(x => x.status === 'pair');
  assert.ok(pairs.some(p => p.omni_id === String(hv.id) && p.web_id === String(wHv.id)), 'Hùng Vương: Web +84 ↔ Omni gốc 0…');
  assert.ok(pairs.some(p => p.omni_id === String(th.id) && p.web_id === String(wTh.id)), 'Thanh Hiếu');
  assert.match(r.summary, /\[CHỈ GHÉP\]/);
  assert.match(r.summary, /chỉ có trên Omni: 1/);
});

test('chỉ ghép: bản dội Sapo sinh ra được nhận diện, ghép vào khách GỐC (nhiều đơn hơn), không vào bản dội', async () => {
  const { ext, hv, wHv } = await realData();
  await ext.run();
  const pair = ext.rows().find(x => x.status === 'pair' && x.web_id === String(wHv.id));
  assert.strictEqual(pair.omni_id, String(hv.id));
  assert.ok(ext.rows().some(x => x.status === 'echo'), 'bản dội được đánh dấu');
});

test('chỉ ghép: sửa khách ở 1 bên → KHÔNG đẩy sang bên kia', async () => {
  const { ext, hv } = await realData();
  await ext.run();
  ext.omni.edit(hv.id, { email: 'ketoan@hungvuong.example' });
  ext.web.calls.length = 0;
  await ext.run({});
  await ext.send({ cmd: 'runFull' });
  assert.deepStrictEqual(writes(ext.web), []);
});

test('chỉ ghép + chọn trong ô gợi ý: khách chỉ có trên Omni → tự tạo đúng 1 khách đó trên Web (không đẩy hàng loạt)', async () => {
  const { ext, onlyOmni } = await realData();
  await ext.run();
  const s = await ext.send({ cmd: 'searchOmni', q: 'khach quay' });
  assert.strictEqual(s.canCreate, true, 'mặc định cho phép tạo khi người dùng bấm chọn');
  assert.strictEqual(s.items[0].omni_id, String(onlyOmni.id));
  const size = ext.web.db.size;
  const r = await ext.send({ cmd: 'pushOmniToWeb', omniId: onlyOmni.id });
  assert.ok(r.ok && r.created, r.error);
  assert.strictEqual(ext.web.db.size, size + 1, 'chỉ tạo đúng 1 khách được chọn');
  assert.strictEqual(ext.web.db.get(Number(r.web_id)).phone, '0911000222');
  // Lượt đồng bộ chỉ ghép sau đó: không tạo thêm gì, không sửa gì
  ext.web.calls.length = 0; ext.omni.calls.length = 0;
  ext.connector.run();
  await ext.run();
  assert.deepStrictEqual(writes(ext.web), []);
  assert.ok(!writes(ext.omni).some(c => /customers/.test(c)), 'không ghi khách lên Omni');
});

test('chỉ ghép + TẮT "tạo khi chọn": ô gợi ý không tạo khách, hướng dẫn dùng nút của Sapo', async () => {
  const { ext, onlyOmni } = await realData();
  await ext.configure({ syncCustomers: false, createOnPick: false });
  await ext.run();
  const s = await ext.send({ cmd: 'searchOmni', q: 'khach quay' });
  assert.strictEqual(s.canCreate, false);
  const size = ext.web.db.size;
  const r = await ext.send({ cmd: 'pushOmniToWeb', omniId: onlyOmni.id });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Tạo khách lên Web khi chọn/);
  assert.strictEqual(ext.web.db.size, size);
});

test('tạo khi chọn trong lúc tiện ích đang đồng bộ → vẫn tạo ngay, lượt sau tự ghép lại, không trùng', async () => {
  const { ext, onlyOmni } = await realData();
  await ext.run();
  ext.state.store.lock = Date.now();                 // giả lập đang có lượt đồng bộ chạy
  const r = await ext.send({ cmd: 'pushOmniToWeb', omniId: onlyOmni.id });
  assert.ok(r.ok && r.created, r.error);
  assert.ok(ext.state.store.lock, 'không nhả khóa của lượt đang chạy');
  delete ext.state.store.lock;
  const size = ext.web.db.size;
  ext.connector.run();
  await ext.run();
  assert.ok(ext.rows().some(x => x.status === 'pair' && x.omni_id === String(onlyOmni.id) && x.web_id === r.web_id), 'lượt sau tự ghép');
  assert.strictEqual(ext.web.db.size, size, 'không tạo trùng');
});

test('chỉ ghép: khách Web chưa có trên Omni → để nguyên, không bao giờ tạo sang Omni', async () => {
  const { ext } = await realData();
  for (let i = 0; i < 5; i++) { await ext.run(); }
  assert.deepStrictEqual(writes(ext.omni), []);
  assert.ok(!ext.rows().some(x => x.status === 'pending_web'));
});
