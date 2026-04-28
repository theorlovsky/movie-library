# Local development

This guide covers everything you need to run the application on your laptop. Production deployment lives in [infrastructure.md](./infrastructure.md).

## Prerequisites

- **Node.js** 20 LTS or newer
- **pnpm** 9+ (`npm i -g pnpm`)
- **Docker** + Docker Compose plugin — used for the local PostgreSQL only (you do *not* need to run the API/web in containers locally)
- **Git**

Recommended editor extensions: Nx Console (VSCode/IntelliJ), ESLint, Prettier, Angular Language Service.

## First-time setup

```bash
# 1. Install workspace dependencies
pnpm install

# 2. Create your local .env from the template
cp .env.example .env
```

Open `.env` and fill in the required values (TMDB / OMDb / Anthropic keys at minimum). See [Environment variables](#environment-variables) below for what each one does.

```bash
# 3. Start PostgreSQL in Docker
docker compose -f deploy/docker-compose.dev.yml up -d
# This brings up only Postgres (with a persistent volume).
# Default connection: postgres://movielib:movielib@localhost:5432/movie_library

# 4. Generate the Prisma client (also runs automatically on every install)
pnpm prisma generate

# 5. Apply migrations
pnpm prisma migrate dev

# 6. Seed reference data (genres, countries)
pnpm prisma db seed
```

## Environment variables

The repo ships with `.env.example`. Copy it to `.env` for local dev. **Never commit `.env`** — it's listed in `.gitignore`.

```env
# .env.example — committed to the repo with safe placeholder values

# Runtime
NODE_ENV=development
PORT=3000

# Database (the docker-compose.dev.yml defaults match these)
DATABASE_URL=postgres://movielib:movielib@localhost:5432/movie_library

# JWT — for local dev anything works; generate strong values for production
# (use `openssl rand -base64 64`)
JWT_ACCESS_SECRET=local-dev-access-secret-change-in-production
JWT_REFRESH_SECRET=local-dev-refresh-secret-change-in-production
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d

# External APIs — get free keys from each provider, see README.md
TMDB_API_KEY=
OMDB_API_KEY=
ANTHROPIC_API_KEY=

# Sentry — optional in dev, leave blank to disable
SENTRY_DSN_API=
SENTRY_DSN_WEB=

# Frontend → Backend URL (used by the Nx dev-server proxy)
API_URL=http://localhost:3000

# Feature toggles
SWAGGER_ENABLED=true
REGISTRATION_ENABLED=true
CORS_ORIGIN=http://localhost:4200
```

The same variable names are used on the VPS — only their values differ. See [infrastructure.md](./infrastructure.md#env-on-the-vps) for production values.

### How env vars are loaded

- **Backend (NestJS)** — `@nestjs/config` with `ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' })`. The `.env` file at the repo root is loaded automatically.
- **Frontend (Angular)** — at build time only. We don't ship secrets to the browser. The only browser-side variable is `API_URL`, injected via Nx's `define` mechanism in the dev server config and via a runtime `env.js` in production.

## Running the dev servers

```bash
# Both API and web in parallel
pnpm nx run-many -t serve -p api,web
```

This starts:
- **API** on `http://localhost:3000` (NestJS, hot reload via `tsx watch`)
- **Web** on `http://localhost:4200` (Angular dev server with HMR)

The Angular dev server proxies `/api/*` to `http://localhost:3000` (configured in `apps/web/proxy.conf.json`), so requests look the same as in production behind Caddy.

You can also start them individually:

```bash
pnpm nx serve api    # backend only
pnpm nx serve web    # frontend only
```

## Working with the database

```bash
# Open Prisma Studio — a built-in admin UI at http://localhost:5555
pnpm prisma studio

# Create a new migration after editing prisma/schema.prisma
pnpm prisma migrate dev --name describe_change

# Reset the local DB (drop + re-create + run migrations + seed)
pnpm prisma migrate reset

# Connect via psql directly
docker compose -f deploy/docker-compose.dev.yml exec postgres \
  psql -U movielib -d movie_library
```

The `docker-compose.dev.yml` exposes Postgres on `localhost:5432`, so any local SQL client (DBeaver, TablePlus, etc.) can connect with the credentials from `.env`.

## Tests

```bash
# All unit tests (Vitest) — affected projects only
pnpm nx affected -t test

# All unit tests in the workspace
pnpm nx run-many -t test

# Watch mode for a specific project
pnpm nx test feature-library --watch

# E2E tests (Playwright)
pnpm nx e2e web-e2e
```

Vitest runs tests in parallel by default and uses jsdom for Angular tests. Tests are colocated with sources (`*.spec.ts` next to the file under test).

## Useful Nx commands

```bash
# Visualize the dependency graph in the browser
pnpm nx graph

# Sync TypeScript project references after adding/removing imports
# (Nx normally does this automatically before build/typecheck — run manually
#  when you want to verify, or fix CI complaints from `nx sync:check`)
pnpm nx sync

# Show what's affected by your current changes (vs main)
pnpm nx affected:graph
pnpm nx affected -t lint
pnpm nx affected -t test

# Reset Nx caches (when something behaves weirdly)
pnpm nx reset
```

## Linting and formatting

```bash
pnpm nx affected -t lint                   # ESLint on changed projects
pnpm nx run-many -t lint --fix             # autofix everything

pnpm nx format:check                       # Prettier check
pnpm nx format:write                       # Prettier autoformat
```

Both run in pre-commit through `simple-git-hooks` (configured during phase 0).

## Production-like local smoke test

Sometimes you want to test the production Docker images locally before pushing. Build and run them:

```bash
# Build both images
docker build -f docker/api.Dockerfile -t movie-library-api:local .
docker build -f docker/web.Dockerfile -t movie-library-web:local .

# Run the production stack locally (using the same docker-compose.yml as VPS)
# Note: this expects a different .env with prod-shaped values — usually you
# create a .env.local-prod file and pass it explicitly.
docker compose -f deploy/docker-compose.yml --env-file .env.local-prod up
```

Don't do this often — the dev workflow above is much faster.

## Troubleshooting

**Postgres connection refused.** Make sure the dev compose is running: `docker compose -f deploy/docker-compose.dev.yml ps`. If it's up but you still can't connect, check the port: another local Postgres might be on 5432 already. Either stop the other instance or change the published port in `docker-compose.dev.yml`.

**Prisma client out of sync after `git pull`.** Run `pnpm prisma generate` and `pnpm prisma migrate dev` to apply any new migrations.

**`Cannot find module '@movie-library/...'`.** The Nx project references are out of date. Run `pnpm nx sync` to regenerate them, then restart the TypeScript server in your editor.

**Vitest fails with esm/cjs interop errors.** Double-check that the test file uses `import` (not `require`) and that any mocked module is referenced via `vi.mock()`. Vitest is ESM-first; CJS-only packages occasionally need `vi.mock()` with `{ partial: true }` or an explicit factory.

**Angular HMR doesn't pick up changes.** Stop the dev server, delete `.nx/cache/`, and restart. If it persists — likely a circular import; check the affected file.

**Service Worker keeps serving stale assets.** In Chrome DevTools → Application → Service Workers → Unregister, then hard reload. The local dev server normally does *not* register the SW (only production builds do); if it does, your `angular.json` is set wrong.

## Cleaning up

```bash
# Stop and remove the dev Postgres container (data is preserved in the volume)
docker compose -f deploy/docker-compose.dev.yml down

# Stop AND wipe the Postgres data volume (⚠️ destructive)
docker compose -f deploy/docker-compose.dev.yml down -v

# Clear Nx cache
pnpm nx reset
```

## docker-compose.dev.yml

For reference, the local Postgres compose file:

```yaml
# deploy/docker-compose.dev.yml

services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: movielib
      POSTGRES_PASSWORD: movielib
      POSTGRES_DB: movie_library
    ports:
      - "5432:5432"
    volumes:
      - postgres-dev-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "movielib", "-d", "movie_library"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  postgres-dev-data:
```

Credentials are intentionally simple (no rotation, no real secrets) — this is local-only and not exposed to the network. The published port `5432:5432` allows direct `psql` and GUI tool access.
