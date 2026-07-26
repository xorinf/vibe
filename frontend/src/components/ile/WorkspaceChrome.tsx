/**
 * Chrome around the ILE teacher workspace.
 *
 * Pulled out of `TeacherILEWorkspace` so the workspace file can focus
 * on orchestration (loading, saving, publishing, lifecycle) and not
 * on layout primitives. Exposes:
 *   - ActivityBar (left rail with tool icons)
 *   - ChatDrawer (left slide-in panel wrapping ChatPane)
 *   - CentreCanvas (the dominant editing surface — three view modes)
 *   - CentreStatusBar (bottom status strip)
 *   - EditorDockStrip (preview-mode "back to split" affordance)
 *
 * The split mode uses `react-resizable-panels` for vertical drag; the
 * code-only and preview-only modes use a CSS grid inside the
 * `EditorSplitPane` itself.
 */
import { forwardRef, useEffect, useState, type Ref } from 'react';
import {
  BarChart3,
  Check,
  CircleAlert,
  Code2,
  Columns2,
  Loader2,
  MessagesSquare,
  History as HistoryIcon,
  Paperclip,
  Settings2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/utils';
import type { ImperativePanelHandle } from 'react-resizable-panels';
import { ChatPane } from './ChatPane';
import { type CodeEditorHandle } from './CodeEditor';
import { EditorSplitPane, type ViewMode } from './EditorSplitPane';
import type { IleStreamState } from './useIleGeneration';
import { useIleEditor } from './useIleEditor';

// ─────────────────────────────────────────────────────────────────────
// ACTIVITY BAR (left rail, 48px wide, vertical icon column).
//
// Each tool is a real destination — the workspace opens the
// corresponding drawer/tab when one is clicked. The inspector toggle
// is a separate stateful button at the bottom of the rail.
// ─────────────────────────────────────────────────────────────────────

export type ActiveTool = 'chat' | 'history' | 'assets' | 'analytics' | 'settings' | null;

const ACTIVITY_BAR_W = 'w-12';
const CHAT_W = 'w-80';
const INSPECTOR_W = 'w-[360px]';
const HEADER_H = 'h-12';
const STATUS_H = 'h-6';

export const WorkspaceLayoutClasses = {
  activityBar: ACTIVITY_BAR_W,
  chat: CHAT_W,
  inspector: INSPECTOR_W,
  header: HEADER_H,
  status: STATUS_H,
};

export interface ActivityBarProps {
  activeTool: ActiveTool;
  onTool: (t: ActiveTool) => void;
}

export function ActivityBar({
  activeTool,
  onTool,
}: ActivityBarProps) {
  const tools: Array<{
    id: ActiveTool;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    shortcut?: string;
  }> = [
    { id: 'chat', label: 'Chat', icon: MessagesSquare, shortcut: '⌘I' },
    { id: 'history', label: 'History', icon: HistoryIcon },
    { id: 'assets', label: 'Assets', icon: Paperclip },
    { id: 'analytics', label: 'Analytics', icon: BarChart3 },
    { id: 'settings', label: 'AI settings', icon: Settings2 },
  ];

  return (
    <aside
      className={cn(
        ACTIVITY_BAR_W,
        'flex shrink-0 flex-col items-center border-r border-border  bg-card ',
      )}
    >
      <div className="flex flex-1 flex-col items-stretch py-2">
        {tools.map((t) => (
          <ActivityBarButton
            key={t.id}
            active={activeTool === t.id}
            onClick={() => onTool(t.id)}
            label={t.label}
            shortcut={t.shortcut}
            icon={t.icon}
          />
        ))}
      </div>
    </aside>
  );
}

function ActivityBarButton({
  active,
  onClick,
  label,
  shortcut,
  icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  shortcut?: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'relative mx-1 flex h-10 w-10 items-center justify-center rounded-md transition-colors',
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground  hover:bg-slate-100 hover:text-slate-900',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-full transition-opacity',
          active ? 'bg-primary opacity-100' : 'opacity-0',
        )}
      />
      <Icon className="h-4 w-4" />
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────
// CHAT DRAWER (left, 320px, slides in next to the ActivityBar).
//
// The ChatPane owns its own header — we wrap it in a thin border so the
// drawer transition reads naturally.
// ─────────────────────────────────────────────────────────────────────

export interface ChatDrawerProps {
  state: ReturnType<typeof useIleEditor>['state'];
  api: ReturnType<typeof useIleEditor>;
  onSubmit: (text: string) => void;
  onContextSelected?: (args: { source: 'youtube'; input: string; prompt: string }) => void;
  contextDisabled?: boolean;
  /** Hidden when set — the workspace wires this to the AI config state
   *  so the composer is always interactive but the Send button is gated
   *  on the configured-state. The header chip is the single place to
   *  configure AI; we don't duplicate that reminder in the chat. */
  composerHidden?: boolean;
  configHint?: string;
  onOpenSettings?: () => void;
  onClose: () => void;
}

export const ChatDrawer = forwardRef<ImperativePanelHandle, ChatDrawerProps>(function ChatDrawer(
  props,
  ref,
) {
  void ref;
  return (
    <aside
      className={cn(
        CHAT_W,
        'flex min-h-0 shrink-0 flex-col border-r border-border  bg-background  animate-in slide-in-from-left-2 duration-200',
      )}
    >
      <ChatPane
        state={props.state}
        api={props.api}
        onSubmit={props.onSubmit}
        onContextSelected={props.onContextSelected}
        contextDisabled={props.contextDisabled}
        composerHidden={props.composerHidden}
        configHint={props.configHint}
        onOpenSettings={props.onOpenSettings}
        className="min-h-0 flex-1"
      />
    </aside>
  );
});

// ─────────────────────────────────────────────────────────────────────
// CENTRE CANVAS — the dominant work surface.
//
// Wraps `EditorSplitPane` so the workspace stays declarative. The
// preview-only mode also shows a 40px "Editor" strip at the top so the
// teacher can hop back to split view without leaving the canvas.
// ─────────────────────────────────────────────────────────────────────

export interface CentreCanvasProps {
  editorHandleRef: Ref<CodeEditorHandle | null>;
  streamState: IleStreamState;
  effectiveHtml: string;
  isStreaming: boolean;
  viewMode: ViewMode;
  onViewModeChange: (v: ViewMode) => void;
  editorRatio: number;
  onEditorRatioChange: (n: number) => void;
  wordWrap: boolean;
  onWordWrapChange: (w: boolean) => void;
  onCodeChange: (next: string) => void;
  experienceId?: string;
  /** Storage key for the resizable split ratio. */
  layoutAutoSaveId?: string;
}

export function CentreCanvas(props: CentreCanvasProps) {
  const { viewMode, streamState, experienceId } = props;
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-card ">
      <div className="flex min-h-0 flex-1 flex-col">
        {viewMode === 'preview' && (
          <EditorDockStrip
            streamState={streamState}
            experienceId={experienceId}
            onExpandToSplit={() => props.onViewModeChange('split')}
          />
        )}
        <div className="min-h-0 flex-1">
          <EditorSplitPane
            editorHandleRef={props.editorHandleRef}
            streamState={streamState}
            effectiveHtml={props.effectiveHtml}
            isStreaming={props.isStreaming}
            viewMode={viewMode}
            onViewModeChange={props.onViewModeChange}
            wordWrap={props.wordWrap}
            onWordWrapChange={props.onWordWrapChange}
            onCodeChange={props.onCodeChange}
            splitRatio={props.editorRatio}
            onSplitRatioChange={props.onEditorRatioChange}
            splitAutoSaveId={props.layoutAutoSaveId}
            className="h-full"
          />
        </div>
      </div>
      <CentreStatusBar
        streamState={streamState}
        isStreaming={props.isStreaming}
        isError={streamState.status === 'error'}
      />
    </main>
  );
}

function CentreStatusBar({
  streamState,
  isStreaming,
  isError,
}: {
  streamState: IleStreamState;
  isStreaming: boolean;
  isError: boolean;
}) {
  const charCount = streamState.html?.length ?? 0;
  // Track online state so the pill flips when the network drops.
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    function on() {
      setOnline(true);
    }
    function off() {
      setOnline(false);
    }
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  return (
    <div
      className={cn(
        STATUS_H,
        'flex shrink-0 items-center gap-3 border-t border-border  bg-background  px-3 text-[10px] text-muted-foreground ',
      )}
    >
      <span className="inline-flex items-center gap-1">
        {isError ? (
          <CircleAlert className="h-3 w-3 text-rose-500" />
        ) : isStreaming ? (
          <Loader2 className="h-3 w-3 animate-spin text-primary" />
        ) : (
          <Check className="h-3 w-3 text-emerald-500" />
        )}
        <span className="font-medium">
          {isError ? 'Error' : isStreaming ? 'Streaming' : 'Ready'}
        </span>
      </span>
      <span aria-hidden="true" className="h-3 w-px bg-muted " />
      <span>{charCount.toLocaleString()} chars</span>
      <div className="flex-1" />
      <span className="inline-flex items-center gap-1">
        <span
          aria-hidden="true"
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            online ? 'bg-emerald-500' : 'bg-rose-500',
          )}
        />
        {online ? 'Connected' : 'Offline'}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// EDITOR DOCK STRIP — 40px mini-strip shown above the preview pane in
// preview-only mode. The teacher can click to switch back to split.
// ─────────────────────────────────────────────────────────────────────

function EditorDockStrip({
  streamState,
  onExpandToSplit,
}: {
  streamState: IleStreamState;
  experienceId?: string;
  onExpandToSplit: () => void;
}) {
  void streamState;
  return (
    <div
      style={{ height: '40px' }}
      className="flex shrink-0 items-center gap-2 border-b border-border  bg-card  px-3 text-[11px] text-muted-foreground "
    >
      <Code2 className="h-3.5 w-3.5 text-muted-foreground/80 " />
      <span className="font-medium">Editor</span>
      <span className="text-muted-foreground/80 ">Hidden</span>
      <div className="flex-1" />
      <Button
        size="sm"
        variant="ghost"
        onClick={onExpandToSplit}
        className="h-6 gap-1 px-2 text-[11px]"
        title="Show split view (⌘2)"
      >
        <Columns2 className="h-3 w-3" />
        Split
      </Button>
    </div>
  );
}
