import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Sparkles,
  History as HistoryIcon,
  ExternalLink,
  Paperclip,
  Check,
  Code,
  Eye,
  Columns2,
  Search,
  Undo2,
  Redo2,
  WrapText,
  Save,
  CircleAlert,
  Wand2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/utils';
import { ChatPane } from './ChatPane';
import { type CodeEditorHandle } from './CodeEditor';
import { MetadataPane } from './MetadataPane';
import { AiConfigPanel } from './AiConfigPanel';
import { HistoryPanel } from './HistoryPanel';
import { ActionsMenu } from './ActionsMenu';
import { AssetManager } from './AssetManager';
import { EditorSplitPane } from './EditorSplitPane';
import { useIleEditor } from './useIleEditor';
import { AddContextMenu } from './AddContextMenu';
import { useIleContextGeneration } from './useIleContextGeneration';
import {
  getIleExperience,
  saveIleExperience,
  publishIleExperience,
  type IleExperienceResponse,
} from './ileApi';

export interface TeacherILEWorkspaceProps {
  experienceId?: string;
  defaults?: {
    courseId?: string;
    courseVersionId?: string;
    itemId?: string;
  };
}

/**
 * Teacher workspace — iterative AI surface, not a one-shot generator.
 *
 * State model:
 *  - `useIleEditor` owns the streaming + chat thread + undo/redo.
 *  - This component owns the workspace chrome (loading, navigation, save,
 *    publish, history drawer) and persists snapshots via the existing
 *    REST API.
 *
 * The first message uses the original `useIleGeneration` path
 * (`/generate/stream`) so the "blank canvas" experience still works.
 * After the first save, the chat switches to the editor path
 * (`/:id/edit/stream`) for every subsequent turn.
 */
export function TeacherILEWorkspace({ experienceId, defaults }: TeacherILEWorkspaceProps) {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const editor = useIleEditor();
  const { state: editorState, setExperience, setFreshCanvas, send, cancel, undo, redo } =
    editor;
  const contextStream = useIleContextGeneration();

  const [saved, setSaved] = useState<IleExperienceResponse | null>(null);
  const [title, setTitle] = useState('Untitled Experience');
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  /** Wall-clock timestamp of the most recent successful save. */
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [configState, setConfigState] = useState<'loading' | 'configured' | 'unconfigured'>(
    'loading',
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);

  const courseId = defaults?.courseId ?? params.get('courseId') ?? '';
  const courseVersionId =
    defaults?.courseVersionId ?? params.get('courseVersionId') ?? '';
  const itemId = defaults?.itemId ?? params.get('itemId') ?? undefined;

  // Decide on mount whether we're loading an existing experience or
  // starting a fresh canvas. The editor handles both.
  useEffect(() => {
    if (experienceId) {
      let cancelled = false;
      (async () => {
        try {
          const doc = await getIleExperience(experienceId);
          if (cancelled) return;
          setSaved(doc);
          setTitle(doc.title);
          setExperience(doc._id, doc.html);
        } catch (err: any) {
          toast.error(err?.message ?? 'Failed to load experience');
        }
      })();
      return () => {
        cancelled = true;
      };
    }
    // No id — fresh canvas. Bind the editor to the course context so
    // the first send() routes through generate().
    if (courseId && courseVersionId) {
      setFreshCanvas({ courseId, courseVersionId, itemId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [experienceId]);

  // After each successful stream, refetch the saved doc so the right
  // pane reflects the persisted state without a full refresh.
  useEffect(() => {
    if (editorState.stream.status !== 'done' || !editorState.stream.experienceId) return;
    let cancelled = false;
    (async () => {
      try {
        const doc = await getIleExperience(editorState.stream.experienceId!);
        if (!cancelled) {
          setSaved(doc);
          if (doc.title) setTitle(doc.title);
        }
      } catch {
        // non-fatal
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editorState.stream.status, editorState.stream.experienceId]);

  // If the very first stream (the generate path) just produced an
  // experience id, navigate to the canonical URL so reloads work.
  useEffect(() => {
    if (
      editorState.freshCanvas &&
      editorState.stream.status === 'done' &&
      editorState.stream.experienceId
    ) {
      const id = editorState.stream.experienceId;
      navigate(`/teacher/ile/${id}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorState.stream.status, editorState.freshCanvas]);

  // One-shot toast when a stream finishes truncated. We only fire on
  // the transition from "not truncated" to "truncated" so repeat
  // re-uses of the workspace don't pile up stale warnings.
  const lastTruncationRef = useRef<boolean>(false);
  useEffect(() => {
    const truncated = Boolean(editorState.stream.truncated);
    const wasTruncated = lastTruncationRef.current;
    lastTruncationRef.current = truncated;
    if (!truncated || wasTruncated) return;
    if (editorState.stream.status !== 'done') return;
    toast.warning(
      'The response was truncated by the provider. The saved draft is incomplete — try a shorter or more specific prompt.',
      { duration: 10_000 },
    );
  }, [editorState.stream.truncated, editorState.stream.status]);

  // ───────────────────────────────────────────────────────────────────
  // Save / publish / lifecycle (unchanged from previous design)
  //
  // The save flow is now driven by either:
  //   - the teacher's manual edits in the code editor (auto-save)
  //   - the AI finishing a stream that diverged from the last save
  // Both paths funnel through the same `effectiveHtml` so the backend
  // sees a single canonical document.
  const [viewMode, setViewMode] = useState<'code' | 'split' | 'preview'>(
    () => {
      if (typeof window === 'undefined') return 'split';
      const stored = window.localStorage.getItem('ile.workspace.viewMode');
      if (stored === 'code' || stored === 'split' || stored === 'preview') {
        return stored;
      }
      return 'split';
    },
  );
  const [wordWrap, setWordWrap] = useState<boolean>(
    () => window.localStorage.getItem('ile.workspace.wordWrap') !== 'false',
  );

  // The latest HTML the teacher has hand-typed. When null, no manual
  // edit has happened yet and the preview/AI/auto-save chain defers
  // to the AI-streamed value. When set, it overrides the stream for
  // preview AND becomes the base the next AI edit operates on.
  const [manualHtml, setManualHtml] = useState<string | null>(null);

  // Stable ref to the editor so the workspace can imperatively
  // setValue when an AI stream finishes (and reset other UI bits).
  const editorHandleRef = useRef<CodeEditorHandle | null>(null);

  // The HTML the preview + auto-save will read. Priority:
  //   1. Manual edit (if the teacher has typed)
  //   2. AI stream output (most recent done/still-streaming)
  //   3. Initial loaded HTML
  //   4. Last-saved server HTML
  // Manual edits always win so the preview reflects what the teacher
  // sees in the code editor.
  const effectiveHtml =
    manualHtml ??
    (editorState.stream.status === 'done' || editorState.stream.status === 'streaming'
      ? editorState.stream.html
      : '') ??
    editorState.initialHtml ??
    saved?.html ??
    '';

  // Whenever the AI stream finishes or the saved snapshot updates,
  // sync the imperative editor. We skip the sync when the teacher
  // is mid-typing (manualHtml differs from the new stream value)
  // because we don't want to clobber an in-flight edit.
  useEffect(() => {
    if (editorState.stream.status === 'done') {
      const streamHtml = editorState.stream.html;
      // Only push when (a) no manual edit, or (b) the manual edit
      // matches the stream — i.e. an undo that took us back to the
      // pre-stream state.
      if (manualHtml === null || manualHtml === streamHtml) {
        editorHandleRef.current?.setValue(streamHtml);
        setManualHtml(null);
        // Keep the AI's view of the head in sync so a follow-up edit
        // starts from the right place.
        editor.setHead(streamHtml);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorState.stream.status, editorState.stream.html]);

  // When the saved snapshot arrives (initial load), seed the editor.
  useEffect(() => {
    if (saved?.html && manualHtml === null) {
      editorHandleRef.current?.setValue(saved.html);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved?._id]);

  // Whenever the teacher types, mirror into the AI's head so the
  // next send() uses the latest manual content.
  const handleCodeChange = useCallback(
    (next: string) => {
      setManualHtml(next);
      editor.setHead(next);
      // Mark the workspace as dirty for the unsaved-changes guard.
      // We do NOT auto-save immediately — that's a separate debounced
      // effect (see handleEditorAutoSave below).
    },
    [editor],
  );

  // Persist view preferences when they change.
  useEffect(() => {
    try {
      window.localStorage.setItem('ile.workspace.viewMode', viewMode);
    } catch {
      /* private mode — ignore */
    }
  }, [viewMode]);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        'ile.workspace.wordWrap',
        wordWrap ? '1' : '0',
      );
    } catch {
      /* ignore */
    }
  }, [wordWrap]);

  // ───────────────────────────────────────────────────────────────────
  // Auto-save. Debounced 1.5s after the last manual edit. We don't
  // auto-save while the AI is streaming (the teacher is likely waiting
  // for the next prompt) or when the saved doc already matches.
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (manualHtml === null) return;
    // Don't race the AI.
    if (editorState.stream.status === 'streaming') return;
    // The dev has nothing to save yet.
    if (!editorState.stream.experienceId) return;
    // Already saved at this exact value.
    if (manualHtml === saved?.html) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      // Save without blocking the UI. The handleSave callback also
      // does its own work; this just kicks it off on a delay.
      void handleSaveRef.current?.();
    }, 1500);
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualHtml, editorState.stream.status]);

  // A ref to handleSave so the auto-save timer always calls the
  // latest version (handleSave's deps would otherwise need to be
  // mirrored in the timer effect, which causes spurious runs).
  const handleSaveRef = useRef<() => Promise<void> | undefined>(undefined);

  const isDirty =
    editorState.stream.status === 'done' &&
    effectiveHtml.length > 0 &&
    effectiveHtml !== (saved?.html ?? '');

  useEffect(() => {
    if (!isDirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  const handleBack = useCallback(() => {
    if (isDirty) {
      const ok = window.confirm('You have unsaved changes. Leave anyway?');
      if (!ok) return;
    }
    navigate(-1);
  }, [isDirty, navigate]);

  const handleSave = useCallback(async () => {
    // Save whatever the teacher is currently looking at — manual
    // edits take priority; the AI stream value is the fallback.
    const html = manualHtml ?? editorState.stream.html;
    if (!html) {
      toast.error('Nothing to save yet — generate or edit first.');
      return;
    }
    setSaving(true);
    try {
      const result = await saveIleExperience({
        _id: editorState.stream.experienceId,
        courseId,
        courseVersionId,
        itemId,
        title: title || 'Untitled Experience',
        prompt: (saved?.prompt as string | undefined) ?? '',
        html,
      });
      setSaved(result);
      setTitle(result.title);
      setLastSavedAt(new Date());
      toast.success(editorState.stream.experienceId ? 'Draft updated' : 'Draft saved');
      if (!editorState.stream.experienceId && result._id) {
        navigate(`/teacher/ile/${result._id}`, { replace: true });
      }
    } catch (err: any) {
      toast.error(err?.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [
    editorState.stream.html,
    editorState.stream.experienceId,
    courseId,
    courseVersionId,
    itemId,
    title,
    saved?.prompt,
    navigate,
    manualHtml,
  ]);

  // The auto-save timer fires `handleSaveRef.current?.()` so it always
  // calls the latest version. Mirror it here after every render.
  handleSaveRef.current = handleSave;

  // Keyboard shortcut: Cmd/Ctrl+S saves the draft. We only fire when the
  // workspace owns focus (i.e. inputs inside the chat composer don't
  // double-handle it as their own save — they don't).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isSaveCombo = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's';
      if (!isSaveCombo) return;
      // Don't intercept when a textarea owns the keystroke — ⌘↩ already
      // triggers submit inside ChatPane, leave it alone there too.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
      e.preventDefault();
      if (!saving) handleSave();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saving, handleSave]);

  const handlePublish = useCallback(async () => {
    const id = saved?._id ?? editorState.stream.experienceId;
    if (!id) {
      toast.error('Save the draft first.');
      return;
    }
    setPublishing(true);
    try {
      const result = await publishIleExperience(id);
      setSaved(result);
      toast.success('Published — students can now play this experience.');
    } catch (err: any) {
      toast.error(err?.message ?? 'Publish failed');
    } finally {
      setPublishing(false);
    }
  }, [saved?._id, editorState.stream.experienceId]);

  const handleLifecycleAction = useCallback(
    async (
      action: 'renamed' | 'duplicated' | 'archived' | 'unarchived' | 'deleted',
      payload?: { newId?: string; newTitle?: string },
    ) => {
      if (action === 'renamed' && payload?.newTitle) {
        setTitle(payload.newTitle);
        if (saved) setSaved({ ...saved, title: payload.newTitle });
        return;
      }
      if (action === 'duplicated') {
        if (payload?.newId) navigate(`/teacher/ile/${payload.newId}`, { replace: true });
        return;
      }
      if (action === 'archived' || action === 'unarchived') {
        if (saved) {
          try {
            const fresh = await getIleExperience(saved._id);
            setSaved(fresh);
            if (action === 'archived') setHistoryOpen(false);
          } catch {
            /* surface is handled by the menu's own toast */
          }
        }
        return;
      }
      if (action === 'deleted') {
        navigate('/teacher/ile');
      }
    },
    [saved, navigate],
  );

  // (legacy htmlForPreview variable removed — the EditorSplitPane now
  //  receives effectiveHtml directly from this workspace.)
  // (removed the legacy `hasExperience` flag — the EditorSplitPane
  //  reads the experience id directly off editorState.stream.)

  const isConfigured = configState === 'configured';
  const forceConfigExpand = configState !== 'configured';

  return (
    <div className="flex h-screen flex-col bg-slate-50">
      <header className="flex items-center justify-between border-b bg-white px-5 py-2.5">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleBack}
            aria-label="Back"
            className="gap-1 text-slate-600"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Back</span>
          </Button>
          <div className="flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-violet-100 text-violet-700">
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            <div>
              <h1 className="text-sm font-semibold text-slate-900">
                Interactive Learning Experience
              </h1>
              <p className="text-[11px] text-slate-500">
                {title || 'Untitled Experience'}
                {isDirty ? ' · unsaved changes' : ''}
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {saved?._id && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setHistoryOpen((v) => !v)}
              className={cn(
                'h-7 gap-1 px-2 text-xs',
                historyOpen ? 'text-violet-700' : 'text-slate-500 hover:text-slate-900',
              )}
              aria-pressed={historyOpen}
            >
              <HistoryIcon className="h-3.5 w-3.5" />
              History
              {saved.currentVersion > 0 && (
                <span className="rounded-full bg-slate-100 px-1.5 text-[10px] font-medium text-slate-600">
                  v{saved.currentVersion}
                </span>
              )}
            </Button>
          )}
          {/* Compact save-state pill so the teacher knows whether the
              current HTML is on disk. Renders "Saved 14:32" or "Unsaved"
              depending on isDirty, and an "Undo" affordance to revert. */}
          {!saving && lastSavedAt && !isDirty && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700"
              title={`Last saved at ${lastSavedAt.toLocaleString()}`}
              aria-live="polite"
            >
              <Check className="h-2.5 w-2.5" />
              Saved {lastSavedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          {saving && (
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
              <Check className="h-2.5 w-2.5 animate-pulse" />
              Saving…
            </span>
          )}
          {saved?._id && (
            <ActionsMenu
              experienceId={saved._id}
              currentTitle={saved.title}
              isArchived={saved.status === 'archived'}
              onAction={handleLifecycleAction}
            />
          )}
          {saved?._id && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => navigate('/teacher/ile')}
              className="h-7 gap-1 px-2 text-xs text-slate-500 hover:text-slate-900"
              aria-label="Open experience library"
              title="All experiences"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Library
            </Button>
          )}
          <div className="text-[11px] text-slate-400">
            {courseVersionId ? `Course version: ${courseVersionId.slice(-6)}` : 'No course context'}
          </div>
        </div>
      </header>

      <div className="border-b bg-slate-50/60 px-5 py-2">
        <AiConfigPanel
          forceExpand={forceConfigExpand}
          onConfiguredChange={(configured) =>
            setConfigState(configured ? 'configured' : 'unconfigured')
          }
        />
      </div>
      {/* Three panes + optional History / Assets drawer */}
      <div className="grid flex-1 grid-cols-[320px_1fr_280px] overflow-hidden">
        <ChatPane
          state={editorState}
          api={editor}
          onSubmit={send}
          onContextSelected={(args) => {
            // Fire the context SSE stream. The ChatPane composer
            // already collected the URL + prompt via the dialog.
            if (!courseId || !courseVersionId) {
              toast.error('Open this experience from a course item to use context.');
              return;
            }
            contextStream.start({
              source: args.source,
              input: args.input,
              prompt: args.prompt,
              courseId,
              courseVersionId,
              itemId,
            });
          }}
          contextDisabled={contextStream.state.status === 'streaming'}
          composerHidden={!isConfigured}
          configHint={{
            configState === 'loading'
              ? 'Checking your saved configuration…'
              : 'Save the form above to enable generation. Your key is stored per teacher.'
          }}
        />
        <EditorSplitPane
          editorHandleRef={editorHandleRef}
          streamState={editorState.stream}
          effectiveHtml={effectiveHtml}
          isStreaming={editorState.stream.status === 'streaming'}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          wordWrap={wordWrap}
          onWordWrapChange={setWordWrap}
          onCodeChange={handleCodeChange}
          experienceId={editorState.stream.experienceId}
        />
        <MetadataPane
          state={editorState.stream}
          savedExperience={saved}
          saving={saving}
          publishing={publishing}
          onTitleChange={setTitle}
          onSave={handleSave}
          onPublish={handlePublish}
        />
      </div>

      {/* History drawer — slides up from the bottom when toggled. */}
      {historyOpen && saved?._id && (
        <div className="absolute bottom-0 left-0 right-0 z-20 h-[420px] border-t bg-white shadow-[0_-8px_24px_rgba(15,23,42,0.08)]">
          <HistoryPanel
            experienceId={saved._id}
            onRestored={({ html, title, currentVersion }) => {
              setSaved((prev) =>
                prev ? { ...prev, html, title, currentVersion } : prev,
              );
              setTitle(title);
              // Refresh the editor's head so undo/redo stacks reset.
              setExperience(saved._id, html);
            }}
            className="h-full"
          />
        </div>
      )}

      {/* Assets drawer — slides in from the right when toggled. Hosts
          the AssetManager with its own upload / list / dropzone. */}
      {assetsOpen && (
        <div className="absolute bottom-0 right-0 top-0 z-20 w-[420px] border-l bg-white shadow-[-8px_0_24px_rgba(15,23,42,0.08)]">
          <AssetManager
            onPick={(asset) => editor.attachAsset(asset)}
            className="h-full"
          />
        </div>
      )}
    </div>
  );
}