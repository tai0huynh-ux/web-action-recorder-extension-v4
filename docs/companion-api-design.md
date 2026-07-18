# Companion LAN API (MVP)

Companion đã được triển khai tại `companion/server.js` bằng Node.js built-in modules, không cần dependency.

## Chạy local

```powershell
$env:WAR_TOKEN='token-ngau-nhien-it-nhat-24-ky-tu'
npm run companion
```

Mặc định server chỉ bind `127.0.0.1:17373`.

## Mở cho LAN

```powershell
node companion/server.js --host 0.0.0.0 --token '<strong-token-at-least-24-characters>' --allow '192.0.2.20,192.0.2.21'
```

Trong Options của extension, bật Companion LAN, nhập URL máy companion và cùng token. Chỉ profile được đánh dấu `enabled` mới được chạy từ xa.

Các endpoint `/v1/*` đều yêu cầu `Authorization: Bearer <token>`. Không dùng `--allow '*'` ngoài mạng test cô lập; firewall hệ điều hành vẫn phải giới hạn subnet cần thiết.

External control is intentionally out of the MVP runtime.

## Default safety posture
- Disabled by default.
- Localhost bind only by default: `127.0.0.1`.
- Bearer token required for every request.
- LAN/Tailscale bind requires explicit user opt-in, token, and host/origin allowlist.
- Never expose publicly without reverse-proxy auth and firewall rules.

## Proposed endpoints
- `GET /health` — local status, version, watcher state.
- `GET /profiles` — list profile metadata only.
- `POST /profiles/:id/run` — enqueue run on active/selected tab.
- `POST /runs/:id/stop` — stop run.
- `GET /runs/:id/logs` — bounded recent logs with secrets redacted.

## Native messaging option
Prefer Chrome Native Messaging for a local companion because MV3 service workers cannot listen on sockets directly.
