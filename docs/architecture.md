# Architecture

## Big picture

```
┌─────────────────────────────────────────────────────────────┐
│                     iPhone (PWA)                            │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Service Worker (precache + runtime cache)             │ │
│  │  ┌──────────────────────────────────────────────────┐  │ │
│  │  │  Angular SPA (standalone, signals, signal-store) │  │ │
│  │  └──────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────┬───────────────────────────────┘
                              │ HTTPS
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                Hostinger VPS (KVM, Ubuntu)                  │
│                                                             │
│   ┌──────────────┐                                          │
│   │   Caddy 2    │ :80, :443 (Let's Encrypt auto)           │
│   └───────┬──────┘                                          │
│           │                                                 │
│     ┌─────┴────────┐                                        │
│     │              │                                        │
│     ▼              ▼                                        │
│  ┌──────┐     ┌───────────┐                                 │
│  │ web  │     │   api     │ ──► TMDB API                    │
│  │(nginx│     │ (NestJS)  │ ──► OMDb API                    │
│  │ +SPA)│     │           │ ──► Anthropic API               │
│  └──────┘     └─────┬─────┘                                 │
│                     │                                       │
│                     ▼                                       │
│              ┌─────────────┐                                │
│              │ PostgreSQL  │                                │
│              │     16      │                                │
│              └─────────────┘                                │
└─────────────────────────────────────────────────────────────┘
```

One VPS, three containers (`web`, `api`, `postgres`) plus Caddy as reverse proxy. All external APIs are called from the backend — the frontend never holds any keys and never makes CORS requests directly to TMDB/OMDb/Anthropic.

## Stack decisions and why

### Why PWA without SSR

Server-side rendering buys two things in Angular: SEO (irrelevant — the app is auth-gated, nothing to index) and a fast first paint (helpful for bots and slow devices). The cost is a Node server you need to host, plus extra complexity around hydration, auth cookies, and environment-dependent code.

Instead, we use:

1. **`@angular/pwa`** — generates a Service Worker that precaches the entire bundle. After the first load, the app starts instantly even offline.
2. **App shell** — a minimal HTML skeleton with logo and spinner is prerendered into `index.html` via the `prerender` block in `angular.json`. iPhone shows the skeleton instantly when launched from the home screen.
3. **SSG for a few static routes** — `/login`, `/register`, `/` (landing/redirect). These don't depend on auth state, so they're rendered at build time. See [frontend.md → SSG](./frontend.md#ssg-prerendering-static-routes).

Result: no Node servers, static assets served by nginx inside the `web` container, cold start on iPhone is well under 500 ms.

### Why PostgreSQL

The data is strictly relational: `user → watched_entry → rating`, `movie ↔ genre` (M2M), `movie ↔ country` (M2M), `wishlist_item → watch_source` (1:N), `friendship` graph. Filters combine multiple relations (genre + country + min score + viewing mode + year). Classic SQL territory.

NoSQL (MongoDB) would force either denormalization (movies duplicated per user) or hand-rolled joins in code. No win.

### Why Prisma instead of TypeORM

- Type-safe out of the box, no decorators-vs-types dance.
- Declarative schema in a single file, migrations auto-generated (`prisma migrate dev`).
- Prisma Studio gives you a free admin UI.
- Less boilerplate than TypeORM (no entity classes, no EntityManager).

Prisma's weak spot is complex analytical raw SQL. Not relevant for this project.

### Why an Nx monorepo

Not because it's trendy:
- Frontend and backend share DTOs/types (`packages/shared/domain`) — without Nx that means npm publishing or manual copy-pasting.
- OpenAPI-generated typed client from the Nest controllers in `packages/shared/api-types` via `orval` or `openapi-typescript-codegen`.
- One command for lint and tests across everything; Nx caching saves time in CI.
- Convenient feature-lib decomposition (Angular best practice — many small libraries).

### Why `apps/` + `packages/` (not `apps/` + `libs/`)

This is the current Nx 22+ recommendation for workspaces using TypeScript Project References. `packages/` aligns with the pnpm/yarn/npm workspaces convention, and `create-nx-workspace --preset=ts --workspaces=true` creates `packages/` by default. The older `apps/` + `libs/` layout (idiomatic with `useProjectJson=true` and pre-Nx-19 setups) still works but goes against current defaults.

Import names are independent of the folder — they come from the `name` field in each project's `package.json` (e.g. `@movie-library/shared/domain`).

### Why signal stores instead of classic NgRx

The project is small, effects are rare. Signal store gives you 90% of NgRx's capabilities in 20% of the code. No actions/reducers/selectors — just `signalStore + withState + withMethods`. Compatible with devtools (`withDevtools()` from `@ngrx/signals`).

### Why Taiga UI v5 + Tailwind for utilities

**Taiga UI v5** is the primary source of components and design tokens:

- Mature library written from inside the Angular ecosystem (not a port from React/Vue). Full support for signals, standalone, zoneless. Minimum requirement is Angular 19+, which matches our setup.
- Comprehensive component set out of the box: forms (TuiInput, TuiSelect, TuiTextarea, TuiSlider, TuiTextfield), overlays (TuiDialog, TuiNotification, TuiHint), navigation (TuiTabs, TuiPagination), visualization (charts, badges, posters). No need to write 30 custom components by hand.
- v5 dropped `@angular/animations` — all animations are native CSS, the bundle is smaller.
- Fully tree-shakable: importing specific directives ships only those into the bundle.
- CSS variables for every theme token, easy to override.
- v5 introduced `provideTaiga()`, registered once in `app.config.ts`.

**Tailwind** stays, but in a **narrow role** — utility classes for layout and spacing only:
- `flex`, `grid`, `gap-*`, `p-*`, `m-*`, `space-*`, `w-*`, `h-*`, breakpoints (`sm:`, `md:`, `lg:`).
- We do NOT use Tailwind colors, fonts, shadows, or radii — that's Taiga's responsibility.
- In `tailwind.config.js` we set `corePlugins.preflight: false` so Tailwind doesn't reset browser styles and clash with Taiga's reset.

This combination delivers the best of both: production-ready components with consistent UX from Taiga, and quick layout without writing CSS classes from Tailwind.

Alternatives considered:
- **Taiga only**, no Tailwind — Taiga has `tui-space-*` directives, but they're less ergonomic for frequent layout work than tailwind utilities.
- **Material**, **PrimeNG**, **Spartan** — rejected: heavier bundle, weaker signals/standalone story, or less customizable.

## Full Nx workspace structure

```
movie-library/
├── apps/
│   ├── web/
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── app.component.ts          (root + router-outlet)
│   │   │   │   ├── app.config.ts             (provideRouter, provideHttpClient, provideTaiga, etc.)
│   │   │   │   └── app.routes.ts             (top-level routes, lazy imports)
│   │   │   ├── assets/
│   │   │   ├── styles/
│   │   │   │   ├── tokens.css                (CSS variables: Taiga theme overrides + custom)
│   │   │   │   └── tailwind.css              (@tailwind base/components/utilities)
│   │   │   ├── manifest.webmanifest
│   │   │   ├── ngsw-config.json              (Service Worker config)
│   │   │   ├── index.html                    (with iOS apple-touch-icon meta tags)
│   │   │   └── main.ts
│   │   ├── public/                           (favicons, PWA icons)
│   │   └── project.json                      (Nx targets: build/serve/test)
│   ├── web-e2e/                              (Playwright)
│   └── api/
│       ├── src/
│       │   ├── main.ts                       (NestJS bootstrap)
│       │   └── app/
│       │       ├── app.module.ts             (imports all feature libs)
│       │       └── interceptors/
│       │           ├── logging.interceptor.ts
│       │           └── timeout.interceptor.ts
│       └── project.json
├── packages/
│   ├── shared/
│   │   ├── domain/                           (DTOs, enums, common interfaces)
│   │   │   └── src/index.ts                  (export * from all files)
│   │   └── api-types/                        (auto-generated from Swagger)
│   ├── web/
│   │   ├── feature-auth/                     (routes /login, /register)
│   │   ├── feature-library/                  (route /library)
│   │   ├── feature-wishlist/                 (route /wishlist)
│   │   ├── feature-suggest/                  (route /suggest)
│   │   ├── feature-movie/                    (route /movies/:id)
│   │   ├── feature-friends/                  (route /friends)
│   │   ├── data-access/
│   │   │   ├── src/lib/
│   │   │   │   ├── api-clients/              (LibraryApiClient, WishlistApiClient, ...)
│   │   │   │   ├── stores/                   (LibraryStore, WishlistStore, AuthStore)
│   │   │   │   ├── guards/                   (authGuard, guestGuard)
│   │   │   │   └── interceptors/             (authInterceptor, errorInterceptor)
│   │   └── ui/                               (thin wrapper: only app-specific components — RatingInput, MoviePoster, FilterBar. Everything else from Taiga)
│   └── api/
│       ├── feature-auth/
│       ├── feature-movies/
│       ├── feature-library/
│       ├── feature-wishlist/
│       ├── feature-friends/
│       ├── feature-suggestions/
│       ├── data-access-tmdb/                 (TmdbClient + Movie cache)
│       ├── data-access-omdb/                 (OmdbClient + imdbRating cache)
│       ├── data-access-ai/                   (AnthropicClient + prompts)
│       └── data-access-db/                   (PrismaService)
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── docker/
│   ├── api.Dockerfile
│   ├── web.Dockerfile
│   └── nginx.conf                            (config for the web container)
├── deploy/
│   ├── docker-compose.yml                    (production stack for the VPS)
│   ├── docker-compose.dev.yml                (Postgres only, for local dev)
│   ├── Caddyfile
│   └── .env.example
├── .github/
│   └── workflows/
│       ├── ci.yml                            (lint + test + build)
│       └── deploy.yml                        (build + push to ghcr.io + ssh deploy)
├── tools/
│   └── scripts/
│       ├── backup.sh                         (pg_dump + rclone)
│       └── restore.sh
├── nx.json
├── tsconfig.base.json
├── package.json
└── pnpm-lock.yaml
```

## Data flow (typical scenario)

Example: user opens `/library`, filters by genre "Horror" and year ≥ 2020.

1. Service Worker serves `index.html` from precache instantly.
2. Angular boots the SPA, `authGuard` reads the token from `localStorage` and validates it via `/api/auth/me`. If expired → `/api/auth/refresh`. If refresh fails → redirect to `/login`.
3. Route `/library` lazy-loads `feature-library`. The component injects `LibraryStore`, which fires `store.load()` in `onInit`.
4. `LibraryStore.load()` → `LibraryApiClient.list(filters)` → `GET /api/library?genres=27&yearFrom=2020`.
5. Caddy routes `/api/*` into the `api` container. The Nest controller validates `@Query() filters: LibraryFiltersDto` via `class-validator`.
6. `LibraryService.findByUser(userId, filters)` builds a Prisma query with `where + include + orderBy + skip/take`.
7. Postgres returns rows, Prisma maps them into typed objects.
8. The controller serializes via DTO (strips fields like `passwordHash`) and returns JSON.
9. On the frontend, the signal store calls `patchState` to commit the result into `entries`. The component re-renders thanks to signal reactivity.

Offline, steps 4-8 fail with a network error, `errorInterceptor` produces a typed `ApiError`, the store shows a "No connection, showing cached data" banner, and the cached data comes from the most recent successful request saved by the Service Worker under the `freshness` strategy for API endpoints.

## Out of scope for MVP

The following are interesting but **deliberately not done** in the first version — only if the app sticks:

- Import history from Letterboxd / Trakt.
- Trakt.tv sync (both directions).
- Social feed ("what your friends watched this week").
- Statistics dashboard (top genres by year, average rating, etc.) — the schema supports it via `GET /library/stats`, but no UI yet.
- Light/dark theme toggle — for now, dark only (or light only, whatever feels right).
- Push notifications (e.g. "new season of a favourite show").
- TV series support (movies only).
