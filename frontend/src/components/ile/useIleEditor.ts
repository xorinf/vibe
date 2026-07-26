import { useCallback, useEffect, useRef, useState } from 'react';
import {
  streamIleEdit,
  streamIleGeneration,
  type IleStreamEvent,
  getIleExperienceHistory,
  type IleHistoryTurn,
} from './ileApi';
import { resolveInstruction, type QuickActionId } from './quickActions';
import type { IleStreamState } from './useIleGeneration';
import type { AttachedAsset } from './AssetAttachments';
export type { AttachedAsset };

export interface ChatMessage extends IleHistoryTurn {
  /**
   * True when the message is in-flight (the SSE event source emitted a
   * 'reasoning' or 'html' for it but no 'done' yet). Lets the renderer
   * apply a streaming indicator per-message rather than globally.
   */
  inFlight?: boolean;
  /**
   * Optional stable id used by the React key strategy. New messages
   * minted in the editor hook get one; messages hydrated from server
   * history don't (we fall back to the role+createdAt composite).
   */
  _msgId?: string;
}

/**
 * Editor-specific state on top of the streaming hook. We deliberately
 * don't merge this with `useIleGeneration` — the streaming hook is a
 * transport, this hook is the editor's domain model. Keeping them
 * separate means undo/redo can sit on top of any future stream source
 * (WebSocket, polling, etc.) without restructuring the transport.
 */
export interface IleEditorState {
  /** Live stream state from the transport. */
  stream: IleStreamState;
  /** Full chat history, oldest first. Hydrated from server on mount. */
  messages: ChatMessage[];
  /**
   * Undo/redo stacks. Each entry is a snapshot of the html that
   * existed BEFORE the corresponding edit applied — so undoing replays
   * the previous HTML. Entries are user-pushed; redo is cleared on
   * every new edit.
   */
  undoStack: string[];
  redoStack: string[];
  /**
   * True between the user pressing "Apply" and the SSE stream finishing.
   * Mirrors stream.status but is exposed separately so the editor's
   * "Editing" badge is independent of any future transport changes.
   */
  editing: boolean;
  /**
   * True if a fresh apply has been requested but the previous stream
   * hasn't started yet. The UI uses this to show a tiny "queued" hint
   * — useful when the teacher mashes Apply twice.
   */
  pending: boolean;
  /**
   * Initial HTML to display before any edits have been applied. Used
   * to seed the preview on mount and to anchor the undo stack.
   */
  initialHtml: string;
  /**
   * True while no experience is bound (blank canvas). The chat pane
   * routes the first submit through generate() instead of send().
   */
  freshCanvas: boolean;
  /**
   * Course context — only set when the editor is in freshCanvas mode
   * so the first generate() can pass it through.
   */
  courseId?: string;
  courseVersionId?: string;
  itemId?: string;
  /**
   * Assets the teacher has attached via the Asset Manager. They ride
   * along on the next `send()` and are then cleared.
   */
  attachedAssets: AttachedAsset[];
}

export type IleEditorApi = UseIleEditorApi;
export interface UseIleEditorApi {
  state: IleEditorState;
  /**
   * Bind the editor to an existing experience (after hydration).
   * Idempotent — calling again resets undo/redo and the head.
   */
  setExperience: (experienceId: string, initialHtml: string) => void;
  /**
   * Configure the editor for blank-canvas mode. Subsequent send()
   * calls route through generate() (the create path) until
   * setExperience() is called.
   */
  setFreshCanvas: (ctx: { courseId: string; courseVersionId: string; itemId?: string }) => void;
  /**
   * Send a free-form edit. If the editor is in freshCanvas mode this
   * runs the create path; otherwise it runs the edit path.
   */
  send: (text: string) => Promise<void>;
  /**
   * Force a specific action. send() routes automatically based on
   * freshCanvas state — use this if you need to send a non-default
   * (e.g. force an edit on a loaded experience).
   */
  sendAsEdit: (text: string) => Promise<void>;
  sendAsGenerate: (text: string) => Promise<void>;
  /** Send a quick action by id (translation needs `followupValue`). */
  sendQuickAction: (id: QuickActionId, followupValue?: string) => Promise<void>;
  /** Cancel the in-flight stream. Returns to the last good state. */
  cancel: () => void;
  /**
   * Revert to the previous HTML snapshot. Pushes the current head onto
   * the redo stack. No-op when the undo stack is empty.
   */
  undo: () => void;
  /** Re-apply a previously-undone edit. No-op when the redo stack is empty. */
  redo: () => void;
  /**
   * Writer-side access to the latest-user-prompt ref. The chat pane
   * calls this on every submit so retry() always has a fresh string
   * to resend.
   */
  setLatestRetryPrompt: (prompt: string) => void;
  /** Attach an asset to the next `send()`. Multiple calls dedupe by id. */
  attachAsset: (asset: AttachedAsset) => void;
  /** Remove a single attached asset. */
  detachAsset: (id: string) => void;
  /** Drop all attached assets (typically after a successful send). */
  clearAttachedAssets: () => void;
  /**
   * Accept the most recent AI turn. The current `stream.html` becomes
   * the new baseline. No-op while streaming.
   */
  accept: () => void;
  /**
   * Reject the most recent AI turn. The chat pane wires the
   * manualHtml restore itself; this hook just signals the rejection.
   * No-op while streaming.
   */
  reject: () => void;
  /**
   * Re-send the user's most recent prompt against the current head.
   * Appends a fresh assistant bubble; the previous one stays in
   * history so the teacher can switch back via the diff toggle.
   */
  retry: () => Promise<void>;
  /**
   * Fork the conversation at a given message index. Trims all
   * messages after `index` and sets the editor back to the HTML
   * that was current at that turn. Used by the "Fork from here"
   * button on an assistant bubble.
   */
  forkFromIndex: (index: number) => void;
  /**
   * Hydrate the chat history from a previously-persisted snapshot.
   * The workspace calls this on mount when localStorage has a
   * saved session for the current experience.
   */
  hydrateMessages: (messages: ChatMessage[]) => void;
  /** True when an undo is available — for greying the toolbar button. */
  canUndo: boolean;
  /** True when a redo is available. */
  canRedo: boolean;
}

const MAX_HISTORY = 8; // chat bubbles shown at once
const MAX_UNDO = 50;  // undo/redo depth — generous, snaps don't accumulate fast

// Cheap monotonic-ish id for new chat messages. Good enough to anchor
// React keys; we don't need crypto-strength uniqueness.
function cryptoRandomId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Composable editor hook. Wraps the streaming transport and adds:
 *  - chat history (hydrated from server, kept in memory)
 *  - quick actions
 *  - undo/redo stacks
 *  - a stable handle for the workspace
 *
 * The workspace calls `setExperience(id, html)` once when the saved
 * experience is loaded; from then on, the editor owns the head state.
 */
export function useIleEditor(): UseIleEditorApi {
  const [stream, setStream] = useState<IleStreamState>({
    html: '',
    progress: [],
    reasoning: false,
    status: 'idle',
  });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [initialHtml, setInitialHtml] = useState('');
  const [freshCanvas, setFreshCanvasState] = useState(false);
  const [courseId, setCourseId] = useState<string | undefined>(undefined);
  const [courseVersionId, setCourseVersionId] = useState<string | undefined>(undefined);
  const [itemId, setItemId] = useState<string | undefined>(undefined);
  const [attachedAssets, setAttachedAssets] = useState<AttachedAsset[]>([]);

  // Refs that need to survive without triggering re-renders.
  const cancelRef = useRef<(() => void) | null>(null);
  const experienceIdRef = useRef<string | null>(null);
  // The html the preview should render right now. We do NOT use the
  // stream's html directly because the preview should keep showing the
  // last good artifact while a new edit streams in.
  const headHtmlRef = useRef<string>('');
  // The assistant message id currently being filled by the SSE stream.
  const inFlightMsgIdRef = useRef<string | null>(null);
  // Track the experienceId we last hydrated for, to avoid refetching.
  const hydratedForRef = useRef<string | null>(null);
  // Track the freshCanvas state for send() routing without re-rendering.
  const freshCanvasRef = useRef(false);
  const courseIdRef = useRef<string | undefined>(undefined);
  const courseVersionIdRef = useRef<string | undefined>(undefined);
  const itemIdRef = useRef<string | undefined>(undefined);

  // ───────────────────────────────────────────────────────────────────
  // setExperience: called by the workspace once on mount.
  const setExperience = useCallback(
    (experienceId: string, html: string) => {
      experienceIdRef.current = experienceId;
      headHtmlRef.current = html;
      setInitialHtml(html);
      setStream((s) => ({ ...s, html, status: 'idle' }));
      setUndoStack([]);
      setRedoStack([]);
      setMessages([]);
      setEditing(false);
      setPending(false);
      setFreshCanvasState(false);
      freshCanvasRef.current = false;
    },
    [],
  );

  // ───────────────────────────────────────────────────────────────────
  // setFreshCanvas: switch the editor into fresh-canvas mode so the
  // next send() runs through generate() (the create path) instead of
  // edit(). Called by the workspace on mount of a brand-new
  // experience.
  const setFreshCanvas = useCallback(
    (ctx: { courseId: string; courseVersionId: string; itemId?: string }) => {
      setCourseId(ctx.courseId);
      setCourseVersionId(ctx.courseVersionId);
      setItemId(ctx.itemId);
      courseIdRef.current = ctx.courseId;
      courseVersionIdRef.current = ctx.courseVersionId;
      itemIdRef.current = ctx.itemId;
      setFreshCanvasState(true);
      freshCanvasRef.current = true;
      setStream({
        html: '',
        progress: [],
        reasoning: false,
        status: 'idle',
      });
    },
    [],
  );

  // ───────────────────────────────────────────────────────────────────
  // Hydration: pull server-side history once per experience.
  useEffect(() => {
    if (!experienceIdRef.current) return;
    if (hydratedForRef.current === experienceIdRef.current) return;
    const id = experienceIdRef.current;
    hydratedForRef.current = id;
    (async () => {
      try {
        const res = await getIleExperienceHistory(id);
        setMessages(res.history ?? []);
      } catch (err) {
        // Non-fatal — the editor just starts with an empty thread.
        console.warn('[ILE] history fetch failed', err);
      }
    })();
  }, [initialHtml]); // re-run whenever a fresh experience is loaded

  // ───────────────────────────────────────────────────────────────────
  // send (router): dispatches to generate() or edit() based on state.
  // Plus sendAsEdit / sendAsGenerate for explicit routing.
  //
  // Edit path takes the existing head HTML and a new instruction; the
  // backend preserves everything except the change requested.
  // Generate path takes a fresh prompt; the backend produces a brand-new
  // experience and assigns an id once the stream completes.
  //
  // The SSE event-shape contract is identical for both — that's why we
  // can share the bridge.

  const startEditStream = useCallback(
    (args: { kind: 'edit'; experienceId: string; prompt: string } | { kind: 'generate'; prompt: string; courseId: string; courseVersionId: string; itemId?: string }) => {
      cancelRef.current?.();
      setUndoStack((s) => {
        const next = [...s, headHtmlRef.current];
        return next.length > MAX_UNDO ? next.slice(-MAX_UNDO) : next;
      });
      setRedoStack([]); // any new edit invalidates redo

      // Use a stable id per message so React doesn't shuffle the chat
      // thread on every streaming update. Assembling messages get an
      // explicit id; replayed history messages fall back to a content-
      // anchored id generated server-side is a future improvement.
      //
      // If the teacher has attached assets, we add a "Attached assets"
      // footer to the user message so the chat bubble shows what's
      // riding along on this turn. The asset URLs are also injected into
      // the prompt body so the AI can reference them in its reply.
      const assetFooter =
        attachedAssets.length > 0
          ? `\n\nAttached assets:\n${attachedAssets
              .map((a) => `- [${a.kind}] ${a.filename}: ${a.url}`)
              .join('\n')}`
          : '';
      const userMsg: ChatMessage = {
        role: 'user',
        content: args.prompt + assetFooter,
        createdAt: new Date().toISOString(),
      };
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: '…',
        createdAt: new Date().toISOString(),
        inFlight: true,
      };
      inFlightMsgIdRef.current = 'assistant';
      setMessages((m) => [
        ...m,
        { ...userMsg, _msgId: cryptoRandomId() },
        { ...assistantMsg, _msgId: 'inFlight' },
      ]);

      // Attached assets are one-shot — they ride along on this turn and
      // then clear. The teacher can re-attach if needed.
      if (attachedAssets.length > 0) setAttachedAssets([]);

      setStream({
        html: headHtmlRef.current, // preserve current preview during stream
        progress: [],
        reasoning: false,
        status: 'streaming',
        lastDeltaAt: Date.now(),
        experienceId:
          args.kind === 'edit' ? args.experienceId : undefined,
        truncated: false,
      });
      setEditing(true);
      setPending(false);

      const onEvent = (ev: IleStreamEvent) => {
        setStream((prev) => {
          switch (ev.kind) {
            case 'start':
              return { ...prev, experienceId: ev.experienceId };
            case 'progress':
              if (prev.progress.includes(ev.message)) return prev;
              return {
                ...prev,
                progress: [...prev.progress, ev.message].slice(-8),
                lastProgress: ev.message,
                reasoning: false,
              };
            case 'reasoning':
              return { ...prev, reasoning: true };
            case 'html':
              setMessages((ms) =>
                ms.map((m) =>
                  m.inFlight
                    ? { ...m, html: (m.html ?? '') + ev.delta }
                    : m,
                ),
              );
              return {
                ...prev,
                html: prev.html + ev.delta,
                reasoning: false,
                lastDeltaAt: Date.now(),
              };
            case 'done':
              headHtmlRef.current = ev.html;
              experienceIdRef.current = ev.experienceId;
              setMessages((ms) =>
                ms.map((m) =>
                  m.inFlight
                    ? {
                        ...m,
                        html: ev.html || m.html,
                        content: ev.truncated
                          ? 'Applied (response was truncated — try a shorter prompt)'
                          : 'Edit applied',
                        inFlight: false,
                      }
                    : m,
                ),
              );
              inFlightMsgIdRef.current = null;
              return {
                ...prev,
                status: 'done',
                html: ev.html || prev.html,
                experienceId: ev.experienceId,
                reasoning: false,
                truncated: ev.truncated ?? prev.truncated,
              };
            case 'error':
              setMessages((ms) =>
                ms.map((m) =>
                  m.inFlight
                    ? { ...m, content: `Error: ${ev.message}`, inFlight: false }
                    : m,
                ),
              );
              inFlightMsgIdRef.current = null;
              return {
                ...prev,
                status: 'error',
                error: ev.message,
                reasoning: false,
              };
          }
        });
      };

      const cancelStream =
        args.kind === 'edit'
          ? streamIleEdit(
              { experienceId: args.experienceId, prompt: args.prompt },
              onEvent,
            )
          : streamIleGeneration(
              {
                prompt: args.prompt,
                courseId: args.courseId,
                courseVersionId: args.courseVersionId,
                itemId: args.itemId,
              },
              onEvent,
            );
      cancelRef.current = cancelStream;
    },
    [],
  );

  const sendAsEdit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const experienceId = experienceIdRef.current;
      if (!experienceId) return;
      if (stream.status === 'streaming') {
        setPending(true);
        return;
      }
      startEditStream({ kind: 'edit', experienceId, prompt: trimmed });
    },
    [stream.status, startEditStream],
  );

  const sendAsGenerate = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (stream.status === 'streaming') {
        setPending(true);
        return;
      }
      const cId = courseIdRef.current;
      const cVId = courseVersionIdRef.current;
      if (!cId || !cVId) return;
      startEditStream({
        kind: 'generate',
        prompt: trimmed,
        courseId: cId,
        courseVersionId: cVId,
        itemId: itemIdRef.current,
      });
    },
    [stream.status, startEditStream],
  );

  const send = useCallback(
    async (text: string) => {
      if (freshCanvasRef.current) {
        return sendAsGenerate(text);
      }
      return sendAsEdit(text);
    },
    [sendAsGenerate, sendAsEdit],
  );

  const attachAsset = useCallback((asset: AttachedAsset) => {
    setAttachedAssets((prev) =>
      prev.find((a) => a.id === asset.id) ? prev : [...prev, asset],
    );
  }, []);

  const detachAsset = useCallback((id: string) => {
    setAttachedAssets((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clearAttachedAssets = useCallback(() => {
    setAttachedAssets([]);
  }, []);

  // ───────────────────────────────────────────────────────────────────
  // Accept / Reject / Retry / Fork / Hydrate
  //
  // These four operations form the "version control" surface of the
  // chat. They all read/write through the same `headHtmlRef` and
  // `messages` state so the preview stays consistent regardless of
  // which action the teacher took.

  /** Accept: snapshot the current stream.html as the new baseline.
   * The chat pane is responsible for clearing any diff hints in the
   * UI. */
  const accept = useCallback(() => {
    setStream((s) => {
      if (s.status === 'streaming') return s;
      return s;
    });
  }, []);

  /** Reject: the workspace owns the manualHtml reset; the hook just
   * signals the rejection so the chat pane can clear UI state. */
  const reject = useCallback(() => {
    setStream((s) => {
      if (s.status === 'streaming') return s;
      return s;
    });
  }, []);

  /**
   * Ref to the latest user-submitted prompt. Updated on every send
   * (callers must do this — the chat pane owns the onSubmit flow).
   * `retry()` reads this ref so the teacher can re-send without the
   * retry having to know about React state ordering.
   */
  const latestRetryPromptRef = useRef<string>('');

  /** Retry: re-send the most recent user message. */
  const retry = useCallback(async () => {
    const latest = latestRetryPromptRef.current;
    if (!latest) return;
    await send(latest);
  }, [send]);

  /** Fork: trim the messages array at `index` and rewind the head
   * to the HTML the teacher was looking at before that turn. The
   * chat pane owns the manualHtml reset; we just trim messages. */
  const forkFromIndex = useCallback((index: number) => {
    setMessages((ms) => ms.slice(0, index));
  }, []);

  /** Hydrate messages from a persisted snapshot (called by the
   * workspace on mount with a localStorage-loaded list). */
  const hydrateMessages = useCallback((persisted: ChatMessage[]) => {
    setMessages(persisted);
  }, []);

  /**
   * Writer-side access to the latest-user-prompt ref. The chat pane
   * calls this on every submit so retry() always has a fresh
   * string to resend.
   */
  const setLatestRetryPrompt = useCallback((prompt: string) => {
    latestRetryPromptRef.current = prompt;
  }, []);

  const sendQuickAction = useCallback(
    async (id: QuickActionId, followupValue?: string) => {
      const instruction = resolveInstruction(id, followupValue);
      if (!instruction) return;
      await send(instruction);
    },
    [send],
  );

  // ───────────────────────────────────────────────────────────────────
  // Cancel

  const cancel = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    setStream((s) => ({ ...s, status: 'idle', reasoning: false }));
    setEditing(false);
    setPending(false);
    // Any in-flight message becomes a "cancelled" placeholder.
    setMessages((ms) =>
      ms.map((m) =>
        m.inFlight
          ? { ...m, content: 'Cancelled', inFlight: false }
          : m,
      ),
    );
    inFlightMsgIdRef.current = null;
  }, []);

  // ───────────────────────────────────────────────────────────────────
  // Undo / Redo
  //
  // Local-only state changes. They don't create new server versions.
  // When the teacher eventually saves, the current head becomes one
  // version snapshot.
  const undo = useCallback(() => {
    setUndoStack((stack) => {
      if (stack.length === 0) return stack;
      const previous = stack[stack.length - 1];
      setRedoStack((r) => {
        const next = [...r, headHtmlRef.current];
        return next.length > MAX_UNDO ? next.slice(-MAX_UNDO) : next;
      });
      headHtmlRef.current = previous;
      setStream((s) => ({ ...s, html: previous, status: 'done' }));
      // Append an assistant bubble so the chat reflects the rollback.
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          content: 'Reverted to the previous version',
          html: previous,
          createdAt: new Date().toISOString(),
        },
      ]);
      return stack.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setRedoStack((stack) => {
      if (stack.length === 0) return stack;
      const next = stack[stack.length - 1];
      setUndoStack((u) => {
        const arr = [...u, headHtmlRef.current];
        return arr.length > MAX_UNDO ? arr.slice(-MAX_UNDO) : arr;
      });
      headHtmlRef.current = next;
      setStream((s) => ({ ...s, html: next, status: 'done' }));
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          content: 'Re-applied the previous edit',
          html: next,
          createdAt: new Date().toISOString(),
        },
      ]);
      return stack.slice(0, -1);
    });
  }, []);

  // ───────────────────────────────────────────────────────────────────
  // P1-4: clear the cancelRef on terminal stream states so the
  // polyfill's onerror retry path (which checks cancelRef.current)
  // can no-op once the server has confirmed done or error. The
  // connection itself is closed by bindIleStream (ileApi.ts).
  useEffect(() => {
    if (stream.status === 'done' || stream.status === 'error') {
      cancelRef.current = null;
    }
  }, [stream.status]);

  // ───────────────────────────────────────────────────────────────────
  // Cancellation on unmount
  useEffect(() => {
    return () => {
      cancelRef.current?.();
      cancelRef.current = null;
    };
  }, []);

  return {
    state: {
      stream,
      messages: messages.slice(-MAX_HISTORY),
      undoStack,
      redoStack,
      editing,
      pending,
      initialHtml,
      freshCanvas,
      courseId,
      courseVersionId,
      itemId,
      attachedAssets,
    },
    setExperience,
    setFreshCanvas,
    send,
    sendAsEdit,
    sendAsGenerate,
    sendQuickAction,
    cancel,
    undo,
    redo,
    attachAsset,
    detachAsset,
    clearAttachedAssets,
    accept,
    reject,
    retry,
    forkFromIndex,
    hydrateMessages,
    setLatestRetryPrompt,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
  };
}