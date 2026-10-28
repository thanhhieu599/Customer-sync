const test = require('node:test');
const assert = require('node:assert');
const { loadSystem } = require('./harness');

test('quy mô thật: 2.500 khách Omni + 400 khách Web → hội tụ, không tạo trùng, đúng giới hạn thời gian', () => {
  const sys = loadSystem({ props: { MAX_CREATE_PER_RUN: '1000', SKIP_OMNI_GROUP_IDS: '579639' } });
  // 2.500 khách Omni: 60% nhóm Bán lẻ, 10% không SĐT/email, 30% B2B
  for (let i = 0; i < 2500; i++) {
    const phone = i % 10 === 0 ? null : '09' + String(10000000 + i);
    sys.omni.add({ name: 'KH ' + i, phone_number: phone, customer_group_id: i % 10 < 6 ? 579639 : 2,
      email: i % 7 === 0 ? 'kh' + i + '@cty.example' : null });
  }
  // 400 khách tự đăng ký Web: 300 trùng SĐT khách Omni (dạng +84), 100 khách mới
  for (let i = 0; i < 400; i++) {
    sys.web.add(i < 300 ? { first_name: 'Web ' + i, phone: '+849' + String(10000000 + i * 3 + 1).slice(0) }
                        : { first_name: 'Mới ' + i, phone: '0388' + String(100000 + i) });
  }
  sys.connector.run();
  const webBefore = sys.web.db.size;

  let runs = 0, maxCalls = 0;
  for (; runs < 30; runs++) {
    const before = sys.web.calls.length + sys.omni.calls.length;
    sys.run();
    sys.connector.run();
    maxCalls = Math.max(maxCalls, sys.web.calls.length + sys.omni.calls.length - before);
    const last = sys.logRows().filter(l => l.action === 'TÓM TẮT').pop();
    assert.ok(last, 'mỗi lượt đều có tóm tắt (không bị dừng)');
    if (/tạo trên Web: 0, tạo trên Omni: 0/.test(last.detail) && /để lượt sau: 0/.test(last.detail) &&
        /Omni→Web: 0, Web→Omni: 0/.test(last.detail) && /ghép mới: 0/.test(last.detail) && /chờ: 0/.test(last.detail)) break;
  }
  assert.ok(runs < 30, 'hội tụ sau ' + runs + ' lượt');

  // Mỗi SĐT chỉ có đúng 1 khách trên Web
  const webPhones = [...sys.web.db.values()].map(w => w.phone).filter(Boolean)
    .map(p => p.replace('+84', '0'));
  assert.strictEqual(new Set(webPhones).size, webPhones.length, 'không có khách Web trùng SĐT');
  // Khách B2B có SĐT/email đều đã lên Web
  const b2b = [...sys.omni.db.values()].filter(c => c.customer_group_id === 2 && (c.phone_number || c.email));
  const pairs = sys.mapRows().filter(r => r.status === 'pair');
  const pairedOmni = new Set(pairs.map(r => r.omni_id));
  assert.ok(b2b.every(c => pairedOmni.has(String(c.id))), 'mọi khách B2B đã được ghép');
  // Khách Bán lẻ chỉ có trên Omni không bị đẩy lên Web
  const retailOnly = [...sys.omni.db.values()].filter(c => c.customer_group_id === 579639 && !pairedOmni.has(String(c.id)));
  assert.ok(retailOnly.length > 1000);
  // Lượt ổn định: không ghi gì
  const w0 = sys.web.calls.length, o0 = sys.omni.calls.length;
  sys.run();
  assert.ok(sys.web.calls.slice(w0).every(c => c.startsWith('get')));
  assert.ok(sys.omni.calls.slice(o0).every(c => c.startsWith('get')));
  console.log(`   ${runs + 1} lượt để hội tụ | Web: ${webBefore} → ${sys.web.db.size} khách | cặp: ${pairs.length} | ` +
              `lệnh API nhiều nhất/lượt: ${maxCalls} | lệnh API lượt ổn định: ${sys.web.calls.length - w0 + sys.omni.calls.length - o0}`);
});
