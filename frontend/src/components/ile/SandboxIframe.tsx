import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/utils/utils';
import {
  IFRAME_MSG_TYPES,
  VIBE_IFRAME_CSP,
  VIBE_RUNTIME_SNIPPET,
} from './vibeSdk';

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
  /** Fired once when the iframe's `vibe:ready` handshake resolves. */
  onLoaded?: () => void;
  /**
   * Fired when the sandboxed runtime flushes a batch of analytics
   * events. The host is responsible for POSTing them to the server.
   * Payload is the raw `events` array from the runtime.
   */
  onAnalytics?: (
    experienceId: string,
    events: { kind: string; clientTs: number; data?: unknown }[],
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
  className,
  experienceId,
  onProgress,
  onComplete,
  onError,
  onLoaded,
  onAnalytics,
}: SandboxIframeProps) {
  const [loaded, setLoaded] = useState(false);
  // The most recent html we successfully pushed into the iframe.
  // We compare every incoming `html` prop against this to decide
  // whether to call `vibe.setContent` (fast in-place update) or
  // bump the `key` so React remounts the iframe with a fresh srcdoc.
  const lastSentRef = useRef<string>('');
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const srcdoc = useMemo(() => {
    const safe = html ?? '';
    if (!safe.trim()) {
      return makeBlankDoc('No preview yet — describe what you want on the left.', experienceId);
    }
    return wrapWithSandbox(safe, injectSdk, experienceId);
  }, [html, injectSdk, experienceId]);

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
        // allow-same-origin: needed for the teacher's own preview so
        // requestFullscreen() works (the spec only grants fullscreen
        // from a same-origin document, and we want Esc-to-exit to work).
        // The teacher-side preview is non-sensitive (it shows the
        // teacher's own generated HTML); the student-side path keeps
        // the strict sandbox.
        sandbox="allow-scripts allow-same-origin"
        srcDoc={srcdoc}
        className="h-full min-h-full w-full border-0 bg-white"
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
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/40 backdrop-blur-[1px]">
          <div className="flex items-center gap-2 rounded-full bg-white px-3 py-1.5 text-xs text-slate-500 shadow-sm ring-1 ring-slate-200">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-violet-500" />
            Booting experience…
          </div>
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
  //
  // The CSP contains a `__VIBE_CSP_REPORT_URI__` placeholder that we
  // substitute here so the runtime knows where to POST violation
  // reports. We default to `/api/interactive-experiences/csp-report`
  // (relative to the parent's origin); deployment can override by
  // setting `VITE_ILE_CSP_REPORT_URI` at build time.
  const cspReportUri =
    (import.meta.env.VITE_ILE_CSP_REPORT_URI as string | undefined) ??
    '/api/interactive-experiences/csp-report';
  const cspPolicy = VIBE_IFRAME_CSP.replace('__VIBE_CSP_REPORT_URI__', cspReportUri);
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${cspPolicy}">`;
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
      `<head$1>${cspMeta}${sdk}`,
    );
  } else {
    // Insert a head before <html>'s body, or prepend one if no html tag.
    if (/<html[\s>]/i.test(body)) {
      body = body.replace(
        /<html([^>]*)>/i,
        `<html$1><head>${cspMeta}${sdk}</head>`,
      );
    } else {
      body = `<head>${cspMeta}${sdk}</head>${body}`;
    }
  }

  return body;
}

function makeBlankDoc(message: string, experienceId?: string) {
  // Mirror the CSP report-uri substitution used in the main path so
  // the blank-state iframe also reports violations to the right URL.
  const cspReportUri =
    (import.meta.env.VITE_ILE_CSP_REPORT_URI as string | undefined) ??
    '/api/interactive-experiences/csp-report';
  const cspPolicy = VIBE_IFRAME_CSP.replace('__VIBE_CSP_REPORT_URI__', cspReportUri);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${cspPolicy}">
<style>
  html, body { margin: 0; padding: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
  .empty { display: flex; align-items: center; justify-content: center; height: 100%;
           color: #94a3b8; font-size: 14px; background: #f8fafc; }
</style>
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