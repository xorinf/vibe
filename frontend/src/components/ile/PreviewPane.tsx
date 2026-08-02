/**
 * The preview side of the editor split.
 *
 * Wraps `SandboxIframe` with:
 *   - Header (status, reload, fullscreen toggle, error banner)
 *   - A `StreamStatus` chip that mirrors `state.stream.status`
 *   - An `EmptyState` that explains the workspace is "not yet
 *     generated" when the experience has no html yet
 *
 * The iframe is rendered WITHOUT the runtime SDK
 * (`injectSdk={false}`) for teacher-side previews — synthetic
 * teacher clicks should never reach the analytics ingest endpoint.
 * Student-side previews (StudentILEWorkspace) pass `injectSdk` so
 * the runtime hands back progress / complete events to the
 * analytics flusher.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, RefreshCw, Maximize2, Minimize2, X, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SandboxIframe } from './SandboxIframe';
import { cn } from '@/utils/utils';
import type { IleStreamState } from './ileStreamState';

export interface PreviewPaneProps {
  state: IleStreamState;
  className?: string;
}

/**
 * Center pane — the live sandboxed preview.
 *
 * Shows one of three states:
 *  - Empty (no HTML yet) — friendly prompt with examples.
 *  - Streaming — overlay with progress indicator; the iframe still renders
 *    whatever HTML has arrived so far.
 *  - Done — preview ready, with Reload and Fullscreen affordances.
 *
 * Runtime errors from the sandboxed iframe are surfaced here (instead of
 * silently failing) so the teacher can see what went wrong.
 */
export function PreviewPane({ state, className }: PreviewPaneProps) {
  const [remountKey, setRemountKey] = useState(0);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const fullscreenRef = useRef<HTMLDivElement | null>(null);

  const hasHtml = Boolean(state.html?.trim());
  const showOverlay = state.status === 'streaming';

  // Reset runtime error when a new stream starts (a fresh model output
  // should fix prior errors).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (state.status === 'streaming') setRuntimeError(null);
  }, [state.status === 'streaming' ? 0 : 1, state.status]);

  // Track whether the preview is currently in fullscreen so we can
  // render an in-frame Exit button. The fullscreenchange event fires
  // on the document whenever ANY element enters or leaves fullscreen
  // — we filter to our own container so other fullscreen surfaces
  // (the chat AI settings dialog, the code editor) don't confuse us.
  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(
        document.fullscreenElement === fullscreenRef.current,
      );
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, []);

  const reload = useCallback(() => {
    setRuntimeError(null);
    setRemountKey((v) => v + 1);
  }, []);

  // Fullscreen the entire preview container (not just the iframe)
  // so the floating Exit button at the top-right stays visible while
  // in fullscreen. Esc still works natively as a backup.
  const enterFullscreen = useCallback(() => {
    const el = fullscreenRef.current;
    if (!el) return;
    el.requestFullscreen?.().catch(() => {
      // Fullscreen denied — silently fall back. The teacher still has
      // the preview in the workspace.
    });
  }, []);

  const exitFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {
        // Already exited or denied — nothing to do.
      });
    }
  }, []);

  return (
    <div className={cn('relative flex h-full flex-col bg-muted ', className)}>
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b bg-background  px-4 py-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground ">
          <Eye className="h-3.5 w-3.5" />
          Live preview
        </div>
        <div className="flex items-center gap-2">
          <StatusLabel state={state} />
          {hasHtml && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={reload}
                className="h-7 gap-1 px-2 text-xs text-muted-foreground  hover:text-accent-foreground"
                title="Reload preview"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Reload
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={enterFullscreen}
                className="h-7 gap-1 px-2 text-xs text-muted-foreground  hover:text-accent-foreground"
                title="Open in fullscreen"
              >
                <Maximize2 className="h-3.5 w-3.5" />
                Fullscreen
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Body — fullscreenRef is what we put into fullscreen so the
          floating Exit button (rendered while fullscreen is true)
          stays visible inside the fullscreen viewport. The wrapper
          uses bg-muted/50 (a near-invisible slate wash in light mode,
          a barely-there panel in dark) so the preview's white card
          reads as a distinct surface — same role the original
          bg-slate-900/5 was filling, but theme-aware. */}
      <div
        ref={fullscreenRef}
        className="relative flex-1 overflow-hidden bg-muted/50"
      >
        <div className="h-full w-full p-3">
          <div className="relative h-full w-full overflow-hidden rounded-lg border bg-background shadow-sm">
            {hasHtml ? (
              // Teacher-side preview: do NOT inject the runtime SDK. This
              // preview is for inspecting generated HTML, not for analytics
              // — any vibe.interact() / vibe.progress() calls here would
              // pollute student metrics (or, worse, fire from a teacher
              // session). experienceId is undefined explicitly so the
              // payload can't accidentally be attributed to a real id.
              <SandboxIframe
                html={state.html}
                remountKey={remountKey}
                injectSdk={false}
                experienceId={undefined}
                onError={(msg) => setRuntimeError(msg)}
                // Teacher-side preview pane opts into same-origin so the
                // generated HTML can use requestFullscreen(). Student
                // paths leave the strict opaque sandbox.
                allowSameOrigin
              />
            ) : (
              <EmptyPreview />
            )}

            {/* Streaming-progress pill — shows the size of the new artifact
                as it streams in. Sits under the (preserved) preview. */}
            {showOverlay && (
              <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-2 rounded-full bg-background px-3 py-1.5 text-xs text-foreground/80 shadow-sm ring-1 ring-ring">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-ai" />
                {state.reasoning ? 'Thinking…' : 'Editing…'}
                <span className="text-muted-foreground/80">
                  {(state.html.length / 1024).toFixed(1)} KB
                </span>
              </div>
            )}

            {/* Soft dim overlay while streaming so the user can still see
                the previous artifact behind the incoming changes. */}
            {showOverlay && state.html && (
              <div className="pointer-events-none absolute inset-0 rounded-lg bg-background" />
            )}

            {/* Fullscreen Exit button — only shown while the preview
                container is the active fullscreen element. Esc still
                works natively as a backup, but in-app fullscreen hides
                the workspace toolbar, so the user needs an in-frame
                affordance to come back. */}
            {isFullscreen && (
              <button
                type="button"
                onClick={exitFullscreen}
                className="absolute right-4 top-4 z-50 inline-flex items-center gap-1.5 rounded-full bg-overlay px-3.5 py-2 text-xs font-medium text-overlay-foreground shadow-lg ring-1 ring-overlay-border backdrop-blur transition-colors hover:bg-overlay-strong"
                title="Back to workspace (Esc)"
              >
                <X className="h-3.5 w-3.5" />
                Back to workspace
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Runtime error banner (uncaught JS in the sandbox).
          Pair: light destructive wash + destructive text — same
          convention as EmptyState.tsx and AuthPage.tsx. The
          destructive foreground is reserved for solid destructive
          surfaces (button/badge) where a near-white text is correct;
          on a wash, use the destructive tone directly. */}
      {runtimeError && (
        <div className="absolute left-3 right-3 top-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/15 px-3 py-2 text-xs text-destructive shadow-sm">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="flex-1 space-y-1">
            <p className="font-medium">Sandbox runtime error</p>
            <p className="font-mono text-[11px] text-destructive ">{runtimeError}</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={reload}
            className="h-6 border-destructive/30  px-2 text-[11px] text-destructive  hover:bg-destructive/20"
          >
            Reload
          </Button>
        </div>
      )}
    </div>
  );
}

function StatusLabel({ state }: { state: IleStreamState }) {
  const label =
    state.status === 'streaming'
      ? state.reasoning
        ? 'Thinking…'
        : 'Streaming…'
      : state.status === 'done'
      ? 'Up to date'
      : state.status === 'error'
      ? 'Error'
      : 'Idle';
  return <span className="text-[11px] text-muted-foreground/80">{label}</span>;
}

function EmptyPreview() {
  // The empty state sits on top of the preview card (`bg-card`).
  // The original gradient (`from-slate-50 to-white`) was light-only
  // — in dark mode it would bleach the surface. `from-muted to-card`
  // gives the same gentle wash (a hair lighter than card) and
  // respects the active theme so the preview's "empty" state reads
  // as a soft panel in both modes.
  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-muted to-card px-6 text-center">
      <div className="max-w-sm space-y-3">
        <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-ai/40 text-primary/90">
          <Eye className="h-5 w-5" />
        </div>
        <p className="text-base font-medium text-foreground">
          Your experience will appear here
        </p>
        <p className="text-sm text-muted-foreground">
          Describe the lesson on the left. The AI will stream an interactive
          HTML experience into this preview as it generates.
        </p>
        <p className="text-xs text-muted-foreground/80">
          Try: <em>"Explain binary search with a step-through visualization"</em>
        </p>
      </div>
    </div>
  );
}