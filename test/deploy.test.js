const test = require('node:test');
const assert = require('node:assert');
const { loadSystem } = require('./harness');

test('tệp gộp dist/Code.gs chạy đúng như bản 4 tệp', () => {
  const sys = loadSystem({ bundle: true });
  sys.omni.add({ name: 'Intel', phone_number: '0281234567' });
  sys.web.add({ first_name: 'Jabil', phone: '0909000111' });
  sys.connector.run();
  sys.run(); sys.connector.run(); sys.run();
  assert.strictEqual(sys.mapRows().filter(r => r.status === 'pair').length, 2);
  assert.strictEqual(sys.web.db.size, 2);
});

test('Kiểm tra kết nối khi mới có key Sapo Web: Web ✅, Omni ⏳; đồng bộ chưa chạy', () => {
  const sys = loadSystem({ props: { OMNI_API_KEY: '', OMNI_API_SECRET: '' } });
  sys.web.add({ first_name: 'Jabil', phone: '0909000111' });
  const msg = sys.ctx.selfTest();
  assert.match(msg, /✅ Sapo Web: kết nối OK\. Tổng khách: 1/);
  assert.match(msg, /⏳ Sapo Omni: chưa có API key/);
  assert.match(msg, /CHẠY THẬT|CHẠY THỬ/);
  sys.run();
  assert.ok(sys.logRows().some(l => l.action === 'DỪNG' && /Thiếu cấu hình: OMNI_API_KEY/.test(l.detail)));
});

test('Kiểm tra kết nối báo lỗi rõ ràng khi sai key', () => {
  const sys = loadSystem();
  sys.web.handle = () => [401, '{"errors":"[API] Invalid API key or access token"}'];
  const msg = sys.ctx.selfTest();
  assert.match(msg, /❌ Sapo Web: .*HTTP 401/);
});
