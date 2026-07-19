import { useEffect, useMemo, useState } from 'react';
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

  const srcdoc = useMemo(() => {
    const safe = html ?? '';
    if (!safe.trim()) {
      return makeBlankDoc('No preview yet — describe what you want on the left.', experienceId);
    }
    return wrapWithSandbox(safe, injectSdk, experienceId);
  }, [html, injectSdk, experienceId]);

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
    <div className={className}>
      <iframe
        key={remountKey}
        title="Interactive Experience preview"
        // sandbox without allow-same-origin means the iframe gets an opaque
        // origin — parent cannot reach into it via DOM, and it cannot
        // read parent's storage. CSP is the second line of defence.
        sandbox="allow-scripts"
        srcDoc={srcdoc}
        className="h-full w-full border-0 bg-white"
        referrerPolicy="no-referrer"
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
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${VIBE_IFRAME_CSP}">`;
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
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${VIBE_IFRAME_CSP}">
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