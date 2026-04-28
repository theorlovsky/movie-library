<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

# General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->

---

# Project context for Claude Code: Movie Library

This file is a quick reference for Claude when working on this codebase. Detailed documentation lives under `docs/`.

## What this is

A personal PWA for tracking a film library. Multi-user (me + my wife + potentially friends), but small audience. Self-hosted on a Hostinger KVM VPS. See `README.md` for the high-level overview.

## Stack and versions

- **Angular** 19+ — standalone components only, signals, control flow (`@if`, `@for`, `@switch`). Use RxJS only where streams genuinely make sense (search debounce, websocket-like flows). Otherwise — signals and `toSignal()` from observables.
- **NgRx Signal Stores** — primary state management. Do not use classic NgRx (`createReducer`, `createEffect`) — only `signalStore`, `withState`, `withMethods`, `withComputed`, `withHooks`.
- **Signal Forms** for all forms (not the legacy Reactive Forms API).
- **Taiga UI v5** — primary UI kit. Import from `@taiga-ui/core` (base primitives), `@taiga-ui/kit` (extended components), `@taiga-ui/layout` (cards, containers). Root provider is `provideTaiga()` in `app.config.ts`. Theme — through Taiga's CSS variables (`--tui-background-base`, `--tui-text-primary`, etc.) overridden in `tokens.css`.
- **Tailwind CSS** — **utilities for layout and spacing only** (`flex`, `grid`, `gap-*`, `p-*`, `m-*`, breakpoints). Do not use Tailwind's color palette, typography, or shadows — that's Taiga's territory. Tailwind preflight is disabled to avoid colliding with Taiga's reset.
- **NestJS** 10+. Thin controllers, business logic in services. DTOs use `class-validator` + `class-transformer`. Global `ValidationPipe` with `whitelist: true, forbidNonWhitelisted: true, transform: true`.
- **Prisma** 5+. Database access only through services in `packages/api/data-access-db`. No raw SQL without explicit reason.
- **Tests** — Vitest for unit (with `@analogjs/vitest-angular` for Angular tests), Playwright for e2e. The global `vi` is available (`globals: true` in `vitest.config.ts`).

## Where things live

| Type of task                          | Where to work                                                                       |
|---------------------------------------|-------------------------------------------------------------------------------------|
| New API endpoint                      | `packages/api/feature-<domain>/` + controller wired in `apps/api/src/`              |
| New Angular route                     | `packages/web/feature-<name>/` + registration in `apps/web/src/app/app.routes.ts`   |
| DTO/interface shared between frontend and backend | `packages/shared/domain/`                                               |
| Database schema change                | `prisma/schema.prisma` + `pnpm prisma migrate dev --name <description>`             |
| Docker config                         | `docker/`, `deploy/docker-compose.yml`                                              |
| CI/CD                                 | `.github/workflows/`                                                                |

## Code conventions

- **Imports** — absolute, via `@movie-library/...` aliases (configured by Nx in `tsconfig.base.json`). No `../../../` paths.
- **Library file structure** — each library has `src/lib/<feature>.routes.ts` for feature libs (we are standalone, no NgModules). Public API exported via `src/index.ts`.
- **Naming** — Angular files: `kebab-case`, classes: `PascalCase`. Suffix `.component.ts`, `.service.ts`, `.store.ts`, `.guard.ts`, `.interceptor.ts`.
- **Errors on the backend** — throw `HttpException` subclasses (`BadRequestException`, `NotFoundException`, etc.). Anything uncaught flows into `GlobalExceptionFilter`, gets sent to Sentry, and returned to the client as `{ statusCode, message, error }`.
- **Errors on the frontend** — `GlobalErrorHandler` → Sentry. HTTP errors flow through `errorInterceptor`, which transforms backend responses into a typed `ApiError`.
- **Logs** — `pino` via `nestjs-pino` on the backend. On the frontend — `console.*` is fine in dev, otherwise Sentry breadcrumbs.

## Frequently-used commands

```bash
# Generate a new Angular feature library
pnpm nx g @nx/angular:lib feature-X --directory=packages/web --standalone

# Generate a NestJS module library
pnpm nx g @nx/nest:lib feature-X --directory=packages/api

# Run a migration
pnpm prisma migrate dev --name add_some_field

# Regenerate the Prisma client after schema changes
pnpm prisma generate

# Open Prisma Studio (DB admin UI)
pnpm prisma studio

# Build Docker images locally for smoke testing
docker build -f docker/api.Dockerfile -t movie-library-api .
docker build -f docker/web.Dockerfile -t movie-library-web .
```

## What NOT to do

- Don't use RxJS for trivial "get a value, render it in the template" cases — in Angular 19 that's `signal` + `toSignal()`.
- Don't write NgModules — standalone only.
- Don't use legacy Reactive Forms — Signal Forms only.
- Don't pull in **other** UI libraries beyond Taiga UI and `@angular/cdk` (we use cdk for overlay/portal/scrolling helpers Taiga doesn't ship). No Material, PrimeNG, Bootstrap.
- Don't use Tailwind colors (`bg-blue-500`, `text-gray-700`), typography (`text-xl`, `font-bold` for semantic emphasis), or shadows — those go through Taiga tokens and custom CSS variables. Tailwind = layout/spacing only.
- Don't call TMDB/OMDb directly from the frontend — all external APIs are proxied through the backend so keys stay private and caching is centralized.
- Don't write `any`. If absolutely needed — `unknown` plus an explicit narrowing check.
- Don't commit secrets. Update `.env.example` whenever you add a new variable.

## Working with Prisma in code

```typescript
// packages/api/data-access-db/src/lib/prisma.service.ts is already defined.
// In services:

@Injectable()
export class LibraryService {
  constructor(private readonly prisma: PrismaService) {}

  async findByUser(userId: string, filters: LibraryFilters) {
    return this.prisma.watchedEntry.findMany({
      where: {
        userId,
        ...(filters.minScore && {
          rating: { score: { gte: filters.minScore } },
        }),
        ...(filters.genreIds?.length && {
          movie: { genres: { some: { genreId: { in: filters.genreIds } } } },
        }),
      },
      include: {
        movie: { include: { genres: { include: { genre: true } } } },
        rating: true,
        coViewer: { select: { id: true, displayName: true } },
      },
      orderBy: { watchedAt: 'desc' },
      take: filters.limit ?? 50,
      skip: ((filters.page ?? 1) - 1) * (filters.limit ?? 50),
    });
  }
}
```

## Working with Signal Stores

```typescript
// packages/web/feature-library/src/lib/library.store.ts

export const LibraryStore = signalStore(
  { providedIn: 'root' },
  withState({
    entries: [] as WatchedEntryDto[],
    filters: defaultFilters(),
    loading: false,
    error: null as ApiError | null,
  }),
  withComputed(({ entries, filters }) => ({
    filteredCount: computed(() => entries().length),
  })),
  withMethods((store, api = inject(LibraryApiClient)) => ({
    async load() {
      patchState(store, { loading: true, error: null });
      try {
        const entries = await firstValueFrom(api.list(store.filters()));
        patchState(store, { entries, loading: false });
      } catch (error) {
        patchState(store, { loading: false, error: error as ApiError });
      }
    },
    setFilter<K extends keyof LibraryFilters>(key: K, value: LibraryFilters[K]) {
      patchState(store, (s) => ({ filters: { ...s.filters, [key]: value } }));
    },
  })),
  withHooks({
    onInit(store) {
      store.load();
    },
  }),
);
```

## Before making large changes

1. Skim the relevant `docs/*.md` file — the conventions and decisions for that area should already be documented.
2. If the code conflicts with the documentation, update the documentation first (or propose an update), then change the code.
3. Database migrations go one logical change per PR. Don't bundle multiple `prisma migrate dev` runs into a single commit unless they're truly inseparable.
