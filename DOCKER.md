# Running in Docker

This repo ships with a `Dockerfile` and `docker-compose.yml` that run `capture.js` as a long-lived container with headless Chromium and a persistent SQLite volume.

## What you get

- **Image base:** `node:20-bookworm-slim` with Debian's `chromium` package — Puppeteer is told to use the system binary via `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`, so no ~300 MB Chrome download during `npm ci`.
- **Native module:** `better-sqlite3` is compiled in a builder stage and copied to the runtime image.
- **Runs as non-root** (`app` user). The container PID 1 is `dumb-init` so `SIGTERM` reaches Node and the existing `cleanup()` handler runs.
- **Persistent volume:** named volume `crash_data` is mounted at `/data`. The app reads `DB_PATH=/data/crash_results.db`, so the DB plus its `-wal` and `-shm` sidecars live on the volume and survive container rebuilds.
- **Port:** `3000` is exposed; override with the `PORT` env var on the host (e.g. `PORT=4000 docker compose up -d` maps host 4000 → container 3000).

## Quick start

```bash
# 1. (optional) configure Telegram / port / etc.
cp .env.example .env
$EDITOR .env

# 2. build and start
docker compose up -d --build

# 3. tail logs
docker compose logs -f crash-monitor
```

Then open `http://localhost:3000` for the live dashboard and `http://localhost:3000/analytics.html` for the analytics view.

`docker compose down` stops the container but keeps the volume; `docker compose down -v` would also delete the DB volume.

## Configuration

Environment variables are read from your shell or a `.env` file in the project root (Compose loads `.env` automatically). Anything in `.env.example` works; the Compose file wires the relevant ones through.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Host port mapped to container's 3000 |
| `DASHBOARD_ENABLED` | `true` | Set `false` for capture-only daemon |
| `TELEGRAM_ENABLED` | `false` | Requires the two vars below |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | |
| `DESKTOP_NOTIFICATIONS_ENABLED` | forced to `false` | `node-notifier` can't reach a desktop from a container |
| `DB_PATH` | `/data/crash_results.db` | Don't override unless you also change the volume mount |

## Migrating the existing DB to the volume

If you already have data in `./crash_results.db` (plus `-wal` / `-shm`), copy it into the named volume **once**, before the container has written anything new. Do it while the container is stopped so SQLite WAL state is consistent.

```bash
# 0. stop the container if it's running
docker compose down

# 1. make sure the named volume exists (compose creates it lazily on `up`)
docker volume create stake-crash-archives_crash_data
# (the prefix is your project dir name; check with `docker volume ls`)

# 2. checkpoint WAL into the main DB file so a plain copy is enough
sqlite3 crash_results.db "PRAGMA wal_checkpoint(TRUNCATE);"

# 3. copy the DB into the volume via a throwaway container
docker run --rm \
  -v stake-crash-archives_crash_data:/data \
  -v "$(pwd)":/src:ro \
  busybox sh -c "cp /src/crash_results.db /data/crash_results.db && \
                 [ -f /src/crash_results.db-wal ] && cp /src/crash_results.db-wal /data/ || true; \
                 [ -f /src/crash_results.db-shm ] && cp /src/crash_results.db-shm /data/ || true; \
                 chown -R 999:999 /data || true"

# 4. start the container
docker compose up -d
```

Notes:

- **Volume name:** Compose names volumes `<project>_<volume>`. The project name defaults to the directory name (`stake-crash-archives`), so the full volume is `stake-crash-archives_crash_data`. Confirm with `docker volume ls`.
- **WAL checkpoint (step 2):** ensures every committed row is in the main `.db` file. Without it you'd need to copy all three files atomically.
- **Ownership (step 3, `chown`):** the container runs as the non-root `app` user. The throwaway `busybox` step chowns the files so the runtime user can read/write them. The numeric UID may differ on your system — if Node logs `EACCES`, run `docker compose exec crash-monitor id` to find the real UID/GID and re-chown.
- **Don't run two writers:** never have the host's `capture.js` and the container both pointed at the same DB. Pick one.

## Verifying the volume

```bash
# inspect the volume contents
docker run --rm -v stake-crash-archives_crash_data:/data busybox ls -lh /data

# open a sqlite shell against the volume
docker run --rm -it -v stake-crash-archives_crash_data:/data \
  keinos/sqlite3 sqlite3 /data/crash_results.db "SELECT COUNT(*) FROM crash_results;"
```

## Rebuilding after code changes

```bash
docker compose up -d --build
```

The volume is untouched by rebuilds — only the image layer with `capture.js` / `public/` is replaced.

## Common issues

- **`Failed to launch the browser process`** — usually a missing shared lib. Re-pull the base image (`docker compose build --no-cache`); the apt step pulls everything Chromium needs.
- **Container exits with `MODULE_NOT_FOUND` for `better-sqlite3`** — happens if the image was built on a different libc/arch than it runs on. Rebuild on the target host.
- **DB is empty after restart** — you bind-mounted instead of using the named volume, or pointed `DB_PATH` somewhere outside `/data`. Check `docker inspect stake-crash-monitor` under `Mounts`.
