# ViBe

Educational platform (continuous assessment + adaptive reviews) with a pnpm monorepo: `backend/` (Express + InversifyJS + MongoDB + Firebase Admin), `frontend/` (React 19 + Vite + TanStack Router + shadcn/ui), `cli/` (commander-based `vibe` CLI), `docs/` (Docusaurus), `e2e/` (Playwright). Firebase is used for auth and hosting; pnpm 10 is required.

## Dev environment

Node ≥ 23 (setup-unix.sh installs 23 via nvm). pnpm 10 via corepack or `npm i -g pnpm`. Backend requires MongoDB (real Atlas URI in `backend/.env` OR `mongodb-memory-server` for tests — the `MongoDB Test Binaries` step pre-downloads them).

First-time setup (interactive): `pnpm install` at the repo root, then either run `python3 setup.py` (cross-platform wizard) or `bash scripts/setup-unix.sh`. Both end with `vibe setup`. Manual equivalent: `pnpm install` in root, `backend/`, `frontend/`; `cd backend && node scripts/start.sh` to launch the Firebase auth emulator; populate `backend/.env` from `backend/.example.env` (`DB_URL`, `GCLOUD_PROJECT`, etc.).

CLI: `pnpm vibe` (alias) → `vibe start [backend|frontend|docs|all]`, `vibe test`, `vibe setup`. Backend on `:3141`, Firebase Auth emulator on `:9099`, Functions emulator on `:4000`. Frontend dev server (Vite) proxies `/api` to `http://localhost:4001` (see `frontend/vite.config.ts`).

## Build & test

Run from repo root unless noted.

- Backend install: `pnpm --filter backend install`
- Backend dev (tsc watch + nodemon): `pnpm --filter backend dev`
- Backend build: `pnpm --filter backend build` (output → `backend/build/`)
- Backend start (built): `pnpm --filter backend start` — run `firebase emulators:start --only auth --project <GCLOUD_PROJECT>` first
- Backend tests (vitest): `pnpm --filter backend test` (UI) / `pnpm --filter backend test:ci` (CI, with coverage) / `pnpm --filter backend test:watch`
- Backend smoke (ILE save): `pnpm --filter backend smoke:ile`
- Generate OpenAPI from backend: `cd backend && node scripts/generate-openapi.cjs --output ../../frontend/openapi.json` — or `pnpm --filter frontend copy`
- Frontend install: `pnpm --filter frontend install`
- Frontend dev: `pnpm --filter frontend dev` (port 5173)
- Frontend build: `pnpm --filter frontend build` (tsc -b + vite build → `frontend/dist/`)
- Frontend lint/fix: `pnpm --filter frontend lint` / `pnpm --filter frontend fix`
- Schema types from OpenAPI: `pnpm --filter frontend gen-schema`
- Preload Mongo binaries for mongodb-memory-server: `pnpm run binaries`
- E2E (Playwright): `pnpm --dir e2e test-e2e` (requires frontend running on `:5173`). One-time browser install: `pnpm --dir e2e exec playwright install`. Tests use `BASE_URL`, `TEST_STUDENT_EMAIL`, `TEST_STUDENT_PASSWORD`, `VITE_E2E_TESTING=true` (see `e2e/README.md`).
- CLI link global: `cd cli && pnpm link --global`

## Conventions

- Backend is TypeScript ESM (`"type": "module"`, `module: nodenext`). Compiled output in `backend/build/` — never hand-edit. Imports use `#root/*`, `#shared/*`, `#<module>/*` aliases declared in `backend/package.json` `imports` and `backend/tsconfig.json` `paths` (mapped to `build/`).
- Strict TS is OFF (`strict: false`) — don't introduce stricter checks ad-hoc.
- Backend modules live in `backend/src/modules/<domain>/` (auth, courses, quizzes, users, media, genAI, settings, anomalies, studentQuestions, interactiveExperiences, …). Each module follows the plop template: `controller.hbs` + `service.hbs` + `repository.hbs` + `module-base/{container,index,types}.ts.hbs`. Scaffold a new module with `pnpm --filter backend generate` (plop).
- DI via InversifyJS (`backend/src/container.ts`, `inversify-adapter.ts`); controllers wired through `routing-controllers`; decorators require `experimentalDecorators` + `emitDecoratorMetadata` (already on).
- API reference served at `/reference` (Scalar) once the backend is running.
- Frontend aliases `@/*` → `src/*` (see `frontend/vite.config.ts` and `frontend/tsconfig.json`). UI = shadcn/ui on Radix + Tailwind v4 + MUI icons + Tabler icons. Router is `@tanstack/react-router`. State: `@tanstack/react-query` + `zustand`.
- Both backend and frontend lint via `gts` (Google TS Style) + ESLint. Backend additionally enforces `plugin:require-extensions/recommended`. Prettier inherits `gts/.prettierrc.json`. Husky pre-commit runs `lint-staged` on `backend/**/*.{js,jsx,ts,tsx}` via `pnpm --filter backend lint` (see root `package.json`).
- CI: `.github/workflows/linter.yml` runs backend lint on PRs; `jest-test.yml` (vitest) requires Atlas IP allowlist secrets. Don't rely on those locally — run `pnpm --filter backend test:ci` with the auth emulator on `:9099`.
- LF line endings enforced via `.gitattributes` for `*.{sh,py,js,ts,html,css}`.
- Generated/ignored paths: `backend/build/`, `frontend/dist/`, `e2e/test-results/`, `e2e/playwright-report/`, `backend/tsconfig.tsbuildinfo`, `frontend/tsconfig.tsbuildinfo`, `backend/nohup.out`, `backend/emulator-data/`, `audit-*.png`, `ile-*.png`, `hover-*.png`, `.playwright-mcp/`, `.vibe.json`, `.hermes/plans/`, `tmp/`.

## Pitfalls

- `class-transformer@0.5.1` is patched on backend `postinstall` (`backend/scripts/class-transformer-0.5.1.patch.js`). Don't bump without verifying the patch still applies — tests rely on it.
- `mongodb-memory-server` needs a downloaded mongod binary. If `pnpm run binaries` was skipped, vitest will hang or fail the first time it boots an in-memory server. Same on CI runners.
- Firebase Admin ID-token verification reads `GCLOUD_PROJECT`. If video buckets live in a separate GCP project, set `GOOGLE_VIDEO_PROJECT_ID` instead — pointing `GCLOUD_PROJECT` at the video project breaks every authenticated request ("incorrect aud claim"). See comments in `backend/.example.env`.
- `GOOGLE_VIDEO_CDN_KEY_NAME`/`_KEY_VALUE` are unrecoverable after creation; capture them at signing-key creation time. Without them, CDN playback URLs are unsigned.
- Vite dev server proxies `/api` → `http://localhost:4001`, not `:3141` (the backend's own port). The Functions emulator on `:4000` is separate. If `/api` 404s locally, you started the wrong emulator.
- ILE Whisper fallback needs `yt-dlp`, `ffmpeg`, and `python3 -c "import faster_whisper"` on PATH; binary detection is cached for the process lifetime — install missing deps, then restart the backend.
- Playwright e2e: a single worker, 10-hour timeout, fake media via `--use-fake-device-for-media-stream` + `assets/webcam-face.{y4m,wav}`. The test file `e2e/tests/play-course-vidoes.test.ts` has a legacy typo (`vidoes`) — keep as-is.
- `pnpm-lock.yaml` is gitignored in this repo (see `.gitignore`). CI deletes it before installing — local lockfile drift will not surface as a PR diff.
- `.hermes/AGENT.md` and `.hermes/plans/` are gitignored — don't write project instructions there; this file (`AGENTS.md` at repo root) is the canonical one.
- `frontend/.firebase/`, `frontend/protype/`, and `mcp/` are also gitignored — do not commit artifacts into them.
- Audit screenshots (`audit-*.png`, `ile-*.png`, `hover-*.png`) are ignored local debugging artifacts; the dozens already on disk in repo root predate the ignore rules — clean them up if they reappear in `git status`.
