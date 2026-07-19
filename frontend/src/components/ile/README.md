# Interactive Learning Experiences (ILE) — Frontend

React component tree for the teacher workspace, student player, and shared
chrome (asset manager, AI config, analytics panel, history panel, etc.).

## Folder layout (this directory)

```
ile/
├── TeacherILEWorkspace.tsx       # 3-pane workspace (chat, preview, metadata)
├── StudentILEWorkspace.tsx       # Fullscreen player + analytics reporter
├── ExperienceList.tsx            # Library view of all drafts/published
├── PreviewPane.tsx                # Center pane — live sandboxed preview
├── ChatPane.tsx                   # Left pane — chat + quick actions + composer
├── MetadataPane.tsx               # Right pane — title + save/publish controls
├── SandboxIframe.tsx              # srcdoc + sandbox + CSP + postMessage host
├── AnalyticsPanel.tsx             # Per-experience teacher dashboard
├── HistoryPanel.tsx               # Version snapshots (newest first)
├── ActionsMenu.tsx                # Rename / Duplicate / Archive / Delete
├── AiConfigPanel.tsx              # Provider + API key + model form
├── AssetManager.tsx               # Upload + search + filter library
├── AssetAttachments.tsx            # Inline chips for assets riding on next msg
├── vibeSdk.ts                     # iframe runtime SDK (string template)
├── ileApi.ts                      # REST + SSE + event-type contracts
├── useIleGeneration.ts            # Transport hook (SSE consumer)
├── useIleEditor.ts                 # Editor hook (chat + undo + assets)
├── useIleEventReporter.ts          # postMessage analytics flusher
├── quickActions.ts                # Quick-action chip registry + label maps
└── index.ts                       # Re-exports
```

## Wire protocols

### postMessage (iframe ↔ host)

Direction is always explicit:

- `iframe:*` (child → parent): `iframe:ready`, `iframe:complete`,
  `iframe:progress`, `iframe:error`, `iframe:analytics`.
- `host:*` (parent → child): reserved for future use; today only
  `host:handshake` exists.

Envelope:

```js
{ __vibe: true, version: '1', type: 'iframe:analytics', experienceId: '...',
  payload: { events: [{ kind, clientTs, data }, ...] } }
```

The runtime SDK buffers analytics events in memory and flushes them every
2s (or on `visibilitychange`/`pagehide`) via `iframe:analytics`. The host
(`useIleEventReporter`) listens for these and POSTs them to
`POST /api/interactive-experiences/:id/events` with the student's Firebase
token from `localStorage`.

### SSE (teacher → AI)

Same shape as backend README. The hook (`useIleGeneration`) consumes the
stream and exposes a single state object. The editor hook (`useIleEditor`)
adds the chat history, undo/redo, and asset-attach concerns on top.

## Security model

- The student's identity is never sent to the analytics ingest endpoint
  as PII — only a per-experience salted hash. See
  `useIleEventReporter.ts` for the construction and backend
  `IleAnalyticsService.hashStudent()` for the server side.
- The sandboxed iframe runtime uses `sandbox="allow-scripts"` WITHOUT
  `allow-same-origin`, so the iframe gets an opaque origin and cannot
  reach back into the parent. CSP further restricts what runs inside.
- API keys are masked on read and never returned in full. See
  `IleAiConfigService.maskKey()`.

## Keyboard shortcuts

| Shortcut                       | Context                | Action                  |
|--------------------------------|------------------------|-------------------------|
| ⌘/Ctrl+Enter                   | Chat composer         | Submit edit             |
| Esc                            | Composer (streaming)  | Cancel in-flight edit   |
| Esc                            | Followup prompt       | Cancel followup         |
| ⌘/Ctrl+S                       | Workspace chrome       | Save draft              |
| Esc                            | Student workspace     | (browser-native; exit uses confirm) |

## Local development notes

- The workspace lives at `/teacher/ile/:experienceId?itemId=...&courseVersionId=...`.
- The student player is fullscreen at `/student/ile/:id`.
- The teacher preview iframe is built WITHOUT the runtime SDK (`injectSdk={false}`)
  so synthetic teacher clicks never reach the analytics ingest endpoint.
