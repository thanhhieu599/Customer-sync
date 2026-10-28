const test = require('node:test');
const assert = require('node:assert');
const { loadSystem, tick } = require('./harness');

function writes(srv) { return srv.calls.filter(c => !c.startsWith('get ')); }
function resetCalls(sys) { sys.web.calls.length = 0; sys.omni.calls.length = 0; }
function byStatus(sys, st) { return sys.mapRows().filter(r => r.status === st); }

/** Dữ liệu giống thực tế: khách gốc trên Omni, khách tự đăng ký trên Web, bộ kết nối dội khách */
function seed(sys) {
  const { web, omni, connector } = sys;
  const O1 = omni.add({ name: 'CÔNG TY TNHH TM DV THIẾT BỊ ĐIỆN HÙNG VƯƠNG', phone_number: '0969458080',
    addresses: [{ address1: 'Số 184A Hoàng Cầm, TP.HCM', phone_number: '0969458080' }],
    sale_order: { order_purchases: 3 } });
  const O2 = omni.add({ name: 'Intel Products Vietnam', phone_number: '0281234567', email: 'Purchasing@Intel.example',
    tax_number: '0301234567', addresses: [{ address1: 'Lô I2, Khu Công nghệ cao, TP.HCM' }] });
  const O3 = omni.add({ name: 'Khách lẻ không SĐT' });
  // Khách tự đăng ký trên Web (SĐT dạng +84) → bộ kết nối tạo bản dội O1e bên Omni
  const W1 = web.add({ first_name: 'Hùng Vương', last_name: '', phone: '+84969458080' });
  // Khách chỉ có trên Web → bộ kết nối tạo bản tương ứng bên Omni
  const W2 = web.add({ first_name: 'Jabil Việt Nam', phone: '0909000111', email: 'buyer@jabil.example',
    addresses: [{ address1: 'KCN Sài Gòn Hi-Tech Park' }] });
  connector.run();
  return { O1, O2, O3, W1, W2 };
}

test('lượt đầu: ghép đúng, tạo khách còn thiếu, nhận diện bản dội, không lặp vô hạn', () => {
  const sys = loadSystem();
  const { O1, O2, W1, W2 } = seed(sys);

  sys.run();
  let pairs = byStatus(sys, 'pair');
  assert.strictEqual(pairs.length, 3, 'Hùng Vương, Jabil, Intel');
  assert.ok(pairs.find(r => r.omni_id === String(O1.id) && r.web_id === String(W1.id)), 'Hùng Vương ghép với bản gốc có đơn');
  assert.ok(pairs.find(r => r.web_id === String(W2.id)), 'Jabil ghép với bản Sapo tạo');
  assert.strictEqual(byStatus(sys, 'echo').length, 1, 'bản dội của Hùng Vương');
  assert.strictEqual(sys.web.db.size, 3, 'Intel được tạo lên Web');
  const intelWeb = [...sys.web.db.values()].find(c => c.first_name === 'Intel Products Vietnam');
  assert.strictEqual(intelWeb.email, 'purchasing@intel.example');
  assert.match(intelWeb.tags, /MST:0301234567/);
  assert.match(intelWeb.tags, /omni:CUZN0/);

  // Sapo dội Intel về Omni → lượt 2 phải nhận ra, không tạo thêm gì
  sys.connector.run();
  resetCalls(sys);
  sys.run();
  assert.strictEqual(byStatus(sys, 'echo').length, 2);
  assert.deepStrictEqual(writes(sys.web).filter(c => c.startsWith('post')), []);
  assert.deepStrictEqual(writes(sys.omni).filter(c => c.startsWith('post')), []);

  // Lượt 3: ổn định, không ghi gì (dù Web đã tự đổi SĐT sang +84)
  sys.connector.run();
  resetCalls(sys);
  sys.run();
  assert.deepStrictEqual(writes(sys.web), []);
  assert.deepStrictEqual(writes(sys.omni), []);
  assert.strictEqual(sys.web.db.size, 3);
});

test('sửa trên Omni → cập nhật Web; sửa trên Web → cập nhật Omni; sau đó ổn định', () => {
  const sys = loadSystem();
  const { O2, W2 } = seed(sys);
  sys.run(); sys.connector.run(); sys.run();

  sys.omni.edit(O2.id, { name: 'Intel Products Vietnam Co., Ltd', addresses: [{ id: O2.addresses[0].id, address1: 'Lô I2-I3, SHTP, TP Thủ Đức', status: 'active' }] });
  const jabilOmni = byStatus(sys, 'pair').find(r => r.web_id === String(W2.id)).omni_id;
  sys.web.edit(W2.id, { email: 'procurement@jabil.example' });
  sys.run();

  const intelWeb = [...sys.web.db.values()].find(c => /Intel/.test(c.first_name));
  assert.strictEqual(intelWeb.first_name, 'Intel Products Vietnam Co., Ltd');
  assert.strictEqual(intelWeb.default_address.address1, 'Lô I2-I3, SHTP, TP Thủ Đức');
  assert.strictEqual(sys.omni.db.get(Number(jabilOmni)).email, 'procurement@jabil.example');

  resetCalls(sys);
  sys.run();
  assert.deepStrictEqual(writes(sys.web), [], 'không ghi lặp bên Web');
  assert.deepStrictEqual(writes(sys.omni), [], 'không ghi lặp bên Omni');
});

test('xung đột: cùng sửa 2 bên → bản sửa sau cùng thắng', () => {
  const sys = loadSystem();
  const { O1, W1 } = seed(sys);
  sys.run(); sys.connector.run(); sys.run();

  sys.web.edit(W1.id, { email: 'web@hungvuong.example' });
  tick(5000);
  sys.omni.edit(O1.id, { email: 'omni@hungvuong.example' });
  sys.run();
  assert.strictEqual(sys.web.db.get(W1.id).email, 'omni@hungvuong.example');
  assert.strictEqual(sys.omni.db.get(O1.id).email, 'omni@hungvuong.example');
  assert.ok(sys.logRows().some(l => /xung đột/.test(l.action)));
});

test('DELETE_ECHO=true: xóa bản dội 0 đơn; giữ bản trùng có sẵn từ trước', () => {
  const sys = loadSystem({ props: { DELETE_ECHO: 'true' } });
  // Bản trùng cũ có sẵn trên Omni (tạo trước khi có khách Web), có đơn
  sys.omni.add({ name: 'Hùng Vương (cũ)', phone_number: '0969458080', sale_order: { order_purchases: 1 } });
  const { O2 } = seed(sys);
  sys.run(); sys.connector.run(); sys.run();

  assert.strictEqual(byStatus(sys, 'echo_deleted').length, 2, 'bản dội Hùng Vương + Intel bị xóa');
  assert.strictEqual(byStatus(sys, 'dup').length, 1, 'bản trùng cũ giữ nguyên');
  const intelCopies = [...sys.omni.db.values()].filter(c => c.phone_number === '0281234567');
  assert.deepStrictEqual(intelCopies.map(c => c.id), [O2.id]);
});

test('khách Web mới mà Sapo không tạo bên Omni → chờ 30 phút rồi tự tạo trên Omni', () => {
  const sys = loadSystem();
  seed(sys);
  sys.run(); sys.connector.run(); sys.run();

  const W = sys.web.add({ first_name: 'Samsung SEV', phone: '0222111222', email: 'sev@samsung.example' });
  sys.run();
  assert.ok(byStatus(sys, 'pending_web').find(r => r.web_id === String(W.id)));
  sys.run();
  assert.ok(byStatus(sys, 'pending_web').find(r => r.web_id === String(W.id)), 'vẫn chờ khi chưa đủ 30 phút');
  tick(31 * 60000);
  sys.run();
  const pair = byStatus(sys, 'pair').find(r => r.web_id === String(W.id));
  assert.ok(pair, 'đã tạo bên Omni và ghép cặp');
  assert.strictEqual(sys.omni.db.get(Number(pair.omni_id)).name, 'Samsung SEV');
  assert.strictEqual(byStatus(sys, 'pending_web').length, 0);
});

test('khách Web mới, Sapo tạo bên Omni → tự ghép, không tạo thêm', () => {
  const sys = loadSystem();
  seed(sys);
  sys.run(); sys.connector.run(); sys.run();
  const W = sys.web.add({ first_name: 'Foxconn', phone: '0333444555' });
  sys.connector.run();
  resetCalls(sys);
  sys.run();
  assert.ok(byStatus(sys, 'pair').find(r => r.web_id === String(W.id)));
  assert.deepStrictEqual(writes(sys.omni).filter(c => c.startsWith('post')), []);
  assert.deepStrictEqual(writes(sys.web).filter(c => c.startsWith('post')), []);
});

test('CHẠY THỬ: không ghi gì lên Sapo, không lưu bảng ghép, nhật ký ghi [THỬ]', () => {
  const sys = loadSystem({ props: { DRY_RUN: 'true' } });
  seed(sys);
  resetCalls(sys);
  sys.run();
  assert.deepStrictEqual(writes(sys.web), []);
  assert.deepStrictEqual(writes(sys.omni), []);
  assert.strictEqual(sys.mapRows().length, 0);
  assert.ok(sys.logRows().some(l => /\[THỬ\] Tạo khách trên Web/.test(l.action)));
  assert.ok(sys.logRows().some(l => /CHẠY THỬ/.test(l.detail)));
});

test('giới hạn số khách tạo mỗi lượt + tự thử lại khi Sapo báo quá tải (429)', () => {
  const sys = loadSystem({ props: { MAX_CREATE_PER_RUN: '2' } });
  for (let i = 0; i < 5; i++) sys.omni.add({ name: 'Khách ' + i, phone_number: '090000000' + i });
  sys.omni.failNext = 2;
  sys.run();
  assert.strictEqual(sys.web.db.size, 2);
  sys.run(); sys.run();
  assert.strictEqual(sys.web.db.size, 5);
  sys.run();
  assert.strictEqual(sys.web.db.size, 5, 'không tạo thừa');
});

test('một bên bị xóa → đánh dấu mất 1 bên, không tự tạo lại', () => {
  const sys = loadSystem();
  const { W2 } = seed(sys);
  sys.run(); sys.connector.run(); sys.run();
  sys.web.db.delete(W2.id);
  resetCalls(sys);
  sys.run();
  assert.strictEqual(byStatus(sys, 'orphan').length, 1);
  assert.deepStrictEqual(writes(sys.web).filter(c => c.startsWith('post')), []);
  assert.ok(sys.logRows().some(l => /Mất 1 bên/.test(l.action)));
});

test('an toàn: Sapo trả thiếu dữ liệu → dừng, không đánh dấu nhầm, không tạo gì', () => {
  const sys = loadSystem();
  seed(sys);
  sys.run(); sys.connector.run(); sys.run();
  const before = JSON.stringify(sys.mapRows());
  // Giả lập lỗi lật trang của Web: trang nào cũng rỗng
  const orig = sys.web.handle;
  sys.web.handle = (m, url, body) => (m === 'get' && /customers\.json\?/.test(url))
    ? [200, JSON.stringify({ customers: [] })] : orig(m, url, body);
  resetCalls(sys);
  sys.run();
  assert.strictEqual(JSON.stringify(sys.mapRows()), before, 'bảng ghép giữ nguyên');
  assert.deepStrictEqual(writes(sys.omni), []);
  assert.ok(sys.logRows().some(l => l.action === 'DỪNG' && /0\/3/.test(l.detail)));
});

test('an toàn: nhiều cặp mất 1 bên cùng lúc → dừng và gửi email cảnh báo', () => {
  const sys = loadSystem({ props: { ALERT_EMAIL: 'admin@example.com' } });
  for (let i = 0; i < 10; i++) sys.omni.add({ name: 'KH ' + i, phone_number: '091000000' + i });
  sys.run(); sys.connector.run(); sys.run();
  assert.strictEqual(byStatus(sys, 'pair').length, 10);
  [...sys.web.db.keys()].slice(0, 7).forEach(id => sys.web.db.delete(id));
  sys.run();
  assert.strictEqual(byStatus(sys, 'orphan').length, 0, 'không đánh dấu hàng loạt');
  assert.ok(sys.mails.some(m => /bị dừng/.test(m.sub)));
});
