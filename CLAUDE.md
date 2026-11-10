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

---

## 3. Traps That Have Already Cost Time Here (Footguns & Pitfalls)

| Date | Issue / Trap | Root Cause | Permanent Solution |
|------|--------------|------------|---------------------|
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
