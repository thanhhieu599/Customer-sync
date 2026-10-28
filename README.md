# Đồng bộ khách hàng 2 chiều: Sapo Omni ↔ Sapo Web

Hệ thống chạy trên **Google Apps Script** (miễn phí, chạy 24/7 trên máy chủ Google, không cần máy tính bật).
Dữ liệu ghép cặp và nhật ký nằm ngay trong 1 Google Sheet để anh/chị xem và kiểm tra.

```
              ┌──────────── Google Sheet + Apps Script (mặc định 10 phút) ──────┐
              │  Sheet "Map": cặp ID Omni ↔ ID Web   |   Sheet "Log": nhật ký    │
              └──────────────────────────────────────────────────────────────────┘
Sapo Omni (mysapogo.com)  ◄──── đọc / tạo / sửa ────►  Sapo Web (mysapo.net)
```

## Hệ thống làm gì

| Tình huống | Hệ thống xử lý |
|---|---|
| Khách **có trên Omni, chưa có trên Web** | Tạo khách trên Web, gắn tag `omni:<mã KH>` để tra ngược |
| Khách **có ở cả 2 nơi** (cùng SĐT hoặc email) | Ghép cặp. Lần ghép đầu lấy Omni làm chuẩn; trường nào Omni để trống thì giữ giá trị bên Web và bổ sung ngược sang Omni |
| **Sửa khách trên Omni** | Cập nhật sang Web |
| **Sửa khách trên Web** | Cập nhật sang Omni |
| **Sửa cùng lúc ở 2 nơi** | Bản sửa **sau cùng** thắng, ghi "xung đột" vào nhật ký |
| **Khách mới tạo trên Web** | Chờ bộ kết nối Sapo tự tạo bên Omni rồi ghép. Sau 30 phút vẫn chưa có thì hệ thống tự tạo bên Omni |
| **Bản dội**: Sapo tự sinh khách trùng bên Omni sau khi có khách trên Web | Nhận diện và **không đồng bộ tiếp** (không tạo vòng lặp). Tùy chọn xóa tự động (xem `DELETE_ECHO`) |
| **Khách trùng có sẵn từ trước** trên Omni | Giữ bản nhiều đơn nhất làm bản chính, các bản còn lại đánh dấu `dup`, **không xóa** |
| **Một bên bị xóa** | Đánh dấu `orphan`, ngừng đồng bộ cặp đó, **không tự tạo lại** |

**Trường được đồng bộ:** Tên · SĐT · Email · Địa chỉ.
Khóa ghép theo thứ tự: **SĐT → email**. SĐT được chuẩn hóa khi so sánh (`+84…`, `84…`, mất số 0 đầu đều coi là `0…`); khi ghi lên Sapo Web, SĐT được gửi dạng `+84…`.

**Mã số thuế (MST) không được dùng** để ghép hay đồng bộ: nhiều phòng ban/chi nhánh của cùng một công ty dùng chung MST nhưng là các đầu mối liên hệ khác nhau, ghép theo MST sẽ gộp nhầm.

**Không đồng bộ:** MST, đơn hàng, công nợ, nhóm khách, điểm thưởng. Đơn hàng vẫn đi theo bộ kết nối có sẵn của Sapo.

## Cần chuẩn bị

1. **API key Sapo Web**: `https://<tên-cửa-hàng>.mysapo.net/admin/apps/private` → Tạo ứng dụng riêng → quyền **Khách hàng: Đọc + Ghi**.
2. **API key Sapo Omni**: đang chờ Sapo cấp. Hỏi rõ Sapo kiểu xác thực:
   - API key + secret → `OMNI_AUTH_MODE = basic`
   - Access token → `OMNI_AUTH_MODE = token`
3. Một tài khoản Google (nên dùng tài khoản công ty).

## Cài đặt

👉 **Làm theo [HUONG-DAN-TRIEN-KHAI.md](HUONG-DAN-TRIEN-KHAI.md)** (khoảng 20 phút, mô tả từng nút cần bấm).

Tóm tắt: tạo Google Sheet → Tiện ích mở rộng → Apps Script → dán **1 tệp** [`dist/Code.gs`](dist/Code.gs) và
[`dist/appsscript.json`](dist/appsscript.json) → nhập thuộc tính tập lệnh → menu **Đồng bộ Sapo → 1. Kiểm tra kết nối**.

### Thuộc tính tập lệnh (cấu hình)

| Khóa | Ví dụ | Ý nghĩa |
|---|---|---|
| `WEB_BASE_URL` | `https://trangthietbivn.mysapo.net` | Địa chỉ trang quản trị Sapo Web |
| `WEB_API_KEY` / `WEB_API_SECRET` | | Key của ứng dụng riêng Sapo Web |
| `OMNI_BASE_URL` | `https://trangthietbivn.mysapogo.com` | Địa chỉ Sapo Omni |
| `OMNI_AUTH_MODE` | `basic` | `basic` (key + secret) hoặc `token` |
| `OMNI_API_KEY` / `OMNI_API_SECRET` | | Dùng khi `basic` |
| `OMNI_ACCESS_TOKEN` | | Dùng khi `token` |
| `DRY_RUN` | `true` | **`true` = chỉ chạy thử, không ghi gì.** Đổi `false` khi đã kiểm tra xong |
| `MAX_CREATE_PER_RUN` | `10` | Số khách tối đa được **tạo mới** mỗi lượt (chống tạo hàng loạt ngoài ý muốn) |
| `DELETE_ECHO` | `false` | `true` = tự xóa bản dội (0 đơn) bên Omni. **Chỉ bật khi phép thử A đạt** (xem dưới) |
| `PENDING_WEB_TIMEOUT_MIN` | `30` | Số phút chờ Sapo tự tạo khách bên Omni trước khi hệ thống tự tạo |
| `SKIP_OMNI_GROUP_IDS` | `579639` | Mã nhóm khách Omni **không đẩy lên Web**, cách nhau dấu phẩy (ví dụ nhóm "Bán lẻ"). Khách nhóm này nếu đã có tài khoản Web cùng SĐT/email thì vẫn được ghép để tránh tạo trùng |
| `ALERT_EMAIL` | `admin@trangthietbi.vn` | Nhận email khi có lỗi (tối đa 1 email/giờ) |
| `SYNC_INTERVAL_MIN` | `10` | Chu kỳ chạy tự động: `5`, `10`, `15` hoặc `30` phút |

> ⚠️ API key chỉ nhập vào **Thuộc tính tập lệnh**, không dán vào code, không gửi qua chat/email.

## Lộ trình bật hệ thống, đi từng nấc

| Nấc | Cấu hình | Kiểm tra |
|---|---|---|
| 1. Chạy thử | `DRY_RUN=true` | Menu **2. Chạy đồng bộ 1 lần** → sheet **Log** liệt kê việc *sẽ* làm, gắn nhãn `[THỬ]`. Đọc kỹ dòng **TÓM TẮT**: số khách sẽ tạo có hợp lý không? |
| 2. Chọn phạm vi | `SKIP_OMNI_GROUP_IDS` | Loại nhóm khách lẻ nếu chỉ muốn đồng bộ khách B2B. Chạy thử lại. ⚠️ "Bán lẻ" (`579639`) là **nhóm mặc định** của Omni, nên nhiều khách công ty đang nằm ở đây (ví dụ Hùng Vương). Chuyển các khách này sang nhóm B2B **trước khi** loại nhóm Bán lẻ |
| 3. Chạy thật 1 khách | `DRY_RUN=false`, `MAX_CREATE_PER_RUN=1` | Kiểm tra khách đó trên Web: tên, SĐT, email, địa chỉ đúng chưa. Sửa thử 1 trường trên Web, chạy lại, xem Omni có cập nhật đúng không |
| 4. Mở rộng | `MAX_CREATE_PER_RUN=50` | Chạy vài lượt cho đến khi dòng TÓM TẮT báo `tạo trên Web: 0` |
| 5. Tự động | Menu **Bật tự động** (chu kỳ theo `SYNC_INTERVAL_MIN`) | Theo dõi sheet Log 2–3 ngày đầu |

### Phép thử A trước khi bật `DELETE_ECHO`

Sapo tự sinh một "bản dội" bên Omni mỗi khi có khách mới trên Web. Trước khi cho hệ thống xóa bản dội, cần biết
**sau khi xóa, đơn hàng từ Web sẽ về khách nào** trên Omni:

1. Tạo khách TEST trên Omni (bản gốc) → để hệ thống tạo lên Web → Sapo sinh bản dội bên Omni.
2. Xóa bản dội trên Omni.
3. Tạo 1 đơn nháp trên Web cho khách TEST, hoàn tất đơn.
4. Kiểm tra trên Omni:
   - Đơn về **bản gốc** → **A: đạt**, bật `DELETE_ECHO=true`.
   - Sapo tạo **thêm bản mới**, hoặc báo lỗi → giữ `DELETE_ECHO=false`. Thông tin khách vẫn đồng bộ 2 chiều,
     nhưng đơn từ Web sẽ nằm ở bản dội. Phần này phải đề nghị Sapo sửa bộ kết nối.

## Đọc sheet Map

| status | Nghĩa |
|---|---|
| `pair` | Cặp Omni ↔ Web đang đồng bộ |
| `pending_web` | Khách Web mới, đang chờ Sapo tạo bên Omni |
| `echo` | Bản dội do Sapo sinh, bỏ qua |
| `echo_deleted` | Bản dội đã được xóa tự động |
| `dup` | Khách trùng có sẵn trên Omni (cùng SĐT/email với khách khác), bỏ qua, cần xử lý tay nếu muốn |
| `create_failed` | Sapo từ chối tạo khách (xem cột note). Hệ thống tự thử lại sau 24 giờ |
| `dup_web` | Tài khoản Web trùng với một tài khoản Web khác, bỏ qua |
| `orphan` | Một bên đã bị xóa, ngừng đồng bộ |

**Không sửa tay sheet Map khi hệ thống đang chạy tự động.** Nếu cần làm lại từ đầu: tắt tự động, xóa các dòng dữ liệu
(giữ dòng tiêu đề), chạy lại từ nấc 1.

## Giới hạn và lưu ý

- **API Omni chưa được xác minh với key thật.** Cấu trúc dữ liệu đọc đã khớp với dữ liệu thật của cửa hàng
  (`/admin/customers.json`). Cấu trúc **ghi** (tạo/sửa khách) suy ra từ dữ liệu đọc, nên phải kiểm tra ở nấc 3.
- Khách **không có SĐT và email** sẽ không được đồng bộ (không có gì để ghép an toàn).
- Nếu Sapo nhận lệnh ghi nhưng **không lưu một trường** (ví dụ API Omni không cho sửa email), sheet Log ghi cảnh báo
  `… không lưu đúng dữ liệu đã gửi` kèm tên trường. Hệ thống không ghi lặp lại; cần báo Sapo hoặc sửa tay.
- **Hạn mức Google:** mỗi lượt đọc toàn bộ khách 2 bên (~80 lệnh API với ~3.500 khách). Tài khoản Gmail cá nhân được
  20.000 lệnh/ngày, Google Workspace được 100.000. Nếu dùng Gmail cá nhân và số khách lớn, đặt `SYNC_INTERVAL_MIN=15`.
- **Tự dừng an toàn** (không thay đổi gì, gửi email cảnh báo) khi: một bên trả về 0 khách, đọc thiếu khách so với tổng,
  hoặc nhiều cặp "mất 1 bên" cùng lúc.
- Với ~5.000 khách, mỗi lượt khoảng 40 lệnh API, chạy dưới 1 phút. Apps Script giới hạn 6 phút/lượt; việc chưa xong sẽ làm tiếp ở lượt sau.
- Thay đổi có độ trễ tối đa bằng chu kỳ chạy (mặc định 10 phút). Lần đầu với vài nghìn khách, hệ thống cần vài lượt để đồng bộ hết.

## Dành cho người phát triển

```bash
npm test        # kiểm tra dist/Code.gs đã cập nhật + chạy toàn bộ kiểm thử
npm run build   # sau khi sửa apps-script/*.js: gộp lại thành dist/Code.gs
```

Bộ kiểm thử (`test/`) giả lập Apps Script, 2 máy chủ Sapo và bộ kết nối Sapo (kể cả hành vi sinh bản dội),
rồi chạy hệ thống qua nhiều lượt để kiểm tra: ghép cặp, gộp dữ liệu lần đầu, tạo mới, sửa 2 chiều, xung đột, bản dội
(kể cả bản dội rơi vào nhóm bị loại), chạy thử, giới hạn tạo mới, Sapo từ chối tạo khách, Sapo không lưu một trường,
thử lại khi bị giới hạn tốc độ (429), giới hạn số khách/trang, mất 1 bên, các điểm dừng an toàn, quy mô 2.500 khách,
và **không ghi lặp khi dữ liệu đã ổn định**.

| Tệp | Vai trò |
|---|---|
| `apps-script/Core.js` | Logic thuần: chuẩn hóa, ghép, lập kế hoạch hành động |
| `apps-script/Api.js` | Gọi API Sapo Web / Omni, lật trang, thử lại |
| `apps-script/Store.js` | Đọc/ghi sheet Map và Log |
| `apps-script/Main.js` | Cấu hình, chạy đồng bộ, menu, hẹn giờ, cảnh báo email |
| `test/sync.test.js` | 18 kịch bản nghiệp vụ |
| `test/scale.test.js` | Mô phỏng 2.500 khách Omni + 400 khách Web |
| `test/deploy.test.js` | Tệp gộp `dist/Code.gs`, kiểm tra kết nối khi mới có key Web |
| `dist/Code.gs` | **Tệp để dán vào Google Apps Script** (tự sinh, không sửa tay) |
