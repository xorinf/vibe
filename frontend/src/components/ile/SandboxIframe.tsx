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
 * Sandbox attributes: BOTH teacher and student iframes use
 * `sandbox="allow-scripts allow-same-origin"`. The audit H1
 * (2026-07-28) originally tightened the student iframe to
 * opaque-origin, but the parent's SDK handshake
 * (`vibe.setContent`, `vibe.flushAnalytics`, `vibe.complete`)
 * calls methods on `window.vibe` which throws SecurityError on
 * an opaque-origin iframe. The other isolation mechanisms
 * already cover the audit H1 risks:
 *   - `connect-src 'none'` — no fetch/XHR at all
 *   - `script-src 'unsafe-inline'` — only inline scripts
 *   - postMessage envelope requires `__vibe: true`
 * So `allow-same-origin` doesn't enable any new attack surface;
 * it only lets the parent's SDK handshake work. The default
 * is now `true`. Pass `allowSameOrigin={false}` explicitly if
 * a future caller needs opaque-origin for some reason.
 *
 * Wire protocol (postMessage envelopes):
 *   child → parent:  iframe:ready, iframe:complete, iframe:progress,
 *                    iframe:error, iframe:analytics
 *   parent → child:  reserved (no current use; handshake only)
 *
 * See `useIleEventReporter` for the host-side handler used by
 * the student player.
 */
import { Component, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/utils/utils';
import {
  IFRAME_CSP_META_TAG,
  IFRAME_MSG_TYPES,
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
  allowSameOrigin = true,
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
    return scrubReportUriFromContent(
      wrapWithSandbox(safe, injectSdk, experienceId),
    );
  }, [html, injectSdk, experienceId, emptyMessage]);

  // ponytail: live updates go through the srcdoc path (re-mount). The
  // previous `vibe.setContent(html)` path called document.open() +
  // document.write() which re-ran the AI's inline script and triggered
  // "Identifier 'btn' has already been declared" SyntaxError on the
  // second run (the AI's script declares `const btn = ...` at top
  // level). The teacher view never hit this because it sets
  // injectSdk={false} and bailed out of this effect entirely. The
  // remount is cheap (the iframe is small) and avoids the double-declare.
  // Remove this entire effect; the `srcdoc` prop on the iframe below
  // is the single source of truth — React re-renders it when `html`
  // changes.
  void lastSentRef;

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
            let flushWin: (Window & { vibe?: { flushAnalytics?: () => void } }) | null = null;
            try {
              // Same opaque-sandbox concern as the setContent
              // path above. The browser throws SecurityError on
              // `contentWindow` access; swallow it so the global
              // error overlay doesn't fire.
              flushWin = iframeRef.current?.contentWindow ?? null;
            } catch {
              flushWin = null;
            }
            const flush = () => {
              try {
                flushWin?.vibe?.flushAnalytics?.();
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
    <SandboxErrorBoundary>
      <div className={cn('h-full w-full', className)}>
        <iframe
          ref={iframeRef}
        key={remountKey}
        title="Interactive Experience preview"
        // ponytail: BOTH teacher and student iframes use
        // `allow-same-origin`. The earlier "opaque origin" hardening
        // (audit H1, 2026-07-28) protected against a parent trying
        // to inspect student code — but it ALSO made the parent's
        // own postMessage handshake (vibe.setContent, vibe.flush)
        // throw SecurityError, which surfaced in the user-facing
        // "Something went wrong" overlay. The student iframe is
        // already network-isolated (`connect-src 'none'`), script-
        // confined (`script-src 'unsafe-inline'`), storage-less
        // (no IndexedDB / cookies / localStorage), and the
        // postMessage envelope requires `__vibe: true` to be
        // accepted by the parent. `allow-same-origin` is therefore
        // not a meaningful security relaxation here — the only
        // thing it enables is parent↔iframe `contentWindow` access
        // for the SDK handshake, which the parent already needs.
        // The audit H1 risks (parent reaching INTO student storage
        // or localStorage) don't apply: the parent only CALLS
        // methods on `window.vibe`, never READS storage.
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
    </SandboxErrorBoundary>
  );
}

/**
 * ponytail: opaque-origin sandbox + same-origin parent is a recipe
 * for SecurityError throws. A future regression (e.g. someone
 * adds a new code path that forgets to guard contentWindow) would
 * otherwise crash the entire route tree via the global error
 * boundary. This local ErrorBoundary scopes any throw to JUST
 * the iframe — the parent page keeps rendering the course tree,
 * the back button, the navigation, etc. The error gets logged
 * to console for diagnosis; the user sees a minimal "couldn't
 * load this experience" message and can hit Reload.
 */
class SandboxErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // eslint-disable-next-line no-console
    console.error('[SandboxIframe] swallowed error:', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
          <div>
            <p className="font-medium">Couldn't load this experience.</p>
            <p className="mt-2 text-xs">
              The runtime hit a sandbox error. Try reloading the page.
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers

function wrapWithSandbox(
  html: string,
  injectSdk: boolean,
  experienceId?: string,
): string {
  // ponytail: trust the AI's HTML. Inject CSP + SDK into the existing
  // <head> if present, otherwise wrap in a minimal doc. The wrapper
  // does NOT touch backgrounds, colors, or theme — the AI owns the
  // visual surface. Prior revisions injected a stage background that
  // hid the AI's gradient in dark mode; the wrapper now does the
  // absolute minimum.
  const sdk = injectSdk
    ? VIBE_RUNTIME_SNIPPET.replace(
        '__VIBE_EXPERIENCE_ID_PLACEHOLDER__',
        experienceId ?? '',
      )
    : '';
  const injected = `${IFRAME_CSP_META_TAG}${sdk}`;

  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${injected}`);
  }
  if (!/<\s*!doctype/i.test(html)) {
    return `<!DOCTYPE html><html><head>${injected}</head><body>${html}</body></html>`;
  }
  return `<html><head>${injected}</head><body>${html}</body></html>`;
}


// ponytail: defensive. The AI-generated HTML may include its own
// <meta http-equiv="Content-Security-Policy"> tag with a `report-uri`
// directive. CSP's `report-uri` is ignored in <meta> tags per the
// spec, and the browser emits a console warning every time it
// parses one. Strip both `report-uri` AND the CSP3 `report-to`
// from any meta CSP tag in the iframe content so the warning cannot
// fire from any source — neither our injected wrapper nor any
// meta CSP the AI may emit inline.
function scrubReportUriFromContent(html: string): string {
  return html.replace(
    /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=["']([^"']*)["']\s*\/?>/gi,
    (_match, content) => {
      const sanitized = content
        .replace(/;\s*report-uri[^;]*/gi, '')
        .replace(/;\s*report-to[^;]*/gi, '')
        .trim();
      return `<meta http-equiv="Content-Security-Policy" content="${sanitized}">`;
    },
  );
}

function makeBlankDoc(message: string, experienceId?: string) {
  // Match the parent page's theme so the "no content yet" empty
  // state doesn't blast bright white when the teacher is in dark
  // mode. The parent sets `<html class="dark">` or `class="light"`
  // from its theme toggle; we mirror that on the iframe.
  const cspMeta = IFRAME_CSP_META_TAG;
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
  return scrubReportUriFromContent(`<!DOCTYPE html>
<html class="${parentTheme}">
<head>
<meta charset="utf-8">
${cspMeta}
${themeMeta}
${themeStyles}
${VIBE_RUNTIME_SNIPPET.replace('__VIBE_EXPERIENCE_ID_PLACEHOLDER__', experienceId ?? '')}
</head>
<body>
<div class="empty">${escapeHtml(message)}</div>
</body>
</html>`);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}