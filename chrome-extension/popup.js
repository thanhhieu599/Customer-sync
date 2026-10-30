var LABEL = { ok: 'Hoạt động tốt', running: 'Đang chạy', warn: 'Có cảnh báo', error: 'Có lỗi',
              session: 'Cần đăng nhập lại Omni', paused: 'Tạm nghỉ', off: 'Đang tắt' };
var ALARM = 'dt-sapo-sync';
function send(cmd, extra) { return chrome.runtime.sendMessage(Object.assign({ cmd: cmd }, extra || {})); }
function fmt(t) { return t ? new Date(t).toLocaleString('vi-VN') : '—'; }
function ago(t) {
  if (!t) return '';
  var m = Math.round((Date.now() - new Date(t).getTime()) / 60000);
  return m <= 0 ? ' (vừa xong)' : ' (' + m + ' phút trước)';
}

async function render() {
  var s = await chrome.storage.local.get(['status', 'config', 'pausedUntil']);
  var st = s.status || { state: 'off' }, cfg = s.config || {};
  var pill = document.getElementById('pill');
  pill.className = 'pill st-' + st.state; pill.textContent = LABEL[st.state] || st.state;
  document.getElementById('msg').textContent = st.message || '';
  document.getElementById('offNotice').hidden = !!cfg.enabled;
  document.getElementById('dryNotice').hidden = cfg.dryRun === false;

  var next = '—';
  if (cfg.enabled) {
    var a = await chrome.alarms.get(ALARM);
    if (a) {
      var mins = Math.max(0, Math.ceil((a.scheduledTime - Date.now()) / 60000));
      next = new Date(a.scheduledTime).toLocaleTimeString('vi-VN') + ' (còn ' + mins + ' phút, mỗi ' + (cfg.intervalMin || 10) + ' phút)';
      if (s.pausedUntil && s.pausedUntil > Date.now()) next += ' – tạm nghỉ đến ' + new Date(s.pausedUntil).toLocaleTimeString('vi-VN');
    } else {
      next = 'Chưa có lịch – bấm Tắt rồi Bật tự động lại';
    }
  }
  document.getElementById('next').textContent = next;
  document.getElementById('last').textContent = fmt(st.lastRunAt) + ago(st.lastRunAt);
  document.getElementById('role').textContent = cfg.role === 'staff' ? 'Máy nhân viên (chỉ gợi ý khách)'
    : 'Máy chính' + (cfg.fixOrders !== false ? ' – chuyển đơn về khách gốc' : '');
  document.getElementById('check').textContent = st.lastCheckAt ? fmt(st.lastCheckAt) + ago(st.lastCheckAt) +
    (st.lastCheckMessage ? ' – ' + st.lastCheckMessage : '') : '—';
  var sum = document.getElementById('summary');
  sum.hidden = !st.lastSummary; sum.textContent = st.lastSummary || '';
  document.getElementById('toggle').textContent = cfg.enabled ? 'Tắt tự động' : 'Bật tự động';
  document.getElementById('run').disabled = st.state === 'running';
  document.getElementById('resume').hidden = st.state !== 'paused';
}

document.getElementById('run').onclick = async function () {
  this.disabled = true; this.textContent = 'Đang chạy…';
  var r = await send('runNow');
  this.textContent = 'Chạy ngay';
  if (r && r.skipped) alert(r.message);
  else if (r && !r.ok && r.error) alert('Dừng: ' + r.error);
  render();
};
document.getElementById('toggle').onclick = async function () {
  var cfg = (await chrome.storage.local.get('config')).config || {};
  var r = await send('setEnabled', { enabled: !cfg.enabled });
  if (r && !r.ok) alert(r.error);
  render();
};
document.getElementById('resume').onclick = async function () {
  if (!confirm('Bỏ tạm nghỉ? Chỉ làm khi chắc Sapo Omni đã hoạt động bình thường trở lại.')) return;
  await send('resume'); render();
};
document.getElementById('omni').onclick = async function () {
  var cfg = (await chrome.storage.local.get('config')).config || {};
  var base = (cfg.omniBase || 'https://trangthietbivn.mysapogo.com').replace(/\/+$/, '');
  var tabs = await chrome.tabs.query({ url: base + '/*' });
  if (tabs[0]) chrome.tabs.update(tabs[0].id, { active: true });
  else chrome.tabs.create({ url: base + '/admin/dashboard', pinned: true });
};
document.getElementById('opts').onclick = function () { chrome.runtime.openOptionsPage(); };
chrome.storage.onChanged.addListener(render);
setInterval(render, 5000);
render();
