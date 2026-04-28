# CI/CD: GitHub Actions + GHCR

## Overview

```
push to a feature branch     →    .github/workflows/ci.yml
                                   (lint + test + build)

PR merged into main          →    .github/workflows/deploy.yml
                                   (ci + build & push images to ghcr.io + ssh deploy to VPS)
```

GitHub Container Registry (`ghcr.io`) is free for private images on personal accounts.

## CI workflow

```yaml
# .github/workflows/ci.yml

name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

env:
  NODE_VERSION: '20'
  PNPM_VERSION: '9'

jobs:
  ci:
    name: Lint, test, build
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0  # required for nx affected

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Generate Prisma client
        run: pnpm prisma generate

      - name: Set Nx SHAs
        uses: nrwl/nx-set-shas@v4

      - name: Verify TypeScript project references are in sync
        run: pnpm nx sync:check

      - name: Lint
        run: pnpm nx affected -t lint --parallel=3

      - name: Test
        run: pnpm nx affected -t test --parallel=3 --configuration=ci

      - name: Build
        run: pnpm nx affected -t build --parallel=3 --configuration=production
```

`nx affected` runs targets only for affected projects — it's how CI stays fast. `nx sync:check` is mandatory: when using TypeScript Project References, Nx auto-syncs the `references` field across all `tsconfig.json` files. If someone forgets to commit those updates, this step fails the build instead of silently shipping broken type information.

## Deploy workflow

```yaml
# .github/workflows/deploy.yml

name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: deploy-prod
  cancel-in-progress: false  # don't cancel an in-flight deploy

env:
  REGISTRY: ghcr.io
  IMAGE_API: ${{ github.repository_owner }}/movie-library-api
  IMAGE_WEB: ${{ github.repository_owner }}/movie-library-web

jobs:
  build-and-push:
    name: Build & push images
    runs-on: ubuntu-latest
    timeout-minutes: 25
    permissions:
      contents: read
      packages: write

    outputs:
      sha-tag: ${{ steps.meta.outputs.sha-tag }}

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set image tags
        id: meta
        run: |
          SHA_SHORT=$(echo "${{ github.sha }}" | cut -c1-7)
          echo "sha-tag=${SHA_SHORT}" >> $GITHUB_OUTPUT

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build & push API image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: docker/api.Dockerfile
          push: true
          cache-from: type=gha,scope=api
          cache-to: type=gha,scope=api,mode=max
          tags: |
            ${{ env.REGISTRY }}/${{ env.IMAGE_API }}:latest
            ${{ env.REGISTRY }}/${{ env.IMAGE_API }}:${{ steps.meta.outputs.sha-tag }}

      - name: Build & push web image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: docker/web.Dockerfile
          push: true
          cache-from: type=gha,scope=web
          cache-to: type=gha,scope=web,mode=max
          tags: |
            ${{ env.REGISTRY }}/${{ env.IMAGE_WEB }}:latest
            ${{ env.REGISTRY }}/${{ env.IMAGE_WEB }}:${{ steps.meta.outputs.sha-tag }}

  deploy:
    name: Deploy to VPS
    needs: build-and-push
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment:
      name: production
      url: https://${{ vars.DOMAIN }}

    steps:
      - name: SSH deploy
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          port: ${{ secrets.SSH_PORT }}
          script: |
            set -e
            cd /opt/movie-library

            # Log in to GHCR (needed once per machine before docker pull works)
            echo "${{ secrets.GHCR_TOKEN }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin

            # Pull new images
            docker compose pull

            # Apply migrations (one-shot api container with overridden command)
            docker compose run --rm --no-deps api npx prisma migrate deploy

            # Up / restart
            docker compose up -d --remove-orphans

            # Wait and health-check
            sleep 10
            curl -fsS https://${{ vars.DOMAIN }}/api/health || (docker compose logs api --tail=50 && exit 1)

            # Prune old images
            docker image prune -f

      - name: Notify Sentry of release
        uses: getsentry/action-release@v1
        env:
          SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
          SENTRY_ORG: ${{ vars.SENTRY_ORG }}
        with:
          environment: production
          version: ${{ needs.build-and-push.outputs.sha-tag }}
          projects: movie-library-api movie-library-web
```

## Secrets and variables

### GitHub repository secrets

| Name                     | Value                                                                    |
|--------------------------|--------------------------------------------------------------------------|
| `SSH_HOST`               | VPS IP or hostname                                                       |
| `SSH_USER`               | `deploy`                                                                 |
| `SSH_PORT`               | `2222` (or whatever you chose)                                           |
| `SSH_PRIVATE_KEY`        | Private SSH key for the deploy user (full contents, including headers)   |
| `GHCR_TOKEN`             | GitHub PAT with `read:packages` scope (so the VPS can pull)              |
| `SENTRY_AUTH_TOKEN`      | Sentry auth token (for tagging releases)                                 |

### GitHub repository variables

| Name          | Value                  |
|---------------|------------------------|
| `DOMAIN`      | `movies.example.com`   |
| `SENTRY_ORG`  | your Sentry org slug   |

### Where to get `GHCR_TOKEN`

GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token. Only `read:packages` scope (for pull). This token lives on the VPS so `docker compose pull` can hit private images on GHCR. Alternative — make the packages public (`Package settings → Change visibility → Public`); then no token is needed. For a personal pet project this is acceptable; nothing sensitive is in the images.

## Generating an SSH key for deploys

Locally:

```bash
# Generate a fresh, deploy-only key (do NOT use your work key)
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/movie-library-deploy

# Add the public key to /home/deploy/.ssh/authorized_keys on the VPS
ssh-copy-id -i ~/.ssh/movie-library-deploy.pub deploy@vps-ip

# Copy the private key into the GitHub secret SSH_PRIVATE_KEY (full text including -----BEGIN ... END-----)
cat ~/.ssh/movie-library-deploy
```

Verify:
```bash
ssh -i ~/.ssh/movie-library-deploy -p 2222 deploy@vps-ip "echo ok"
```

## Branch strategy

Simple, single-developer workflow:

- `main` — the only protected branch. Pushes here trigger production deploy.
- `feature/<name>` — feature branches. Open a PR to `main`; CI must be green to merge.
- No `develop` or `release/*` branches — overkill for a pet project.

## Protecting `main`

GitHub → Settings → Branches → Add rule:

- Branch name pattern: `main`
- Require a pull request before merging
- Require status checks to pass: `ci` (the job name from `ci.yml`)
- Require branches to be up to date before merging
- Don't enable "Include administrators" — leave yourself an escape hatch for force-push in a personal project.

## Rolling back a deploy

If something breaks in production, two options:

### Quick rollback (image-level)

On the VPS:
```bash
cd /opt/movie-library
# Find the previous good tag
docker images | grep movie-library

# Pin the tag in docker-compose.yml manually (or use an env var)
# For example, replace :latest with :abc1234
nano docker-compose.yml
docker compose pull
docker compose up -d
```

### Revert PR

```bash
git revert <bad-commit-hash>
git push origin main
```

GitHub Actions runs deploy.yml with the rollback. Slower (5-10 minutes for the build) but "more correct" — repo and prod stay in sync.

## Local smoke test before pushing

```bash
# Build production images locally
docker build -f docker/api.Dockerfile -t movie-library-api:test .
docker build -f docker/web.Dockerfile -t movie-library-web:test .

# Bring up a local stack mirroring prod
docker compose -f deploy/docker-compose.yml up -d

# Verify
curl http://localhost:3000/api/health
```
