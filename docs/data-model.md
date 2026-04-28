# Data model

Full Prisma schema with explanations of the key decisions.

## schema.prisma

```prisma
// prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ============ Users & Auth ============

model User {
  id            String   @id @default(cuid())
  email         String   @unique
  passwordHash  String
  displayName   String
  avatarUrl     String?
  language      String   @default("en") // 'en' | 'ru' | 'uk'
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  watchedEntries  WatchedEntry[]
  wishlistItems   WishlistItem[]
  ratings         Rating[]
  friendshipsFrom Friendship[]   @relation("FriendshipRequester")
  friendshipsTo   Friendship[]   @relation("FriendshipReceiver")
  coViewedEntries WatchedEntry[] @relation("CoViewer")
  suggestions     AiSuggestion[]
  refreshTokens   RefreshToken[]
}

model RefreshToken {
  id        String    @id @default(cuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash String    @unique
  expiresAt DateTime
  revokedAt DateTime?
  createdAt DateTime  @default(now())

  @@index([userId])
}

// ============ Friendships ============

enum FriendshipStatus {
  PENDING
  ACCEPTED
  BLOCKED
}

model Friendship {
  id          String           @id @default(cuid())
  requesterId String
  receiverId  String
  status      FriendshipStatus @default(PENDING)
  createdAt   DateTime         @default(now())
  acceptedAt  DateTime?

  requester User @relation("FriendshipRequester", fields: [requesterId], references: [id], onDelete: Cascade)
  receiver  User @relation("FriendshipReceiver",  fields: [receiverId],  references: [id], onDelete: Cascade)

  @@unique([requesterId, receiverId])
  @@index([receiverId, status])
}

// ============ Movies (shared TMDB+OMDb cache across all users) ============

model Movie {
  id              String   @id @default(cuid())
  tmdbId          Int      @unique
  imdbId          String?  @unique
  title           String
  originalTitle   String
  year            Int?
  runtimeMinutes  Int?
  overview        String?
  posterPath      String?
  backdropPath    String?
  tmdbRating      Float?
  tmdbVoteCount   Int?
  imdbRating      Float?
  rawTmdb         Json?    // full TMDB response, in case we want a field we didn't extract upfront
  rawOmdb         Json?
  lastSyncedAt    DateTime @default(now())
  createdAt       DateTime @default(now())

  genres          MovieGenre[]
  countries       MovieCountry[]
  watchedEntries  WatchedEntry[]
  wishlistItems   WishlistItem[]

  @@index([year])
  @@index([imdbRating])
  @@index([tmdbRating])
}

model Genre {
  id            Int    @id          // TMDB genre id (28=Action, 27=Horror, ...)
  name          String              // English fallback
  nameLocalized Json   @default("{}")  // { "en": "Horror", "ru": "Ужасы", "uk": "Жахи" }
  movies        MovieGenre[]
}

model MovieGenre {
  movieId String
  genreId Int

  movie   Movie @relation(fields: [movieId], references: [id], onDelete: Cascade)
  genre   Genre @relation(fields: [genreId], references: [id])

  @@id([movieId, genreId])
  @@index([genreId])
}

model Country {
  code    String @id  // ISO 3166-1 alpha-2 ("US", "FR", "UA", ...)
  name    String

  movies  MovieCountry[]
}

model MovieCountry {
  movieId     String
  countryCode String

  movie   Movie   @relation(fields: [movieId],     references: [id], onDelete: Cascade)
  country Country @relation(fields: [countryCode], references: [code])

  @@id([movieId, countryCode])
  @@index([countryCode])
}

// ============ Library: what I've watched ============

enum ViewingMode {
  SOLO
  WITH_PARTNER
}

model WatchedEntry {
  id          String      @id @default(cuid())
  userId      String
  movieId     String
  watchedAt   DateTime?   // actual viewing date (can be in the past — fill in when you remember)
  viewingMode ViewingMode @default(SOLO)
  coViewerId  String?     // only when viewingMode = WITH_PARTNER
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt

  user     User    @relation(fields: [userId],     references: [id], onDelete: Cascade)
  movie    Movie   @relation(fields: [movieId],    references: [id])
  coViewer User?   @relation("CoViewer", fields: [coViewerId], references: [id])
  rating   Rating?

  @@unique([userId, movieId])
  @@index([userId, watchedAt(sort: Desc)])
  @@index([userId, viewingMode])
}

model Rating {
  id              String   @id @default(cuid())
  watchedEntryId  String   @unique
  userId          String
  score           Int      // 1..10
  comment         String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  watchedEntry WatchedEntry @relation(fields: [watchedEntryId], references: [id], onDelete: Cascade)
  user         User         @relation(fields: [userId],         references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([score])
}

// ============ Wishlist: what I want to watch ============

model WishlistItem {
  id        String   @id @default(cuid())
  userId    String
  movieId   String
  notes     String?
  priority  Int?     // null = not prioritized; otherwise a manual rank
  addedAt   DateTime @default(now())

  user    User          @relation(fields: [userId],  references: [id], onDelete: Cascade)
  movie   Movie         @relation(fields: [movieId], references: [id])
  sources WatchSource[]

  @@unique([userId, movieId])
  @@index([userId, addedAt(sort: Desc)])
}

model WatchSource {
  id              String   @id @default(cuid())
  wishlistItemId  String
  url             String
  sourceName      String   // free-form: "Megogo", "Sweet.tv", "Netflix"
  addedAt         DateTime @default(now())

  wishlistItem WishlistItem @relation(fields: [wishlistItemId], references: [id], onDelete: Cascade)

  @@index([wishlistItemId])
}

// ============ AI suggestions: log + cache of LLM calls ============

model AiSuggestion {
  id              String   @id @default(cuid())
  userId          String
  filters         Json     // { genres: [27], country: "US", mood: "tension", ... }
  promptInput     Json     // exactly what we sent to the LLM (system + user prompt)
  response        Json     // [{ title, year, whyMightLike }]
  resolvedTmdbIds Int[]    @default([])
  createdAt       DateTime @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, createdAt(sort: Desc)])
}
```

## Key decisions

### `Movie` is a shared cache across users

When any user adds a movie by `tmdbId`, the backend upserts into `Movie`. If the row already exists, no new TMDB/OMDb call is made. This:
- saves the OMDb quota (1000 req/day);
- speeds up UX (no extra TMDB call when the same movie is added a second time);
- gives a single place to refresh — `lastSyncedAt` older than N days → re-fetch.

The `rawTmdb` / `rawOmdb` columns hold the full API responses as JSONB. If we later want a field like `tagline` or `homepage` we already have the data — just read it from JSONB.

### `WatchedEntry` is unique on `(userId, movieId)`

One entry per user per film. Marking a rewatch updates `watchedAt` and (optionally) `rating`. Rewatch history is **not** tracked — a deliberate simplification.

### The `coViewer` link is metadata only — it doesn't duplicate entries

`coViewerId` records "I watched this with this friend." The friend has their own independent `WatchedEntry` with their own rating, which they create themselves. On the movie detail page the UI:

1. Loads my `WatchedEntry` with `coViewerId` = Ira's userId.
2. Issues a separate query for Ira's `WatchedEntry` for the same `movieId`.
3. Shows both ratings side by side. If Ira hasn't logged it yet — a banner: "Ira hasn't added this yet."

The alternative was a `WatchedEntryViewers` M2M table. Rejected because:
- The co-viewer is named from one side (mine); they're not a co-author of my entry.
- Each user owns their entry and can edit it without coordination.

### `Rating.userId` is separate from `WatchedEntry.userId`

99% of the time they match. The field is split to keep room for future expansion, e.g. allowing a co-viewer to comment on someone else's entry. Today the service always sets `Rating.userId = WatchedEntry.userId`.

### Genres and countries live in separate tables

The alternative is a string array on `Movie`. Downsides of the array:
- Can't filter cleanly with `WHERE genre IN (...)` — Postgres has `ANY`, but it's slower than an indexed JOIN.
- Can't show "how many movies in genre X" in a single query.
- Localizing genre names becomes a hand-built map in code — versus having `nameLocalized` JSON in the DB.

`Genre.id` is the **TMDB** id, not our cuid. This is intentional — when syncing from TMDB we map directly without lookups.

### Indexes

Each `@@index` corresponds to a real filter in the API:

- `WatchedEntry(userId, watchedAt DESC)` — the main `/library` screen sorts by viewing date.
- `WatchedEntry(userId, viewingMode)` — "watched only with Ira" filter.
- `MovieGenre(genreId)` — genre filter in the library.
- `Movie(year)`, `Movie(imdbRating)`, `Movie(tmdbRating)` — range filters in search/recommendations.
- `Friendship(receiverId, status)` — list of incoming PENDING requests.
- `AiSuggestion(userId, createdAt DESC)` — user's recommendation history.

## Migrations

```bash
# When you change schema.prisma locally:
pnpm prisma migrate dev --name describe_change   # creates migration + applies it + regenerates the client

# In production (run by GitHub Actions deploy.yml):
pnpm prisma migrate deploy                       # only applies existing migrations, never creates new ones

# Rollbacks (Prisma has no auto-generated rollback — migrations are forward-only):
# Create a new migration that reverts the change.
```

Migrations live in `prisma/migrations/` and are committed. **One logical change per migration.** Don't bundle multiple unrelated edits into a single migration unless they're truly inseparable.

## Seeding reference data

On first deploy you need to seed `Genre` (29 TMDB genres) and `Country` (250 ISO countries).

```typescript
// prisma/seed.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Genres from TMDB /genre/movie/list (https://api.themoviedb.org/3/genre/movie/list)
  const tmdbGenres = [
    { id: 28, name: 'Action', nameLocalized: { en: 'Action', ru: 'Боевик', uk: 'Бойовик' } },
    { id: 27, name: 'Horror', nameLocalized: { en: 'Horror', ru: 'Ужасы', uk: 'Жахи' } },
    // ... the remaining 27 genres
  ];

  for (const genre of tmdbGenres) {
    await prisma.genre.upsert({
      where: { id: genre.id },
      update: { name: genre.name, nameLocalized: genre.nameLocalized },
      create: genre,
    });
  }

  // Countries — pull from ISO 3166 (the `i18n-iso-countries` npm package works well)
  // ...
}

main().finally(() => prisma.$disconnect());
```

In `package.json`:
```json
{
  "prisma": {
    "seed": "ts-node prisma/seed.ts"
  }
}
```

Run with `pnpm prisma db seed`. The seed is idempotent (uses upsert) — safe to run repeatedly.
