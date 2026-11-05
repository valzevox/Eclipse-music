# Kế Hoạch Nâng Cấp Trending Feed & Khám Phá — Eclipse PC

## 1. Mục tiêu
Hiện đại hóa toàn diện giao diện & trải nghiệm mục **Trending (Thịnh hành)** trên Eclipse PC theo tiêu chuẩn thiết kế Material 3 Expressive & Fluid UI:
- **Hero Spotlight Carousel**: Trình diễn các ca khúc trending thịnh hành nhất với banner tràn viền, ảnh phân giải cao, auto-scroll mượt, nút nghe tức thì và ambient glow.
- **Compact Ranked Chart (Lưới xếp hạng phân cột có số thứ tự)**: Thay thế danh sách card 1 hàng ngang phẳng bằng lưới 3–4 hàng dạng cột (#1, #2, #3, ...) với snap scroll thông minh.
- **Chips Category Bar**: Thanh lọc thể loại / xu hướng (`Thịnh hành`, `Bảng xếp hạng`, `Mới phát hành`).
- **Shimmer Skeleton Loader**: Hiệu ứng skeleton pulse mượt mà khi đang tải dữ liệu thay cho spinner đơn điệu.
- **Fluid Micro-interactions**: Gradient ánh sáng theo bài hát, hiệu ứng hover scale spring bezier.

---

## 2. Phạm vi thay đổi (Disjoint Scope)
- `src/renderer/index.html`: Thêm container cấu trúc cho Category Chips & Trending Chart Grid.
- `src/renderer/style.css`: Hệ thống CSS cho Hero Spotlight Carousel, Ranked Item Card, Grouped Border Shapes, Category Chips và Skeleton Shimmer.
- `src/renderer/app.js`: Logic render carousel tự động, tính toán snap layout, fetch đa danh mục, và binding điều khiển phát nhạc.
- `src/server/server.js`: Mở rộng `/api/trending` hỗ trợ query phân loại (`trending`, `charts`, `new_releases`).

---

## 3. Các giai đoạn triển khai (Phases)

### Giai đoạn 1: Mở rộng Server Backend (`src/server/server.js`)
- Bổ sung tham số `category` cho endpoint `/api/trending` (`type=trending|top|new_releases`).
- Cache theo từng category (`ts`, `tracks`) với TTL 2 giờ để phản hồi tức thì.
- Giữ vững cơ chế bảo mật token & fallback dữ liệu an toàn.

### Giai đoạn 2: Khung giao diện HTML & CSS (`index.html` & `style.css`)
- **Category Chips Bar**: Thiết kế thanh chips bo tròn pill mượt mà trên đầu phần Thịnh hành.
- **Hero Carousel Component**:
  - Container tỷ lệ vàng, bo góc `24px`, ambient backlight theo màu bìa.
  - Controls chuyển slide (dot indicators + nút Previous / Next dạng kính mờ glassmorphism).
- **Ranked Chart Grid**:
  - Lưới `grid-template-rows: repeat(3, auto)` hoặc `repeat(4, auto)` cuộn ngang.
  - Huy hiệu thứ hạng `rank-badge` (#1 - #3 màu nhấn đặc biệt, #4+ màu tinh tế).
  - Khung bao cụm 3-4 bài hát có đường bo liên kết mềm mại.
- **Shimmer Keyframes**:
  - Animation `shimmerWave` gradient trượt từ trái sang phải cho cả banner và list item.

### Giai đoạn 3: Logic Renderer & Animations (`src/renderer/app.js`)
- Tạo hàm `renderTrendingHeroCarousel(tracks)`:
  - Tự động chuyển card mỗi 5 giây; tạm dừng khi chuột rê vào (hover) hoặc khi đang cuộn.
  - Nút Play trực tiếp phát nguyên danh sách từ vị trí đang chọn.
- Tạo hàm `renderTrendingRankedGrid(tracks)`:
  - Hiển thị thứ hạng từ 1 đến N.
  - Phím tắt / chuột cuộn ngang mượt mà với thanh fade ở 2 rìa (`updateRowFade`).
- Tạo hàm `renderTrendingShimmer()`:
  - Hiển thị khung giả lập ngay lập tức trước khi có dữ liệu từ server hoặc cache.
- Tích hợp bộ lọc Chips:
  - Khi người dùng click chip, chuyển đổi danh sách với hiệu ứng cross-fade mượt (150ms).

### Giai đoạn 4: Đánh giá & Kiểm chứng (Verification Gate)
- `node -c src/renderer/app.js` và `node -c src/server/server.js` thoát code 0.
- Khởi động app thử nghiệm, kiểm tra giao diện không vỡ layout ở mọi độ phân giải (800x600 đến 4K).
- Thao tác chuyển category, hover, phát nhạc từ banner và chart hoạt động chuẩn xác.
