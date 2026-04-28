# Frontend

## Routes

```
/                       → redirect to /library (if authenticated) or /login
/login                  → login form (SSG, public)
/register               → register form (SSG, public)
/library                → list of watched movies with filters
/library/:id            → entry detail (movie + my rating + co-viewer's rating)
/wishlist               → "want to watch" list
/wishlist/:id           → wishlist item detail
/movies/:id             → movie page (generic, not tied to my entry)
/suggest                → AI suggestions form by filters
/suggest/history        → history of past suggestion sessions
/friends                → friends list and pending requests
/friends/add            → add friend by email
/profile                → profile settings
```

All routes except `/login` and `/register` are protected by `authGuard`. `/login` and `/register` are protected by `guestGuard` (if authenticated → redirect to `/library`).

## Lazy loading

Each feature library is lazy-loaded:

```typescript
// apps/web/src/app/app.routes.ts
import { Route } from '@angular/router';
import { authGuard, guestGuard } from '@movie-library/web/data-access';

export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'library' },
  {
    path: 'login',
    canMatch: [guestGuard],
    loadComponent: () =>
      import('@movie-library/web/feature-auth').then((m) => m.LoginPageComponent),
  },
  {
    path: 'register',
    canMatch: [guestGuard],
    loadComponent: () =>
      import('@movie-library/web/feature-auth').then((m) => m.RegisterPageComponent),
  },
  {
    path: 'library',
    canMatch: [authGuard],
    loadChildren: () =>
      import('@movie-library/web/feature-library').then((m) => m.LIBRARY_ROUTES),
  },
  {
    path: 'wishlist',
    canMatch: [authGuard],
    loadChildren: () =>
      import('@movie-library/web/feature-wishlist').then((m) => m.WISHLIST_ROUTES),
  },
  {
    path: 'movies/:id',
    canMatch: [authGuard],
    loadComponent: () =>
      import('@movie-library/web/feature-movie').then((m) => m.MoviePageComponent),
  },
  {
    path: 'suggest',
    canMatch: [authGuard],
    loadChildren: () =>
      import('@movie-library/web/feature-suggest').then((m) => m.SUGGEST_ROUTES),
  },
  {
    path: 'friends',
    canMatch: [authGuard],
    loadChildren: () =>
      import('@movie-library/web/feature-friends').then((m) => m.FRIENDS_ROUTES),
  },
  // ...
];
```

## Feature library structure

Every feature library follows the same shape:

```
packages/web/feature-library/
├── src/
│   ├── lib/
│   │   ├── library.routes.ts           (routes for this feature)
│   │   ├── pages/
│   │   │   ├── library-list/
│   │   │   │   ├── library-list.component.ts
│   │   │   │   └── library-list.component.html
│   │   │   └── library-detail/
│   │   ├── components/                 (feature-scoped components)
│   │   │   ├── filter-bar/
│   │   │   ├── library-card/
│   │   │   └── rating-badge/
│   │   └── library.store.ts            (signal store for this feature)
│   └── index.ts                        (export const LIBRARY_ROUTES; export everything public)
└── project.json
```

## State management — signal stores

One signal store per feature. Holds the data the feature's UI needs.

```typescript
// packages/web/feature-library/src/lib/library.store.ts

import { computed, inject } from '@angular/core';
import { signalStore, withState, withMethods, withComputed, withHooks, patchState } from '@ngrx/signals';
import { firstValueFrom } from 'rxjs';
import { LibraryApiClient } from '@movie-library/web/data-access';
import type { WatchedEntryDto, LibraryFilters } from '@movie-library/shared/domain';
import { defaultLibraryFilters } from '@movie-library/shared/domain';

type LibraryState = {
  entries: WatchedEntryDto[];
  filters: LibraryFilters;
  pagination: { page: number; limit: number; total: number };
  loading: boolean;
  error: ApiError | null;
};

const initialState: LibraryState = {
  entries: [],
  filters: defaultLibraryFilters(),
  pagination: { page: 1, limit: 50, total: 0 },
  loading: false,
  error: null,
};

export const LibraryStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withComputed(({ entries }) => ({
    isEmpty: computed(() => entries().length === 0),
  })),
  withMethods((store, api = inject(LibraryApiClient)) => ({
    async load(): Promise<void> {
      patchState(store, { loading: true, error: null });
      try {
        const response = await firstValueFrom(
          api.list({ ...store.filters(), page: store.pagination().page, limit: store.pagination().limit }),
        );
        patchState(store, {
          entries: response.data,
          pagination: response.pagination,
          loading: false,
        });
      } catch (error) {
        patchState(store, { loading: false, error: error as ApiError });
      }
    },
    setFilter<K extends keyof LibraryFilters>(key: K, value: LibraryFilters[K]) {
      patchState(store, (s) => ({
        filters: { ...s.filters, [key]: value },
        pagination: { ...s.pagination, page: 1 },
      }));
      this.load();
    },
    resetFilters() {
      patchState(store, { filters: defaultLibraryFilters(), pagination: { page: 1, limit: 50, total: 0 } });
      this.load();
    },
    nextPage() {
      patchState(store, (s) => ({ pagination: { ...s.pagination, page: s.pagination.page + 1 } }));
      this.load();
    },
  })),
  withHooks({
    onInit(store) {
      void store.load();
    },
  }),
);
```

In the component:

```typescript
@Component({
  selector: 'lib-library-list',
  standalone: true,
  imports: [FilterBarComponent, LibraryCardComponent],
  templateUrl: './library-list.component.html',
})
export class LibraryListComponent {
  protected readonly store = inject(LibraryStore);
}
```

In the template, signal accessors are read directly:

```html
<lib-filter-bar
  [filters]="store.filters()"
  (filterChange)="store.setFilter($event.key, $event.value)"
/>

@if (store.loading()) {
  <div class="spinner"></div>
} @else if (store.isEmpty()) {
  <div class="empty-state">Your library is empty. Add the first movie.</div>
} @else {
  @for (entry of store.entries(); track entry.id) {
    <lib-library-card [entry]="entry" />
  }
}
```

## Auth interceptor

Catches `401` from the backend, attempts a token refresh, retries the request on success. On failure — clears tokens and redirects to `/login`.

```typescript
// packages/web/data-access/src/lib/interceptors/auth.interceptor.ts

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authStore = inject(AuthStore);
  const router = inject(Router);

  // attach access token
  const accessToken = authStore.accessToken();
  const authReq = accessToken
    ? req.clone({ setHeaders: { Authorization: `Bearer ${accessToken}` } })
    : req;

  return next(authReq).pipe(
    catchError((error: HttpErrorResponse) => {
      if (error.status !== 401 || req.url.endsWith('/auth/refresh')) {
        return throwError(() => error);
      }
      return from(authStore.refresh()).pipe(
        switchMap(() => {
          const newToken = authStore.accessToken();
          if (!newToken) {
            void router.navigate(['/login']);
            return throwError(() => error);
          }
          return next(req.clone({ setHeaders: { Authorization: `Bearer ${newToken}` } }));
        }),
        catchError((refreshError) => {
          authStore.clear();
          void router.navigate(['/login']);
          return throwError(() => refreshError);
        }),
      );
    }),
  );
};
```

Registered in `app.config.ts`:

```typescript
provideHttpClient(
  withInterceptors([authInterceptor, errorInterceptor]),
),
```

## PWA

### Setup

```bash
pnpm dlx nx g @angular/pwa:ng-add --project=web
```

Adds `manifest.webmanifest`, `ngsw-config.json`, and `provideServiceWorker()` in `app.config.ts`.

### Manifest

```json
// apps/web/src/manifest.webmanifest
{
  "name": "Movie Library",
  "short_name": "Movies",
  "theme_color": "#0a0a0a",
  "background_color": "#0a0a0a",
  "display": "standalone",
  "scope": "./",
  "start_url": "./",
  "icons": [
    { "src": "icons/icon-72x72.png",   "sizes": "72x72",   "type": "image/png", "purpose": "maskable any" },
    { "src": "icons/icon-96x96.png",   "sizes": "96x96",   "type": "image/png", "purpose": "maskable any" },
    { "src": "icons/icon-128x128.png", "sizes": "128x128", "type": "image/png", "purpose": "maskable any" },
    { "src": "icons/icon-144x144.png", "sizes": "144x144", "type": "image/png", "purpose": "maskable any" },
    { "src": "icons/icon-152x152.png", "sizes": "152x152", "type": "image/png", "purpose": "maskable any" },
    { "src": "icons/icon-192x192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable any" },
    { "src": "icons/icon-384x384.png", "sizes": "384x384", "type": "image/png", "purpose": "maskable any" },
    { "src": "icons/icon-512x512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable any" }
  ]
}
```

### iOS-specific meta tags in `index.html`

```html
<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Movies">

<!-- Splash screens for various iPhone sizes (generated by pwa-asset-generator) -->
<link rel="apple-touch-startup-image" media="..." href="splash-1290x2796.png">
<!-- ... -->

<meta name="theme-color" content="#0a0a0a">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
```

### Generating all icons and splash screens

```bash
pnpm dlx pwa-asset-generator ./apps/web/public/icon-source.png ./apps/web/public/icons \
  --background "#0a0a0a" \
  --manifest ./apps/web/src/manifest.webmanifest \
  --index ./apps/web/src/index.html
```

Design the 1024×1024 icon once in Figma; the script generates every size plus splash images for every iPhone.

### Service Worker config

```json
// apps/web/ngsw-config.json
{
  "$schema": "./node_modules/@angular/service-worker/config/schema.json",
  "index": "/index.html",
  "assetGroups": [
    {
      "name": "app",
      "installMode": "prefetch",
      "resources": {
        "files": ["/favicon.ico", "/index.html", "/manifest.webmanifest", "/*.css", "/*.js"]
      }
    },
    {
      "name": "assets",
      "installMode": "lazy",
      "updateMode": "prefetch",
      "resources": {
        "files": ["/assets/**", "/icons/**", "/*.(svg|cur|jpg|jpeg|png|apng|webp|avif|gif|otf|ttf|woff|woff2)"]
      }
    }
  ],
  "dataGroups": [
    {
      "name": "tmdb-images",
      "urls": ["https://image.tmdb.org/t/p/**"],
      "cacheConfig": {
        "maxSize": 500,
        "maxAge": "30d",
        "strategy": "performance"
      }
    },
    {
      "name": "api-freshness",
      "urls": ["/api/**"],
      "cacheConfig": {
        "maxSize": 100,
        "maxAge": "1d",
        "timeout": "3s",
        "strategy": "freshness"
      }
    }
  ]
}
```

Strategies:
- `performance` (cache-first) for TMDB images — they're immutable.
- `freshness` (network-first with timeout) for API calls — try fresh, fall back to cache on slow networks.

## SSG (prerendering static routes)

Angular 19 supports prerendering through `@angular/ssr` without running an SSR server. In `angular.json` (or `project.json` for Nx):

```json
{
  "build": {
    "executor": "@angular-devkit/build-angular:application",
    "options": {
      "outputMode": "static",
      "prerender": {
        "discoverRoutes": false,
        "routes": ["/", "/login", "/register"]
      }
    }
  }
}
```

`outputMode: "static"` means the build does not produce a Node server, only static HTML files. For each prerendered route Angular emits the corresponding file (`index.html`, `login/index.html`, `register/index.html`) with the route fully rendered.

These files are served by nginx in the `web` container directly, with no Angular runtime involved. First-paint time on iPhone after tapping the home-screen icon is essentially instant.

Protected routes (`/library`, `/wishlist`, etc.) are **not** prerendered — Angular bootstraps, reads the token from storage, calls the API.

## App shell

In addition to SSG, you can generate an app shell — a minimal HTML fragment baked into `index.html` and shown before JS loads:

```bash
pnpm nx g @angular/pwa:app-shell --project=web
```

This adds skeleton markup directly into `index.html`. When the iOS PWA launches, the user sees the UI outline (header, sidebar, spinner) **before** Angular has a chance to bootstrap. The "feels instant" sensation is critical for PWAs on iPhone.

## i18n

Transloco is configured with three locales: `en` (default), `ru`, `uk`. Translations live in `apps/web/src/assets/i18n/{lang}.json`.

```typescript
// apps/web/src/app/app.config.ts
provideTransloco({
  config: {
    availableLangs: ['en', 'ru', 'uk'],
    defaultLang: 'en',
    reRenderOnLangChange: true,
    prodMode: !isDevMode(),
  },
  loader: TranslocoHttpLoader,
}),
```

In templates:
```html
<h1>{{ 'library.title' | transloco }}</h1>
<p>{{ 'library.empty' | transloco: { count: store.entries().length } }}</p>
```

The active language lives in `User.language` and is updated via `PATCH /api/auth/me`.

## Theming and UI Kit (Taiga UI v5 + Tailwind utilities)

### Installing Taiga UI

After the Angular app is generated, add Taiga UI:

```bash
pnpm add taiga-ui
pnpm nx g taiga-ui:ng-add --project=web
```

The schematic automatically:
- Installs `@taiga-ui/cdk`, `@taiga-ui/core`, `@taiga-ui/kit`, `@taiga-ui/icons`, `@taiga-ui/layout` and dependencies (`@maskito/*`, `@ng-web-apis/*`).
- Adds `provideTaiga()` to `app.config.ts`.
- Imports the base styles into `apps/web/src/styles.scss`.

### `app.config.ts` setup

```typescript
import { ApplicationConfig } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideTaiga } from '@taiga-ui/core';
import { NG_EVENT_PLUGINS } from '@taiga-ui/event-plugins';
import { appRoutes } from './app.routes';
import { authInterceptor, errorInterceptor } from '@movie-library/web/data-access';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(appRoutes, withComponentInputBinding()),
    provideHttpClient(withInterceptors([authInterceptor, errorInterceptor])),
    provideTaiga(),  // registers all Taiga services and event plugins
    NG_EVENT_PLUGINS,
    // ... transloco, sentry, signal stores
  ],
};
```

### Importing Taiga styles

```scss
// apps/web/src/styles.scss

@import '@taiga-ui/core/styles/taiga-ui-theme.less';
@import '@taiga-ui/core/styles/taiga-ui-fonts.less';

@import './styles/tokens.css';
@import './styles/tailwind.css';
```

### Tailwind with preflight disabled

```js
// tailwind.config.js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './apps/web/src/**/*.{html,ts}',
    './packages/web/**/*.{html,ts}',
  ],
  corePlugins: {
    preflight: false,  // don't reset browser styles — Taiga handles that
  },
  theme: {
    extend: {
      // No colors here — we use Taiga CSS variables directly via [style]
    },
  },
  plugins: [],
};
```

We deliberately do not wire up Tailwind colors or typography — Taiga owns the palette.

### Customizing the Taiga theme

Taiga is built on CSS variables. Override them in `tokens.css`:

```css
/* apps/web/src/styles/tokens.css */

:root {
  /* Taiga UI base tokens */
  --tui-background-base: #0a0a0a;
  --tui-background-base-alt: #161616;
  --tui-background-elevation-1: #1c1c1c;
  --tui-background-elevation-2: #232323;

  --tui-text-primary: #f5f5f5;
  --tui-text-secondary: #a0a0a0;
  --tui-text-tertiary: #6e6e6e;

  --tui-status-positive: #22c55e;
  --tui-status-negative: #ef4444;
  --tui-status-warning: #f59e0b;
  --tui-status-info: #3b82f6;

  --tui-border-normal: #2a2a2a;
  --tui-border-hover: #3a3a3a;

  /* Custom application tokens */
  --color-accent: #f5a623;          /* accent for ratings and CTAs */
  --movie-poster-radius: 8px;
}
```

Full list of variables — [taiga-ui.dev/tokens](https://taiga-ui.dev/tokens). Default theme is light; we override `:root` with dark values directly. If we ever want a light/dark switch — wrap content in `[tuiTheme]="theme()"`.

### Using Taiga components

In feature libraries, import what you need:

```typescript
// packages/web/feature-library/src/lib/components/library-card/library-card.component.ts

import { Component, input, computed } from '@angular/core';
import { TuiCard, TuiAvatar } from '@taiga-ui/layout';
import { TuiButton, TuiIcon } from '@taiga-ui/core';
import { TuiBadge } from '@taiga-ui/kit';
import type { WatchedEntryDto } from '@movie-library/shared/domain';

@Component({
  selector: 'lib-library-card',
  standalone: true,
  imports: [TuiCard, TuiAvatar, TuiButton, TuiIcon, TuiBadge],
  template: `
    <tui-card class="flex gap-4 p-4">
      <img
        [src]="posterUrl()"
        [alt]="entry().movie.title"
        class="w-20 h-28 rounded-md object-cover"
      />
      <div class="flex-1 flex flex-col gap-2">
        <h3 class="text-base font-medium">{{ entry().movie.title }}</h3>
        <div class="flex gap-2">
          <tui-badge>{{ entry().movie.year }}</tui-badge>
          @if (entry().rating) {
            <tui-badge appearance="success">
              {{ entry().rating!.score }}/10
            </tui-badge>
          }
        </div>
      </div>
    </tui-card>
  `,
})
export class LibraryCardComponent {
  readonly entry = input.required<WatchedEntryDto>();
  protected posterUrl = computed(() =>
    this.entry().movie.posterPath
      ? \`https://image.tmdb.org/t/p/w200\${this.entry().movie.posterPath}\`
      : '/assets/no-poster.svg'
  );
}
```

Notes:
- Imports come from specific `@taiga-ui/*` entry points — **not** a single `@taiga-ui` umbrella.
- Layout — Tailwind classes (`flex`, `gap-4`, `p-4`).
- Colors — none specified (Taiga applies tokens automatically).
- Fonts, shadows, radii — come from Taiga.

### Taiga components we'll use

Minimal MVP set:

| Taiga component                            | Where                                       |
|--------------------------------------------|---------------------------------------------|
| `TuiCard`, `TuiCardLarge`                  | Movie cards in library/wishlist             |
| `TuiButton`, `TuiIconButton`               | All buttons                                 |
| `TuiInput`, `TuiTextarea`, `TuiSelect`     | Forms (auth, add movie, filters)            |
| `TuiBadge`, `TuiChip`                      | Genres, countries, ratings                  |
| `TuiDialog` + `TuiDialogService`           | Modals (add movie, rating)                  |
| `TuiNotification` + `TuiAlertService`      | Toasts                                      |
| `TuiLoader`                                | Loading states                              |
| `TuiAvatar`                                | User avatars in friends                     |
| `TuiSlider`, `TuiInputNumber`              | Filter min score, rating 1-10               |
| `TuiCombobox`                              | Movie search with autocomplete              |
| `TuiTabs`                                  | Friends tabs (incoming/outgoing/accepted)   |
| `TuiHint`                                  | Tooltips                                    |
| `TuiPagination` or `TuiScrollIntoView`     | Pagination / infinite scroll                |
| `TuiSkeleton`                              | Skeleton states while loading               |
