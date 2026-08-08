/**
 * Sandboxed iframe for running ILE HTML.
 *
 * Two modes:
 *   - Teacher preview: `injectSdk={false}`. No runtime SDK is
 *     injected; synthetic teacher clicks don't reach the analytics
 *     endpoint.
 *   - Student player: `injectSdk={true}`. The runtime SDK is
 *     appended to the HTML and reports progress / completion /
 *     analytics events via postMessage.
 *
 * Sandbox attributes: the iframe is created with
 * `sandbox="allow-scripts"`. By default, same-origin is NOT
 * allowed (opaque origin; cannot reach the parent). The teacher
 * preview opts in to same-origin via `sameOrigin` so the
 * generated HTML can call `requestFullscreen()` (the Esc-to-exit
 * fullscreen button). The student player keeps the strict opaque
 * sandbox.
 *
 * Wire protocol (postMessage envelopes):
 *   child → parent:  iframe:ready, iframe:complete, iframe:progress,
 *                    iframe:error, iframe:analytics
 *   parent → child:  reserved (no current use; handshake only)
 *
 * See `useIleEventReporter` for the host-side handler used by
 * the student player.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/utils/utils';
import {
  IFRAME_MSG_TYPES,
  VIBE_IFRAME_CSP,
  VIBE_RUNTIME_SNIPPET,
} from './vibeSdk';

/**
 * The analytics event payload we hand the host. Mirrors the shape of
 * `IleRuntimeEvent` from `ileApi` and `IleAnalyticsEvent` from
 * `useIleEventReporter` so consumers can keep their narrow types.
 */
export interface SandboxAnalyticsEvent {
  kind: string;
  clientTs: number;
  data?: unknown;
}

export interface SandboxIframeProps {
  /**
   * Raw HTML payload from the AI (or from a saved experience). The iframe
   * runs it via srcdoc — no network, no same-origin.
   */
  html: string;
  /**
   * Optional key — bumping it forces the iframe to remount even if the
   * HTML string is identical. Used by the "Reload Preview" affordance.
   */
  remountKey?: number;
  /** Whether to inject the ViBe runtime SDK snippet. */
  injectSdk?: boolean;
  /**
   * Whether to grant `allow-same-origin` on the iframe's sandbox
   * attribute. Defaults to `false` (secure default — opaque origin,
   * no DOM/storage access to the parent). Teacher-side previews can
   * opt in to `true` if they need fullscreen (which the spec only
   * grants to same-origin documents). STUDENT-SIDE callers must
   * leave this `false` — the audit (2026-07-28) caught this component
   * granting same-origin unconditionally on the student path,
   * which defeats the primary sandbox boundary.
   */
  allowSameOrigin?: boolean;
  className?: string;
  /**
   * Stable per-experience id, embedded into the runtime snippet so
   * analytics events can self-identify. Required for the host to POST
   * events to the right server route.
   */
  experienceId?: string;
  /** Fired when the sandboxed page signals progress (percent 0-100). */
  onProgress?: (percent: number) => void;
  /** Fired when the sandboxed page calls `vibe.complete()`. */
  onComplete?: () => void;
  /**
   * Fired on sandboxed-page runtime error (uncaught JS, CSP violation, etc.).
   */
  onError?: (message: string) => void;
  /**
   * Optional handle to the iframe's runtime `vibe.flushAnalytics()`.
   * Called by the host (via the prop function) to force a flush
   * before the iframe is unmounted — used on "Next" navigation
   * so events that haven't hit the 2-second auto-flush window
   * still land on the server.
   */
  onFlushReady?: (flush: () => void) => void;
  /** Fired once when the iframe's `vibe:ready` handshake resolves. */
  onLoaded?: () => void;
  /**
   * Optional message rendered in the placeholder iframe when the
   * `html` prop is empty. The default empty-state copy mentions
   * describing an experience, but a host (e.g. the student player)
   * can override it to render something more contextual like
   * "Loading experience…".
   */
  emptyMessage?: string;
  /**
   * Fired when the sandboxed runtime flushes a batch of analytics
   * events. The host is responsible for POSTing them to the server.
   * Payload is the raw `events` array from the runtime.
   */
  onAnalytics?: (
    experienceId: string,
    events: SandboxAnalyticsEvent[],
  ) => void;
}

/**
 * Sandboxed iframe runtime. Single source of truth for "how do we run
 * teacher-generated HTML". Swappable: replace this file with a different
 * renderer (PixiJS, WebGL, etc.) without touching the rest of ILE.
 */
export function SandboxIframe({
  html,
  remountKey,
  injectSdk = true,
  allowSameOrigin = false,
  className,
  experienceId,
  emptyMessage,
  onProgress,
  onComplete,
  onError,
  onLoaded,
  onAnalytics,
  onFlushReady,
}: SandboxIframeProps) {
  const [loaded, setLoaded] = useState(false);
  // The most recent html we successfully pushed into the iframe.
  // We compare every incoming `html` prop against this to decide
  // whether to call `vibe.setContent` (fast in-place update) or
  // bump the `key` so React remounts the iframe with a fresh srcdoc.
  const lastSentRef = useRef<string>('');
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Fallback: if `onLoad` never fires (e.g. CSP issue, a runtime
  // throw during init that suppresses the native load event, or the
  // SDK handshake is missing for this path), the "Booting…"
  // overlay would stay stuck on top of the rendered iframe
  // content and the user sees a blank card. Force-clear the overlay
  // after 1.5s — well below the 90s stream watchdog in
  // useIleEditor — so the iframe content is always visible
  // regardless of whether the postMessage handshake completed.
  useEffect(() => {
    if (loaded) return;
    const t = setTimeout(() => setLoaded(true), 1500);
    return () => clearTimeout(t);
  }, [loaded, html, remountKey]);

  const srcdoc = useMemo(() => {
    const safe = html ?? '';
    if (!safe.trim()) {
      return makeBlankDoc(
        emptyMessage ??
          'No preview yet — describe what you want on the left.',
        experienceId,
      );
    }
    return wrapWithSandbox(safe, injectSdk, experienceId);
  }, [html, injectSdk, experienceId, emptyMessage]);

  // Live update: when `html` changes AFTER the iframe has booted, prefer
  // the runtime's `vibe.setContent` over a srcdoc remount. This keeps
  // any in-flight runtime state (autoplaying audio, animation frame
  // index, scroll position outside the swapped content) intact.
  //
  // We only do this when the SDK is injected (student-side) and the
  // html is non-empty. For the teacher preview (injectSdk={false})
  // and the blank-state doc, fall through to the srcdoc path.
  useEffect(() => {
    const safe = html ?? '';
    if (!injectSdk) return;
    if (!safe.trim()) return;
    if (!loaded) return;
    if (lastSentRef.current === safe) return;
    const win = iframeRef.current?.contentWindow as (Window & {
      vibe?: { setContent?: (html: string) => void };
    }) | null;
    if (!win || typeof win.vibe?.setContent !== 'function') return;
    try {
      win.vibe.setContent(safe);
      lastSentRef.current = safe;
    } catch (err) {
      // If the runtime threw (e.g. document.write blocked by CSP),
      // fall through to the srcdoc path so the user still sees an
      // update. We deliberately do NOT remount — the iframe is
      // already in a usable state.
      // eslint-disable-next-line no-console
      console.warn('[SandboxIframe] vibe.setContent failed; falling back to srcdoc', err);
    }
  }, [html, loaded, injectSdk]);

  // Listen for postMessage events from the sandboxed iframe.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data as
        | { __vibe?: boolean; type?: string; payload?: any; experienceId?: string }
        | undefined;
      if (!data || !data.__vibe) return;

      switch (data.type) {
        case IFRAME_MSG_TYPES.READY:
          setLoaded(true);
          onLoaded?.();
          // Expose a synchronous flush handle for the host's
          // teardown. The runtime snippet (vibeSdk.ts) defines
          // `vibe.flushAnalytics()` which calls `flush()` here,
          // which posts the current batch of events and clears
          // the queue. The host invokes this from its
          // `stopCurrentItem` (e.g. when the student clicks
          // "Next") so the last 1-2 seconds of interaction events
          // don't sit in the queue when the iframe is unmounted.
          if (onFlushReady) {
            const win = iframeRef.current?.contentWindow as
              | (Window & { vibe?: { flushAnalytics?: () => void } })
              | null;
            const flush = () => {
              try {
                win?.vibe?.flushAnalytics?.();
              } catch {
                // Iframe may already be unmounted; best-effort.
              }
            };
            onFlushReady(flush);
          }
          break;
        case IFRAME_MSG_TYPES.PROGRESS:
          onProgress?.(Number(data.payload?.percent ?? 0));
          break;
        case IFRAME_MSG_TYPES.COMPLETE:
          onComplete?.();
          break;
        case IFRAME_MSG_TYPES.ERROR:
          onError?.(String(data.payload?.message ?? 'Sandbox error'));
          break;
        case IFRAME_MSG_TYPES.ANALYTICS:
          if (onAnalytics && Array.isArray(data.payload?.events)) {
            onAnalytics(
              String(data.experienceId ?? experienceId ?? ''),
              data.payload.events as { kind: string; clientTs: number; data?: unknown }[],
            );
          }
          break;
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onProgress, onComplete, onError, onLoaded, onAnalytics, experienceId]);

  const hasHtml = Boolean(html?.trim());
  const showOverlay = hasHtml && !loaded;

  return (
    <div className={cn('h-full w-full', className)}>
      <iframe
        ref={iframeRef}
        key={remountKey}
        title="Interactive Experience preview"
        // sandbox without allow-same-origin means the iframe gets an opaque
        // origin — parent cannot reach into it via DOM, and it cannot
        // read parent's storage. CSP is the second line of defence.
        // allow-scripts: let the AI's <script> blocks run.
        // The teacher-side preview path opts INTO `allowSameOrigin` so
        // requestFullscreen() works (Esc-to-exit needs same-origin per
        // the spec). The student-side path keeps the strict opaque
        // sandbox — student HTML cannot reach parent storage, DOM, or
        // postMessage back into our app. See the audit H1 (2026-07-28).
        sandbox={
          allowSameOrigin
            ? 'allow-scripts allow-same-origin'
            : 'allow-scripts'
        }
        srcDoc={srcdoc}
        className="h-full min-h-full w-full border-0 bg-background "
        referrerPolicy="no-referrer"
        // The SDK's READY postMessage never fires in the teacher preview
        // (we don't inject the SDK here so we don't pollute student
        // analytics), so fall back to the iframe's native `onload` —
        // it fires once the document has been parsed and rendered.
        // The native onload also gives us a second, reliable signal
        // even if the SDK is later re-enabled for some path.
        onLoad={() => {
          if (!loaded) setLoaded(true);
          onLoaded?.();
        }}
      />
      {showOverlay && (
        // Background kept transparent so the iframe content is always
        // visible even before the boot signal arrives. The pill is the
        // only thing the user actually sees as a transient indicator;
        // it sits over the top-right of the iframe so it doesn't
        // cover the center of the experience. Click events pass
        // through to the iframe via `pointer-events-none`.
        <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-2 rounded-full bg-background/85 px-3 py-1.5 text-xs text-muted-foreground shadow-sm ring-1 ring-ring">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-violet-500" />
          Booting experience…
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Helpers

function wrapWithSandbox(
  html: string,
  injectSdk: boolean,
  experienceId?: string,
): string {
  // The AI is told to emit a full <!DOCTYPE html> document. If it didn't
  // (e.g. partial fragment in early drafts), wrap it so the iframe still
  // parses cleanly.
  let body = html;
  const hasDoctype = /^\s*<!doctype\s+html/i.test(body);
  const hasHtml = /<html[\s>]/i.test(body);

  if (!hasDoctype || !hasHtml) {
    body = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
  }

  // Inject CSP + (optionally) the runtime SDK by rewriting the <head>.
  // If the document doesn't have one, add it.
  // The CSP no longer carries a report-uri placeholder — that
  // directive is ignored in <meta> tags per the CSP spec, and the
  // browser used to spam the console warning on every iframe load.
  const cspPolicy = VIBE_IFRAME_CSP;
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${cspPolicy}">`;

  // Match the parent page's theme so an AI-generated HTML without an
  // explicit dark-mode body background still reads correctly. The
  // parent (teacher-course-page) sets `<html class="dark">` or
  // `<html class="light">` from its theme toggle. We mirror that
  // class on the iframe so child styles that key off `.dark` work.
  // We also set `color-scheme: light dark` so the browser picks
  // the right form-control + scrollbar colors, and a default
  // `background-color` on body that defaults to a dark stage in
  // dark mode (hsl 230 20% 7% = #12131a) and a light stage in
  // light mode (hsl 220 16% 95% = #f0f2f4) — the platform's
  // `--stage` token values. This means an AI-generated white HTML
  // looks at home on either side instead of blasting white in dark.
  const parentTheme =
    typeof document !== 'undefined'
      ? document.documentElement.classList.contains('dark')
        ? 'dark'
        : 'light'
      : 'light';
  const themeMeta = `<meta name="color-scheme" content="light dark">`;
  const stageBg = parentTheme === 'dark' ? 'hsl(230 20% 7%)' : 'hsl(220 16% 95%)';
  const defaultBodyStyle = `<style>html,body{background:${stageBg}}@media (prefers-color-scheme:dark){html:not(.light){background:hsl(230 20% 7%)}}@media (prefers-color-scheme:light){html:not(.dark){background:hsl(220 16% 95%)}}</style>`;

  // Substitute the placeholder with the real experience id (or '' if
  // not bound yet). The empty string is a safe default because the
  // server falls back to the path parameter.
  const sdk = injectSdk
    ? VIBE_RUNTIME_SNIPPET.replace(
        '__VIBE_EXPERIENCE_ID_PLACEHOLDER__',
        experienceId ?? '',
      )
    : '';

  if (/<head[\s>]/i.test(body)) {
    body = body.replace(
      /<head([^>]*)>/i,
      `<head$1>${cspMeta}${themeMeta}${defaultBodyStyle}${sdk}`,
    );
  } else {
    // Insert a head before <html>'s body, or prepend one if no html tag.
    if (/<html[\s>]/i.test(body)) {
      body = body.replace(
        /<html([^>]*)>/i,
        `<html$1 class="${parentTheme}"><head>${cspMeta}${themeMeta}${defaultBodyStyle}${sdk}</head>`,
      );
    } else {
      body = `<head>${cspMeta}${themeMeta}${defaultBodyStyle}${sdk}</head>${body}`;
    }
  }

  return body;
}

function makeBlankDoc(message: string, experienceId?: string) {
  // Match the parent page's theme so the "no content yet" empty
  // state doesn't blast bright white when the teacher is in dark
  // mode. The parent sets `<html class="dark">` or `class="light"`
  // from its theme toggle; we mirror that on the iframe.
  const cspPolicy = VIBE_IFRAME_CSP;
  const parentTheme =
    typeof document !== 'undefined'
      ? document.documentElement.classList.contains('dark')
        ? 'dark'
        : 'light'
      : 'light';
  const themeMeta = `<meta name="color-scheme" content="light dark">`;
  const themeStyles = `<style>
    html, body { margin: 0; padding: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
    html, body { background: ${parentTheme === 'dark' ? 'hsl(230 20% 7%)' : 'hsl(220 16% 95%)'}; color: ${parentTheme === 'dark' ? 'hsl(220 16% 97%)' : 'hsl(230 25% 12%)'}; }
    .empty { display: flex; align-items: center; justify-content: center; height: 100%; font-size: 14px; }
  </style>`;
  return `<!DOCTYPE html>
<html class="${parentTheme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${cspPolicy}">
${themeMeta}
${themeStyles}
${VIBE_RUNTIME_SNIPPET.replace('__VIBE_EXPERIENCE_ID_PLACEHOLDER__', experienceId ?? '')}
</head>
<body>
<div class="empty">${escapeHtml(message)}</div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}