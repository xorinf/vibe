# ViBe Backend

## Overview

ViBe is a modular, scalable backend built with **TypeScript**, **Express**, **MongoDB**, and **InversifyJS** for dependency injection. It powers the ViBe platform, supporting authentication, course management, quizzes, anomaly detection, notifications, user progress, and more.

## Architecture

- **Express**: Main web server, with modular routing via `routing-controllers`.
- **InversifyJS**: Dependency injection for services, repositories, and controllers.
- **MongoDB**: Primary database, accessed via repository pattern.
- **Sentry**: Error monitoring and profiling.
- **Firebase**: Authentication and user management.
- **OpenAPI**: Auto-generated API documentation via Scalar.

## Main Features

- **Authentication**: Firebase-based, with JWT support and user management.
- **Courses**: CRUD for courses, versions, modules, sections, and items (video, quiz, blog).
- **Quizzes**: Question banks, quiz attempts, grading, and settings.
- **Users**: Enrollment, progress tracking, watch time, and anomaly detection.
- **Notifications**: Invites, email notifications, and status tracking.
- **Settings**: Proctoring and custom settings for users/courses.
- **Anomalies**: Detection and monitoring for user/course anomalies.
- **GenAI**: Integration for generative AI features.
- **API Reference**: `/reference` endpoint for live OpenAPI docs.

## Directory Structure


```
backend/
├── plop-templates/         # Code generation templates
│   ├── controller.hbs
│   ├── repository.hbs
│   ├── service.hbs
│   └── module-base/
│       ├── container.ts.hbs
│       ├── index.ts.hbs
│       └── types.ts.hbs
├── src/                    # Main source code
│   ├── bootstrap/          # Module loader and startup logic
│   │   └── loadModules.ts
│   ├── config/             # App and DB configuration
│   │   ├── ai.ts
│   │   ├── app.ts
│   │   ├── db.ts
│   │   ├── index.ts
│   │   ├── sentry.ts
│   │   ├── smtp.ts
│   │   └── storage.ts
│   ├── container.ts        # Inversify DI container setup
│   ├── index.ts            # Main entry point
│   ├── instrument.ts       # Sentry instrumentation
│   ├── inversify-adapter.ts# Inversify adapter for routing-controllers
│   ├── modules/            # Main business logic, organized by domain
│   │   ├── anomalies/
│   │   ├── auth/
│   │   ├── courses/
│   │   ├── genAI/
│   │   ├── notifications/
│   │   ├── quizzes/
│   │   ├── settings/
│   │   └── users/
│   ├── shared/             # Common code (classes, interfaces, db, middleware, etc.)
│   │   ├── classes/
│   │   ├── constants/
│   │   ├── database/
│   │   ├── functions/
│   │   ├── interfaces/
│   │   └── middleware/
│   ├── types.ts            # Global type symbols for DI
│   └── utils/              # Utility functions
│       ├── env.ts
│       ├── index.ts
│       ├── logDetails.ts
│       └── to-bool.ts
├── .env                    # Environment variables (not committed)
├── .example.env            # Example env file
├── Dockerfile              # Docker setup for deployment
├── Dockerfile-all          # Docker setup for all-in-one deployment
├── firebase.json           # Firebase config
├── package.json            # Project metadata and dependencies
├── plopfile.cjs            # Plop code generator config
├── tsconfig.json           # TypeScript config
├── typedoc.json            # Typedoc config for API docs
├── vite.config.ts          # Vite config (if used for frontend)
└── README.md               # Project documentation
```

## Key Modules

- **Auth**: FirebaseAuthService for signup, login, password change, and token verification.
- **Courses**: CourseRepository for managing courses, versions, modules, sections, and items.
- **Quizzes**: Quiz logic, question types (SOL, SML, MTL, OTL, NAT, DES), and grading.
- **Users**: EnrollmentService and ProgressService for tracking user progress and enrollments.
- **Notifications**: InviteRepository and MailService for sending and managing invites.
- **Settings**: SettingsRepository for proctoring and custom settings.
- **Anomalies**: User anomaly tracking and reporting.

## Module Details

- **Anomalies**: Detects and tracks user/course anomalies for monitoring and security.
- **Auth**: Handles user authentication, signup, login, password management, and token verification using Firebase.
- **Courses**: Manages courses, versions, modules, sections, and items (video, quiz, blog).
- **GenAI**: Integrates generative AI features (details depend on implementation).
- **Notifications**: Manages invites, email notifications, and status tracking.
- **Quizzes**: Handles question banks, quiz attempts, grading, and quiz settings. Supports multiple question types (SOL, SML, MTL, OTL, NAT, DES).
- **Settings**: Manages proctoring and custom settings for users and courses.
- **Users**: Tracks enrollments, progress, watch time, and user-specific data.

## Shared Layer

- **Classes**: Base service classes, utility classes.
- **Constants**: Shared constants for configuration and logic.
- **Database**: MongoDB connection, repositories, and interfaces for CRUD operations.
- **Functions**: Utility functions (OpenAPI spec generation, authorization, current user checker, etc.).
- **Interfaces**: TypeScript interfaces for models, DTOs, and contracts.
- **Middleware**: Express middleware for logging, error handling, etc.

## Utilities

- **env.ts**: Loads environment variables.
- **logDetails.ts**: Prints startup summary and route table.
- **to-bool.ts**: Utility for boolean conversion.

## Scripts

- **generate-openapi.cjs**: Generates OpenAPI spec from codebase.
- **class-transformer-0.5.1.patch.js**: Patch for class-transformer compatibility.
- **start.sh**: Startup script for server.

## Plop Templates

- Used for scaffolding new modules, controllers, services, and repositories.

## Build Output

- All compiled JS files are placed in the `build/` directory. Do not edit these directly.

## Environment Variables

- See `.example.env` for all required variables.
- Sensitive values (DB, Firebase, Sentry, etc.) should be set in `.env`.

## API Reference

- Auto-generated OpenAPI docs available at `/reference` after starting the server.

## Error Handling & Logging

- **Sentry**: Integrated for error tracking in production/staging.
- **Custom Middleware**: Logging of requests, responses, and errors.
- **Startup Summary**: Prints environment, routes, and config on boot.

## Testing

- Uses `vitest` for unit and integration tests.
- Run tests with `pnpm test`.

## Deployment

- Dockerfiles provided for containerized deployment.
- Sentry integration for error monitoring in production/staging.

## Extending

- Add new modules in `src/modules/`
- Register controllers, services, and repositories in the module's `index.ts`
- Use dependency injection via Inversify

## Technologies Used

- TypeScript, Express, MongoDB, InversifyJS, Firebase Admin, Sentry, Scalar, Chalk, Console Table Printer, Routing Controllers, Class Validator/Transformer

## Contributing

- See code comments and module structure for guidance. Use plop templates for scaffolding new controllers, services, and repositories.

---

## Context Providers (YouTube in v1)

The Interactive Learning Experiences (ILE) module accepts educational
content from external sources. v1 ships with **YouTube** as the first
implementation of the generic `ContextProvider` interface. The
provider chains three strategies transparently:

1. **Creator-uploaded captions** — `youtube-transcript` (no API key).
2. **Auto-generated captions** — same library, multi-language loop.
3. **Local Whisper** — `yt-dlp` + `faster-whisper` Python child process.

The teacher never sees which strategy succeeded. The UI surface is
always `Preparing context...` → `Understanding the learning material...`
→ `Generating interactive experience...`. Raw transcripts are never
persisted — only lightweight provenance (`source`, `sourceUrl`,
`title`, `provider`, `transcriptHash`, `createdAt`).

### Optional: install Whisper fallback

The first two strategies need nothing beyond the runtime npm dep
`youtube-transcript` (installed automatically). The third strategy
(Whisper) is **optional** and only activates when both `yt-dlp` and
`faster-whisper` are on `PATH`. Without them, the provider
transparently falls back to captions-only and surfaces a friendly
install hint to the teacher.

**Supported platforms:** macOS, Linux. Windows works if you have
`where` + a Python install; audio-extraction paths may differ.

#### macOS

```bash
brew install yt-dlp ffmpeg           # ffmpeg is required by yt-dlp
python3 -m pip install --user faster-whisper
```

`yt-dlp` lives at `/opt/homebrew/bin/yt-dlp` on Apple Silicon and
`/usr/local/bin/yt-dlp` on Intel Macs. `python3` is the default on
macOS. The strategy resolves `yt-dlp` via `which` and runs
`python3 -c "import faster_whisper"` as the probe — no env config
needed on macOS.

#### Linux

```bash
# Debian / Ubuntu
sudo apt update
sudo apt install -y ffmpeg python3-pip
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
python3 -m pip install --user faster-whisper
```

#### Windows

```powershell
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg
py -m pip install --user faster-whisper
```

The strategy uses `where` on Windows (vs `which` on POSIX). Override
the binary path with `ILE_WHISPER_BIN=python` if needed.

### Environment variables

| Variable | Default | Notes |
|---|---|---|
| `ILE_WHISPER_MODEL` | `small` | One of `tiny`, `base`, `small`, `medium`, `large-v3`. `small` is the quality/speed tradeoff. |
| `ILE_WHISPER_TIMEOUT_MS` | `600000` | Hard cap on transcription time (10 min). |
| `ILE_WHISPER_BIN` | `python3` | Python interpreter. Use `python` on Windows. |
| `ILE_WHISPER_DEVICE` | `cpu` | `cuda` for GPU acceleration. |
| `ILE_WHISPER_COMPUTE_TYPE` | `int8` (cpu) / `float16` (cuda) | Whisper compute type. |
| `ILE_YT_AUTO_LANGS` | `en,en-US,en-GB,es,fr,de` | Comma-separated languages to try for auto captions. |

Binary detection is **cached for the process lifetime**. If you install
missing deps mid-session, restart the backend to pick them up.

### Behavior matrix

| Video state | Result |
|---|---|
| Public video with creator captions | Strategy 1 succeeds. |
| Public video with auto captions only | Strategy 2 succeeds. |
| Public video with no captions | Strategy 3 runs (Whisper). |
| Private video | `ContextProviderError('unsupported')` — friendly message, no fall-through. |
| Region-blocked video | `ContextProviderError('unsupported')`. |
| Age-restricted video | `ContextProviderError('unsupported')`. |
| yt-dlp / faster-whisper missing | Falls back to captions-only with install hint. |
| Network blip | `ContextProviderError('transient')` — UI offers retry. |
| Teacher cancels mid-stream | `ContextProviderError('cancelled')`. Whisper child is killed with SIGTERM, then SIGKILL after 5s. |

### Troubleshooting

**`YouTube captions unavailable and local transcription is not configured`**
Both captions failed AND Whisper isn't installed. Install per the
platform instructions above and restart the backend.

**`Unable to download audio from this video`** — yt-dlp ran but
errored. Check `~/.local/share/yt-dlp` or backend logs for stderr.
Usually a region block or a sign-in requirement; the friendly message
already says what to do.

**Whisper takes a long time on big videos** — Expected for the
default `small` model. Drop to `tiny` for 5–10× speedup at modest
quality cost via `ILE_WHISPER_MODEL=tiny`.

**Whisper outputs nonsense** — Probably language mismatch. Whisper
auto-detects; you can't force a language in v1. If it's a non-English
video, `youtube-transcript` auto-captions usually handles it faster.

**`faster-whisper not importable`** — The Python probe failed. Run
`python3 -c "import faster_whisper"` and fix any pip / venv issues.

### Architecture: adding a new provider

The whole architecture is designed so a future provider (PDF, Course
Item, Audio, OCR, Website, …) is **one file + one line of
registration**. Concretely:

1. Implement `ContextProvider` in
   `src/modules/interactiveExperiences/context/providers/<Name>.ts`.
2. Bind it in `container.ts` next to `YouTubeContextProvider`.
3. Register it in `index.ts`'s `setupInteractiveExperiencesContainer`.

No changes to `IleGenerationService`, the controller, or the
frontend menu's structure — `AddContextMenu.tsx` adds a row when a
new provider ships.

---

For more details, see the codebase and module documentation.
