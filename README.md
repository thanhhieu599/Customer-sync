# Đồng bộ khách hàng 2 chiều: Sapo Omni ↔ Sapo Web

Hệ thống chạy trên **Google Apps Script** (miễn phí, chạy 24/7 trên máy chủ Google, không cần máy tính bật).
Dữ liệu ghép cặp và nhật ký nằm ngay trong 1 Google Sheet để anh/chị xem và kiểm tra.

```
              ┌──────────── Google Sheet + Apps Script (mỗi 10 phút) ────────────┐
              │  Sheet "Map": cặp ID Omni ↔ ID Web   |   Sheet "Log": nhật ký    │
              └──────────────────────────────────────────────────────────────────┘
Sapo Omni (mysapogo.com)  ◄──── đọc / tạo / sửa ────►  Sapo Web (mysapo.net)
```

## Hệ thống làm gì

| Tình huống | Hệ thống xử lý |
|---|---|
| Khách **có trên Omni, chưa có trên Web** | Tạo khách trên Web, gắn tag `omni:<mã KH>` và `MST:<mã số thuế>` |
| Khách **có ở cả 2 nơi** (cùng SĐT / MST / email) | Ghép cặp, lấy thông tin Omni làm chuẩn ở lần ghép đầu |
| **Sửa khách trên Omni** | Cập nhật sang Web |
| **Sửa khách trên Web** | Cập nhật sang Omni |
| **Sửa cùng lúc ở 2 nơi** | Bản sửa **sau cùng** thắng, ghi "xung đột" vào nhật ký |
| **Khách mới tạo trên Web** | Chờ bộ kết nối Sapo tự tạo bên Omni rồi ghép. Sau 30 phút vẫn chưa có thì hệ thống tự tạo bên Omni |
| **Bản dội**: Sapo tự sinh khách trùng bên Omni sau khi có khách trên Web | Nhận diện và **không đồng bộ tiếp** (không tạo vòng lặp). Tùy chọn xóa tự động (xem `DELETE_ECHO`) |
| **Khách trùng có sẵn từ trước** trên Omni | Giữ bản nhiều đơn nhất làm bản chính, các bản còn lại đánh dấu `dup`, **không xóa** |
| **Một bên bị xóa** | Đánh dấu `orphan`, ngừng đồng bộ cặp đó, **không tự tạo lại** |

**Trường được đồng bộ:** Tên · SĐT · Email · MST · Địa chỉ.
Khóa ghép theo thứ tự: **SĐT → MST → email**. SĐT được chuẩn hóa (`+84…`, `84…`, mất số 0 đầu đều về `0…`).

**Không đồng bộ:** đơn hàng, công nợ, nhóm khách, điểm thưởng. Đơn hàng vẫn đi theo bộ kết nối có sẵn của Sapo.

## Cần chuẩn bị

1. **API key Sapo Web**: `https://<tên-cửa-hàng>.mysapo.net/admin/apps/private` → Tạo ứng dụng riêng → quyền **Khách hàng: Đọc + Ghi**.
2. **API key Sapo Omni**: đang chờ Sapo cấp. Hỏi rõ Sapo kiểu xác thực:
   - API key + secret → `OMNI_AUTH_MODE = basic`
   - Access token → `OMNI_AUTH_MODE = token`
3. Một tài khoản Google (nên dùng tài khoản công ty).

## Cài đặt (khoảng 15 phút)

1. Tạo **Google Sheet** mới, đặt tên `Đồng bộ Sapo`.
2. Menu **Tiện ích mở rộng → Apps Script**.
3. Tạo 4 tệp script, đặt tên đúng như sau, rồi dán nội dung tương ứng trong thư mục `apps-script/`:
   `Core`, `Api`, `Store`, `Main` (Apps Script tự thêm đuôi `.gs`).
4. Bánh răng **Cài đặt dự án** → tích **"Hiển thị tệp kê khai appsscript.json"** → mở `appsscript.json` và dán nội dung tệp cùng tên.
5. Vẫn ở **Cài đặt dự án** → **Thuộc tính tập lệnh** → thêm các khóa ở bảng dưới.
6. Quay lại Sheet, tải lại trang → xuất hiện menu **Đồng bộ Sapo**.
7. **Đồng bộ Sapo → 1. Kiểm tra kết nối** → cấp quyền lần đầu → phải thấy ✅ cho cả Web và Omni.

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
| `SKIP_OMNI_GROUP_IDS` | `579639` | Mã nhóm khách Omni **không** đồng bộ, cách nhau dấu phẩy (ví dụ nhóm "Bán lẻ") |
| `ALERT_EMAIL` | `admin@trangthietbi.vn` | Nhận email khi có lỗi (tối đa 1 email/giờ) |

> ⚠️ API key chỉ nhập vào **Thuộc tính tập lệnh**, không dán vào code, không gửi qua chat/email.

## Lộ trình bật hệ thống, đi từng nấc

| Nấc | Cấu hình | Kiểm tra |
|---|---|---|
| 1. Chạy thử | `DRY_RUN=true` | Menu **2. Chạy đồng bộ 1 lần** → sheet **Log** liệt kê việc *sẽ* làm, gắn nhãn `[THỬ]`. Đọc kỹ dòng **TÓM TẮT**: số khách sẽ tạo có hợp lý không? |
| 2. Chọn phạm vi | `SKIP_OMNI_GROUP_IDS` | Loại nhóm khách lẻ nếu chỉ muốn đồng bộ khách B2B. Chạy thử lại. ⚠️ "Bán lẻ" (`579639`) là **nhóm mặc định** của Omni, nên nhiều khách công ty đang nằm ở đây (ví dụ Hùng Vương). Chuyển các khách này sang nhóm B2B **trước khi** loại nhóm Bán lẻ |
| 3. Chạy thật 1 khách | `DRY_RUN=false`, `MAX_CREATE_PER_RUN=1` | Kiểm tra khách đó trên Web: tên, SĐT, email, địa chỉ, tag MST đúng chưa. Sửa thử 1 trường trên Web, chạy lại, xem Omni có cập nhật đúng không |
| 4. Mở rộng | `MAX_CREATE_PER_RUN=50` | Chạy vài lượt cho đến khi dòng TÓM TẮT báo `tạo trên Web: 0` |
| 5. Tự động | Menu **Bật tự động (mỗi 10 phút)** | Theo dõi sheet Log 2–3 ngày đầu |

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
| `dup` | Khách trùng có sẵn trên Omni (cùng SĐT/MST/email với khách khác), bỏ qua, cần xử lý tay nếu muốn |
| `dup_web` | Tài khoản Web trùng với một tài khoản Web khác, bỏ qua |
| `orphan` | Một bên đã bị xóa, ngừng đồng bộ |

**Không sửa tay sheet Map khi hệ thống đang chạy tự động.** Nếu cần làm lại từ đầu: tắt tự động, xóa các dòng dữ liệu
(giữ dòng tiêu đề), chạy lại từ nấc 1.

## Giới hạn và lưu ý

- **API Omni chưa được xác minh với key thật.** Cấu trúc dữ liệu đọc đã khớp với dữ liệu thật của cửa hàng
  (`/admin/customers.json`). Cấu trúc **ghi** (tạo/sửa khách) suy ra từ dữ liệu đọc, nên phải kiểm tra ở nấc 3.
- Khách **không có SĐT, MST và email** sẽ không được đồng bộ (không có gì để ghép an toàn).
- Sapo Web không có trường MST nên MST lưu trong **tag** `MST:<số>`. Sửa tag này trên Web thì MST bên Omni cũng đổi theo.
- Với ~5.000 khách, mỗi lượt khoảng 40 lệnh API, chạy dưới 1 phút. Apps Script giới hạn 6 phút/lượt; việc chưa xong sẽ làm tiếp ở lượt sau.
- Chạy 10 phút/lần nên thay đổi có độ trễ tối đa ~10 phút.

## Dành cho người phát triển

```bash
npm test
```

Bộ kiểm thử (`test/`) giả lập Apps Script, 2 máy chủ Sapo và bộ kết nối Sapo (kể cả hành vi sinh bản dội),
rồi chạy hệ thống qua nhiều lượt để kiểm tra: ghép cặp, tạo mới, sửa 2 chiều, xung đột, bản dội, chạy thử,
giới hạn tạo mới, thử lại khi bị giới hạn tốc độ (429), mất 1 bên, và **không ghi lặp khi dữ liệu đã ổn định**.

| Tệp | Vai trò |
|---|---|
| `apps-script/Core.js` | Logic thuần: chuẩn hóa, ghép, lập kế hoạch hành động |
| `apps-script/Api.js` | Gọi API Sapo Web / Omni, lật trang, thử lại |
| `apps-script/Store.js` | Đọc/ghi sheet Map và Log |
| `apps-script/Main.js` | Cấu hình, chạy đồng bộ, menu, hẹn giờ, cảnh báo email |
