# Hướng dẫn triển khai lên Google (khoảng 20 phút)

Hệ thống chạy trong **Google Apps Script**, gắn vào 1 **Google Sheet**. Sau khi cài xong, hệ thống tự chạy trên máy chủ Google, không cần máy tính nào bật.

> **Nên dùng tài khoản Google Workspace của công ty** (ví dụ `admin@trangthietbi.vn`), không dùng Gmail cá nhân.
> Lý do: hạn mức gọi API cao hơn 5 lần, và nhân sự nghỉ việc không mang theo hệ thống.

---

## Phần A: Làm ngay hôm nay (chưa cần key Omni)

### Bước 1: Lấy API key Sapo Web (5 phút)

1. Đăng nhập trang quản trị **Sapo Web** bằng tài khoản **chủ cửa hàng**.
2. Nhìn thanh địa chỉ và ghi lại phần đầu, dạng `https://xxxxx.mysapo.net`. Đây là **WEB_BASE_URL**.
3. Vào `https://xxxxx.mysapo.net/admin/apps/private` → **Tạo ứng dụng riêng**.
4. Đặt tên `DT-Customer-Sync`. Phần quyền chỉ cấp: **Khách hàng → Đọc và ghi**. Các quyền khác để "Không truy cập".
5. Bấm **Lưu**. Ghi lại **API Key** và **Mật khẩu (Secret)**.

> ⚠️ Không gửi key qua Zalo, email hay chat. Chỉ dán thẳng vào Google ở Bước 4.

### Bước 2: Tạo Google Sheet và Apps Script (3 phút)

1. Vào https://sheets.new → đặt tên Sheet: **Đồng bộ Sapo**.
2. Menu **Tiện ích mở rộng → Apps Script**. Một tab mới mở ra.
3. Ở góc trên bên trái, đổi tên dự án thành **Đồng bộ Sapo**.

### Bước 3: Dán code (3 phút)

1. Mở tệp code: https://github.com/thanhhieu599/customer-sync/blob/main/dist/Code.gs
2. Bấm nút **Copy raw file** (biểu tượng 2 ô vuông, góc phải phía trên khung code).
3. Quay lại Apps Script, mở tệp **Code.gs**, **xóa hết** nội dung có sẵn, dán vào, rồi bấm **Ctrl + S** để lưu.
4. Bấm **biểu tượng bánh răng ⚙ (Cài đặt dự án)** ở thanh bên trái:
   - Tích ô **Hiển thị tệp kê khai "appsscript.json" trong trình chỉnh sửa**.
   - Đổi **Múi giờ** thành `(GMT+07:00) Hồ Chí Minh` nếu chưa đúng.
5. Quay lại **Trình chỉnh sửa** (biểu tượng `< >`), mở tệp **appsscript.json**, xóa hết, dán nội dung từ
   https://github.com/thanhhieu599/customer-sync/blob/main/dist/appsscript.json, rồi **Ctrl + S**.

### Bước 4: Nhập cấu hình (5 phút)

**⚙ Cài đặt dự án** → kéo xuống **Thuộc tính tập lệnh** → **Thêm thuộc tính tập lệnh**, nhập lần lượt:

| Thuộc tính | Giá trị |
|---|---|
| `WEB_BASE_URL` | `https://xxxxx.mysapo.net` (lấy ở Bước 1) |
| `WEB_API_KEY` | API Key Sapo Web |
| `WEB_API_SECRET` | Mật khẩu (Secret) Sapo Web |
| `OMNI_BASE_URL` | `https://trangthietbivn.mysapogo.com` |
| `DRY_RUN` | `true` |
| `MAX_CREATE_PER_RUN` | `10` |
| `ALERT_EMAIL` | email nhận cảnh báo lỗi, ví dụ `admin@trangthietbi.vn` |
| `SYNC_INTERVAL_MIN` | `10` |

Bấm **Lưu thuộc tính tập lệnh**.

> Chưa có key Omni thì **chưa nhập** `OMNI_API_KEY`, `OMNI_API_SECRET`. Hệ thống vẫn kiểm tra được kết nối Sapo Web.

### Bước 5: Cấp quyền và kiểm tra kết nối (3 phút)

1. Quay lại tab **Google Sheet** → bấm **F5** để tải lại trang. Chờ khoảng 5 giây, trên thanh menu xuất hiện **Đồng bộ Sapo**.
2. Bấm **Đồng bộ Sapo → 1. Kiểm tra kết nối**.
3. Lần đầu, Google hỏi cấp quyền:
   - **Tiếp tục** → chọn tài khoản Google của anh.
   - Nếu hiện **"Google chưa xác minh ứng dụng này"**: bấm **Nâng cao** → **Đi tới Đồng bộ Sapo (không an toàn)**.
     Cảnh báo này xuất hiện vì đây là code riêng của công ty, chưa đăng ký với Google; không phải phần mềm lạ.
   - Bấm **Cho phép**. Các quyền được xin:

     | Quyền | Dùng để |
     |---|---|
     | Xem và sửa bảng tính này | Ghi sheet Map và Log |
     | Kết nối với dịch vụ bên ngoài | Gọi API Sapo |
     | Chạy khi anh không có mặt | Chạy tự động mỗi 10 phút |
     | Gửi email thay anh | Gửi cảnh báo khi có lỗi |
4. Bấm lại **1. Kiểm tra kết nối**. Kết quả đúng:
   ```
   ✅ Sapo Web: kết nối OK. Tổng khách: 1234
      Mẫu: Nguyễn Văn A | 0909xxxxxx | a@cty.vn
   ⏳ Sapo Omni: chưa có API key (thêm OMNI_API_KEY / OMNI_API_SECRET khi Sapo cấp)
   ```

✅ **Xong phần A.** Hệ thống đã sẵn sàng, chỉ chờ key Omni.

---

## Phần B: Khi Sapo cấp key Omni

### Bước 6: Thêm key Omni

**⚙ Cài đặt dự án → Thuộc tính tập lệnh**, thêm:

| Sapo cấp dạng | Thêm các thuộc tính |
|---|---|
| API Key + Secret | `OMNI_AUTH_MODE` = `basic`, `OMNI_API_KEY`, `OMNI_API_SECRET` |
| Access Token | `OMNI_AUTH_MODE` = `token`, `OMNI_ACCESS_TOKEN` |

Rồi bấm **Đồng bộ Sapo → 1. Kiểm tra kết nối**. Phải thấy ✅ ở **cả 2 dòng**.

### Bước 7: Bật dần theo 5 nấc, không bật hết một lần

| Nấc | Làm gì | Kiểm tra gì | Đạt thì |
|---|---|---|---|
| **1. Chạy thử** | Để `DRY_RUN=true`, bấm **2. Chạy đồng bộ 1 lần** | Mở sheet **Log**, xem dòng **TÓM TẮT** cuối cùng: số khách *sẽ* tạo, *sẽ* ghép có hợp lý không? Các dòng có nhãn `[THỬ]` là việc sẽ làm, chưa làm thật | Sang nấc 2 |
| **2. Chọn phạm vi** | Nếu chỉ muốn đẩy khách B2B lên Web, thêm `SKIP_OMNI_GROUP_IDS` = `579639` (nhóm Bán lẻ). **Trước đó** chuyển các khách công ty đang nằm nhầm ở nhóm Bán lẻ sang nhóm B2B | Chạy thử lại, xem số khách sẽ tạo đã giảm | Sang nấc 3 |
| **3. Chạy thật 1 khách** | `DRY_RUN=false`, `MAX_CREATE_PER_RUN=1`, bấm **2. Chạy đồng bộ 1 lần** | ① Khách vừa tạo trên Web có đúng tên, SĐT, email, địa chỉ không? ② Sửa SĐT khách đó trên Web, bấm chạy lại, Omni có cập nhật không? ③ Sheet Log có dòng `không lưu đúng dữ liệu` không? | Sang nấc 4 |
| **4. Mở rộng** | `MAX_CREATE_PER_RUN=100`, bấm chạy vài lần | Dòng TÓM TẮT báo `tạo trên Web: 0` và `để lượt sau: 0` | Sang nấc 5 |
| **5. Tự động** | Bấm **Đồng bộ Sapo → Bật tự động** | Theo dõi sheet Log 2–3 ngày đầu | Hoàn tất |

> Ở nấc 3, nếu sheet Log báo **"Sapo Omni không lưu đúng dữ liệu đã gửi"** hoặc lỗi `HTTP 4xx`, dừng lại và gửi nội dung dòng lỗi
> (che SĐT, email khách) để điều chỉnh code theo đúng API Omni thật.

### Bước 8 (tùy chọn): Bật xóa bản dội

Chỉ làm sau khi **phép thử A** trong `README.md` đạt (đơn từ Web về đúng khách gốc sau khi xóa bản dội).
Thêm `DELETE_ECHO` = `true`.

---

## Vận hành hằng ngày

| Việc | Ở đâu |
|---|---|
| Xem hệ thống vừa làm gì | Sheet **Log**, các dòng mới nhất ở cuối |
| Xem cặp khách Omni ↔ Web | Sheet **Map** (không sửa tay) |
| Có lỗi | Email cảnh báo tự gửi về `ALERT_EMAIL` (tối đa 1 email/giờ) |
| Tạm dừng hệ thống | **Đồng bộ Sapo → Tắt tự động** |
| Xem lịch chạy, lịch sử chạy | Apps Script → biểu tượng **đồng hồ ⏰ (Trình kích hoạt)** và **☰ (Thực thi)** |

## Lỗi thường gặp

| Hiện tượng | Nguyên nhân | Cách xử lý |
|---|---|---|
| Không thấy menu **Đồng bộ Sapo** | Chưa tải lại Sheet, hoặc code chưa lưu | Ctrl + S trong Apps Script, rồi F5 Sheet |
| `Thiếu cấu hình: …` | Thiếu hoặc gõ sai tên thuộc tính | Kiểm tra lại Bước 4, tên phải viết HOA, đúng chính tả |
| `HTTP 401` / `HTTP 403` | Sai key, hoặc thiếu quyền Khách hàng | Tạo lại ứng dụng riêng, cấp quyền **Khách hàng: Đọc và ghi** |
| `HTTP 3xx (bị chuyển hướng…)` | Sai `WEB_BASE_URL` / `OMNI_BASE_URL` | Kiểm tra đúng dạng `https://xxxxx.mysapo.net`, không có `/admin` ở cuối |
| `không trả về JSON` | Sai địa chỉ cửa hàng | Như trên |
| `trả về 0 khách hàng (bất thường)` / `chỉ đọc được …/… khách` | Key không đủ quyền xem khách, hoặc Sapo đang lỗi | Hệ thống đã tự dừng an toàn. Kiểm tra quyền key, chờ 10 phút để chạy lại |
| `SYNC_INTERVAL_MIN chỉ nhận …` | Gõ chu kỳ không hợp lệ | Chỉ dùng 5, 10, 15 hoặc 30 |
| Email báo **"Đồng bộ Sapo bị dừng"** | Một trong các lỗi trên | Đọc dòng `DỪNG` ở cuối sheet Log |

## Cập nhật phiên bản mới

1. **Đồng bộ Sapo → Tắt tự động**.
2. Dán đè `dist/Code.gs` mới vào **Code.gs** → Ctrl + S. **Không** xóa sheet Map, **không** xóa thuộc tính tập lệnh.
3. **1. Kiểm tra kết nối** → **2. Chạy đồng bộ 1 lần** → **Bật tự động**.
