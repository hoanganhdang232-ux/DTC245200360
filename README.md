# Hệ thống Quản lý Thư viện – Triển khai bằng Docker Compose

Đề 1 – môn Triển khai & Quản trị Hệ thống Phần mềm.

## Kiến trúc
```
Internet ─► Nginx (HTTPS :8443) ─► App Node.js ─► PostgreSQL ◄─ pgAdmin
                │                       │              │
                └── nginx-exporter      │        postgres-exporter
                         cAdvisor ──────┴──────────────┘
                              ▼
                  Prometheus ─► Grafana ◄─ Loki ◄─ Promtail (docker logs)
```
Hai network: `frontend` (publish port) và `backend` (`internal: true`, không ra Internet, DB không publish port).

## Chạy hệ thống
```bash
cp .env.example .env        # sửa mật khẩu mạnh cho từng biến
# tạo chứng chỉ HTTPS tự ký (nếu chưa có)
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout nginx/certs/server.key -out nginx/certs/server.crt \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
docker compose up -d --build
```
`.env` đã khai báo `COMPOSE_FILE` nên lệnh trên chạy cả 3 lớp (app, monitoring, logging).

| Thành phần | URL |
|---|---|
| Website | https://localhost:8443 |
| pgAdmin | http://localhost:5050 |
| Grafana | http://localhost:3000 |
| Prometheus | http://localhost:9090 |

Kết nối pgAdmin: Host `db`, Port `5432`, DB `library`, user/password = `DB_ADMIN_*` trong `.env`.

## LogQL mẫu (Grafana → Explore → Loki)
```logql
{service="nginx"} |= "POST"
{service="app"} | json | status >= 400
sum by (status) (count_over_time({service="app"} | json [1m]))
rate({container=~"library-.*"}[1m])
```

## Hardening đã áp dụng
- Container non-root: app (`USER node`), nginx-unprivileged, Grafana/Prometheus/pgAdmin chạy user riêng
- Network isolation: `backend` internal, DB không publish port; pgAdmin/Grafana/Prometheus chỉ bind `127.0.0.1`
- Mật khẩu mạnh trong `.env` (không commit); user DB riêng cho app (chỉ DML) và exporter (chỉ `pg_monitor`)
- `read_only`, `cap_drop: ALL`, `no-new-privileges` cho app và nginx
- Nginx: HTTPS TLS1.2+, HSTS, CSP, X-Frame-Options, X-Content-Type-Options, rate limit, ẩn version, chặn `/metrics`
- Grafana: tắt đăng ký và anonymous

## Quy trình commit
1. `feat: app + postgres + pgadmin + nginx reverse proxy (HTTPS, security headers)`
2. `feat: prometheus + grafana + cadvisor + exporters`
3. `feat: loki + promtail + LogQL`
