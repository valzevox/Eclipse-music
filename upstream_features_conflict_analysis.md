# Tổng hợp tính năng mới từ Riff v0.6.0 & v0.7.0 và Đánh giá Xung đột (Conflict Analysis) với Eclipse PC

Tài liệu rà soát toàn bộ các thay đổi từ Riff v0.6.0 (`v44.2.0`) và v0.7.0 (`b5ae209` / `v0.7.0`) đối chiếu với kiến trúc hiện tại của **Eclipse PC (v1.4.15)**.

---

## 1. Danh sách tính năng mới theo Changelog & Code Diff

### A. Nhóm Playback & Audio Engine (Âm thanh & Phát nhạc)
1. **Top Moment Pin (Đánh dấu đoạn cao trào / Drop):**
   - *Mô tả:* Cho phép user ghim một timestamp (ví dụ 1:15) trên thanh scrubber hoặc giao diện TV karaoke bằng icon trái tim hoặc icon tùy chọn. Click vào là nhảy thẳng tới drop/chorus.
   - *Storage & State:* `riff_top_moments` (Lưu map `trackId -> seconds`).
   - *Hàm liên quan:* `updateTopMomentPin`, `getTopMoment`, `setTopMoment`, `toggleTopMoment`.
2. **Reset / Alternative Audio Source (Đổi nguồn âm thanh dự phòng):**
   - *Mô tả:* Thêm nút / dialog trong menu ngữ cảnh bài hát để quét và đổi sang luồng âm thanh YouTube/SoundCloud khác nếu bài hát hiện tại bị khớp sai audio.
   - *Storage:* `riff_blocked_audio_sources` (Lưu danh sách audio ID bị người dùng reject).
3. **Zero Track Start Delay & Smart Queue Prefetch (Giảm độ trễ bắt đầu phát & Prefetch 2 bài):**
   - *Mô tả:* Tối ưu hoá luồng stream unthrottled trực tiếp tới Chromium, pre-fetch metadata & audio stream URL của 2 bài kế tiếp trong Queue để next bài tức thì (0.1s).
   - *Server & Audio:* Tối ưu `server.js` xử lý pipe stream chunk và IPC prefetch.
4. **Instrumental Break Animation (Hiệu ứng đoạn nhạc không lời):**
   - *Mô tả:* Trong màn hình Lyrics (lời bài hát), khi gặp khoảng trống không có lời hát giữa các câu, thanh note nhạc `.lyric-gap-note-fill` sẽ chạy animation mượt mà thể hiện tiến trình đoạn dạo nhạc.
5. **Fixed Word-level Sync (Đồng bộ lời bài hát từng từ):**
   - *Mô tả:* Cải thiện thuật toán khớp nhịp từng từ (syllable lyrics sync) từ LRCLIB / YouTube captions.

---

### B. Nhóm Library, Playlist & Recommendations (Thư viện & Đề xuất)
1. **Playlist & Favorites Recommendations ("Recommended for you"):**
   - *Mô tả:* Ở cuối mỗi Playlist hoặc danh sách Liked Songs, hiển thị thêm mục gợi ý các bài hát tương tự dựa trên nghệ sĩ/thể loại của playlist đó để thêm nhanh vào playlist.
2. **Spotify-style Track Table View (Chế độ xem bảng chi tiết):**
   - *Mô tả:* Bổ sung layout dạng bảng chuẩn Spotify: Cột `#`, `Title`, `Album`, `Plays`, `Date added`, `Duration` kèm toggle bật/tắt trong cài đặt hoặc ngay đầu danh sách.
3. **Show Delisted Albums (Hiện album bị ẩn / gỡ bản quyền):**
   - *Mô tả:* Truy vấn danh mục mở rộng để hiển thị các album/single đã bị delist trên streaming platform.
4. **Offline Mode (Chế độ ngoại tuyến):**
   - *Mô tả:* Công tắc chuyển app sang trạng thái Offline, chỉ load và phát các bài hát đã tải về hoặc đã được lưu trong disk cache (`cachedTracks`).
5. **Track Metadata Editor mở rộng & Full Song Credits:**
   - *Mô tả:* Cho phép sửa trực tiếp Album name, Custom streaming URL, và xem credits chi tiết (Nhạc sĩ, Ca sĩ, Producer, Platform source).

---

### C. Nhóm UI, Navigation & Polish (Giao diện & Cài đặt)
1. **Top-Left Window Navigation (Nút Back / Forward & Menu 3 chấm):**
   - *Mô tả:* Thêm nút `<` (Back) và `>` (Forward) lịch sử điều hướng các tab/trang cùng menu 3 chấm ở góc trên bên trái titlebar.
2. **Compact Sidebar Icons (Thu nhỏ Sidebar dạng biểu tượng):**
   - *Mô tả:* Sidebar có thể thu nhỏ hoàn toàn thành cột icon hẹp tiết kiệm diện tích màn hình.
3. **Combined Performance Mode & Reduce Motion:**
   - *Mô tả:* Gộp cài đặt Chế độ hiệu năng cao (`riff_perf_mode`) và Giảm chuyển động thành một nút gạt duy nhất.
4. **New Liked Songs Cover & Playlist Header Badge:**
   - *Mô tả:* Badge hiển thị nguồn import playlist (YouTube / Spotify) và thời gian import; cover mới cho Liked Songs.

---

## 2. Bảng Đánh Giá Xung Đột (Conflict Analysis) với Eclipse PC

| Tính năng Riff | Nguy cơ Xung đột với Eclipse PC | Phương án xử lý (Merge an toàn & Xoá sạch Riff brand) | Đánh giá |
| :--- | :--- | :--- | :--- |
| **1. Top Moment Pin** | **Thấp**. Không đụng chạm Audio Engine. Chỉ render thêm 1 pin indicator trên thanh Scrubber (`#scrubber`) và TV Player. | Đổi key lưu trữ thành `eclipse_top_moments`. Dùng màu neon violet Eclipse thay vì theme Riff. Class CSS đổi thành `.eclipse-top-moment-pin`. | **Khuyên dùng** (Hữu ích) |
| **2. Reset / Alternative Audio Source** | **Thấp**. Hoạt động như một modal tìm kiếm và gán lại `customAudioSource`. | Đổi storage key `riff_blocked_audio_sources` thành `eclipse_blocked_audio_sources`. Style modal theo Dark Neon Glassmorphism. | **Khuyên dùng** (Rất hữu ích khi nhạc bị khớp nhầm bản karaoke/cover) |
| **3. Instrumental Break Animation** | **Rất thấp**. Chỉ là CSS keyframes và logic đếm thời gian giữa 2 dòng lyrics. | Port class `.lyric-gap-note-fill` sang `src/renderer/styles.css`, đổi màu gradient theo neon cyan/violet của Eclipse. | **Khuyên dùng** (Đẹp mắt, không ảnh hưởng core) |
| **4. Zero Track Start Delay & Smart Queue Prefetch** | **TRUNG BÌNH ĐẾN CAO**. Eclipse PC có tích hợp **AutoMix DJ** (`automix-dj.js`, dual audio elements crossfade). Nếu Riff can thiệp vào `server.js` hoặc logic buffering của `audio.js` có thể gây desync hoặc lỗi double-audio trên AutoMix. | Cần bóc tách cẩn thận: Giữ nguyên luồng `EclipseAudioEngine` của Eclipse, chỉ áp dụng logic prefetch URL ở tầng queue renderer (`prefetchNextQueueTracks`), KHÔNG ghi đè `src/server/server.js` một cách mù quáng. | **Cần thận trọng & cherry-pick chọn lọc** |
| **5. Spotify-style Track Table View** | **Trung bình**. Eclipse có giao diện Dark Neon Glassmorphism đặc thù và các nút tương tác riêng (Favorite, Add to Queue, AutoMix tag). | Port CSS table view nhưng áp dụng biến màu `--eclipse-glass-bg`, `--eclipse-neon-*`. Tích hợp đầy đủ các context action hiện có của Eclipse. | **Khuyên dùng** |
| **6. Playlist & Favorites Recommendations** | **Thấp**. Chỉ là API call lấy related tracks gắn vào cuối danh sách view. | Áp dụng logic fetch từ YouTube Music Innertube của Eclipse, style thẻ bài hát theo style Eclipse hiện tại. | **Khuyên dùng** |
| **7. Top-Left Navigation (`<` `>` History)** | **Trung bình**. Eclipse đã tùy biến titlebar Windows/macOS/Linux với nút Đồng bộ di động (QR Sync), Sleep timer, Mini player. | Cần bố trí vị trí nút `<` `>` khéo léo để không đè lên logo Eclipse hoặc nút Mobile Sync trên titlebar. | **Nên cân nhắc vị trí UI** |
| **8. Gộp Performance Mode** | **Thấp**. | Đổi tên biến lưu trữ sang `eclipse_perf_mode`. Kiểm tra class `body.perf` xem có tắt nhầm visualizer WebGL của Eclipse không. | **Khuyên dùng** |
| **9. Offline Mode** | **Thấp**. | Dùng local storage `eclipse_offline_mode`, lọc danh sách hiển thị chỉ lấy các track có trong local DB / IndexedDB. | **Khuyên dùng** |

---

## 3. Các quy tắc "Bất di bất dịch" khi thực hiện Merge:
1. **Tuyệt đối không mang Branding Riff vào:**
   - Mọi key `localStorage` phải bắt đầu bằng `eclipse_` (Ví dụ: `eclipse_top_moments`, `eclipse_perf_mode`, `eclipse_blocked_audio_sources`).
   - Mọi class CSS phải dùng tiền tố `eclipse-` hoặc giữ class chuẩn chung, KHÔNG dùng `.riff-*`.
   - Mọi icon và logo phải dùng logo trăng lưỡi liềm Eclipse (`assets/icon.png` / `assets/logo.svg`), không import `assets/rifflibrary.svg` hay `riff.svg`.
2. **Bảo vệ toàn vẹn các tính năng độc quyền của Eclipse:**
   - **AutoMix DJ Engine** (`src/renderer/automix-dj.js` & `audio.js`).
   - **Mobile Sync / QR Transfer** (`mobileSync`).
   - **YouTube Music WebView Cookie Interception** (Google Auth không cần domain).
   - **Hệ thống Visualizer WebGL & Dark Neon Glassmorphism**.
3. **Quy trình merge:**
   - Không thực hiện `git merge` trực tiếp nhánh upstream vào `main` vì diff lên tới hơn 30,000 dòng code sẽ làm nát toàn bộ các custom fixes của Eclipse.
   - Thực hiện **cherry-pick theo module tính năng** (Feature-by-Feature porting).
