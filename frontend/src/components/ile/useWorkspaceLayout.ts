/**
 * Persisted layout state for the teacher ILE workspace.
 *
 * The teacher can leave the workspace and come back; their
 *   - which main tool is open (chat, history, assets, analytics)
 *   - whether the right-side inspector is open, and which tab
 *   - centre canvas view mode (code / split / preview)
 *   - editor/preview split ratio
 *   - word-wrap on/off
 * all stay where they were.
 *
 * Persistence is split across two keys:
 *   - `ile.workspace.layout.v3`        — drawers + inspector (one object)
 *   - `ile.workspace.viewMode`         — single string
 *   - `ile.workspace.wordWrap`         — single '0' / '1' string
 *
 * The viewMode + wordWrap keys are older (pre-v3) and were kept to
 * avoid wiping out teachers' existing settings during the v3 rollout.
 * Future layout additions should go in the v3 object.
 *
 * The hook returns the live state plus its setters — the workspace
 * uses them like any useState pair, but persistence is handled here
 * so the component doesn't accumulate localStorage glue.
 */
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { ActiveTool } from './WorkspaceChrome';
import type { ViewMode } from './EditorSplitPane';
import type { InspectorTabId } from './InspectorDrawer';

const LAYOUT_STORAGE_KEY = 'ile.workspace.layout.v3';
const VIEW_MODE_KEY = 'ile.workspace.viewMode';
const WORD_WRAP_KEY = 'ile.workspace.wordWrap';
/** Min/max % of canvas height the editor can occupy in split mode. */
const EDITOR_RATIO_MIN = 25;
const EDITOR_RATIO_MAX = 80;
const DEFAULT_EDITOR_RATIO = 58;
const PERSIST_DEBOUNCE_MS = 200;

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

export interface WorkspaceLayoutState {
  /** Main tool open in the left rail (chat / history / assets / analytics). */
  activeTool: ActiveTool;
  setActiveTool: Dispatch<SetStateAction<ActiveTool>>;
  /** Whether the right-side inspector drawer is visible. */
  inspectorOpen: boolean;
  setInspectorOpen: Dispatch<SetStateAction<boolean>>;
  /** Which inspector tab is active when the drawer is open. */
  inspectorTab: InspectorTabId;
  setInspectorTab: Dispatch<SetStateAction<InspectorTabId>>;
  /** Centre canvas view mode (code-only / split / preview-only). */
  viewMode: ViewMode;
  setViewMode: Dispatch<SetStateAction<ViewMode>>;
  /** Editor's % of the canvas height in split mode. Clamped to 25..80. */
  editorRatio: number;
  setEditorRatio: (r: number) => void;
  /** Word-wrap toggle in the editor toolbar. */
  wordWrap: boolean;
  setWordWrap: Dispatch<SetStateAction<boolean>>;
}

export function useWorkspaceLayout(): WorkspaceLayoutState {
  // ── Drawers + inspector (v3 object) ──────────────────────────────
  const [activeTool, setActiveTool] = useState<ActiveTool>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTabId>('details');
  const [editorRatio, setEditorRatioRaw] = useState<number>(DEFAULT_EDITOR_RATIO);

  // Hydrate v3 layout once on mount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
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
        setEditorRatioRaw(clamp(parsed.editorRatio, EDITOR_RATIO_MIN, EDITOR_RATIO_MAX));
      }
    } catch {
      /* ignore corrupted JSON */
    }
  }, []);

  // Debounced persist on v3-object changes. 200ms coalesces the burst
  // of setState calls that fire when the teacher opens the workspace.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const t = setTimeout(() => {
      try {
        window.localStorage.setItem(
          LAYOUT_STORAGE_KEY,
          JSON.stringify({ activeTool, inspectorOpen, inspectorTab, editorRatio }),
        );
      } catch {
        /* quota / private mode — ignore */
      }
    }, PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [activeTool, inspectorOpen, inspectorTab, editorRatio]);

  const setEditorRatio = (r: number) => setEditorRatioRaw(clamp(r, EDITOR_RATIO_MIN, EDITOR_RATIO_MAX));

  // ── viewMode + wordWrap (legacy single-key) ──────────────────────
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window === 'undefined') return 'split';
    const stored = window.localStorage.getItem(VIEW_MODE_KEY);
    if (stored === 'code' || stored === 'split' || stored === 'preview') {
      return stored as ViewMode;
    }
    return 'split';
  });
  const [wordWrap, setWordWrap] = useState<boolean>(
    () =>
      typeof window !== 'undefined' &&
      window.localStorage.getItem(WORD_WRAP_KEY) !== 'false',
  );

  // Persist viewMode + wordWrap immediately on change (small scalars,
  // no debounce needed).
  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_MODE_KEY, viewMode);
    } catch {
      /* ignore */
    }
  }, [viewMode]);
  useEffect(() => {
    try {
      window.localStorage.setItem(WORD_WRAP_KEY, wordWrap ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [wordWrap]);

  return {
    activeTool,
    setActiveTool,
    inspectorOpen,
    setInspectorOpen,
    inspectorTab,
    setInspectorTab,
    viewMode,
    setViewMode,
    editorRatio,
    setEditorRatio,
    wordWrap,
    setWordWrap,
  };
}
