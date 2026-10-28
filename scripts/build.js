// Gộp 4 tệp trong apps-script/ thành 1 tệp dist/Code.gs để dán vào Google Apps Script
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const files = ['Core.js', 'Api.js', 'Store.js', 'Main.js'];
const head = '/**\n * Đồng bộ khách hàng 2 chiều Sapo Omni <-> Sapo Web\n' +
  ' * TỆP TỰ SINH từ apps-script/ bằng lệnh: npm run build. Không sửa trực tiếp.\n */\n\n';
const body = files.map(f => '// ======================= ' + f + ' =======================\n' +
  fs.readFileSync(path.join(root, 'apps-script', f), 'utf8').replace(/\nif \(typeof module !== 'undefined'\) module\.exports = SyncCore;\n?/, '\n'))
  .join('\n');
const out = head + body;
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(path.join(root, 'dist', 'Code.gs')) ? fs.readFileSync(path.join(root, 'dist', 'Code.gs'), 'utf8') : '';
  if (cur !== out) { console.error('dist/Code.gs chưa cập nhật. Chạy: npm run build'); process.exit(1); }
} else {
  fs.writeFileSync(path.join(root, 'dist', 'Code.gs'), out);
  fs.copyFileSync(path.join(root, 'apps-script', 'appsscript.json'), path.join(root, 'dist', 'appsscript.json'));
  console.log('Đã tạo dist/Code.gs (' + out.split('\n').length + ' dòng) và dist/appsscript.json');
}
