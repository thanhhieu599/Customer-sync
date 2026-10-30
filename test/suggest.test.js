/**
 * Gợi ý khách Sapo Omni ngay trong ô "Tìm kiếm khách hàng…" của Sapo Web.
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadExtension } = require('./ext-harness');

const writesOmni = ext => ext.omni.calls.filter(c => !c.startsWith('get '));
const pairs = ext => ext.rows().filter(r => r.status === 'pair');

async function setup() {
  const ext = loadExtension();
  ext.openOmniTab();
  const hv = ext.omni.add({ name: 'CÔNG TY TNHH TM DV THIẾT BỊ ĐIỆN HÙNG VƯƠNG', phone_number: '0969458080', sale_order: { order_purchases: 3 } });
  const intel = ext.omni.add({ name: 'Intel Products Vietnam', phone_number: '0281234567', email: 'purchasing@intel.example' });
  const noKey = ext.omni.add({ name: 'Khách lẻ không SĐT' });
  const jabilW = ext.web.add({ first_name: 'Jabil Việt Nam', phone: '+84909000111', email: 'buyer@jabil.example' });
  ext.connector.run();                                   // Sapo tạo bản tương ứng của Jabil bên Omni
  await ext.configure({ dryRun: true });
  await ext.run();                                       // quét toàn bộ lần đầu → có bản sao, không ghi gì
  return { ext, hv, intel, noKey, jabilW };
}
const search = (ext, q) => ext.send({ cmd: 'searchOmni', q });

test('gợi ý: gõ không dấu / một phần tên vẫn ra khách Omni', async () => {
  const { ext, hv } = await setup();
  let r = await search(ext, 'hung vuong');
  assert.ok(r.ready);
  assert.strictEqual(r.items[0].omni_id, String(hv.id));
  assert.strictEqual(r.items[0].web_id, '', 'chưa có trên Web');
  r = await search(ext, 'thiết bị điện');
  assert.strictEqual(r.items[0].omni_id, String(hv.id));
  r = await search(ext, 'intel');
  assert.strictEqual(r.items[0].email, 'purchasing@intel.example');
});

test('gợi ý: tìm theo SĐT, kể cả gõ dạng +84 hoặc một phần số', async () => {
  const { ext, hv } = await setup();
  for (const q of ['0969458080', '+84 969 458 080', '0969', '458080']) {
    const r = await search(ext, q);
    assert.ok(r.items.some(x => x.omni_id === String(hv.id)), 'tìm được với "' + q + '"');
  }
});

test('gợi ý: khách đã có trên Web được đánh dấu và kèm SĐT bên Web để điền vào ô tìm kiếm', async () => {
  const { ext } = await setup();
  const r = await search(ext, 'jabil');
  assert.strictEqual(r.items.length, 1);
  assert.ok(r.items[0].web_id, 'đã có trên Web');
  assert.strictEqual(r.items[0].web_phone, '+84909000111', 'đúng như Sapo Web đang lưu');
});

test('gợi ý: không gợi ý bản dội do Sapo tự sinh', async () => {
  const { ext, intel } = await setup();
  await ext.configure({ dryRun: false });
  await ext.run();                                       // tạo Intel lên Web
  ext.connector.run();                                   // Sapo dội Intel về Omni
  await ext.run();                                       // nhận diện bản dội
  const r = await search(ext, 'intel');
  assert.strictEqual(JSON.stringify(r.items.map(x => x.omni_id)), JSON.stringify([String(intel.id)]), 'chỉ bản gốc');
});

test('gợi ý: gõ phím KHÔNG gửi lệnh nào tới Sapo Omni (tìm trong bản sao)', async () => {
  const { ext } = await setup();
  ext.omni.calls.length = 0;
  for (const q of ['h', 'hu', 'hun', 'hung', 'hung v', 'hung vuong']) await search(ext, q);
  assert.strictEqual(ext.omni.calls.length, 0);
});

test('gợi ý: chưa quét lần đầu → báo cần quét, không lỗi', async () => {
  const ext = loadExtension();
  await ext.configure({});
  const r = await search(ext, 'intel');
  assert.strictEqual(r.ready, false);
});

test('đẩy lên Web: tạo khách trên Web, ghi bảng ghép; lượt đồng bộ sau KHÔNG tạo trùng', async () => {
  const { ext, hv } = await setup();
  const webBefore = ext.web.db.size;
  const r = await ext.send({ cmd: 'pushOmniToWeb', omniId: hv.id });
  assert.ok(r.ok && r.created, r.error);
  assert.strictEqual(r.phone, '0969458080');
  assert.strictEqual(ext.web.db.size, webBefore + 1);
  const w = ext.web.db.get(Number(r.web_id));
  assert.strictEqual(w.first_name, 'CÔNG TY TNHH TM DV THIẾT BỊ ĐIỆN HÙNG VƯƠNG');
  assert.strictEqual(w.phone, '0969458080');
  assert.ok(pairs(ext).some(p => p.omni_id === String(hv.id) && p.web_id === r.web_id));
  // Gõ lại → giờ đã có trên Web
  const s = await search(ext, 'hung vuong');
  assert.strictEqual(s.items[0].web_id, r.web_id);
  // Bấm lần nữa → không tạo thêm
  const again = await ext.send({ cmd: 'pushOmniToWeb', omniId: hv.id });
  assert.ok(again.existed);
  assert.strictEqual(ext.web.db.size, webBefore + 1);
  // Sapo dội bản về Omni + đồng bộ chạy thật → không tạo thêm khách Web nào cho Hùng Vương
  await ext.configure({ dryRun: false });
  ext.connector.run();
  await ext.run();
  const hvWeb = [...ext.web.db.values()].filter(x => /HÙNG VƯƠNG/.test(x.first_name));
  assert.strictEqual(hvWeb.length, 1, 'chỉ 1 khách Hùng Vương trên Web');
  assert.ok(ext.rows().some(x => x.status === 'echo'), 'bản dội được nhận diện');
  assert.deepStrictEqual(writesOmni(ext).filter(c => c.startsWith('post')), [], 'không tạo thêm trên Omni');
});

test('đẩy lên Web: khách chưa có SĐT/email → từ chối, tránh tạo trùng', async () => {
  const { ext, noKey } = await setup();
  const r = await ext.send({ cmd: 'pushOmniToWeb', omniId: noKey.id });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /chưa có SĐT hoặc email/);
});

test('đẩy lên Web: khách đã có trên Web (khác bảng ghép, trùng SĐT) → trả về khách sẵn có, không tạo', async () => {
  const { ext } = await setup();
  const jabilOmni = [...ext.omni.db.values()].find(c => /Jabil/.test(c.name));
  const size = ext.web.db.size;
  const r = await ext.send({ cmd: 'pushOmniToWeb', omniId: jabilOmni.id });
  assert.ok(r.ok && r.existed);
  assert.strictEqual(ext.web.db.size, size);
});
