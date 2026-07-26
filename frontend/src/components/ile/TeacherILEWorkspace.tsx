import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams as useTanstackParams } from '@tanstack/react-router';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/utils';
import {
  Sparkles,
  History as HistoryIcon,
  Check,
  Settings2,
  X,
  Save,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { type CodeEditorHandle } from './CodeEditor';
import { AiConfigPanel, AiConfigFormBody } from './AiConfigPanel';
import { ActionsMenu } from './ActionsMenu';
import { useIleEditor } from './useIleEditor';
import { useIleContextGeneration } from './useIleContextGeneration';
import {
  getIleExperience,
  saveIleExperience,
  publishIleExperience,
  type IleExperienceResponse,
} from './ileApi';
import {
  ActivityBar,
  ChatDrawer,
  CentreCanvas,
  type ActiveTool,
} from './WorkspaceChrome';
import type { ViewMode } from './EditorSplitPane';
import { InspectorDrawer, type InspectorTabId } from './InspectorDrawer';

/**
 * Tiny URLSearchParams reader for the search string. The workspace
 * lives inside a Dialog mounted by the TanStack tree, so it has no
 * `BrowserRouter` ancestor — `react-router-dom`'s `useSearchParams`
 * would throw on mount. Fall back to `window.location.search` only
 * for the standalone mount case.
 */
function useSearchParamsFallback(): [URLSearchParams] {
  return useMemo(
    () => [
      new URLSearchParams(
        typeof window === 'undefined' ? '' : window.location.search,
      ),
    ],
    [],
  );
}

export interface TeacherILEWorkspaceProps {
  experienceId?: string;
  defaults?: {
    courseId?: string;
    courseVersionId?: string;
    itemId?: string;
  };
  /**
   * Called whenever a navigation-style action would have happened in
   * the routed version — Back button, after-delete, after-duplicate.
   * The Dialog wrapper closes itself in response.
   */
  onClose?: () => void;
}

// Persisted layout — which tools (drawers) the teacher has open, and
// what the centre canvas's split ratio is.
const LAYOUT_STORAGE_KEY = 'ile.workspace.layout.v3';
const SPLIT_PERSIST_KEY = `${LAYOUT_STORAGE_KEY}:split`;

export function TeacherILEWorkspace({
  experienceId: propExperienceId,
  defaults,
  onClose,
}: TeacherILEWorkspaceProps) {
  const [params] = useSearchParamsFallback();

  // When the component is mounted via the TanStack route the active
  // id has to be read from the route param.
  const tanstackParams = useTanstackParams({ strict: false }) as {
    experienceId?: string;
  };
  const experienceId = propExperienceId ?? tanstackParams.experienceId;

  const editor = useIleEditor();
  const { state: editorState, setExperience, setFreshCanvas, send } = editor;
  const contextStream = useIleContextGeneration();

  const [saved, setSaved] = useState<IleExperienceResponse | null>(null);
  const [title, setTitle] = useState('Untitled Experience');
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [configState, setConfigState] = useState<
    'loading' | 'configured' | 'unconfigured'
  >('loading');

  // Drawer state — at most one main tool is active at a time. The
  // inspector is independent. Tools open and close like Cmd+Shift+P
  // in VS Code: pick one, pick another, click again to close.
  const [activeTool, setActiveTool] = useState<ActiveTool>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTabId>('details');

  // Course context, pulled from defaults + URL fallback.
  const courseId = defaults?.courseId ?? params.get('courseId') ?? '';
  const courseVersionId =
    defaults?.courseVersionId ?? params.get('courseVersionId') ?? '';
  const itemId = defaults?.itemId ?? params.get('itemId') ?? undefined;

  // Centre canvas view mode + split ratio. The ratio is the % of the
  // canvas height the editor occupies in split mode.
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window === 'undefined') return 'split';
    const stored = window.localStorage.getItem('ile.workspace.viewMode');
    if (stored === 'code' || stored === 'split' || stored === 'preview') {
      return stored as ViewMode;
    }
    return 'split';
  });
  const [editorRatio, setEditorRatio] = useState(58); // % of canvas

  const [wordWrap, setWordWrap] = useState<boolean>(
    () => window.localStorage.getItem('ile.workspace.wordWrap') !== 'false',
  );

  const [manualHtml, setManualHtml] = useState<string | null>(null);
  const editorHandleRef = useRef<CodeEditorHandle | null>(null);

  // Load persisted layout (which tools/drawers are open, inspector tab).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<{
        activeTool: ActiveTool;
        inspectorOpen: boolean;
        inspectorTab: InspectorTabId;
        editorRatio: number;
      }>;
      if (parsed.activeTool !== undefined) setActiveTool(parsed.activeTool);
      if (typeof parsed.inspectorOpen === 'boolean') {
        setInspectorOpen(parsed.inspectorOpen);
      }
      if (parsed.inspectorTab) setInspectorTab(parsed.inspectorTab);
      if (typeof parsed.editorRatio === 'number') {
        setEditorRatio(clamp(parsed.editorRatio, 25, 80));
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Persist on change.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        window.localStorage.setItem(
          LAYOUT_STORAGE_KEY,
          JSON.stringify({
            activeTool,
            inspectorOpen,
            inspectorTab,
            editorRatio,
          }),
        );
      } catch {
        /* ignore */
      }
    }, 200);
    return () => clearTimeout(t);
  }, [activeTool, inspectorOpen, inspectorTab, editorRatio]);

  // ─────────────────────────────────────────────────────────────────
  // Save / publish / lifecycle
  // ─────────────────────────────────────────────────────────────────
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
    // No experienceId — fresh-canvas mode. Always set the fresh
    // canvas (even without a course context) so the next send()
    // routes through the generate path. The backend stores
    // courseId/courseVersionId as empty strings when no course
    // context is bound, and the teacher can attach the experience
    // to a course later via the item-level Save / Publish flow.
    setFreshCanvas({
      courseId: courseId ?? '',
      courseVersionId: courseVersionId ?? '',
      itemId: itemId ?? undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [experienceId]);

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
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editorState.stream.status, editorState.stream.experienceId]);

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

  // The HTML the preview + auto-save + Monaco will read. Resolution
  // chain: manual edit > stream output > initial > saved.
  const effectiveHtml =
    manualHtml ??
    (editorState.stream.status === 'done' || editorState.stream.status === 'streaming'
      ? editorState.stream.html
      : null) ??
    editorState.initialHtml ??
    saved?.html ??
    '';

  useEffect(() => {
    if (editorState.stream.status === 'done') {
      const streamHtml = editorState.stream.html;
      if (manualHtml === null || manualHtml === streamHtml) {
        editorHandleRef.current?.setValue(streamHtml);
        setManualHtml(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorState.stream.status, editorState.stream.html]);

  useEffect(() => {
    if (saved?.html && manualHtml === null) {
      editorHandleRef.current?.setValue(saved.html);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved?._id]);

  const handleCodeChange = useCallback(
    (next: string) => {
      setManualHtml(next);
    },
    [],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem('ile.workspace.viewMode', viewMode);
    } catch {
      /* ignore */
    }
  }, [viewMode]);
  useEffect(() => {
    try {
      window.localStorage.setItem('ile.workspace.wordWrap', wordWrap ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [wordWrap]);

  // Auto-save after 1.5s of no manual edits.
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (manualHtml === null) return;
    if (editorState.stream.status === 'streaming') return;
    if (!editorState.stream.experienceId) return;
    if (manualHtml === saved?.html) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      void handleSaveRef.current?.();
    }, 1500);
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualHtml, editorState.stream.status]);

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

  // Surface stream errors as a toast so the teacher doesn't think the
  // AI is 'still working' forever when the backend rejected the
  // request (e.g. auth mismatch, validation failure).
  useEffect(() => {
    if (editorState.stream.status === 'error' && editorState.stream.error) {
      toast.error(editorState.stream.error, { duration: 8000 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorState.stream.status, editorState.stream.error]);

  const handleClose = useCallback(() => {
    if (isDirty) {
      const ok = window.confirm('You have unsaved changes. Close anyway?');
      if (!ok) return;
    }
    onClose?.();
  }, [isDirty, onClose]);

  const handleSave = useCallback(async () => {
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
        // prompt is optional on the backend (defaults to a placeholder
        // if absent) — pass through undefined when we don't have it
        // loaded yet (e.g. fresh-canvas before history hydrates).
        prompt: saved?.prompt,
        html,
      });
      setSaved(result);
      setTitle(result.title);
      setLastSavedAt(new Date());
      toast.success(editorState.stream.experienceId ? 'Draft updated' : 'Draft saved');
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
    manualHtml,
  ]);

  handleSaveRef.current = handleSave;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isSaveCombo = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's';
      if (!isSaveCombo) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
      e.preventDefault();
      if (!saving) handleSave();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saving, handleSave]);

  /**
   * Compute the student-facing share URL whenever the experience is
   * published. The MetadataPane reads this from a data attribute so it
   * stays unaware of routing.
   */
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (saved?.status === 'published' && saved?._id) {
      const url = `${window.location.origin}/student/course/${courseId}/${courseVersionId}?experience=${saved._id}`;
      document.body.dataset.studentShareUrl = url;
    } else {
      delete document.body.dataset.studentShareUrl;
    }
  }, [saved?.status, saved?._id, courseId, courseVersionId]);

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
      if (action === 'duplicated') return;
      if (action === 'archived' || action === 'unarchived') {
        if (saved) {
          try {
            const fresh = await getIleExperience(saved._id);
            setSaved(fresh);
          } catch {
            /* surface is handled by the menu's own toast */
          }
        }
        return;
      }
      if (action === 'deleted') onClose?.();
    },
    [saved, onClose],
  );

  // Activity-bar tool router. The chat tool opens the chat drawer.
  // All other tools open the inspector at the matching tab, except
  // settings which opens the AI provider dialog. Clicking the active
  // tool closes whatever was opened.
  const handleTool = useCallback(
    (t: ActiveTool) => {
      if (t === null) {
        setActiveTool(null);
        return;
      }
      if (t === 'chat') {
        setActiveTool((curr) => (curr === 'chat' ? null : 'chat'));
        return;
      }
      if (t === 'settings') {
        setAiConfigOpen(true);
        setActiveTool(null);
        return;
      }
      // history / assets / analytics all live in the inspector drawer.
      const nextTab: InspectorTabId =
        t === 'history' ? 'history' : t === 'assets' ? 'assets' : 'analytics';
      setInspectorTab(nextTab);
      setInspectorOpen(true);
      setActiveTool(null);
    },
    [],
  );

  const [aiConfigOpen, setAiConfigOpen] = useState(false);

  // Stats for the status bar.
  const isStreaming = editorState.stream.status === 'streaming';
  const isConfigured = configState === 'configured';

  return (
    <div className="flex h-full min-h-0 flex-col bg-background ">
      {/* ── HEADER 48px ──────────────────────────────────────────── */}
      <header
        className={cn(
          'h-12',
          'flex shrink-0 items-center gap-2 border-b border-border  bg-background  px-3',
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-semibold text-foreground ">
                {title || 'Untitled Experience'}
              </h1>
              {isDirty ? (
                <span className="rounded-full bg-ai/30  px-1.5 py-0.5 text-[10px] font-medium text-accent-foreground ">
                  Unsaved
                </span>
              ) : lastSavedAt ? (
                <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-primary/15  px-1.5 py-0.5 text-[10px] font-medium text-primary ">
                  <Check className="h-2.5 w-2.5" />
                  Saved {lastSavedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              ) : null}
              {saving ? (
                <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-muted  px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ">
                  <Check className="h-2.5 w-2.5 animate-pulse" />
                  Saving…
                </span>
              ) : null}
            </div>
            <p className="truncate text-[11px] text-muted-foreground ">
              Interactive Learning Experience
              {courseVersionId ? ` · course ${courseVersionId.slice(-6)}` : ''}
            </p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <AiConfigPanel
            mode="chip"
            onRequestEdit={() => setAiConfigOpen(true)}
            onConfiguredChange={(configured) =>
              setConfigState(configured ? 'configured' : 'unconfigured')
            }
          />

          {saved?._id ? (
            <Button
              size="sm"
              variant={inspectorOpen && inspectorTab === 'history' ? 'secondary' : 'ghost'}
              onClick={() => handleTool('history')}
              className="h-8 gap-1 px-2 text-xs"
              aria-pressed={inspectorOpen && inspectorTab === 'history'}
              title="Version history"
            >
              <HistoryIcon className="h-3.5 w-3.5" />
              <span className="hidden md:inline">History</span>
              {saved.currentVersion > 0 && (
                <span className="rounded-full bg-muted  px-1 text-[10px] font-medium text-muted-foreground ">
                  v{saved.currentVersion}
                </span>
              )}
            </Button>
          ) : null}

          {saved?._id ? (
            <ActionsMenu
              experienceId={saved._id}
              currentTitle={saved.title}
              isArchived={saved.status === 'archived'}
              onAction={handleLifecycleAction}
            />
          ) : null}

          <Button
            size="sm"
            variant="ghost"
            onClick={handleSave}
            disabled={saving || !effectiveHtml}
            className="h-8 gap-1 px-2 text-xs text-muted-foreground  hover:text-slate-900"
            title="Save the current draft (Ctrl+S)"
            aria-label="Save draft"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            <span className="hidden md:inline">Save</span>
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={handleClose}
            aria-label="Close workspace"
            title="Close"
            className="h-8 w-8 text-muted-foreground  hover:bg-slate-100 hover:text-slate-900"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {/* ── BODY: ActivityBar | (ChatDrawer | Centre | InspectorDrawer) ── */}
      <div className="flex min-h-0 flex-1">
        <ActivityBar
          activeTool={activeTool}
          onTool={handleTool}
        />

        {/* ChatDrawer — slides in next to the ActivityBar. */}
        {activeTool === 'chat' && (
          <ChatDrawer
            state={editorState}
            api={editor}
            onSubmit={send}
            onContextSelected={(args: { source: 'youtube'; input: string; prompt: string }) => {
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
            configHint={
              configState === 'loading'
                ? 'Checking your saved configuration…'
                : 'Add your provider + API key, then come back here.'
            }
            onOpenSettings={() => setAiConfigOpen(true)}
            onClose={() => setActiveTool(null)}
          />
        )}

        {/* Centre canvas — the dominant work surface. Always visible. */}
        <CentreCanvas
          editorHandleRef={editorHandleRef}
          streamState={editorState.stream}
          effectiveHtml={effectiveHtml}
          isStreaming={isStreaming}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          editorRatio={editorRatio}
          onEditorRatioChange={setEditorRatio}
          wordWrap={wordWrap}
          onWordWrapChange={setWordWrap}
          onCodeChange={handleCodeChange}
          experienceId={editorState.stream.experienceId}
          layoutAutoSaveId={SPLIT_PERSIST_KEY}
        />

        {/* InspectorDrawer — slides in from the right. */}
        {inspectorOpen && (
          <InspectorDrawer
            tab={inspectorTab}
            onTabChange={setInspectorTab}
            onClose={() => setInspectorOpen(false)}
            streamState={editorState.stream}
            savedExperience={saved}
            saving={saving}
            publishing={publishing}
            onTitleChange={setTitle}
            onSave={handleSave}
            onPublish={handlePublish}
            onRestoredFromHistory={({ html, title, currentVersion }: { html: string; title: string; currentVersion: number }) => {
              if (saved) {
                setSaved({ ...saved, html, title, currentVersion });
              }
              setTitle(title);
              if (saved) setExperience(saved._id, html);
            }}
          />
        )}
      </div>

      {/* AI config dialog */}
      <Dialog open={aiConfigOpen} onOpenChange={setAiConfigOpen}>
        <DialogContent
          className="h-[min(640px,90vh)] w-[min(560px,95vw)] gap-0 overflow-hidden border-border  bg-background  p-0 [&>button:has(>span.sr-only)]:hidden"
        >
          <DialogHeader className="border-b border-border  px-5 py-3">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary/15 text-primary">
                <Settings2 className="h-3.5 w-3.5" />
              </span>
              <div>
                <DialogTitle className="text-base">AI provider</DialogTitle>
                <p className="text-xs text-muted-foreground ">
                  Pick a provider, paste your key, hit Test, then Save.
                </p>
              </div>
            </div>
          </DialogHeader>
          <div className="px-5 py-4">
            <AiConfigFormBody
              onConfiguredChange={(configured: boolean) => {
                // Reflect configured/unconfigured into the chip. The
                // dialog itself closes on Save (handled via the
                // separate onSaved callback), not here — closing on
                // every onConfiguredChange call from the load-on-mount
                // effect was making the dialog open-and-immediately-
                // close on the second open because the body was firing
                // onConfiguredChange(true) the moment it finished
                // loading the saved config.
                setConfigState(configured ? 'configured' : 'unconfigured');
              }}
              onSaved={() => setAiConfigOpen(false)}
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
