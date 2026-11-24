# Eclipse Connect — Browser Extension (Manifest V3)

Eclipse Connect is an official companion extension for the Eclipse Music Player desktop application.

## Purpose
Enables secure, one-time import of your signed-in YouTube Music session from Google Chrome, Microsoft Edge, or Brave Browser without entering passwords or bypassing browser encryption.

## Security & Privacy Architecture
- **Least Privilege**: Only requests access to `cookies` and YouTube/Google domains.
- **Explicit Trigger**: Cookies are only read when you click **"Connect to Eclipse"**.
- **Ephemeral Pairing**: Transferred over local loopback (`127.0.0.1`) using a short-lived (120s), single-use cryptographic nonce.
- **Zero Storage**: Cookies are never stored in `chrome.storage`, never written to disk, and never transmitted over external networks.

## Manual Installation Guide (Chrome / Edge / Brave)
1. In Eclipse desktop app, open **Settings > Connect YouTube Music**.
2. Click **Download Extension** or locate `dist/extension/eclipse-connect.zip`.
3. Extract `eclipse-connect.zip` to a folder on your computer.
4. In your browser, open the extensions management page:
   - **Chrome**: `chrome://extensions`
   - **Edge**: `edge://extensions`
   - **Brave**: `brave://extensions`
5. Enable **Developer mode** (toggle in top right or bottom left).
6. Click **Load unpacked** and select the extracted `eclipse-connect` folder.
7. Click the **Eclipse Connect** extension icon in your browser toolbar.
8. Enter the Pairing Port and Nonce shown in the Eclipse desktop app, then click **Connect to Eclipse**.
