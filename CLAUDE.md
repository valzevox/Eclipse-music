# CLAUDE.md — Eclipse Engineering Guide & Invariant Rules for AI Agents

> **MANDATORY INSTRUCTION FOR ALL AI CODING AGENTS (Claude, Gemini, Antigravity, Mimi):**
> 1. Read this file and `AGENTS.md` before making any modifications.
> 2. Whenever an architectural change, bug fix, or pitfall is solved, **YOU MUST IMMEDIATELY UPDATE THIS FILE AND `AGENTS.md`** under *Traps That Have Already Cost Time Here* and *Architectural Invariants*.
> 3. Zero placeholder stubs (`// TODO`, `pass`), zero untested assertions. Every milestone must exit code 0.

---

## 1. Monorepo Architecture & Directory Structure

```
D:\Eclipse\
├── eclipse-pc/           # Desktop App (Electron + Vanilla JS + WebGL + WebAudio)
│   ├── src/
│   │   ├── main/         # Electron main process (IPC, window lifecycle, Discord RPC)
│   │   ├── renderer/     # Front-end UI (Dark Neon Glassmorphism, Audio Player, MV Player, AutoMix, EQ)
│   │   ├── server/       # Local background streaming proxy, YTM Auth, QR Session Transfer, SponsorBlock
│   │   └── services/     # Shared audio processing & YouTube scrapers
│   ├── dist/             # Built binary installers (win-x64, win-ia32, zip, AppImage, deb, dmg)
│   └── test-integration-verification.js  # 8-step integration test suite
│
├── eclipse-mobile/       # Mobile App (Capacitor + Vanilla JS + Native Android/iOS Plugins)
│   ├── android/          # Native Android Studio project (Gradle, ABI splits: arm64-v8a, vivo, universal)
│   ├── ios/              # Native Xcode iOS project (Swift, Background Audio, Dynamic Island)
│   ├── mobile/build.mjs  # Asset bundler (MUST BE RUN to sync root web files to www/)
│   ├── public/           # Shared static assets (HTML, CSS, JS)
│   ├── www/              # Capacitor webDir destination built by mobile/build.mjs
│   ├── server.js         # Local background streaming proxy, YTM Auth, QR Transfer, SponsorBlock
│   └── test-integration-verification.js  # 8-step integration test suite
│
└── SimpMusic-dev/        # Reference codebase (Compose Multiplatform) for protocol & feature parity
```

---

## 2. Mandatory Rules & Invariants for AI Agents

### Rule 1: Mobile Web Asset Build Invariant (`mobile/build.mjs`)
- In `eclipse-mobile`, web source files (`app.js`, `index.html`, `mv-player.js`, `automix-dj.js`, etc.) live in the root of `eclipse-mobile/`.
- Capacitor reads from `www/` (`capacitor.config.json: "webDir": "www"`).
- **CRITICAL**: After editing any web asset in `eclipse-mobile/`, you **MUST** run:
  ```bash
  cd eclipse-mobile && node mobile/build.mjs
  ```
  Failing to run `mobile/build.mjs` causes Capacitor builds and live devices to execute stale code!

### Rule 2: OS-Level Kernel Lock Invariant (Zero Pathname TOCTOU)
- File locking using pathname checks (`statSync` + `unlinkSync` or `renameSync`) suffers from TOCTOU race conditions under high process contention.
- **Windows**: Use Kernel Named Pipes (`\\.\pipe\eclipse-lock-<hash>`). The OS kernel reclaims pipes instantly on process exit/crash.
- **Linux**: Use Kernel Abstract Namespace Sockets (`\0eclipse-lock-<hash>`). Null-byte prefix ensures ZERO filesystem entries exist (`fs.existsSync` is false), completely eliminating stale lock files on disk.
- **macOS / Loopback Fallback**: Use local Loopback TCP (`{ host: '127.0.0.1', port: 25000 + (hash % 15000) }`).
  - **TRAP AVOIDED**: Windows Hyper-V and WSL reserve dynamic port exclusions in range `50000–50412` (`netsh interface ipv4 show excludedportrange protocol=tcp`). Never assign loopback ports in range `49152–50500`; strictly use safe range `25000–39999`.
  - Always handle `'error'` on `net.createServer().listen()` with `server.once('error', reject)` to avoid unhandled crash on reserved ports.

### Rule 3: YouTube IFrame MV Player Invariant
- When switching between Song Mode and Video Mode:
  1. **2-Way Timestamp Synchronization**: Listen to `event.data.event === 'infoDelivery'` and store `event.data.info.currentTime`. Never rely solely on initial audio timestamp; otherwise switching back to audio causes playback to rewind to 0:00!
  2. **Embed Restriction Fallback**: YouTube videos with disabled embedding emit `onError` (codes 2, 5, 100, 101, 150). The player must trap `onError`, gracefully call `switchToSong()`, and display a non-blocking toast so the user is never stuck with a black screen.

### Rule 4: SponsorBlock Invariant
- Backend (`server.js` / `src/server/server.js`):
  - Category whitelist: `['sponsor', 'intro', 'outro', 'selfpromo', 'music_offtopic']`.
  - In-memory LRU cache (200 tracks), 4s network timeout, fail-soft returns `[]`.
- Frontend (`app.js`):
  - Do not trigger segment skips while user is actively scrubbing (`isDraggingScrubber === true`).
  - Guard skip with `lastSkippedSegmentEnd !== seg.end` to prevent toast spam loops on the same segment.
  - Persist user preference under `localStorage.getItem('riff_sponsorblock_enabled')`.

### Rule 5: AutoMix DJ & Tempo Matching Invariant
- In `tempo_synced` mode:
  - Calculate tempo ratio: `ratio = sourceBpm / targetBpm`.
  - **Strict Clamp**: `Math.max(0.94, Math.min(1.06, ratio))` (±6% max adjustment). Extreme pitch/tempo bending sounds jarring and destroys vocal naturalness.
  - Crossfade gain curves must strictly use **Equal-Power** ($\cos(p \cdot \frac{\pi}{2})$ and $\sin(p \cdot \frac{\pi}{2})$) to maintain uniform sound pressure level without center-dip.
  - After crossfade completes or is cancelled, both players must have `playbackRate` and `volume` restored to `1.0`.

### Rule 6: Design System Preservation
- Eclipse's signature visual identity is **Dark Neon Glassmorphism** (`backdrop-filter: blur(20px)`, `rgba(255, 255, 255, 0.08)` borders, deep violet/magenta glowing accents).
- **NEVER** copy Material 3 Expressive shapes or Compose default widgets into Eclipse UI.

### Rule 7: Spotify Canvas & Animated Artwork Invariant
- Backend (`/api/canvas`):
  - Tra cứu animated video loop theo `title` + `artist` + `videoId`, cache LRU 200 bài, fail-soft trả `{ success: true, canvasUrl: null, isVideo: false }`.
- Frontend (`canvas-video-bg`):
  - Render thẻ `<video autoplay loop muted playsinline class="canvas-video-bg">` làm nền mờ Now Playing.
  - **CRITICAL BATTERY & GPU PROTECTION**: Bắt buộc lắng nghe sự kiện `visibilitychange` để `pause()` video khi `document.hidden` (ẩn tab, chuyển ứng dụng background) và `play()` trở lại khi mở lại app.
  - Lưu trạng thái bật/tắt người dùng qua `localStorage.getItem('riff_canvas_enabled')`.

### Rule 8: End-to-End GUI Verification via Windows MCP (`windows-mcp`)
- Không chỉ dựa vào script test headless (`node test-integration-verification.js`).
- Sau khi thêm hoặc chỉnh sửa tính năng UI/Menu trên Desktop (`eclipse-pc`), AI agent **PHẢI** sử dụng các công cụ `windows-mcp` (`App`, `Process`, `Snapshot`, `Screenshot`, `Click`) để:
  1. Khởi chạy bản build/source mới nhất của Eclipse PC.
  2. Chụp ảnh màn hình và đọc UI Tree (`Snapshot` / `Screenshot`) để xác nhận các nút bấm, menu Settings, dialog, và Canvas render đúng vị trí, không bị che khuất hoặc lỗi layout.
  3. Tương tác thử trực tiếp (bấm mở Cài đặt, chuyển tab, kiểm tra toggle) để đảm bảo hoạt động thực sự trên giao diện người dùng.

### Rule 9: Release Title & Tag Invariant (STRICT vX.X.X ONLY)
- **CẤM TUYỆT ĐỐI**: Không bao giờ được đặt title của GitHub Release hoặc Git Tag chứa bất kỳ tiền tố hoặc chữ cái nào ngoài đúng định dạng `vX.X.X` (ví dụ `v1.4.16`).
- **NGHIÊM CẤM**: Các dạng title như `Eclipse v1.4.16`, `Release v1.4.16`, `Eclipse Desktop v1.4.16`, v.v. Bắt buộc:
  - Tag name: `vX.X.X`
  - Release Title: đúng chính xác `vX.X.X` (không có chữ "Eclipse", không có thêm hậu tố).
  - Lệnh tạo release chuẩn:
    ```bash
    gh release create vX.X.X --title "vX.X.X" --notes-file release-notes.md ...
    ```
- **Lý do**: Website download và trình auto-updater bóc tách chuỗi version từ GitHub Release Title/Tag. Việc thêm bất kỳ chữ cái nào sẽ làm sai lệch parser của website tải nhạc và làm hỏng luồng cập nhật tự động.

### Rule 10: Auto-Updater Invariants & NSIS Destination Lock
- Khi nâng cấp phiên bản qua trình auto-updater trên Windows (`src/main/updater.js`):
  1. Trình cài đặt NSIS (`electron-builder`) bắt buộc phải được gọi với cờ `/S` (silent) và `/D=<execDir>` (đường dẫn thư mục chạy của app, ví dụ `dist\win-unpacked`).
  2. Không bao giờ chạy installer mà thiếu `/D=` khi app đang chạy từ thư mục unpacked/portable; nếu thiếu, NSIS sẽ cài lệch vào `%LocalAppData%\Programs\Eclipse` hoặc `Program Files`, khiến ứng dụng mở lại vẫn là version cũ và bị lặp vô tận popup update.
  3. Sau khi cập nhật thành công và khởi động lại, `update-notifier.js` dựa vào `CURRENT_VER > lastSeenVer` để hiển thị release notes trong chế độ Changelog với nút bấm **"Got it"**, tuyệt đối không được bung lại nút "Download & Install".

### Rule 11: Mobile Distribution Rules & Invariants
- **Google Play Store (CH Play): CẤM TUYỆT ĐỐI**. Bóc tách stream YouTube, chặn quảng cáo và phát nền vi phạm Device and Network Abuse Policy. Sẽ bị Google ban vĩnh viễn tài khoản Developer Console và danh tính dev.
- **Kênh Phân Phối Chuẩn**: Bắt buộc phân phối qua **GitHub Releases + IzzyOnDroid (F-Droid Repo) + Obtainium** (theo kiến trúc của SimpMusic / ViMusic / InnerTune).

### Rule 12: Enterprise Auto-Update Architecture Invariants & Footgun Registry
1. **Bypass GitHub API Rate Limit (60 req/h)**:
   - Tuyệt đối KHÔNG gọi định kỳ lên `api.github.com/repos/.../releases/latest`.
   - Bắt buộc dùng asset tĩnh CDN: `.../releases/latest/download/latest.json` (hoặc `latest.yml` cho PC). Asset tĩnh không bị tính hạn mức 60 req/h.
   - Thêm `If-None-Match` (ETag), jitter ngẫu nhiên cho PC và chỉ check khi app resume (cách tối thiểu vài giờ) cho Mobile.
2. **Xác thực Hash (sha512 base64)**:
   - File `latest.yml` của electron-builder dùng **sha512 (base64)**, KHÔNG PHẢI SHA-256. Kiểm tra hash phải parse đúng sha512.
   - Mobile: File `latest.json` chứa trường `sha512` của APK do release script sinh ra.
3. **HTTP Range Resume Guard**:
   - Khi resume tải file `.part`, nếu server trả HTTP `200 OK` (thay vì `206 Partial Content`), bắt buộc phải **xóa và ghi lại từ đầu**, không được append tiếp.
4. **An Toàn Tiến Trình Windows (PID & /T & chcp 65001)**:
   - Không dùng `taskkill /IM Eclipse.exe` (tránh kill nhầm app khác cùng tên). Phải lấy chính xác `process.pid` của app cha.
   - Bắt buộc dùng cờ `/T` trong `taskkill /PID <pid> /T /F` để dọn sạch toàn bộ cây tiến trình con (như `ffmpeg.exe` hoặc `yt-dlp.exe` có thể khóa file trong thư mục cài đặt).
   - Script batch bắt buộc có `chcp 65001 >nul` để không bị vỡ khi đường dẫn chứa tiếng Việt có dấu (`%USERPROFILE%`).
   - File log của script batch phải ghi vào `%APPDATA%\Eclipse\logs\update.log`, không để ở `%TEMP%`.
   - Tham số NSIS `/D=<execDir>` bắt buộc đứng cuối cùng và không có dấu ngoặc kép.
5. **Trải Nghiệm Nghe Nhạc (Tải Ngầm & Lưu State)**:
   - Tải ngầm hoàn toàn; không ngắt bài hát đang phát.
   - Chỉ hiển thị "Cài khi thoát" hoặc "Khởi động lại ngay" sau khi file đã tải và verify xong.
   - Trước khi kill process để cài: Bắt buộc lưu đồng bộ trạng thái phát nhạc (track ID, queue, currentTime, volume) vào disk (`playback-resume.json` hoặc Android `SharedPreferences`).
   - PC: Bắt buộc hook vào sự kiện `app.on('before-quit')` để khi người dùng Quit từ Tray Icon thì app tự động apply installer đã tải sẵn (kèm fallback nhắc lại sau 3 ngày nếu app chỉ nằm ở Tray).
   - Mobile: Kiểm tra `PlaybackService.running`; nếu đang phát thì mở dialog xác nhận tạm dừng trước khi phát Intent cài đặt.
6. **Kiểm Tra An Toàn File APK (Android)**:
   - Không hardcode package name. Phải so sánh động: `archiveInfo.packageName.equals(context.getPackageName())`.
   - Kiểm tra `archiveInfo.versionCode > currentVersionCode` (nghiêm ngặt `>` để chống vòng lặp update cùng bản).
   - Dùng `SigningInfo` (`GET_SIGNING_CERTIFICATES` / `GET_SIGNATURES`) đối chiếu chữ ký cert trước khi cài.
   - Dùng `canRequestPackageInstalls()` và `ACTION_VIEW` qua `FileProvider` (không dùng `ACTION_INSTALL_PACKAGE` đã deprecated).
7. **Cơ Chế Rollback & Manifest `blocked`**:
   - Thêm mảng `blocked: [...]` trong `latest.json`:
     - Nếu `currentVersion` thuộc `blocked`: Bật cảnh báo đỏ và ép cập nhật bản vá.
     - Nếu `targetVersion` thuộc `blocked`: Hủy tải ngay lập tức.
   - Lưu cờ `startedOk = false`, bật `true` sau 60s. Nếu crash 2 lần liên tiếp: Hủy tự động update lại bản đó và hiện link tải thủ công.
8. **Quy Trình Release An Toàn (Draft First)**:
   - Tạo release dạng **Draft** -> Upload đủ APK, EXE, `latest.yml`, `latest.json` -> Sau đó mới chuyển sang **Published** để tránh 404 client fallback xuống API dính rate limit.
9. **Bổ Sung Bất Biến Spec v3 (Android Playback, PC Shutdown & no-safe-target)**:
   - **Android Playback & Disk Persistence**: Không ngắt nhạc cưỡng bức khi mở installer APK; để OS tự thay thế process khi người dùng bấm "Cài đặt". Trước khi mở installer, bắt buộc dùng `SharedPreferences.Editor.commit()` đồng bộ để lưu trạng thái phát nhạc xuống đĩa flash (không dùng `apply()` bất đồng bộ).
   - **PC Shutdown Guard**: Bắt buộc dùng `powerMonitor.on('shutdown')` để gán cờ hủy kích hoạt installer trong `app.on('before-quit')` khi máy tính đang tắt hoặc khởi động lại.
   - **Re-hash SHA-512 Pre-exec**: Luôn tính toán lại SHA-512 của file installer trên đĩa ngay trước khi sinh batch process để đảm bảo tính toàn vẹn bytes sau quét virus.
   - **Continuous Playback Sync**: Renderer định kỳ (mỗi 10s) đồng bộ snapshot phát nhạc lên Main Process để Main luôn ghi đĩa đồng bộ (`fs.writeFileSync`) ngay khi thoát.
   - **Trạng Thái `no-safe-target`**: Khi cả bản hiện tại và bản mục tiêu remote đều thuộc `blocked`, chuyển sang trạng thái `no-safe-target`, vô hiệu hóa hoàn toàn nút tải và hiện thông báo bản vá đang được chuẩn bị.

---

## 3. Traps That Have Already Cost Time Here (Footguns & Pitfalls)

| Date | Issue / Trap | Root Cause | Permanent Solution |
|------|--------------|------------|---------------------|
| 2026-11-14 | NSIS updater looped 1.4.15 -> 1.4.16 | Installer launched without `/S /D=<execDir>`, installing to default ProgramFiles/LocalAppData instead of unpacked folder. | Appended `/S /D=<execDir>` in `src/main/updater.js`. |
| 2026-11-14 | Release Title pollution (`Eclipse vX.X.X`) | Website download parser broke because release title had extra words instead of pure `vX.X.X`. | Enforced Rule 9: Release title MUST strictly be `vX.X.X` only with zero extra text. |
| 2026-11-10 | Windows Port `EACCES` in Subtest 4I | Port `50237` fell inside Windows Hyper-V dynamic excluded port range (`50213–50312`). | Re-mapped loopback ports to `25000–39999` and attached error handler to `occupiedServer`. |
| 2026-11-10 | MV Player audio rewind on song switch | `lastTimestamp` was only recorded at start; IFrame playback progress was ignored. | Hooked `window.onmessage` for `infoDelivery` message with `currentTime`. |
| 2026-11-10 | MV Player black box on restricted videos | YouTube error codes 101/150 (embed forbidden) were unhandled. | Hooked `onError` to auto-fallback to song mode + toast notification. |
| 2026-11-10 | Stale Lock TOCTOU on Linux | `stat` -> `rename` -> `unlink` allowed another process to take over path between steps. | Replaced with Linux Kernel Abstract Namespace Sockets (`\0...`) which kernel reclaims on exit. |
| 2026-11-10 | Stale mobile web files | Edits to root web files in `eclipse-mobile` were not reflected in Capacitor `www/`. | Enforced `mobile/build.mjs` run on every change. |
| 2026-11-09 | Android Keystore async write failure | Hardware Keystore async rejection caused credential state corruption. | Fail-closed policy + fallback encrypted store with master key. |

---

## 4. Verification & Testing Commands

- **Desktop (Eclipse PC)**:
  ```powershell
  cd D:\Eclipse\eclipse-pc
  node test-integration-verification.js
  ```
- **Mobile (Eclipse Mobile)**:
  ```powershell
  cd D:\Eclipse\eclipse-mobile
  node mobile/build.mjs
  node test-integration-verification.js
  ```
- **Linux (WSL2)**:
  ```bash
  wsl bash -c "cd /mnt/d/Eclipse/eclipse-pc && node test-integration-verification.js"
  wsl bash -c "cd /mnt/d/Eclipse/eclipse-mobile && node test-integration-verification.js"
  ```
All test suites must report **ALL 8/8 VERIFICATION CHECKS PASSED (EXIT CODE 0)** before any task or commit is closed.

### 7. Google Auth / Library Import Fatal Pitfalls (Learned from Eclipse PC / Claude Audit)
- **Zero Undeclared Variables in IPC Handlers**: `GOOGLE_CLIENT_ID` was accessed at the top of `ipcMain.handle('google-import-library')` without declaration or import in `main.js`, throwing an unhandled `ReferenceError` immediately upon IPC call. When renderer wraps IPC calls in silent `catch (_) {}`, errors become completely invisible unless tested in DevTools or linted. ALWAYS verify identifier declarations at top of scope.
- **Never Clear Valid Session Partitions**: `importYoutubeCookiesToSession` called `clearStorageData({ storages: ['cookies'] })` before reading cookies, which wiped existing valid Google sessions and caused "Connected for 2s then reverts to Not connected". Always check if `SAPISID` exists before clearing.
- **Chromium Cookie Security Flags (`__Host-` / `__Secure-`)**: Setting `domain` on `__Host-*` cookies throws an error in Chromium/Electron. Always `delete details.domain` for host-only cookies and wrap `session.cookies.set()` in `try/catch`.
- **Non-blocking Background Tasks**: Never `await` sequential external processes like `exportYoutubeCookiesToDisk()` (which ran `yt-dlp` across 3 browsers for 45s) at the beginning of user-initiated IPC handlers.
- **Auto-Sync Lifecycle & State Guards**: When implementing auto-sync on app startup, ensure `checkGoogleAuthStatus()` is called in the top-level `DOMContentLoaded` lifecycle, lock the sync flag (`__eclipseAutoSyncing`) only while pending, and set completed flag (`__eclipseAutoSyncedAlbums = true`) ONLY upon successful response. Always store `tracks: pl.tracks` so imported albums can be played immediately.

### 8. Strict Non-Branded Nomenclature Invariant
- **CẤM TUYỆT ĐỐI**: Không bao giờ sử dụng tên các nền tảng/thương hiệu đối thủ (Spotify, SoundCloud, Apple Music, SimpMusic, EchoMusic) trong commit messages, release titles, release notes, tên hàm, ID hay nhãn giao diện UI.
- **QUY CHUẨN ĐỊNH DANH**: Luôn đóng gói tính năng dưới tên gọi bản quyền của Eclipse:
  - Theme Presets: `eclipse_neon`, `emerald_flow`, `solar_amber`, `crimson_pulse`, `cyber_cyan`.
  - Tính năng: *Eclipse Sync Rooms*, *Eclipse Analytics / Sonic Persona*, *Waveform Card Mode*, *Vertical Flow Reel*, *Song DNA*, *8D Spatial Audio*.

### 9. Mobile In-App Google / YouTube Sign-In Architecture
- **Clean Mobile User-Agent**: Bắt buộc loại bỏ `; wv` và chuỗi `Version/X.X` khỏi User-Agent của Android WebView để tránh lỗi "This browser or app may not be secure".
- **Cookie Interception**: Lắng nghe chuyển hướng đến `music.youtube.com`, dùng Android `CookieManager` để trích xuất `SAPISID`, `SID`, `SSID`.
- **Session Dispatch**: Chuyển cookie về backend proxy qua `/api/ytm/intercept-cookie` và mã hóa qua `ytm-auth.js` cho thư viện 2 chiều.

### 10. Minimalist Splash / Intro Animation Invariant
- **Thiết Kế**: Nền đen `#000`, logo vector Eclipse ở trung tâm (`26vmin`).
- **Hiệu Ứng**: Vẽ nét viền (`stroke-dashoffset`) và fill sáng kết hợp scale `1.28 -> 1.0` trong 1.15s.
- **CẤM TUYỆT ĐỐI**: Không thêm orb phát sáng, viền scallop răng cưa, chữ nhảy ký tự hay badge pill rườm rà. Luôn ưu tiên cờ `perf` và `prefers-reduced-motion`.

