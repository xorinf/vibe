# Interactive Learning Experiences (ILE) — Backend

Module that owns the "Interactive Learning Experience" feature end-to-end:
AI-driven HTML generation, versioned publishing, sandboxed runtime delivery,
per-student analytics with salted hash identity.

## Folder layout

```
interactiveExperiences/
├── controllers/IleController.ts          # HTTP surface (routing-controllers)
├── services/
│   ├── IleService.ts                     # Save/versioning/publish/duplicate
│   ├── IleGenerationService.ts           # SSE generation/edit streams
│   ├── IleSseService.ts                   # SSE writer (heartbeats, cleanup)
│   ├── IleAnalyticsService.ts             # Cohort summary + dashboard rollup
│   ├── IleAiConfigService.ts              # Per-owner provider config
│   ├── IleAssetService.ts                 # Upload/list/sign/delete orchestration
│   ├── IleAssetStorageService.ts          # GCS wrapper
│   └── providers/
│       ├── anthropicProvider.ts           # Anthropic streaming (claude-sonnet-X)
│       ├── openaiCompatibleProvider.ts     # OpenAI/MiniMax/openrouter/custom
│       ├── index.ts                       # createProvider factory
│       └── types.ts                       # ChatStream, ChatStreamRequest, errors
├── repositories/
│   ├── IleRepository.ts                  # interactive_experiences collection
│   ├── IleStudentProgressRepository.ts   # ile_student_progress
│   ├── IleAssetRepository.ts              # ile_assets
│   └── IleAiConfigRepository.ts           # ile_ai_configs
├── classes/
│   ├── transformers/                     # Plain class models (IleExperience, …)
│   └── validators/                       # class-validator DTOs
├── types.ts                               # inversify symbols
├── container.ts                           # inversify wiring
└── index.ts                               # Controller/validator exports for bootstrap
```

## Wire protocols

### SSE (generate + edit)

```
event: start        data: { experienceId }
event: progress     data: { message }
event: reasoning    data: {}
event: html         data: { delta }
event: done         data: { experienceId, html, truncated? }
event: error        data: { message }
```

`truncated` is `true` only when the provider cut the response at `max_tokens`.
Teachers see a one-shot toast in the workspace when it fires.

### Provider stream chunk shape (internal)

```ts
type StreamChunk =
  | { kind: 'text'; delta: string }
  | { kind: 'reasoning'; delta: string }
  | { kind: '_stream_meta'; truncated?: boolean };
```

The `_stream_meta` sentinel is yielded EXACTLY ONCE at end-of-stream and is
filtered out before any SSE emit.

## Auth

The controller class is annotated `@Authorized()`. The module's
`authorizationChecker` returns `true` for every request, matching the rest of
the platform (which centralises auth in a middleware). The public student
analytics endpoint (`POST /:id/events`) intentionally bypasses
`CurrentUser` and instead reads the Firebase token from the
`X-Vibe-Student-Token` header so the sandboxed iframe can ingest events
without a session.

## Analytics

- Students are identified by `sha256(salt + experienceId + rawToken)` —
  never persisted, never sent back to the client. The teacher only sees
  the hash.
- Events (`started`, `progress`, `interaction`, `retry`, `error`,
  `complete`, `resume`) are buffered in the iframe runtime and flushed
  every ~2 seconds via postMessage. The host POSTs them to
  `POST /:id/events`.
- Resume events are server-augmented with a derived "where they were"
  snapshot (lastPercent + lastInteractionLabel) before persistence so
  teachers see a self-contained payload.
- The dashboard exposes `difficultyScore`, `errorRate`,
  `averageEngagementPerMinute`, and a top-5 `mostDifficult` leaderboard.

## Storage

IleRepository for collections:

| Collection                   | Document shape                       |
|------------------------------|--------------------------------------|
| `interactive_experiences`    | `IleExperience` (versioned)          |
| `ile_student_progress`       | `IleStudentProgress` (per (student,experience)) |
| `ile_assets`                 | `IleAsset` (per-owner library)        |
| `ile_ai_configs`             | `IleAiConfig` (per-owner provider config; ONE row per teacher) |

IleAssetStorageService keeps the bytes in GCS under
`{ownerId}/{kind}/{assetId}.{ext}`. The Mongo row is the metadata;
the actual URL is regenerated on demand via a 1-hour signed URL.

## Security TODOs (intentional, deferred)

- `IleAiConfigRepository` stores API keys **plaintext**. Acceptable for
  local-dev single-tenant deployments; **must** be replaced with at-rest
  encryption (KMS / envelope encryption) before any production rollout.
  The repo file has an explicit TODO marker.
- The provider's `stream` method relies on the abort controller; the
  Anthropic SDK's bundled error events are not directly captured — if a
  provider SDK version changes its event envelope the `_stream_meta`
  truncation detection may need updating.

## Local development

1. The ILE module has no separate env vars — it uses the platform's GCS
   config (`storageConfig.googleCloud.ileAssetsBucketName`) and Mongo.
2. Each teacher must call `PUT /api/interactive-experiences/config` once
   with their provider + key before generating their first experience.
3. The runtime SDK in `frontend/src/components/ile/vibeSdk.ts` is a
   sandboxed iframe snippet — it's a string template injected into the
   srcdoc, not a separately-imported JS module.
