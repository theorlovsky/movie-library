# Roadmap

Phased plan for the MVP. Every phase ends with a **working deployment to the VPS**. Don't accumulate local changes for weeks — that path leads to "almost done but never deployed." Time estimates are in "evenings" (~2-3 hours of focused work); calendar duration depends on how many evenings you can spend.

---

## Phase 0: Bootstrap (1-2 evenings)

**Goal:** a working deploy of an empty skeleton on your own domain, with HTTPS.

### Tasks

- [ ] Create the GitHub repo.
- [ ] Run `npx create-nx-workspace movie-library` with the chosen flags (preset=ts, workspaces=true, vitest, claude AI agent, etc.). See [README.md](../README.md) for the exact command.
- [ ] Add Nx plugins: `@nx/angular`, `@nx/nest`, `@nx/eslint`, `@nx/vite` (for Vitest), `@nx/playwright`.
- [ ] Generate `apps/web` (Angular 19, standalone, no SSR) and `apps/api` (NestJS).
- [ ] Generate base packages: `packages/shared/domain`, `packages/web/data-access`, `packages/api/data-access-db`.
- [ ] Set up Tailwind CSS (with `preflight: false`); tokens in `apps/web/src/styles/tokens.css`.
- [ ] Install Taiga UI v5: `pnpm add taiga-ui` + `pnpm nx g taiga-ui:ng-add --project=web`. Register `provideTaiga()` in `app.config.ts`.
- [ ] Install Prisma; create `prisma/schema.prisma` with the bare minimum (only `User` and `RefreshToken`).
- [ ] Implement `AuthModule` on the backend: register/login/refresh/logout/me, JWT via Passport, bcrypt for passwords, refresh-token rotation.
- [ ] On the frontend: `/login`, `/register`, a stub `/library`, `authStore`, `authInterceptor`, `authGuard`.
- [ ] Wire up `@sentry/angular` and `@sentry/nestjs`.
- [ ] Create `.env.example` at the repo root with all variables (placeholder values). Copy locally to `.env` and fill in TMDB / OMDb / Anthropic keys.
- [ ] Write `docker/api.Dockerfile`, `docker/web.Dockerfile`, `docker/nginx.conf`.
- [ ] Write `deploy/docker-compose.yml`, `deploy/docker-compose.dev.yml`, `deploy/Caddyfile`.
- [ ] Configure the VPS per [docs/infrastructure.md](./infrastructure.md): UFW, fail2ban, key-only SSH, deploy user, Docker, `/opt/movie-library/` directory.
- [ ] Buy a domain (or use the one Hostinger gives you), set the A record.
- [ ] Create `.env` on the VPS, copy `docker-compose.yml` and `Caddyfile`.
- [ ] Write `.github/workflows/ci.yml` and `.github/workflows/deploy.yml`.
- [ ] Configure GitHub secrets and variables.
- [ ] Push to `main` for the first time → verify the deploy worked.

### Definition of done

- `https://your-domain.com` opens to a login page with a Let's Encrypt HTTPS cert.
- You can register, log in, see an empty `/library` with "Hello, [name]" in the header.
- Errors land in Sentry.
- `docker compose ps` on the VPS shows 4 healthy containers: postgres, api, web, caddy.
- A `feature/*` branch push triggers CI. Merging into main triggers a deploy.

---

## Phase 1: Library + Movies (1-2 weeks)

**Goal:** search films, add them to the library, rate them, filter the list.

### Tasks

#### Backend
- [ ] Extend `schema.prisma`: `Movie`, `Genre`, `Country`, `MovieGenre`, `MovieCountry`, `WatchedEntry`, `Rating`, `ViewingMode`. Migrate.
- [ ] Seed: `prisma/seed.ts` with TMDB genres and ISO countries. `pnpm prisma db seed`.
- [ ] `packages/api/data-access-tmdb`: client with `search`, `getMovie` (using `append_to_response=credits`), `getRecommendations`. Locale-aware. All requests via Nest `HttpService` with timeouts.
- [ ] `packages/api/data-access-omdb`: client with `getRatingByImdbId`. Cache for 30 days in `Movie.imdbRating`.
- [ ] `packages/api/feature-movies`:
  - `MoviesService.findOrFetchByTmdbId(tmdbId)` — the central method. Transactional upsert.
  - Controller: `GET /movies/search`, `GET /movies/tmdb/:tmdbId`, `GET /movies/:id`, `GET /movies/:id/similar`.
- [ ] `packages/api/feature-library`:
  - `LibraryService` with CRUD and filters.
  - Controller: all endpoints listed in [api.md](./api.md#library).

#### Frontend
- [ ] `packages/web/feature-library`:
  - `LibraryStore` with filters and pagination.
  - Page `/library` — card list with virtualization (`@angular/cdk/scrolling`).
  - `<lib-filter-bar>` — genres / countries / min score / year / viewing mode. Two-way signal binding.
  - Page `/library/:id` — entry detail.
- [ ] `packages/web/feature-movie`:
  - Page `/movies/:id` — poster, overview, TMDB+IMDb ratings, "Add to library" / "Add to wishlist".
- [ ] `packages/web/ui`:
  - Only app-specific bits: `<lib-rating-input>` (10-point slider), `<lib-movie-poster>`, `<lib-filter-bar>`. Buttons / cards / modals come from Taiga UI directly at use-sites.
- [ ] Search dialog (accessible from any page via FAB or keyboard shortcut) — TMDB search with 300ms debounce, posters from CDN.
- [ ] Loading / error states everywhere (you usually do this through `GlobalErrorHandler` + Sentry — wire up Sentry from day one).

### Definition of done

- Search "Alien," open the movie page, tap "Watched, rate 9/10 with comment 'perfect survival horror'." The entry persists.
- Go back to `/library`, see "Alien" in the list.
- Filter by genre "Horror" + min 7 — only matching entries shown.
- Open an entry, edit the rating, delete it.
- Mobile UX is solid (full-width cards, filters in a drawer).

---

## Phase 2: Wishlist (3-5 evenings)

**Goal:** "want to watch" list with clickable sources.

### Tasks

#### Backend
- [ ] `WishlistItem`, `WatchSource` — migrate.
- [ ] `packages/api/feature-wishlist`: CRUD + sources sub-resource + `move-to-library`.

#### Frontend
- [ ] `packages/web/feature-wishlist`:
  - `WishlistStore`.
  - Page `/wishlist` — card list with sources at the bottom of each card (Megogo / Sweet.tv / Netflix as clickable chips).
  - "Add to wishlist" dialog — TMDB search, `notes` field, `sources[]`.
  - "Watched it" button → conversion dialog into a WatchedEntry with rating.

### Definition of done

- Add a movie to the wishlist with a Megogo link.
- Wishlist card shows sources as clickable chips.
- Tapping a chip opens the source in a new tab.
- "Watched it" removes from wishlist and creates a WatchedEntry.

---

## Phase 3: Friends + co-viewing (5-7 evenings)

**Goal:** my partner sets up her own account, we add each other as friends, mark "watched together," see both ratings.

### Tasks

#### Backend
- [ ] `Friendship`, `FriendshipStatus` — migrate.
- [ ] `packages/api/feature-friends`: endpoints `/friends`, `/friends/request`, `/friends/:id/accept`, etc.
- [ ] In `LibraryService.findOne()` — also load `coViewerRating` (the co-viewer's rating for the same movie if they've added it).

#### Frontend
- [ ] `packages/web/feature-friends`:
  - Page `/friends` — tabs for incoming / outgoing / accepted.
  - "Add friend" form by email.
- [ ] In the "add to library" dialog — `viewingMode` select and (for WITH_PARTNER) friend dropdown.
- [ ] On `/library/:id` — block "Rating from [coViewer.displayName]: 8/10 — 'decent, but Alien is scarier'." If they haven't logged the entry yet — banner "Ira hasn't added this yet."

### Definition of done

- I create my partner's account, send a friend request. On her side — a banner "new request." She accepts.
- I add "Alien" with viewingMode=WITH_PARTNER, coViewer=Ira, rating 9/10.
- Ira adds the same film with her own rating 8/10 and a comment "Too dark."
- On my `/library/:id` page, her 8/10 and comment show next to my rating.

---

## Phase 4: AI suggestions (3-5 evenings)

**Goal:** the "Suggest a movie" button works and produces relevant recommendations.

### Tasks

#### Backend
- [ ] `AiSuggestion` — migrate.
- [ ] `packages/api/data-access-ai`: `AnthropicClient`, `prompts.ts`, Zod schema for parsing.
- [ ] `packages/api/feature-suggestions`:
  - Build the context (top liked, disliked, recent, wishlist).
  - Call the LLM, retry on invalid JSON.
  - Resolve via TMDB in parallel `Promise.all`.
  - Persist `AiSuggestion`.
- [ ] Throttler `5 req/min/user`.

#### Frontend
- [ ] `packages/web/feature-suggest`:
  - `/suggest` — form with filters (genre, country, mood chips "tense / light / thoughtful", runtime slider, era chips).
  - "Suggest" button → loader with meaningful placeholder text.
  - Result — 5 cards with poster, short "why this one" text, "Add to wishlist" / "Already seen" buttons.
  - `/suggest/history` — list of past suggestion sessions.

### Definition of done

- Tap "Suggest" with "Horror" filter → 5 cards in 3-7 seconds.
- Each card has a meaningful `whyMightLike` referencing my actual ratings.
- Already-watched movies are not suggested.
- One-tap "Add to wishlist" works.

---

## Phase 5: PWA polish (3-5 evenings)

**Goal:** the app installs on iPhone, runs offline (with cache), feels native.

### Tasks

- [ ] `pnpm nx g @angular/pwa --project=web` — generates manifest and service worker.
- [ ] `pwa-asset-generator` for all icons and splash screens.
- [ ] Finish iOS meta tags in `index.html` (see [frontend.md](./frontend.md#ios-specific-meta-tags-in-indexhtml)).
- [ ] Configure `ngsw-config.json` with the right caching strategies.
- [ ] Wire up SSG for `/login`, `/register`, `/` in `angular.json`.
- [ ] Generate the app shell — `pnpm nx g @angular/pwa:app-shell --project=web`.
- [ ] Empty states, error states (offline banner).
- [ ] Install on your iPhone and your partner's, verify Add to Home Screen, splash, icon.
- [ ] Verify cold start under 500ms after first load.
- [ ] Lighthouse PWA audit — all checks green.

### Definition of done

- On iPhone: Share → "Add to Home Screen" → icon appears, tap → splash → app.
- Works offline (shows cached library list with "offline" banner).
- Lighthouse PWA score = 100 (or close).
- Lighthouse Performance > 90 on mobile.

---

## Phase 6 (optional): Polish and extras

If the project sticks, in priority order:

- [ ] **Stats dashboard** at `/library/stats` — top genres, average rating, films per year, year-in-review.
- [ ] **Letterboxd import** (CSV export → batch import).
- [ ] **Library full-text search** — search your own entries and comments via Postgres `pg_trgm`.
- [ ] **Tagging** — custom tags like "rewatch," "show a friend," "disappointment of the year."
- [ ] **TV series** — separate `Series`, `Episode` entities. Full data-model rework.
- [ ] **Trakt.tv sync**.
- [ ] **Themes** — light/dark with a switch.

These aren't promises, just an idea list. After phase 5 the app may already cover 100% of your needs and you might never want anything else. That's fine.
