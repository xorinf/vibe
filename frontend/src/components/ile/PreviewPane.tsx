import { useCallback, useEffect, useState } from 'react';
import { Eye, RefreshCw, Maximize2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SandboxIframe } from './SandboxIframe';
import { cn } from '@/utils/utils';
import type { IleStreamState } from './useIleGeneration';

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

  const hasHtml = Boolean(state.html?.trim());
  const showOverlay = state.status === 'streaming';

  // Reset runtime error when a new stream starts (a fresh model output
  // should fix prior errors).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (state.status === 'streaming') setRuntimeError(null);
  }, [state.status === 'streaming' ? 0 : 1, state.status]);

  const reload = useCallback(() => {
    setRuntimeError(null);
    setRemountKey((v) => v + 1);
  }, []);

  const fullscreen = useCallback(() => {
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe[title="Interactive Experience preview"]',
    );
    if (!iframe) return;
    iframe.requestFullscreen?.().catch(() => {
      // Fullscreen denied — silently fall back. The teacher still has the
      // preview in the workspace.
    });
  }, []);

  return (
    <div className={cn('relative flex h-full flex-col bg-slate-100', className)}>
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b bg-white px-4 py-2">
        <div className="flex items-center gap-2 text-xs font-medium text-slate-600">
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
                className="h-7 gap-1 px-2 text-xs text-slate-500 hover:text-slate-900"
                title="Reload preview"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Reload
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={fullscreen}
                className="h-7 gap-1 px-2 text-xs text-slate-500 hover:text-slate-900"
                title="Open in fullscreen"
              >
                <Maximize2 className="h-3.5 w-3.5" />
                Fullscreen
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="relative flex-1 overflow-hidden p-3">
        <div className="relative h-full w-full overflow-hidden rounded-lg border bg-white shadow-sm">
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
            />
          ) : (
            <EmptyPreview />
          )}

          {/* Streaming-progress pill — shows the size of the new artifact
              as it streams in. Sits under the (preserved) preview. */}
          {showOverlay && (
            <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-2 rounded-full bg-white/95 px-3 py-1.5 text-xs text-slate-700 shadow-sm ring-1 ring-slate-200">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-violet-500" />
              {state.reasoning ? 'Thinking…' : 'Editing…'}
              <span className="text-slate-400">
                {(state.html.length / 1024).toFixed(1)} KB
              </span>
            </div>
          )}

          {/* Soft dim overlay while streaming so the user can still see
              the previous artifact behind the incoming changes. */}
          {showOverlay && state.html && (
            <div className="pointer-events-none absolute inset-0 rounded-lg bg-white/15" />
          )}

          {/* Runtime error banner (uncaught JS in the sandbox) */}
          {runtimeError && (
            <div className="absolute left-3 right-3 top-3 flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 shadow-sm">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="flex-1 space-y-1">
                <p className="font-medium">Sandbox runtime error</p>
                <p className="font-mono text-[11px] text-rose-700">{runtimeError}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={reload}
                className="h-6 border-rose-200 px-2 text-[11px] text-rose-700 hover:bg-rose-100"
              >
                Reload
              </Button>
            </div>
          )}
        </div>
      </div>
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
  return <span className="text-[11px] text-slate-400">{label}</span>;
}

function EmptyPreview() {
  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-slate-50 to-white px-6 text-center">
      <div className="max-w-sm space-y-3">
        <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-violet-100 text-violet-600">
          <Eye className="h-5 w-5" />
        </div>
        <p className="text-base font-medium text-slate-900">
          Your experience will appear here
        </p>
        <p className="text-sm text-slate-500">
          Describe the lesson on the left. The AI will stream an interactive
          HTML experience into this preview as it generates.
        </p>
        <p className="text-xs text-slate-400">
          Try: <em>"Explain binary search with a step-through visualization"</em>
        </p>
      </div>
    </div>
  );
}