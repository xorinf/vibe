import { useEffect, useRef, useState, type Ref } from 'react';
import {
  Code,
  Columns2,
  Eye,
  Search,
  WrapText,
  Wand2,
  RotateCcw,
  RotateCw,
  Loader2,
  Save,
  Check,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/utils';
import { CodeEditor, type CodeEditorHandle } from './CodeEditor';
import { PreviewPane } from './PreviewPane';
import type { IleStreamState } from './useIleGeneration';

export type ViewMode = 'code' | 'split' | 'preview';

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
  /**
   * Identifies the experience for analytics + iframe-injected sdk.
   * Undefined while in fresh-canvas mode.
   */
  experienceId?: string;
}

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
  experienceId,
}: EditorSplitPaneProps) {
  // We use a local ref mirror of the imperative editor so the Find
  // button can call `openSearch` without the parent having to
  // re-render. The parent keeps the `editorHandleRef` in sync.
  const localHandleRef = useRef<CodeEditorHandle | null>(null);
  // Mirror for the React-side editorRef so JSX can hand the same
  // value to both `handleRef` and our own local ref capture.
  const editorRef = useRef<CodeEditorHandle | null>(null);
  // Surface a one-shot "search opened" notification so the workspace
  // can (later) show a global Find hint. Not wired yet.
  const [, setSearchCount] = useState(0);

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50">
      <EditorToolbar
        viewMode={viewMode}
        onViewModeChange={onViewModeChange}
        wordWrap={wordWrap}
        onWordWrapChange={onWordWrapChange}
        isStreaming={isStreaming}
        onOpenSearch={() => {
          localHandleRef.current?.openSearch();
          setSearchCount((c) => c + 1);
        }}
        onFormat={() => localHandleRef.current?.format()}
        isEditorReady={Boolean(editorRef.current)}
      />

      <div className="grid min-h-0 flex-1 overflow-hidden">
        {/* Code editor column — visible in 'code' and 'split'. */}
        {(viewMode === 'code' || viewMode === 'split') && (
          <div
            className={cn(
              'flex h-full min-h-0 flex-col border-r border-slate-200 bg-white',
              viewMode === 'split' ? 'w-1/2' : 'w-full',
            )}
          >
            <div className="flex items-center justify-between border-b bg-slate-50 px-3 py-1.5 text-[11px] font-medium text-slate-600">
              <span className="flex items-center gap-1.5">
                <Code className="h-3 w-3" /> Source
              </span>
              <span className="text-[10px] text-slate-400">
                {isStreaming
                  ? 'AI editing — manual changes are paused'
                  : 'Click to edit; ⌘S to save'}
              </span>
            </div>
            <div className="min-h-0 flex-1">
              <CodeEditor
                value={effectiveHtml}
                onChange={onCodeChange}
                wordWrap={wordWrap}
                readOnly={isStreaming}
                handleRef={(handle) => {
                  // Capture locally for the toolbar buttons AND forward
                  // to the parent's ref.
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
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Toolbar
// ─────────────────────────────────────────────────────────────────────

interface EditorToolbarProps {
  viewMode: ViewMode;
  onViewModeChange: (m: ViewMode) => void;
  wordWrap: boolean;
  onWordWrapChange: (w: boolean) => void;
  isStreaming: boolean;
  onOpenSearch: () => void;
  onFormat: () => void;
  isEditorReady: boolean;
}

function EditorToolbar({
  viewMode,
  onViewModeChange,
  wordWrap,
  onWordWrapChange,
  isStreaming,
  onOpenSearch,
  onFormat,
  isEditorReady,
}: EditorToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-white px-2 py-1.5">
      <ViewModeSwitch value={viewMode} onChange={onViewModeChange} />

      <Divider />

      <ToolbarButton
        icon={<Search className="h-3.5 w-3.5" />}
        label="Find"
        shortcut="⌘F"
        onClick={onOpenSearch}
        disabled={!isEditorReady}
      />
      <ToolbarButton
        icon={<Wand2 className="h-3.5 w-3.5" />}
        label="Format"
        shortcut="⌘⇧F"
        onClick={onFormat}
        disabled={!isEditorReady}
      />
      <ToolbarButton
        icon={<WrapText className="h-3.5 w-3.5" />}
        label={wordWrap ? 'Word wrap on' : 'Word wrap off'}
        onClick={() => onWordWrapChange(!wordWrap)}
        active={wordWrap}
        disabled={!isEditorReady}
      />

      <Divider />

      <SaveIndicator isStreaming={isStreaming} />

      <div className="ml-auto" />

      <ToolbarButton
        icon={
          isStreaming ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )
        }
        label={isStreaming ? 'AI editing…' : 'Live sync'}
        onClick={() => {}}
        active={!isStreaming}
        disabled
      />
    </div>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px bg-slate-200" aria-hidden="true" />;
}

interface ToolbarButtonProps {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}

function ToolbarButton({
  icon,
  label,
  shortcut,
  onClick,
  active,
  disabled,
}: ToolbarButtonProps) {
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      aria-label={shortcut ? `${label} (${shortcut})` : label}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={cn(
        'h-7 gap-1 px-2 text-xs',
        active ? 'bg-violet-50 text-violet-700 hover:bg-violet-100' : 'text-slate-600 hover:text-slate-900',
        disabled && 'opacity-40',
      )}
    >
      {icon}
      <span className="hidden md:inline">{label}</span>
      {shortcut && (
        <span className="hidden lg:inline text-[10px] text-slate-400">
          {shortcut}
        </span>
      )}
    </Button>
  );
}

function ViewModeSwitch({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  return (
    <div
      className="inline-flex items-center rounded-md border border-slate-200 bg-slate-50 p-0.5"
      role="radiogroup"
      aria-label="View mode"
    >
      <ViewModeButton
        current={value}
        target="code"
        icon={<Code className="h-3.5 w-3.5" />}
        onChange={onChange}
      />
      <ViewModeButton
        current={value}
        target="split"
        icon={<Columns2 className="h-3.5 w-3.5" />}
        onChange={onChange}
      />
      <ViewModeButton
        current={value}
        target="preview"
        icon={<Eye className="h-3.5 w-3.5" />}
        onChange={onChange}
      />
    </div>
  );
}

function ViewModeButton({
  current,
  target,
  icon,
  onChange,
}: {
  current: ViewMode;
  target: ViewMode;
  icon: React.ReactNode;
  onChange: (v: ViewMode) => void;
}) {
  const active = current === target;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={() => onChange(target)}
      className={cn(
        'inline-flex h-6 w-7 items-center justify-center rounded-sm transition-colors',
        active
          ? 'bg-white text-violet-700 shadow-sm'
          : 'text-slate-500 hover:text-slate-800',
      )}
      title={target === 'code' ? 'Code only' : target === 'split' ? 'Split view' : 'Preview only'}
    >
      {icon}
    </button>
  );
}

function SaveIndicator({ isStreaming }: { isStreaming: boolean }) {
  return (
    <div
      className="flex items-center gap-1.5 px-2 text-[10px] font-medium uppercase tracking-wider text-slate-500"
      title={isStreaming ? 'AI is editing the document' : 'In sync with the saved document'}
    >
      {isStreaming ? (
        <>
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>AI editing</span>
        </>
      ) : (
        <>
          <Check className="h-3 w-3 text-emerald-500" />
          <span>Live</span>
        </>
      )}
    </div>
  );
}
