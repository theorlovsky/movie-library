# API

REST API on NestJS. Base prefix is `/api` (Caddy routes `/api/*` → the `api` container).

## General rules

### Authentication

JWT with two tokens:

- **Access token** — short-lived (15 minutes), passed via `Authorization: Bearer <token>`.
- **Refresh token** — long-lived (30 days), stored in `localStorage` on the client. Only the hash (`RefreshToken.tokenHash`) is stored server-side.

All endpoints except `/auth/register`, `/auth/login`, `/auth/refresh`, `/health` require a valid access token. Enforced by a global `JwtAuthGuard` with an explicit `@Public()` decorator opt-out.

### Error format

All errors share a single shape:

```json
{
  "statusCode": 400,
  "message": "Validation failed",
  "errors": [
    { "field": "email", "constraint": "isEmail", "message": "must be a valid email" }
  ],
  "timestamp": "2026-04-28T19:00:00.000Z",
  "path": "/api/auth/register"
}
```

The `errors` array appears only for validation failures. `GlobalExceptionFilter` writes this. All errors are reported to Sentry with `userId` attached (if the request was authenticated).

### Pagination

All collection endpoints accept:

```
GET /api/library?page=1&limit=50
```

And respond with:
```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 247,
    "totalPages": 5
  }
}
```

Default limit is 50, maximum is 100.

### Sorting

The `sort` parameter has the format `field:direction`:

```
GET /api/library?sort=watchedAt:desc
GET /api/library?sort=movie.year:asc
```

Allowed fields are whitelisted at the DTO level.

### CORS

In dev: `http://localhost:4200`. In production: same origin behind Caddy, CORS disabled entirely. External APIs are never called from the frontend, so there's no CORS configuration for them either.

---

## Endpoints

### Auth (`/api/auth`)

| Method | Path          | Body / Query                                   | Response                                              |
|--------|---------------|------------------------------------------------|-------------------------------------------------------|
| POST   | `/register`   | `{ email, password, displayName }`             | `{ accessToken, refreshToken, user }`                 |
| POST   | `/login`      | `{ email, password }`                          | `{ accessToken, refreshToken, user }`                 |
| POST   | `/refresh`    | `{ refreshToken }`                             | `{ accessToken, refreshToken }` (rotated)             |
| POST   | `/logout`     | `{ refreshToken }`                             | `204 No Content` (revokes the refresh token)          |
| GET    | `/me`         | —                                              | `{ user }`                                            |

Refresh tokens rotate: when used, the old token is marked `revokedAt` and a new pair is issued. If a request comes in with an already-revoked token — all of that user's refresh tokens are invalidated (defense against token theft).

Passwords are hashed with `bcrypt` (cost 12). Emails are normalized (lowercased, trimmed) before storage.

### Friends (`/api/friends`)

| Method | Path            | Body / Query           | Response                            |
|--------|-----------------|------------------------|-------------------------------------|
| GET    | `/`             | `?status=ACCEPTED`     | `Friendship[]` with user info       |
| POST   | `/request`      | `{ email }`            | `Friendship` with status PENDING    |
| POST   | `/:id/accept`   | —                      | `Friendship` with status ACCEPTED   |
| POST   | `/:id/reject`   | —                      | `204 No Content` (deletes the row)  |
| DELETE | `/:id`          | —                      | `204 No Content`                    |

Duplicate protection: if a `Friendship(requester, receiver)` or its reverse already exists, no new row is created — the existing one is returned.

### Movies (`/api/movies`)

A read-through cache for TMDB+OMDb. All endpoints publish **our** `Movie` objects (with our `cuid`), not raw TMDB ones.

| Method | Path                  | Body / Query                         | Response                                       |
|--------|-----------------------|--------------------------------------|------------------------------------------------|
| GET    | `/search`             | `?q=alien&page=1`                    | `{ data: TmdbSearchResult[], pagination }` (search hits TMDB directly, not our DB) |
| GET    | `/tmdb/:tmdbId`       | —                                    | `Movie` (cache miss → fetched from TMDB+OMDb, persisted, returned) |
| GET    | `/:id`                | —                                    | `Movie` by our cuid                            |
| GET    | `/:id/similar`        | `?limit=10`                          | `Movie[]` (TMDB recommendations, minus what I've already watched) |

Localization: TMDB request language is determined by `User.language` (or query param `?lang=en-US`).

### Library (`/api/library`)

Movies I've watched.

| Method | Path              | Body / Query                                                                                       | Response                       |
|--------|-------------------|----------------------------------------------------------------------------------------------------|--------------------------------|
| GET    | `/`               | `?genres=27,53&countries=US&minScore=7&yearFrom=2000&viewingMode=WITH_PARTNER&sort=watchedAt:desc&page=1&limit=50` | `{ data: WatchedEntry[], pagination }` |
| GET    | `/:id`            | —                                                                                                  | `WatchedEntry` (with `coViewerRating` if available) |
| POST   | `/`               | `{ tmdbId, watchedAt?, viewingMode, coViewerId?, rating?: { score, comment } }`                    | `WatchedEntry`                 |
| PATCH  | `/:id`            | `{ watchedAt?, viewingMode?, coViewerId? }`                                                        | `WatchedEntry`                 |
| PATCH  | `/:id/rating`     | `{ score, comment? }`                                                                              | `Rating`                       |
| DELETE | `/:id`            | —                                                                                                  | `204 No Content`               |
| GET    | `/stats`          | —                                                                                                  | `{ totalWatched, byGenre, byYear, avgScore, ... }` |

Special behavior of `POST /`: if no `Movie` exists with that `tmdbId`, the backend first fetches from TMDB+OMDb, creates the `Movie`, then creates the `WatchedEntry`. All in one transaction.

`GET /:id` additionally returns `coViewerRating: Rating | null` — the co-viewer's rating for the same movie (if they've added it).

### Wishlist (`/api/wishlist`)

| Method | Path                          | Body / Query                                                  | Response                       |
|--------|-------------------------------|---------------------------------------------------------------|--------------------------------|
| GET    | `/`                           | `?genres=...&sort=addedAt:desc&page=1&limit=50`               | `{ data: WishlistItem[], pagination }` |
| POST   | `/`                           | `{ tmdbId, notes?, priority?, sources?: [{ url, sourceName }] }` | `WishlistItem`              |
| PATCH  | `/:id`                        | `{ notes?, priority? }`                                       | `WishlistItem`                 |
| DELETE | `/:id`                        | —                                                             | `204 No Content`               |
| POST   | `/:id/sources`                | `{ url, sourceName }`                                         | `WatchSource`                  |
| DELETE | `/:id/sources/:sourceId`      | —                                                             | `204 No Content`               |
| POST   | `/:id/move-to-library`        | `{ watchedAt?, viewingMode, coViewerId?, rating?: {...} }`    | `WatchedEntry` (created, the wishlist item is deleted) |

### Suggestions (`/api/suggestions`)

| Method | Path          | Body / Query                                                         | Response                                                 |
|--------|---------------|----------------------------------------------------------------------|----------------------------------------------------------|
| POST   | `/`           | `{ filters: { genres?, countries?, mood?, runtime?, era? } }`        | `AiSuggestion` (with movies resolved into `response`)    |
| GET    | `/history`    | `?page=1&limit=20`                                                   | `{ data: AiSuggestion[], pagination }`                   |

Details on the LLM flow live in [ai-suggestions.md](./ai-suggestions.md).

Rate limit: `5 req / minute / user` via `@nestjs/throttler` (LLM calls cost money).

### Health (`/api/health`)

| Method | Path          | Response                                              |
|--------|---------------|-------------------------------------------------------|
| GET    | `/`           | `{ status: "ok", db: "ok", tmdb: "ok", uptime: 12345 }` |

Used by Caddy for healthchecks and by UptimeRobot (if the frontend ever moves to a free-tier host).

## Swagger

Enabled via `@nestjs/swagger`:

```typescript
// apps/api/src/main.ts
const config = new DocumentBuilder()
  .setTitle('Movie Library API')
  .setVersion('1.0')
  .addBearerAuth()
  .build();
const document = SwaggerModule.createDocument(app, config);
SwaggerModule.setup('api/docs', app, document);
```

In dev it's available at `http://localhost:3000/api/docs`. In production it's disabled via env: `SWAGGER_ENABLED=false` so we don't expose the API surface to the world.

## OpenAPI → typed client

After every push to `main`, GitHub Actions generates the OpenAPI JSON and stores it in `packages/shared/api-types/src/lib/openapi.json`. From this JSON, `orval` or `openapi-typescript-codegen` produces a typed client:

```bash
pnpm openapi-typescript packages/shared/api-types/src/lib/openapi.json \
  -o packages/shared/api-types/src/lib/schema.ts
```

Then on the frontend:

```typescript
import type { components } from '@movie-library/shared/api-types';
type WatchedEntry = components['schemas']['WatchedEntryDto'];
```

No hand-maintained interfaces duplicating DTOs — everything is generated from the source of truth (Nest controllers).
