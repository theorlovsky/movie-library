# Infrastructure (production VPS)

This guide covers deploying to the Hostinger KVM VPS. For local dev, see [local-development.md](./local-development.md).

## VPS prerequisites

What you need on the Hostinger KVM before deploying:

- **OS** — Ubuntu 22.04 LTS or 24.04 LTS.
- **Docker Engine** + **Docker Compose plugin** — `curl -fsSL https://get.docker.com | sh`, then `sudo usermod -aG docker $USER`.
- **UFW** configured: SSH allowed (custom port, not 22), 80, 443. Everything else closed.
- **fail2ban** — `apt install fail2ban`, default config is fine.
- **SSH** — key-only, root login disabled, password auth off.
- **A non-root user** for deploys (e.g. `deploy`), member of the `docker` group, no sudo.
- **DNS** — A record for your domain pointing at the VPS IP. Caddy will issue a certificate at first start.

## Layout on the VPS

```
/opt/movie-library/
├── docker-compose.yml          (production stack)
├── .env                        (secrets, in .gitignore)
├── Caddyfile
├── postgres-data/              (DB volume, created automatically)
├── caddy-data/                 (Let's Encrypt certificates)
├── caddy-config/
└── backups/                    (local dumps before uploading to the cloud)
```

These files are placed manually during the initial setup. CI/CD only updates the images and restarts containers.

## docker-compose.yml

```yaml
# /opt/movie-library/docker-compose.yml

services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - ./postgres-data:/var/lib/postgresql/data
    healthcheck:
      test:
        ['CMD', 'pg_isready', '-U', '${POSTGRES_USER}', '-d', '${POSTGRES_DB}']
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - internal

  api:
    image: ghcr.io/${GITHUB_USERNAME}/movie-library-api:latest
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      NODE_ENV: production
      PORT: 3000
      DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET}
      JWT_REFRESH_SECRET: ${JWT_REFRESH_SECRET}
      JWT_ACCESS_TTL: 15m
      JWT_REFRESH_TTL: 30d
      TMDB_API_KEY: ${TMDB_API_KEY}
      OMDB_API_KEY: ${OMDB_API_KEY}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      SENTRY_DSN: ${SENTRY_DSN_API}
      SWAGGER_ENABLED: 'false'
      CORS_ORIGIN: https://${DOMAIN}
    healthcheck:
      test: ['CMD', 'wget', '-qO-', 'http://localhost:3000/api/health']
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
    networks:
      - internal

  web:
    image: ghcr.io/${GITHUB_USERNAME}/movie-library-web:latest
    restart: unless-stopped
    networks:
      - internal

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy-data:/data
      - ./caddy-config:/config
    depends_on:
      - api
      - web
    networks:
      - internal

networks:
  internal:
    driver: bridge
```

## Caddyfile

```
# /opt/movie-library/Caddyfile

{$DOMAIN} {
    encode zstd gzip

    # API — proxy first; otherwise the SPA fallback would catch it
    handle /api/* {
        reverse_proxy api:3000 {
            header_up Host {host}
            header_up X-Real-IP {remote_host}
            header_up X-Forwarded-For {remote_host}
            header_up X-Forwarded-Proto {scheme}
        }
    }

    # Everything else — frontend (SPA fallback inside the web/nginx container)
    handle {
        reverse_proxy web:80
    }

    # Security headers
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "strict-origin-when-cross-origin"
        Permissions-Policy "camera=(), microphone=(), geolocation=()"
    }

    log {
        output file /var/log/caddy/access.log
        format json
    }
}
```

Caddy talks to Let's Encrypt on first start, generates a certificate, and stores it in `caddy-data`. After that it auto-renews every 60 days.

## .env on the VPS

This file is **separate** from your local `.env` — same variable names, different values. Same `.env.example` template applies; copy it to `/opt/movie-library/.env` on the VPS and fill in production values.

```env
# /opt/movie-library/.env

NODE_ENV=production

DOMAIN=movies.example.com
GITHUB_USERNAME=your-github-username

POSTGRES_USER=movielib
POSTGRES_PASSWORD=<generate via `openssl rand -base64 32`>
POSTGRES_DB=movie_library

JWT_ACCESS_SECRET=<openssl rand -base64 64>
JWT_REFRESH_SECRET=<openssl rand -base64 64>

TMDB_API_KEY=<your-tmdb-api-key>
OMDB_API_KEY=<your-omdb-api-key>
ANTHROPIC_API_KEY=<your-anthropic-api-key>

SENTRY_DSN_API=https://...@sentry.io/...
SENTRY_DSN_WEB=https://...@sentry.io/...

SWAGGER_ENABLED=false
REGISTRATION_ENABLED=true
```

How to generate strong secrets:

```bash
openssl rand -base64 32   # for passwords
openssl rand -base64 64   # for JWT secrets
```

In the repo, only `.env.example` is committed (with placeholders). Update it whenever you add a new variable.

## Dockerfiles

### docker/api.Dockerfile

```dockerfile
# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

# pnpm
RUN npm i -g pnpm@9

COPY pnpm-lock.yaml package.json nx.json tsconfig.base.json ./
COPY apps apps
COPY packages packages
COPY prisma prisma

RUN pnpm install --frozen-lockfile
RUN pnpm prisma generate
RUN pnpm nx build api --configuration=production

# Production stage
FROM node:20-alpine AS runner
WORKDIR /app

RUN apk add --no-cache wget

# Only what's needed for production
COPY --from=builder /app/dist/apps/api ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production
EXPOSE 3000

# Apply migrations on start, then run the server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
```

### docker/web.Dockerfile

```dockerfile
# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

RUN npm i -g pnpm@9

COPY pnpm-lock.yaml package.json nx.json tsconfig.base.json ./
COPY apps apps
COPY packages packages

RUN pnpm install --frozen-lockfile
RUN pnpm nx build web --configuration=production

# Production stage — serves static via nginx
FROM nginx:alpine AS runner

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist/apps/web/browser /usr/share/nginx/html

EXPOSE 80
```

### docker/nginx.conf

```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # Exact matches for prerendered routes
    location = /login {
        try_files /login/index.html =404;
    }
    location = /register {
        try_files /register/index.html =404;
    }

    # Static assets with long cache
    location ~* \.(js|css|png|jpg|jpeg|svg|webp|woff2|ico)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    # Service worker — never cache, otherwise updates won't reach clients
    location = /ngsw-worker.js {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        try_files $uri =404;
    }
    location = /ngsw.json {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        try_files $uri =404;
    }
    location = /manifest.webmanifest {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        try_files $uri =404;
    }

    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

## Initial VPS setup

A one-time sequence:

```bash
# 1. SSH into the VPS as your non-root user (created beforehand)
ssh deploy@your-vps-ip

# 2. Create the project directory
sudo mkdir -p /opt/movie-library
sudo chown deploy:deploy /opt/movie-library
cd /opt/movie-library

# 3. Copy the deploy files (from your local checkout, or git clone)
scp deploy/docker-compose.yml deploy/Caddyfile deploy@your-vps-ip:/opt/movie-library/

# 4. Create .env (paste it via nano or scp it from the local machine)
nano .env
chmod 600 .env

# 5. Log in to GHCR (you need a GitHub PAT with read:packages scope)
echo $GHCR_PAT | docker login ghcr.io -u your-github-username --password-stdin

# 6. Bring the stack up
docker compose pull
docker compose up -d

# 7. Seed the DB once
docker compose exec api npx prisma db seed

# 8. Verify
docker compose logs -f
curl https://your-domain.com/api/health
```

## Backups

Daily backup script — `tools/scripts/backup.sh`:

```bash
#!/bin/bash
# /opt/movie-library/backup.sh

set -e

BACKUP_DIR="/opt/movie-library/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/movie_library_${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

# Dump
docker compose -f /opt/movie-library/docker-compose.yml exec -T postgres \
  pg_dump -U "${POSTGRES_USER}" "${POSTGRES_DB}" \
  | gzip > "$BACKUP_FILE"

# Upload to cloud storage
# (configure rclone beforehand: `rclone config` for Mega.io / Google Drive / OneDrive)
rclone copy "$BACKUP_FILE" cloud-backups:movie-library/

# Drop local backups older than 7 days
find "$BACKUP_DIR" -name "*.sql.gz" -mtime +7 -delete

# Mega.io's free 50 GB tier means you won't run out of space for years.
```

Crontab:

```bash
crontab -e

# Every day at 3:30 AM
30 3 * * * /opt/movie-library/backup.sh >> /var/log/movie-library-backup.log 2>&1
```

Install rclone and connect a cloud provider:

```bash
sudo apt install rclone
rclone config
# Choose "n" (new remote), name = "cloud-backups", type = mega/drive/onedrive/...
# OAuth flow follows.
```

## Restoring from a backup

Script `tools/scripts/restore.sh`:

```bash
#!/bin/bash
set -e

BACKUP_FILE=$1

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: $0 <path-to-backup.sql.gz>"
  exit 1
fi

# Stop the API so no new writes come in
docker compose stop api

# Drop and re-create the DB
docker compose exec -T postgres psql -U "${POSTGRES_USER}" -c "DROP DATABASE ${POSTGRES_DB};"
docker compose exec -T postgres psql -U "${POSTGRES_USER}" -c "CREATE DATABASE ${POSTGRES_DB};"

# Restore
gunzip -c "$BACKUP_FILE" | docker compose exec -T postgres psql -U "${POSTGRES_USER}" "${POSTGRES_DB}"

docker compose start api
echo "Restored from $BACKUP_FILE"
```

## Monitoring

Minimum setup, no Grafana — because the app is personal.

- **Logs** — `docker compose logs -f` or `docker compose logs api --tail=100`. Caddy logs go to `caddy-data/log/`.
- **Sentry** — runtime errors from frontend and backend land here. Configure email notifications for new issues.
- **UptimeRobot** (optional) — monitor `https://your-domain.com/api/health` every 5 minutes, send email on outage.
- **Disk space** — `df -h` once in a while. On a 50 GB VPS, Postgres and logs won't run out for the foreseeable future.

## Baseline security

Minimum you should do:

1. **SSH**:
   ```bash
   # /etc/ssh/sshd_config
   Port 2222                              # not 22
   PasswordAuthentication no
   PermitRootLogin no
   AllowUsers deploy                      # only this user
   ```
2. **UFW**:
   ```bash
   sudo ufw default deny incoming
   sudo ufw default allow outgoing
   sudo ufw allow 2222/tcp                # SSH
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   sudo ufw enable
   ```
3. **fail2ban** — default config on top of SSH logs already works.
4. **Unattended security updates**:
   ```bash
   sudo apt install unattended-upgrades
   sudo dpkg-reconfigure -plow unattended-upgrades
   ```
5. **Don't expose .env** — `chmod 600 .env`, never commit it, don't put it in publicly readable directories.
6. **Invite-only registration** — once you and your partner are signed up, flip `REGISTRATION_ENABLED=false` in the production env to lock the door behind you.
