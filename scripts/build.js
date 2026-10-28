// Sinh các tệp phát hành từ mã nguồn trong apps-script/:
//  - dist/Code.gs, dist/appsscript.json : dán vào Google Apps Script
//  - chrome-extension/lib/core.js, engine.js : lõi dùng chung cho tiện ích Chrome
// Chạy: npm run build   |   Kiểm tra đã cập nhật chưa: node scripts/build.js --check
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = f => fs.readFileSync(path.join(root, 'apps-script', f), 'utf8');
const stripExport = s => s.replace(/\nif \(typeof module !== 'undefined'\) module\.exports = \w+;\n?/, '\n');

const files = ['Core.js', 'Engine.js', 'Api.js', 'Store.js', 'Main.js'];
const head = '/**\n * Đồng bộ khách hàng 2 chiều Sapo Omni <-> Sapo Web\n' +
  ' * TỆP TỰ SINH từ apps-script/ bằng lệnh: npm run build. Không sửa trực tiếp.\n */\n\n';
const libHead = '// TỆP TỰ SINH từ apps-script/ bằng lệnh: npm run build. Không sửa trực tiếp.\n';

const outputs = {
  'dist/Code.gs': head + files.map(f => '// ======================= ' + f + ' =======================\n' + stripExport(src(f))).join('\n'),
  'dist/appsscript.json': src('appsscript.json'),
  'chrome-extension/lib/core.js': libHead + stripExport(src('Core.js')),
  'chrome-extension/lib/engine.js': libHead + stripExport(src('Engine.js'))
};

if (process.argv.includes('--check')) {
  const stale = Object.keys(outputs).filter(p => {
    const f = path.join(root, p);
    return !fs.existsSync(f) || fs.readFileSync(f, 'utf8') !== outputs[p];
  });
  if (stale.length) { console.error('Chưa cập nhật: ' + stale.join(', ') + '. Chạy: npm run build'); process.exit(1); }
} else {
  fs.mkdirSync(path.join(root, 'chrome-extension', 'lib'), { recursive: true });
  for (const [p, content] of Object.entries(outputs)) fs.writeFileSync(path.join(root, p), content);
  console.log('Đã tạo: ' + Object.keys(outputs).join(', '));
}
