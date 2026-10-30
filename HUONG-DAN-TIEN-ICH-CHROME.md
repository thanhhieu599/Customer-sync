# Hướng dẫn cài tiện ích Chrome "D&T Sapo Sync" (khoảng 30 phút)

Tiện ích đồng bộ khách hàng 2 chiều Sapo Omni ↔ Sapo Web, **không cần API key Omni**: nó dùng tab Sapo Omni đang
đăng nhập trên Chrome, giống hệt cách nhân viên thao tác. Phía Sapo Web dùng API key như bình thường.

> Đã kiểm chứng trên cửa hàng thật: đọc khách / đơn hàng và **sửa khách** qua phiên đăng nhập đều được chấp nhận
> (Omni yêu cầu gửi kèm mã KH và tên khi sửa – tiện ích đã làm đúng như vậy).

---

## ⭐ Chuyển đơn từ Sapo Web về đúng khách gốc trên Omni (từ phiên bản 1.6)

**Vấn đề:** đơn tạo trên Sapo Web khi về Omni bị bộ kết nối của Sapo gắn vào một **khách trùng** (mang tag `Web`),
không phải hồ sơ khách gốc → lịch sử mua hàng, công nợ bị tách đôi.

**Tiện ích tự sửa (đã kiểm chứng trên Omni thật: đổi khách trên đơn đã chốt qua API được chấp nhận):**

```
Sale tạo đơn trên Sapo Web → Sapo đẩy đơn về Omni, gắn vào khách trùng (tag "Web")
→ mỗi 10 phút tiện ích đọc trang đầu danh sách đơn Omni (1 lệnh)
→ đơn kênh "Sapoweb" trong 24 giờ, đang ở khách tag "Web"
→ tìm hồ sơ GỐC cùng SĐT (+84… = 0…) hoặc email → chuyển đơn về hồ sơ gốc → đọc lại xác nhận
```

| Tình huống | Tiện ích làm |
|---|---|
| Có **đúng 1** hồ sơ gốc (không tag "Web", tạo trước) | **Chuyển đơn về hồ sơ gốc**, ghi nhật ký *"Đã chuyển đơn về khách gốc"*, hiện thông báo |
| Khách **hoàn toàn mới** (chưa có hồ sơ nào khác trên Omni) | Giữ nguyên đơn |
| **Nhiều** hồ sơ trùng SĐT/email, hoặc hồ sơ "gốc" lại tạo sau | **Không chuyển**, ghi cảnh báo *"Đơn Web cần xem tay"* kèm danh sách hồ sơ (báo 1 lần) |
| Đơn tại quầy / kênh khác, đơn cũ hơn 24 giờ, đơn đã ở hồ sơ gốc | Không đụng tới |
| Omni nhận lệnh nhưng không lưu | Báo lỗi, lượt sau thử lại |
| Omni chậm / hết phiên đăng nhập | Dừng ngay (tạm nghỉ / báo đăng nhập lại); đơn đã chuyển xong được ghi nhớ |

**Bật lần đầu:**
1. Cài đặt → *Chuyển đơn từ Sapo Web về đúng khách gốc* = **BẬT**, *Chế độ* = **CHẠY THỬ** → Lưu.
2. Tạo 1 đơn thử trên Sapo Web → chờ đơn về Omni → popup **Chạy ngay**.
3. Thẻ **Nhật ký**: dòng *"[THỬ] Sẽ chuyển đơn về khách gốc"* phải ghi đúng mã đơn, đúng khách gốc.
4. Đúng → *Chế độ* = **CHẠY THẬT** → Lưu → **Chạy ngay** → mở đơn trên Omni kiểm tra khách hàng, lịch sử mua hàng, công nợ.
5. Popup → **Bật tự động**.

> Hằng ngày nên lọc Nhật ký theo **WARN** để xử lý tay các đơn *"cần xem tay"* (thường do khách có 2 hồ sơ thật trên Omni –
> nên gộp/ngừng dùng hồ sơ phụ để các đơn sau tự chuyển đúng).

## Chế độ mặc định: CHỈ GHÉP khách (từ phiên bản 1.5)

Mục tiêu của D&T: **đơn tạo trên Sapo Web phải về đúng hồ sơ khách gốc trên Omni** – không đẩy khách qua lại.
Vì vậy mặc định tiện ích **không tạo, không sửa khách ở bên nào**, chỉ ghi nhận *"khách Web này là khách gốc nào trên Omni"*:

- Ghép theo **SĐT đã quy về một dạng** (Sapo Web lưu `+84983503360`, Omni lưu `0983503360` → coi là một) rồi đến **email**.
- Khi một SĐT/email có nhiều hồ sơ trên Omni (hồ sơ gốc + bản trùng do Sapo tự sinh), chọn **hồ sơ gốc** (nhiều đơn hơn, tạo sớm hơn).
- Bảng ghép này là nền để bước tiếp theo **tự chuyển đơn từ Web về đúng khách gốc trên Omni**.

Muốn bật lại việc tạo/sửa khách 2 bên: Cài đặt → *Đẩy / cập nhật khách giữa Omni và Web* → **CÓ**.

## Cách tiện ích bảo vệ Sapo Omni (từ phiên bản 1.1)

Sau sự cố Omni chậm/sập tạm thời khi chạy thử bản 1.0 (bản cũ đọc lại toàn bộ khách mỗi lượt, dồn ~3 lệnh/giây),
tiện ích chạy theo nguyên tắc **"nhẹ hơn một nhân viên thao tác"**:

| Cơ chế | Bản 1.0 (gây sự cố) | Bản 1.1 |
|---|---|---|
| Mỗi lượt định kỳ | Đọc lại **toàn bộ** ~2.500 khách (10–50 lệnh nặng) | Chỉ hỏi **"khách nào vừa thay đổi"** – thường **1 lệnh** |
| Quét toàn bộ để đối soát | Mỗi 10 phút | **1 lần/ngày vào giờ đêm** (mặc định 2 giờ sáng), trang nhỏ 50 khách |
| Giãn cách giữa 2 lệnh Omni | 0,3 giây | **≥ 1,5 giây** |
| Thời gian chờ tối đa mỗi lệnh | Không giới hạn | **30 giây** |
| Omni chậm / lỗi (429, 5xx, treo) | Thử lại tới 5 lần mỗi lệnh | **Dừng ngay sau 2 lần**, **tạm nghỉ 60 phút**, báo ⏸ + thông báo |
| Số lệnh ghi Omni mỗi lượt | Không giới hạn | **Tối đa 60**, phần còn lại để lượt sau |
| Xóa bản dội (nếu bật) | Dựa vào số liệu lưu sẵn | **Hỏi lại Sapo có đơn hàng không ngay trước khi xóa** |

**Sapo Omni của D&T** (kiểm chứng 29/10/2026) **không** lọc được "chỉ khách thay đổi" nhưng luôn trả **khách mới tạo lên đầu**.
Tiện ích tự nhận ra và chạy chế độ phù hợp:

| Loại thay đổi | Thời gian cập nhật | Số lệnh |
|---|---|---|
| Khách **mới tạo** trên Omni (gợi ý, ghép, đẩy lên Web) | ≤ 10 phút | 1 lệnh/lượt (trang đầu) |
| Khách mới / sửa trên **Sapo Web** → Omni | ≤ 10 phút | 1 lệnh/lượt (Web lọc được theo thay đổi) |
| **Sửa thông tin khách cũ** trên Omni → Web | ≤ 6 giờ (lượt quét toàn bộ, chậm rãi) | ~50 lệnh / 6 giờ |

Nếu Sapo vừa không lọc được vừa không xếp khách mới lên đầu, tiện ích chuyển sang **quét toàn bộ mỗi 6 giờ**.

## 1. Chuẩn bị (làm 1 lần)

| Việc | Chi tiết |
|---|---|
| **Máy chạy** | 1 máy văn phòng bật liên tục (PC sẵn có hoặc mini PC). Windows: *Cài đặt → Hệ thống → Nguồn* → **Ngủ: Không bao giờ** |
| **Chrome tự mở khi bật máy** | Nhấn `Win + R` → gõ `shell:startup` → kéo biểu tượng Chrome vào thư mục vừa mở |
| **Hồ sơ Chrome riêng** | Bấm ảnh đại diện góc phải Chrome → **Thêm** → đặt tên `Đồng bộ Sapo`. Chỉ dùng hồ sơ này cho việc đồng bộ |
| **Tài khoản Omni riêng** | Trong Sapo Omni: *Cấu hình → Nhân viên* → tạo nhân viên **"Đồng bộ tự động"**, chỉ cấp quyền **Khách hàng: xem, thêm, sửa**. Mọi thay đổi do tiện ích thực hiện sẽ mang tên tài khoản này để dễ truy vết |
| **API key Sapo Web** | `https://xxxxx.mysapo.net/admin/apps/private` → Tạo ứng dụng riêng → chỉ quyền **Khách hàng: Đọc và ghi** → ghi lại API Key + Mật khẩu |

## 2. Cài tiện ích

1. Mở https://github.com/thanhhieu599/customer-sync → nút xanh **Code → Download ZIP** → giải nén vào ổ đĩa
   (ví dụ `C:\DT-Sapo-Sync\`). **Không xóa thư mục này sau khi cài** – Chrome chạy tiện ích từ đây.
2. Trong hồ sơ Chrome `Đồng bộ Sapo`, gõ vào thanh địa chỉ: `chrome://extensions`
3. Bật **Chế độ dành cho nhà phát triển** (góc trên bên phải).
4. Bấm **Tải tiện ích đã giải nén** → chọn thư mục **`chrome-extension`** bên trong thư mục vừa giải nén.
5. Bấm biểu tượng **mảnh ghép 🧩** trên thanh Chrome → **ghim 📌** "D&T Sapo Sync" để biểu tượng luôn hiện.

> Chrome có thể hiện thông báo *"Tắt các tiện ích ở chế độ nhà phát triển"* khi khởi động: bấm **Giữ lại / Đóng**, không tắt.

## 3. Đăng nhập Omni & cấu hình

1. Mở tab `https://trangthietbivn.mysapogo.com` → đăng nhập bằng tài khoản **"Đồng bộ tự động"** →
   chuột phải vào tab → **Ghim**. Tab này cần luôn mở.
2. Bấm biểu tượng tiện ích → **Cài đặt & nhật ký**. Điền:

| Ô | Giá trị |
|---|---|
| Địa chỉ Sapo Web | `https://xxxxx.mysapo.net` |
| API Key / Mật khẩu | lấy ở bước chuẩn bị |
| Địa chỉ Sapo Omni | `https://trangthietbivn.mysapogo.com` (đã điền sẵn) |
| Chế độ | **CHẠY THỬ** |
| Số khách tạo mới tối đa mỗi lượt | `10` |
| Chu kỳ chạy tự động | `10` phút |
| Giờ quét toàn bộ | `2 giờ` (giờ đêm, ít người dùng Sapo) |

3. Bấm **Lưu cài đặt** → **Kiểm tra kết nối**. Kết quả đúng:
   ```
   ✅ Sapo Web: kết nối OK. Tổng khách: ...
   ✅ Sapo Omni (qua tab đăng nhập): kết nối OK. Tổng khách: ...
   ```

## 4. Bật dần theo 5 nấc

| Nấc | Làm gì | Kiểm tra |
|---|---|---|
| **0. Quét lần đầu** | **Ngoài giờ làm việc** (trưa hoặc sau 18 giờ): Chế độ CHẠY THỬ → **Quét toàn bộ ngay** | Lần đầu tiện ích phải đọc toàn bộ khách 2 bên (khoảng 1–2 phút, chậm rãi). Từ lượt sau chỉ đọc thay đổi |
| **1. Chạy thử** | Chế độ CHẠY THỬ → **Chạy đồng bộ 1 lần** | Thẻ **Nhật ký** → lọc *Chỉ tóm tắt*: số khách *sẽ* tạo / ghép có hợp lý không? Các dòng `[THỬ]` là việc sẽ làm |
| **2. Phạm vi** | Nếu chỉ đẩy khách B2B lên Web: điền `579639` (nhóm Bán lẻ) vào ô *Mã nhóm khách KHÔNG đẩy lên Web* – **sau khi** đã chuyển khách công ty ra khỏi nhóm Bán lẻ | Chạy thử lại, số khách sẽ tạo giảm |
| **3. Chạy thật 1 khách** | Chế độ **CHẠY THẬT**, tạo tối đa **1** → Chạy 1 lần | Khách vừa tạo trên Web đúng tên/SĐT/email/địa chỉ? Sửa SĐT khách đó trên Web → chạy lại → Omni cập nhật? Nhật ký có dòng *"không lưu đúng dữ liệu"* không? |
| **4. Mở rộng** | Tạo tối đa **100** → chạy vài lần | Dòng tóm tắt: `tạo trên Web: 0`, `để lượt sau: 0` |
| **5. Tự động** | Popup → **Bật tự động** | Biểu tượng không có dấu = tốt. Theo dõi nhật ký 2–3 ngày đầu |

## 5. Gợi ý khách Omni ngay khi tạo đơn trên Sapo Web (từ phiên bản 1.3)

Trên trang **Tạo đơn hàng / Đơn hàng nháp** của Sapo Web, khi gõ vào ô **"Tìm kiếm khách hàng…"**, tiện ích hiện thêm
khung xanh **"Khách hàng từ Sapo Omni"** bên trái ô tìm kiếm (không che danh sách gợi ý của Sapo).

| Thao tác | Kết quả |
|---|---|
| Gõ tên (có dấu hoặc không dấu: `hung vuong`), SĐT (`0969…`, `+84 969…`, một phần số) hoặc email | Hiện tối đa 8 khách Omni khớp nhất, kèm SĐT, email, mã KH, số đơn |
| Khách có nhãn xanh **"Đã có trên Web"** → bấm chọn | Tiện ích **tự chọn khách đó vào đơn** (điền SĐT → bấm đúng dòng khách trong danh sách của Sapo) |
| Khách có nhãn vàng **"Chưa có trên Web"** → bấm chọn | Tiện ích **tự tạo khách trên Sapo Web** từ dữ liệu Omni (tên, SĐT, email, địa chỉ), chờ Sapo cập nhật vài giây rồi **tự chọn vào đơn**. Đơn sau đó về Omni sẽ được chuyển về đúng hồ sơ gốc |
| Phím ↑ ↓ và Enter | Chọn bằng bàn phím |

- Tìm kiếm dùng **bản sao danh sách Omni trong máy** → gõ phím **không gửi lệnh nào tới Omni**. Khách mới tạo trên Omni
  xuất hiện trong gợi ý sau lượt đồng bộ kế tiếp (tối đa ~10 phút).
- Khách Omni **chưa có SĐT hoặc email** sẽ không được tạo lên Web (tránh tạo trùng) – bổ sung trên Omni trước.
- Tiện ích chỉ bấm vào dòng nằm ngay dưới ô tìm kiếm và chứa đúng SĐT / email / tên khách; **không bao giờ bấm "Thêm mới khách hàng"**.
  Không tự chọn được (hiếm) → khung báo đỏ, gõ SĐT vào ô tìm kiếm và chọn tay.
- Tắt tính năng tự tạo: Cài đặt → *Chọn khách chỉ có trên Omni trong ô gợi ý* → **Chỉ hướng dẫn**.
- Tính năng này hoạt động trên **mọi máy cài tiện ích** (máy của sale), nhưng bản sao danh sách Omni chỉ có ở máy đã
  quét / đồng bộ. Máy sale cần: cài tiện ích, nhập cấu hình, đăng nhập Omni, bấm **Quét toàn bộ ngay** 1 lần (ngoài giờ),
  **không cần bật tự động** (để máy đồng bộ chính lo việc đó).

> ⚠️ **Lưu ý về đơn hàng bên Omni:** khi khách được tạo trên Sapo Web, bộ kết nối có sẵn của Sapo vẫn sinh một
> "bản dội" bên Omni, và **đơn tạo trên Web sẽ về bản dội đó**, không về hồ sơ gốc. Tiện ích giúp **tìm và chọn khách
> nhanh**, nhưng không thay đổi được cách bộ kết nối của Sapo gắn đơn. Muốn mọi đơn về đúng hồ sơ gốc: làm phép thử A
> (README) để quyết định bật `Xóa bản dội`, hoặc tạo đơn B2B trực tiếp trên Omni.

## 6. Đọc popup (bấm biểu tượng tiện ích)

| Dòng | Ý nghĩa |
|---|---|
| Khung **vàng** "Tự động đang TẮT" | Hệ thống **không tự chạy**. Bấm **Bật tự động** |
| Khung **xanh** "Đang ở CHẠY THỬ" | Chỉ ghi nhật ký, **chưa sửa dữ liệu Sapo**. Đổi sang CHẠY THẬT trong Cài đặt khi đã kiểm tra xong |
| **Lượt kế tiếp** | Giờ chạy lượt tiếp theo, còn bao nhiêu phút |
| **Lượt chạy gần nhất** | Lần đồng bộ thật gần nhất và kết quả (khung xám bên dưới) |
| **Kiểm tra gần nhất** | Lần gần nhất hệ thống "thức dậy" kiểm tra – kể cả khi bỏ qua (đang tạm nghỉ…) kèm lý do |

Khi đồng bộ **có thay đổi** (tạo/cập nhật khách), Chrome hiện thông báo góc màn hình *"Đã đồng bộ N khách hàng"*.
Không có gì mới thì không làm phiền.

> **Không thấy thông báo nào trên Windows?** Vào *Cài đặt Windows → Hệ thống → Thông báo* → bật cho **Google Chrome**,
> và tắt chế độ *Không làm phiền / Hỗ trợ tập trung*.

## 7. Đọc biểu tượng tiện ích

| Biểu tượng | Nghĩa | Cần làm |
|---|---|---|
| (không có chữ) | Hoạt động tốt | Không |
| `…` xanh | Đang chạy | Không |
| `!` cam | Có cảnh báo (vd. Sapo không lưu đúng 1 trường) | Xem thẻ Nhật ký, lọc WARN |
| `X` đỏ | Có lỗi hoặc đã dừng an toàn | Xem dòng `DỪNG` / `ERROR` trong Nhật ký |
| `🔑` đỏ | **Hết phiên đăng nhập Omni** | Mở tab Omni → đăng nhập lại → popup bấm **Chạy ngay** |
| `⏸` cam | **Omni đang chậm/lỗi – tiện ích tự tạm nghỉ 60 phút** | Không cần làm gì, hết giờ nghỉ tự chạy lại. Nếu chắc Omni đã ổn: popup → **Bỏ tạm nghỉ** |
| `OFF` xám | Đang tắt tự động | Popup → Bật tự động |

Khi hết phiên đăng nhập hoặc có lỗi, Chrome hiện **thông báo trên màn hình** (tối đa 1 lần/giờ cho mỗi loại).

## 8. (Tùy chọn) Nhận cảnh báo qua email

1. Vào https://script.google.com → **Dự án mới** → dán đoạn dưới (sửa email) → **Ctrl + S**:
   ```javascript
   function doPost(e) {
     var d = JSON.parse(e.postData.contents);
     MailApp.sendEmail('admin@trangthietbi.vn', '[D&T Sapo Sync] ' + d.subject, d.body);
     return ContentService.createTextOutput('ok');
   }
   ```
2. **Triển khai → Triển khai mới → Loại: Ứng dụng web** → *Thực thi với tư cách*: **Tôi** → *Ai có quyền truy cập*: **Bất kỳ ai** → **Triển khai** → cấp quyền.
3. Chép **URL ứng dụng web** (dạng `https://script.google.com/macros/s/.../exec`) → dán vào ô **Email cảnh báo** trong cài đặt tiện ích → Lưu.

## 9. Vận hành & sự cố

| Tình huống | Hệ thống xử lý | Anh/chị cần làm |
|---|---|---|
| Mất điện / khởi động lại máy | Chrome tự mở, tiện ích tự chạy lại; lượt sau tự bù toàn bộ thay đổi | Kiểm tra tab Omni còn đăng nhập |
| Lỡ đóng tab Omni | Tiện ích tự mở lại tab ghim | Không |
| Chrome cho tab Omni "ngủ đông" (Tiết kiệm bộ nhớ) | Tự tải lại tab trước khi dùng, và đặt cờ cấm ngủ đông cho tab Omni | Không. Nếu muốn chắc hơn: *Chrome → Cài đặt → Hiệu suất → Tiết kiệm bộ nhớ* → thêm `trangthietbivn.mysapogo.com` vào danh sách **luôn hoạt động** |
| Tab Omni bị treo không trả lời | Mỗi lệnh chờ tối đa 45 giây, sau đó dừng lượt và tạm nghỉ | Không |
| **Sau 15–20 phút popup vẫn không đổi** | — | ① Popup có khung vàng "Tự động đang TẮT"? → bấm Bật tự động. ② Xem dòng "Kiểm tra gần nhất". ③ Vào `chrome://extensions` → ở tiện ích, nếu có nút đỏ **Lỗi** → bấm vào, chụp màn hình gửi người phụ trách kỹ thuật |
| Hết phiên đăng nhập Omni | Dừng an toàn, biểu tượng 🔑, thông báo + email | Đăng nhập lại trên tab Omni |
| Sapo Omni chậm / quá tải | Dừng ngay, tạm nghỉ 60 phút, biểu tượng ⏸ | Không cần làm gì |
| Sapo thay đổi hệ thống, dữ liệu trả về bất thường | Dừng an toàn, không ghi gì, báo lỗi | Gửi dòng `DỪNG` trong nhật ký cho người phụ trách kỹ thuật |
| Muốn tạm dừng | — | Popup → **Tắt tự động** |
| Xuất báo cáo | — | Thẻ Nhật ký / Bảng ghép → **Xuất Excel (CSV)** |

**Cập nhật phiên bản mới:** tải ZIP mới → giải nén **đè** vào đúng thư mục cũ → `chrome://extensions` → bấm **↻ Tải lại** ở tiện ích.
Cài đặt, bảng ghép và nhật ký được giữ nguyên.

## 10. Lưu ý

- Đây là **giải pháp chuyển tiếp** dùng API nội bộ của Omni (giống giao diện Omni dùng). Khi Sapo cấp API chính thức
  (Enterprise API / API key Omni), chuyển sang bản Google Apps Script ([HUONG-DAN-TRIEN-KHAI.md](HUONG-DAN-TRIEN-KHAI.md)) –
  logic đồng bộ là một, không phải làm lại.
- Máy chạy tiện ích đang giữ phiên đăng nhập Omni: đặt mật khẩu Windows, không cài phần mềm lạ, không dùng hồ sơ Chrome này để duyệt web.
- Không chia sẻ API key Sapo Web qua chat/email.
