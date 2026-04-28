# Movie Library

Personal PWA for tracking your film library: what you've watched, what you want to watch, ratings from you and your viewing partner, filters by genre / country / year / score, AI-powered recommendations.

## Stack

| Layer            | Choice                                              |
|------------------|-----------------------------------------------------|
| Frontend         | Angular 19+ (standalone, signals, control flow)     |
| UI Kit           | Taiga UI v5 (components + design tokens)            |
| Utility styles   | Tailwind CSS (layout/spacing only, preflight off)   |
| State            | NgRx Signal Stores                                  |
| Forms            | Angular Signal Forms                                |
| i18n             | Transloco (`en` / `ru` / `uk`)                      |
| PWA              | `@angular/pwa` (Service Worker + app shell)         |
| Monorepo         | Nx 22+                                              |
| Backend          | NestJS 10+                                          |
| ORM              | Prisma 5+                                           |
| Database         | PostgreSQL 16                                       |
| Auth             | JWT (access + refresh), Passport, bcrypt            |
| External APIs    | TMDB, OMDb, Anthropic (Claude Haiku)                |
| Observability    | Sentry (`@sentry/angular`, `@sentry/nestjs`)        |
| Tests            | Vitest (unit), Playwright (e2e)                     |
| Containerization | Docker + Docker Compose                             |
| Reverse proxy    | Caddy 2 (auto-HTTPS via Let's Encrypt)              |
| CI/CD            | GitHub Actions + GHCR                               |
| Hosting          | Hostinger VPS (KVM)                                 |

## Workspace structure

```
movie-library/
├── apps/
│   ├── web/                  Angular SPA + PWA
│   ├── web-e2e/              Playwright e2e
│   └── api/                  NestJS API
├── packages/
│   ├── shared/
│   │   ├── domain/           DTOs, enums, common interfaces
│   │   └── api-types/        OpenAPI-generated types
│   ├── web/
│   │   ├── feature-auth/
│   │   ├── feature-library/
│   │   ├── feature-wishlist/
│   │   ├── feature-suggest/
│   │   ├── feature-movie/
│   │   ├── feature-friends/
│   │   ├── data-access/      HTTP clients, signal stores
│   │   └── ui/               Reusable app-specific components
│   └── api/
│       ├── feature-auth/
│       ├── feature-movies/
│       ├── feature-library/
│       ├── feature-wishlist/
│       ├── feature-friends/
│       ├── feature-suggestions/
│       ├── data-access-tmdb/
│       ├── data-access-omdb/
│       ├── data-access-ai/
│       └── data-access-db/   Prisma client wrapper
├── docker/
│   ├── api.Dockerfile
│   └── web.Dockerfile
├── deploy/
│   ├── docker-compose.yml         Production stack for VPS
│   ├── docker-compose.dev.yml     Local Postgres only
│   └── Caddyfile
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── deploy.yml
├── prisma/
│   ├── schema.prisma
│   └── migrations/
└── docs/
```

## Quick start (local development)

Detailed instructions are in [docs/local-development.md](./docs/local-development.md). The short version:

```bash
# 1. Install dependencies
pnpm install

# 2. Create your local .env from the template
cp .env.example .env
# Edit .env and fill in TMDB_API_KEY, OMDB_API_KEY, ANTHROPIC_API_KEY

# 3. Start local PostgreSQL via Docker
docker compose -f deploy/docker-compose.dev.yml up -d

# 4. Apply migrations and seed reference data
pnpm prisma migrate dev
pnpm prisma db seed

# 5. Run API and web in parallel
pnpm nx run-many -t serve -p api,web
# API → http://localhost:3000
# Web → http://localhost:4200
```

Common Nx commands:

```bash
pnpm nx serve api                          # API only
pnpm nx serve web                          # frontend only
pnpm nx run-many -t test                   # all unit tests (Vitest)
pnpm nx run-many -t lint                   # all linters
pnpm nx run-many -t build --configuration=production
pnpm nx graph                              # interactive dependency graph
pnpm nx sync                                # sync TypeScript project references
pnpm prisma studio                         # admin UI for the local DB
```

> **Tip:** install **Nx Console** (VSCode / IntelliJ extension). It gives you generators, target runners, and the project graph as a sidebar — much faster than typing `nx g ...` manually. Get it at [nx.dev/getting-started/editor-setup](https://nx.dev/getting-started/editor-setup).

## Documentation

| File                                                              | About                                                      |
|-------------------------------------------------------------------|------------------------------------------------------------|
| [CLAUDE.md](./CLAUDE.md)                                          | Context and conventions for Claude Code                    |
| [docs/local-development.md](./docs/local-development.md)          | Local environment setup, `.env`, dev commands, tips        |
| [docs/architecture.md](./docs/architecture.md)                    | Stack decisions, Nx layout, why no SSR                     |
| [docs/data-model.md](./docs/data-model.md)                        | Full Prisma schema with rationale                          |
| [docs/api.md](./docs/api.md)                                      | REST API: endpoints, auth flow, error format               |
| [docs/frontend.md](./docs/frontend.md)                            | Routes, libraries, signal stores, PWA, SSG, Taiga UI       |
| [docs/ai-suggestions.md](./docs/ai-suggestions.md)                | LLM recommendations: context, prompt, parsing              |
| [docs/infrastructure.md](./docs/infrastructure.md)                | VPS, Docker Compose, Caddy, backups, secrets               |
| [docs/ci-cd.md](./docs/ci-cd.md)                                  | GitHub Actions: build, push to GHCR, deploy to VPS         |
| [docs/roadmap.md](./docs/roadmap.md)                              | Phased MVP plan                                            |

## External keys and accounts

The following free API keys are required:

- **TMDB** — themoviedb.org → Settings → API → Create. Practically no rate limits for personal use.
- **OMDb** — omdbapi.com → free tier 1000 requests/day. Used only to fetch IMDb ratings by `imdb_id` (aggressively cached).
- **Anthropic** — console.anthropic.com → API Keys. Default model: `claude-haiku-4-5`. Cost per recommendation is around $0.001.
- **Sentry** (optional but recommended) — sentry.io → Create Project (Angular + Node, two separate projects).

All keys live in `.env` files (one local, one on the VPS). Only `.env.example` is committed to the repo, with placeholder values.
