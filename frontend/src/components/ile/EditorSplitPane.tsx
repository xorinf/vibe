import { useRef, useState, Component, type ReactNode, type Ref } from 'react';
import { Code } from 'lucide-react';
import { cn } from '@/utils/utils';
import { CodeEditor, type CodeEditorHandle } from './CodeEditor';
import { PreviewPane } from './PreviewPane';
import type { IleStreamState } from './useIleGeneration';
import { EditorToolbar, type ViewMode } from './EditorToolbar';
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from 'react-resizable-panels';

export type { ViewMode };

/**
 * ErrorBoundary for the CodeMirror editor. The HTML syntax-highlighting
 * parser occasionally throws "Cannot read properties of undefined
 * (reading 'length')" mid-stream when the AI is emitting partial
 * tags — without this boundary the crash takes down the entire
 * ILE workspace (the global router error boundary is too coarse
 * for this and the user loses chat + preview along with the
 * editor). The boundary swaps the editor for a plain <pre> of
 * the same code so the workspace keeps functioning.
 *
 * Recovery: the boundary accepts a `streamStatus` prop and uses it
 * as part of its React key. When the stream transitions from
 * 'streaming' to 'done', the key changes and React unmounts the
 * stale boundary subtree (including its captured error state) and
 * remounts a fresh one — CodeMirror comes back for the next edit
 * instead of staying on the plain-<textarea> fallback for the
 * rest of the session.
 */
function CodeEditorErrorBoundary({
  children,
  fallback,
  streamStatus,
}: {
  children: ReactNode;
  fallback: ReactNode;
  streamStatus: string;
}) {
  return (
    <ErrorBoundaryImpl fallback={fallback} key={`editor-${streamStatus}`}>
      {children}
    </ErrorBoundaryImpl>
  );
}

class ErrorBoundaryImpl extends Component<
  {
    children: ReactNode;
    fallback: ReactNode;
  },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.warn('[ILE] CodeEditor crashed, falling back to <textarea>:', error);
  }
  render() {
    if (this.state.error) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

export interface EditorSplitPaneProps {
  /**
   * Imperative handle to the CodeMirror editor — populated here so the
   * workspace can call `setValue` on AI stream completion.
   */
  editorHandleRef: Ref<CodeEditorHandle>;
  /** Live stream state from useIleGeneration. */
  streamState: IleStreamState;
  /**
   * The HTML the preview should render. Already resolved by the
   * workspace: manual edits > stream > initial > saved.
   */
  effectiveHtml: string;
  /** True while the AI is streaming. The code editor goes read-only. */
  isStreaming: boolean;
  viewMode: ViewMode;
  onViewModeChange: (m: ViewMode) => void;
  wordWrap: boolean;
  onWordWrapChange: (w: boolean) => void;
  /**
   * Fired on every CodeMirror change. The workspace turns this into
   * the `manualHtml` state and pushes it into the AI's head so the
   * next edit starts from the right base.
   */
  onCodeChange: (next: string) => void;
  /** Optional className passthrough for the outer flex container. */
  className?: string;

  /**
   * When the view mode is `split`, the % of the canvas height the
   * editor occupies. Defaults to 58 (matches the workspace default).
   * The split ratio is persisted via `splitAutoSaveId` when set.
   */
  splitRatio?: number;
  onSplitRatioChange?: (n: number) => void;
  /** Storage key for the resizable split ratio. */
  splitAutoSaveId?: string;
}

const RESIZE_HANDLE_H_CLASS =
  'group relative flex h-1 shrink-0 items-center justify-center bg-slate-200 transition-colors hover:bg-primary data-[resize-handle-state=drag]:bg-primary data-[resize-handle-state=hover]:bg-primary/60 cursor-row-resize';

/**
 * The central authoring surface. Three-way view-mode toggle (Code /
 * Split / Preview), a code editor on the left, the live iframe on
 * the right, and a shared toolbar that exposes find, format, undo,
 * redo, and word-wrap.
 *
 * State strategy: the parent owns the HTML (via `effectiveHtml`).
 * The editor's content is initialized from `effectiveHtml` on first
 * render and kept in sync via `onChange` + the imperative
 * `setValue` handle. The preview reads `effectiveHtml` directly so
 * it never gets a stale frame when the AI is streaming.
 *
 * Split mode uses `react-resizable-panels` so the teacher can drag the
 * divider; the ratio is persisted via `splitAutoSaveId` when set.
 * Code and preview modes use a CSS grid.
 */
export function EditorSplitPane({
  editorHandleRef,
  streamState,
  effectiveHtml,
  isStreaming,
  viewMode,
  onViewModeChange,
  wordWrap,
  onWordWrapChange,
  onCodeChange,
  className,
  splitRatio = 58,
  onSplitRatioChange,
  splitAutoSaveId,
}: EditorSplitPaneProps) {
  // We use a local ref mirror of the imperative editor so the Find
  // button can call `openSearch` without the parent having to
  // re-render. The parent keeps the `editorHandleRef` in sync.
  const localHandleRef = useRef<CodeEditorHandle | null>(null);
  const editorRef = useRef<CodeEditorHandle | null>(null);
  // Mount the resizable panel group only once — `react-resizable-panels`
  // re-uses its persistence across re-renders, but re-mounting on every
  // view-mode tick would lose the user's drag.
  const [resizableMounted] = useState(true);

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-slate-50', className)}>
      <EditorToolbar
        viewMode={viewMode}
        onViewModeChange={onViewModeChange}
        wordWrap={wordWrap}
        onWordWrapChange={onWordWrapChange}
        onOpenSearch={() => localHandleRef.current?.openSearch()}
        onFormat={() => localHandleRef.current?.format()}
        isEditorReady={Boolean(editorRef.current)}
      />

      {/* Body — split mode uses a drag-resizable panel group; the
          other modes use a CSS grid. The split path is mounted only
          once so its persistence survives toolbar re-renders. */}
      {viewMode === 'split' && resizableMounted ? (
        <PanelGroup
          direction="vertical"
          autoSaveId={splitAutoSaveId}
          onLayout={(sizes: number[]) => {
            const first = sizes[0];
            if (typeof first === 'number' && first > 1 && first < 99) {
              onSplitRatioChange?.(first);
            }
          }}
          className="min-h-0 flex-1"
        >
          <Panel id="code" order={1} defaultSize={splitRatio} minSize={20}>
            <div className="flex h-full min-h-0 flex-col bg-white dark:bg-slate-900">
              <SourceSubHeader isStreaming={isStreaming} />
              <div className="min-h-0 flex-1">
                <CodeEditorErrorBoundary
                  streamStatus={streamState.status}
                  fallback={
                    <textarea
                      value={effectiveHtml}
                      onChange={(e) => onCodeChange(e.target.value)}
                      readOnly={isStreaming}
                      spellCheck={false}
                      className="h-full w-full resize-none border-0 bg-slate-50 dark:bg-slate-900/60 p-3 font-mono text-xs text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-slate-300"
                      aria-label="Experience HTML source (fallback)"
                      title="CodeMirror crashed — edit here until reload"
                    />
                  }
                >
                  <CodeEditor
                    value={effectiveHtml}
                    onChange={onCodeChange}
                    wordWrap={wordWrap}
                    readOnly={isStreaming}
                    handleRef={(handle) => {
                      localHandleRef.current = handle;
                      editorRef.current = handle;
                      if (typeof editorHandleRef === 'function') {
                        editorHandleRef(handle);
                      } else if (editorHandleRef) {
                        (editorHandleRef as { current: CodeEditorHandle | null }).current =
                          handle;
                      }
                    }}
                    className="h-full w-full overflow-auto"
                    aria-label="Experience HTML source"
                  />
                </CodeEditorErrorBoundary>
              </div>
            </div>
          </Panel>
          <PanelResizeHandle className={RESIZE_HANDLE_H_CLASS}>
            <span className="sr-only">Resize code / preview</span>
          </PanelResizeHandle>
          <Panel id="preview" order={2} defaultSize={100 - splitRatio} minSize={20}>
            <PreviewPane
              state={
                streamState.status !== 'idle' || effectiveHtml
                  ? { ...streamState, html: effectiveHtml }
                  : { ...streamState, html: '' }
              }
            />
          </Panel>
        </PanelGroup>
      ) : (
        <div className="grid min-h-0 flex-1 overflow-hidden">
          {/* Code editor column — visible in 'code' and 'split'. */}
          {(viewMode === 'code' || viewMode === 'split') && (
            <div
              className={cn(
                'flex h-full min-h-0 flex-col border-r border-slate-200 bg-white',
                viewMode === 'split' ? 'w-1/2' : 'w-full',
              )}
            >
              <SourceSubHeader isStreaming={isStreaming} />
              <div className="min-h-0 flex-1">
                <CodeEditorErrorBoundary
                  streamStatus={streamState.status}
                  fallback={
                    <textarea
                      value={effectiveHtml}
                      onChange={(e) => onCodeChange(e.target.value)}
                      readOnly={isStreaming}
                      spellCheck={false}
                      className="h-full w-full resize-none border-0 bg-slate-50 dark:bg-slate-900/60 p-3 font-mono text-xs text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-slate-300"
                      aria-label="Experience HTML source (fallback)"
                      title="CodeMirror crashed — edit here until reload"
                    />
                  }
                >
                  <CodeEditor
                    value={effectiveHtml}
                    onChange={onCodeChange}
                    wordWrap={wordWrap}
                    readOnly={isStreaming}
                    handleRef={(handle) => {
                      localHandleRef.current = handle;
                      editorRef.current = handle;
                      if (typeof editorHandleRef === 'function') {
                        editorHandleRef(handle);
                      } else if (editorHandleRef) {
                        (editorHandleRef as { current: CodeEditorHandle | null }).current =
                          handle;
                      }
                    }}
                    className="h-full w-full overflow-auto"
                    aria-label="Experience HTML source"
                  />
                </CodeEditorErrorBoundary>
              </div>
            </div>
          )}

          {/* Preview column — visible in 'preview' and 'split'. */}
          {(viewMode === 'preview' || viewMode === 'split') && (
            <div
              className={cn(
                'h-full min-h-0',
                viewMode === 'split' ? 'w-1/2' : 'w-full',
              )}
            >
              <PreviewPane
                // We always render PreviewPane; it shows a friendly empty
                // state when streamState.html is empty AND manualHtml
                // is null. The workspace passes the effective html via
                // `state` so the iframe always reflects the latest content.
                state={
                  streamState.status !== 'idle' || effectiveHtml
                    ? { ...streamState, html: effectiveHtml }
                    : { ...streamState, html: '' }
                }
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SourceSubHeader({ isStreaming }: { isStreaming: boolean }) {
  return (
    <div className="flex h-7 shrink-0 items-center justify-between border-b bg-slate-50 dark:bg-slate-900/60 px-3 text-[11px] font-medium text-slate-600 dark:text-slate-400">
      <span className="flex items-center gap-1.5">
        <Code className="h-3 w-3" /> Source
      </span>
      <span className="text-[10px] text-slate-400 dark:text-slate-500">
        {isStreaming
          ? 'AI editing — manual changes are paused'
          : 'Click to edit; ⌘S to save'}
      </span>
    </div>
  );
}

// Re-export for the workspace to type-check its legacy callers.
export type { ImperativePanelHandle };
