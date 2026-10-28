var LABEL = { ok: 'Hoạt động tốt', running: 'Đang chạy', warn: 'Có cảnh báo', error: 'Có lỗi', session: 'Cần đăng nhập lại Omni', off: 'Đang tắt' };
function send(cmd, extra) { return chrome.runtime.sendMessage(Object.assign({ cmd: cmd }, extra || {})); }
function fmt(t) { return t ? new Date(t).toLocaleString('vi-VN') : '—'; }

async function render() {
  var s = await chrome.storage.local.get(['status', 'config']);
  var st = s.status || { state: 'off' }, cfg = s.config || {};
  var pill = document.getElementById('pill');
  pill.className = 'pill st-' + st.state; pill.textContent = LABEL[st.state] || st.state;
  document.getElementById('msg').textContent = st.message || '';
  document.getElementById('last').textContent = 'Lượt gần nhất: ' + fmt(st.lastRunAt) +
    (cfg.dryRun !== false ? ' · CHẠY THỬ' : ' · CHẠY THẬT') + (cfg.enabled ? ' · tự động mỗi ' + (cfg.intervalMin || 10) + ' phút' : '');
  var sum = document.getElementById('summary');
  sum.hidden = !st.lastSummary; sum.textContent = st.lastSummary || '';
  document.getElementById('toggle').textContent = cfg.enabled ? 'Tắt tự động' : 'Bật tự động';
  document.getElementById('run').disabled = st.state === 'running';
}

document.getElementById('run').onclick = async function () {
  this.disabled = true; this.textContent = 'Đang chạy…';
  var r = await send('runNow');
  this.textContent = 'Chạy ngay';
  if (r && r.skipped) alert(r.message);
  render();
};
document.getElementById('toggle').onclick = async function () {
  var cfg = (await chrome.storage.local.get('config')).config || {};
  var r = await send('setEnabled', { enabled: !cfg.enabled });
  if (r && !r.ok) alert(r.error);
  render();
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
render();
