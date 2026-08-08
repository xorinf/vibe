/**
 * CodeMirror 6 wrapper used by the centre canvas.
 *
 * Exposes a `CodeEditorHandle` imperative API (getValue / setValue /
 * search / find next) so the parent (`EditorSplitPane` /
 * `TeacherILEWorkspace`) can drive the editor without owning
 * CodeMirror state itself.
 *
 * Re-themes itself when the `<html class="dark">` toggle flips
 * (mutation observer), so dark/light mode switches are reflected
 * without a remount.
 */
import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';

/**
 * Tagged `userEvent` for transactions the ILE wrapper dispatches
 * itself (the live-stream sync effect and the AI's accept/reject).
 * The `updateListener` checks for this tag so it can skip the
 * `onChange` re-emit — without the tag, every programmatic
 * dispatch would round-trip to the parent as a "user edit" and
 * freeze `manualHtml` at the first streaming delta (the rest of
 * the stream would then never reach the editor).
 */
const ILE_PROGRAMMATIC_USER_EVENT = 'ile.programmatic';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
// ponytail: html() extension is disabled by default to avoid the
// @lezer/html parser-throw on partial streaming input. The import is
// kept via this comment in case a future change wants to re-enable it.
// import { html } from '@codemirror/lang-html';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';

// ─────────────────────────────────────────────────────────────────────
// Theme tokens — read live from the parent's CSS custom properties so
// the editor matches whatever theme the page is in. We resolve at
// mount time AND subscribe to the `.dark` class toggle so a hot
// theme change re-themes without remounting the editor.
//
// Hard-coding hex values here was the source of the "white lines in
// dark mode" bug — the active-line highlight (#f1f5f9) bled through
// as a glaring band, and the gutter border (#e2e8f0) was visible on
// a dark surface. Using `hsl(var(--…) / alpha)` lets CodeMirror
// inherit the platform palette without us re-declaring values.
// ─────────────────────────────────────────────────────────────────────

/** Pull a token's current value from `:root` (or `.dark` if active). */
function readCssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const style = getComputedStyle(document.documentElement);
  const raw = style.getPropertyValue(name).trim();
  return raw || fallback;
}

/**
 * Resolve the HSL triple (e.g. `0 0% 100%`) for a token and optionally
 * wrap it with an alpha. CodeMirror's theme API accepts any CSS color,
 * so we hand it `hsl(var(--token) / alpha)` which is exactly what
 * Tailwind v4 produces internally.
 */
function tokenColor(name: string, alpha?: number): string {
  const hsl = readCssVar(name, '0 0% 50%');
  return alpha === undefined
    ? `hsl(${hsl})`
    : `hsl(${hsl} / ${alpha})`;
}

/**
 * Build the per-theme configuration CodeMirror needs. Called once
 * initially, and again whenever `<html class="dark">` toggles.
 */
function buildThemeSpec(isDark: boolean) {
  // Active-line highlight: in light mode a near-white wash on the
  // editor surface; in dark mode a slightly-lighter wash on the
  // dark editor body. Using muted/30 keeps the highlight visible
  // without bleaching the row.
  const activeLine = isDark
    ? tokenColor('--muted', 0.35)
    : tokenColor('--muted', 0.7);
  const activeLineGutter = isDark
    ? tokenColor('--muted', 0.5)
    : tokenColor('--muted', 0.85);
  // Selection: a tinted wash in primary-soft.
  const selection = isDark
    ? tokenColor('--primary', 0.28)
    : tokenColor('--primary', 0.22);
  // Gutter border: a soft divider that mirrors --border but a
  // little darker so the gutter reads as a distinct column.
  const gutterBorder = tokenColor('--border', isDark ? 0.5 : 0.9);
  // Line-number color: muted enough to recede, legible enough to read.
  const lineNumberFg = tokenColor('--muted-foreground', isDark ? 0.7 : 1);
  // Caret: use the foreground token so it's visible against the
  // editor's own surface.
  const caret = tokenColor('--foreground', isDark ? 0.95 : 1);
  // Editor background: take from --card so it sits flush with the
  // wrapping card surface (matches the surrounding `bg-background`).
  const editorBg = isDark
    ? tokenColor('--card', 1)
    : tokenColor('--background', 1);

  return {
    spec: {
      '&': {
        height: '100%',
        fontSize: '13px',
        backgroundColor: editorBg,
        color: tokenColor('--foreground', 0.95),
      },
      '.cm-scroller': {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      '.cm-content': { padding: '8px 0', caretColor: caret },
      '.cm-gutters': {
        background: 'transparent',
        borderRight: `1px solid ${gutterBorder}`,
        color: lineNumberFg,
      },
      '.cm-activeLineGutter': {
        background: activeLineGutter,
        color: tokenColor('--foreground', isDark ? 0.9 : 0.8),
      },
      '.cm-activeLine': { background: activeLine },
      '.cm-selectionBackground, ::selection': { background: selection },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: caret },
      '.cm-searchMatch': {
        background: tokenColor('--warm', 0.25),
        outline: `1px solid ${tokenColor('--warm', 0.6)}`,
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        background: tokenColor('--warm', 0.45),
      },
    },
    isDark,
  };
}

// Two parallel HighlightStyles so syntax colors stay legible on both
// surfaces. Light mode = saturated mid-tones; dark mode = slightly
// desaturated + lighter to maintain contrast on a near-black surface.
const HTML_HIGHLIGHT_LIGHT = HighlightStyle.define([
  { tag: t.tagName, color: '#7c3aed' },
  { tag: t.attributeName, color: '#0ea5e9' },
  { tag: t.attributeValue, color: '#16a34a' },
  { tag: t.string, color: '#16a34a' },
  { tag: t.comment, color: '#94a3b8', fontStyle: 'italic' },
  { tag: t.content, color: '#334155' },
  { tag: t.heading, color: '#0f172a', fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.link, color: '#2563eb', textDecoration: 'underline' },
  { tag: t.url, color: '#2563eb' },
  { tag: t.invalid, color: '#dc2626' },
]);

const HTML_HIGHLIGHT_DARK = HighlightStyle.define([
  // Slightly brighter than the light-mode palette so the syntax
  // tokens still pop against the dark `--card` surface.
  { tag: t.tagName, color: '#a78bfa' },
  { tag: t.attributeName, color: '#7dd3fc' },
  { tag: t.attributeValue, color: '#86efac' },
  { tag: t.string, color: '#86efac' },
  { tag: t.comment, color: '#64748b', fontStyle: 'italic' },
  { tag: t.content, color: '#cbd5e1' },
  { tag: t.heading, color: '#f1f5f9', fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.link, color: '#93c5fd', textDecoration: 'underline' },
  { tag: t.url, color: '#93c5fd' },
  { tag: t.invalid, color: '#fca5a5' },
]);

export interface CodeEditorHandle {
  /** Set the editor contents (no-op if the value already matches). */
  setValue: (html: string) => void;
  /** Focus the editor. */
  focus: () => void;
  /** Read the current contents. */
  getValue: () => string;
  /** Format the current document (the toolbar's "Format" button). */
  format: () => void;
  /**
   * Open the search panel. Used by ⌘F and the toolbar Find button.
   */
  openSearch: () => void;
}

/**
 * Lightweight, code-editor-grade HTML editor.
 *
 * Wraps CodeMirror 6 with the right extension set for our use case:
 * bracket matching, indent-on-input, fold-gutter, line numbers, search
 * (Ctrl+F), undo history (Ctrl+Z), and HTML syntax highlighting tuned
 * for tag/attribute/attribute-value/string/comment differentiation.
 *
 * The component is fully controlled-by-value (the parent owns the
 * HTML). When the AI generates new HTML we set it via the imperative
 * `setValue` handle; when the teacher types we surface the change via
 * `onChange` (debounced upstream by the workspace).
 *
 * Refs handle the imperative surface (focus / setValue / openSearch).
 * External callers get the `useImperativeHandle` interface so they
 * don't have to know CM internals.
 */
export interface CodeEditorProps {
  /** The current HTML to display. Parent owns this. */
  value: string;
  /** Called on every edit. Parent should debounce. */
  onChange?: (next: string) => void;
  /** When true, long lines wrap at the viewport edge. */
  wordWrap?: boolean;
  /** Imperative handle for the parent. */
  handleRef?: Ref<CodeEditorHandle>;
  /** Optional className for the wrapper. */
  className?: string;
  /** Optional aria-label for screen readers. */
  'aria-label'?: string;
  /**
   * Disables the editor — the iframe preview stays interactive. Used
   * while the AI is streaming so manual edits don't fight the stream.
   */
  readOnly?: boolean;
  /**
   * Fired when the user explicitly invokes the in-editor search
   * panel (Ctrl+F). The default is the CodeMirror-native panel; we
   * expose this so the workspace can also surface its own "Find" button.
   */
  onSearchOpen?: () => void;
}

// The active highlight style is chosen at mount + on theme toggle
// (see `themeCompartment` / `highlightCompartment` below). The two
// `HTML_HIGHLIGHT_*` constants above are the source of truth for
// the per-theme palettes.

export function CodeEditor({
  value,
  onChange,
  wordWrap = true,
  handleRef,
  className,
  'aria-label': ariaLabel = 'Experience HTML source',
  readOnly = false,
  onSearchOpen,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Track the value we last set into the editor so onChange doesn't
  // bounce-set the same value back.
  const lastSetRef = useRef<string>(value);
  // The exceptionSink re-dispatches the doc to recover from the
  // rollback that happens before the sink fires. The re-dispatch
  // needs the CURRENT value, not the value at mount time — the
  // stream might have advanced by the time the sink fires. The
  // value-sync effect writes the latest value here on every render,
  // and the sink reads it when it has to re-dispatch.
  const liveValueRef = useRef<string>(value);
  // Compartment re-creates per configuration change without rebuilding
  // the entire editor state.
  const wrapCompartment = useMemo(() => new Compartment(), []);
  const readOnlyCompartment = useMemo(() => new Compartment(), []);
  // Theme + highlight compartments — re-configurable so a hot theme
  // toggle re-themes the editor without remounting it.
  const themeCompartment = useMemo(() => new Compartment(), []);
  const highlightCompartment = useMemo(() => new Compartment(), []);

  // Returns whether the parent page is currently in dark mode.
  const readDark = () =>
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('dark');

  // Build the initial state once. Re-builds on remount only — that
  // never happens in practice because the parent keeps the ref stable.
  useEffect(() => {
    if (!hostRef.current) return;

    const updateListener = EditorView.updateListener.of((v) => {
      if (v.docChanged) {
        const next = v.state.doc.toString();
        // Belt-and-suspenders alongside the userEvent-tag check.
        // If the new doc equals the value we just set programmatically
        // (via the value-prop sync effect or the imperative setValue
        // handle), no real user edit happened — skip onChange
        // unconditionally. This is more robust than the
        // `every(userEvent)` check because CM batches extension
        // transactions (autocompletion, search, highlight, state-
        // field updates from @lezer/html) into the same update tick
        // and ANY non-tagged transaction would defeat the userEvent
        // filter. The identity check is the canonical guard.
        //
        // CRITICAL: do NOT assign `lastSetRef.current` here. The
        // listener should only READ lastSetRef (set by the dispatch
        // sites); writing here would mask real user edits.
        if (next === lastSetRef.current) return;
        // Secondary filter: every transaction tagged as our own
        // programmatic write. Catches edge cases where the new doc
        // doesn't equal lastSetRef (e.g. an extension mutated it)
        // AND the only transactions in the update are ours.
        const onlyProgrammatic = v.transactions.every((t) =>
          t.isUserEvent(ILE_PROGRAMMATIC_USER_EVENT),
        );
        if (onlyProgrammatic) return;
        onChange?.(next);
      }
    });

    const isDark = readDark();
    const { spec: themeSpec } = buildThemeSpec(isDark);

    // Probe the @lezer/html parser before mounting the editor. The
    // `html()` extension registers a state field that re-parses on
    // every doc change; for some AI-generated content with deeply
    // nested `<style>` blocks + inline event handlers, the parser
    // can throw an uncatchable `Cannot read properties of undefined`
    // inside its tree walker. Rather than crash the editor and fall
    // back to a plain `<textarea>` (which loses the dark-mode
    // theme + line numbers + history), we detect the failure mode
    // and skip the parser entirely. The teacher still gets a fully
    // functional editor with all the platform theme tokens applied,
    // they just lose colorized syntax tokens — a fair trade vs the
    // textarea fallback.
    // Runtime parser guard. The @lezer/html parser is an
    // incremental LR parser that throws inside its tree balancer
    // when given a partial / invalid document — `undefined is not
    // an object (evaluating 'children.length')` shows up at the
    // 29k-char threshold on AI streams that emit `` thinking
    // blocks inline, style tags with unescaped chars, or anything
    // else the grammar doesn't like. A static mount-time probe
    // doesn't catch this because the parser doesn't throw on init
    // — it throws on every incremental reparse while the stream
    // is going. We register an `exceptionSink` that swaps the
    // `html()` extension out of its compartment the first time the
    // library catches an exception. The teacher keeps a fully
    // functional editor with all the other extensions — they just
    // lose syntax highlighting for the rest of the session, which
    // is the same trade the probe was making.
    // Runtime parser guard — see the catch handler below. `exceptionSink`
    // is a CodeMirror Facet, so we register it through `extensions`,
    // not as a property of the `EditorView({})` config (which JS
    // silently ignores and which TS rightly flagged).
    let htmlParserDisabled = false;
    const htmlLangCompartment = new Compartment();

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        foldGutter(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        drawSelection(),
        highlightSelectionMatches(),
        themeCompartment.of(EditorView.theme(themeSpec)),
        highlightCompartment.of(
          syntaxHighlighting(isDark ? HTML_HIGHLIGHT_DARK : HTML_HIGHLIGHT_LIGHT, { fallback: true }),
        ),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        // HTML syntax highlighting (tags/attrs/strings/comments).
        // Wrapped in a compartment so we can swap it out mid-session
        // if the parser starts throwing on the streaming input.
        //
        // ponytail: start disabled. The @lezer/html parser throws
        // `undefined is not an object (evaluating 'this._tree_
        // .children.length')` on partial streaming input — the
        // throw propagates to the React error boundary, which
        // collapses the editor to a plain <textarea> and loses
        // the dark-mode theme + line numbers + history. The
        // exceptionSink DOES fire on the dispatcher path, but
        // the parser throws BEFORE the sink in some cases (the
        // sink can't catch what the parser already threw). The
        // robust fix: don't enable the parser at all. The ILE
        // streaming edits are read-only while they're happening,
        // so the teacher never sees syntax highlighting during a
        // stream anyway. The compartment is left in the
        // extensions list (stubbed) so the exceptionSink can
        // reconfigure it without a remount if a future change
        // wants to re-enable it.
        htmlLangCompartment.of([]),
        // CodeMirror-level exception sink. JS silently drops
        // properties the EditorView constructor doesn't know about
        // — we have to register the sink via this Facet or the
        // parser-throw fallback never fires.
        EditorView.exceptionSink.of((exception: unknown) => {
          if (!htmlParserDisabled) {
            // First throw: swap the html() extension out of its
            // compartment so the next dispatches don't re-throw.
            // The dispatch's *changes* were already rolled back
            // by CM before the sink fires — without the re-dispatch
            // below, the doc stays at the OLD value (often empty)
            // and the editor appears blank even though React
            // state has 11k+ chars. The fix is to re-dispatch the
            // doc with the current view.value AFTER the rebuild
            // so the doc catches up to what React intended.
            htmlParserDisabled = true;
            try {
              view.dispatch({
                effects: htmlLangCompartment.reconfigure([]),
                userEvent: ILE_PROGRAMMATIC_USER_EVENT,
              });
            } catch {
              /* view torn down */
            }
          }
          // The dispatch's changes were rolled back by CM before
          // the sink fires. Re-dispatch the live target value as
          // a plain-text replacement so the doc catches up to
          // React state. The compartment swap above already
          // removed the html() extension, so this re-dispatch
          // should not throw.
          try {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: liveValueRef.current ?? '' },
              userEvent: ILE_PROGRAMMATIC_USER_EVENT,
            });
          } catch {
            /* view torn down mid-stream */
          }
          // eslint-disable-next-line no-console
          console.warn(
            '[CodeEditor] @lezer/html parser threw; disabling HTML syntax highlighting for this session.',
            exception,
          );
        }),
        autocompletion(),
        // Word-wrap is a compartment so toggling it doesn't reset the
        // document. We seed the initial value to whatever the parent
        // wants so the first render matches.
        wrapCompartment.of(wordWrap ? EditorView.lineWrapping : []),
        // Read-only compartment — same trick.
        readOnlyCompartment.of(readOnly ? [EditorState.readOnly.of(true)] : []),
        updateListener,
      ],
    });

    const view = new EditorView({
      state,
      parent: hostRef.current,
      // Catch any exception thrown by the @lezer/html parser during
      // an incremental reparse — the parser can throw inside its
      // tree balancer when given partial / malformed streaming
      // input, and the throw is otherwise uncatchable (it would
      // propagate to the React error boundary and replace the
      // editor with a plain `<textarea>`). When we catch one, we
      // swap the `html()` extension out of its compartment so the
      // parser is gone for the rest of the session — the editor
      // keeps every other extension (line numbers, theme, history,
      // search, autocompletion) and just loses syntax highlighting.
      // The swap is idempotent — once disabled it stays disabled.
      //
      // `exceptionSink` is a CM Facet, NOT a direct config option —
      // pass it via `extensions` instead of as a property of the
      // `EditorView({})` arg. The previous code passed it as a
      // property, which TypeScript flagged but JavaScript silently
      // dropped — the parser-throw fallback then NEVER fired and
      // the React error boundary took over, dropping the editor
      // down to the textarea fallback.
    });
    viewRef.current = view;
    lastSetRef.current = value;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // We intentionally only build the state once. `value` and the
    // other props are synced through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-theme when the parent's `.dark` class toggles. We use a
  // MutationObserver so the change is detected even when the toggle
  // happens outside this component (e.g. the global theme button).
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const target = document.documentElement;
    const apply = () => {
      const view = viewRef.current;
      if (!view) return;
      const isDark = readDark();
      const { spec } = buildThemeSpec(isDark);
      view.dispatch({
        effects: [
          themeCompartment.reconfigure(EditorView.theme(spec)),
          highlightCompartment.reconfigure(
            syntaxHighlighting(isDark ? HTML_HIGHLIGHT_DARK : HTML_HIGHLIGHT_LIGHT, { fallback: true }),
          ),
        ],
      });
    };
    const observer = new MutationObserver(apply);
    observer.observe(target, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [themeCompartment, highlightCompartment]);

  // Sync `value` → editor content. Use a transaction so the change
  // doesn't trigger a re-emit through onChange.
  //
  // We tag the dispatch with `userEvent: 'ile.programmatic'` so
  // the updateListener can distinguish our own writes from a user
  // typing in the editor and skip the onChange call. Without the
  // tag, the listener would round-trip every dispatch back to
  // the parent as a "user edit", which would set `manualHtml` to
  // the current stream html and freeze the editor at that snapshot
  // (the next stream delta would never reach the editor because
  // `effectiveHtml` resolves to `manualHtml` first).
  //
  // Performance: streaming HTML into a CodeMirror doc by replacing
  // the whole content on every delta is O(n²)-ish — every dispatch
  // re-parses the entire accumulated doc through `@lezer/html`.
  // For a 39k-char stream with ~1700 deltas that's ~67M parser
  // operations. To keep this fast, we do an incremental INSERT
  // whenever the new `value` is a strict extension of the
  // current doc content. Falls back to the full replace only on
  // the first delta or when the docs diverge (e.g. the user typed
  // something and the model's snapshot doesn't match).
  useEffect(() => {
    const view = viewRef.current;
    // Keep the sink's recovery buffer in sync with the latest value
    // so the exceptionSink can re-dispatch the current target after
    // a parser-throw rollback.
    liveValueRef.current = value;
    if (!view) return;
    if (value === undefined || value === lastSetRef.current) return;
    const prev = view.state.doc.toString();
    try {
      if (prev.length > 0 && value.startsWith(prev)) {
        // Incremental append — insert the new tail only.
        const tail = value.slice(prev.length);
        view.dispatch({
          changes: { from: prev.length, insert: tail },
          userEvent: ILE_PROGRAMMATIC_USER_EVENT,
        });
      } else {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: value ?? '' },
          userEvent: ILE_PROGRAMMATIC_USER_EVENT,
        });
      }
      // Only stamp lastSetRef AFTER the dispatch lands. If the
      // dispatch rolls back (e.g. @lezer/html throws inside the
      // reparse, which the exceptionSink Facet handles separately),
      // the doc is unchanged and lastSetRef must stay equal to
      // the doc content, not the attempted value — otherwise the
      // sync effect's identity check at the top would skip the
      // NEXT delta (the bug the previous fix already addressed).
      lastSetRef.current = value;
    } catch (err) {
      // The dispatch can throw for two distinct reasons:
      //   (a) the view is being torn down — nothing to do, the
      //       next mount will rebuild the editor from the parent's
      //       value.
      //   (b) the @lezer/html parser threw on the streamed input
      //       — the editor's exceptionSink re-dispatches the doc
      //       to recover the rollback, so the doc is now in sync
      //       with the value we just tried. Mark lastSetRef as
      //       updated so the NEXT value's effect doesn't get
      //       confused by a stale compare flag.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/destroy|destroyed|removed/i.test(msg)) {
        lastSetRef.current = value;
      }
    }
  }, [value]);

  // Sync `wordWrap` → compartment.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: wrapCompartment.reconfigure(
        wordWrap ? EditorView.lineWrapping : [],
      ),
    });
  }, [wordWrap, wrapCompartment]);

  // Sync `readOnly` → compartment.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(
        readOnly ? [EditorState.readOnly.of(true)] : [],
      ),
    });
  }, [readOnly, readOnlyCompartment]);

  // Imperative surface for the parent.
  useImperativeHandle(
    handleRef,
    () => ({
      setValue: (next: string) => {
        const view = viewRef.current;
        if (!view) return;
        if (next === lastSetRef.current) return;
        // Incremental append when the new value extends the current
        // doc — much cheaper than a full replace for large streaming
        // payloads. Falls back to replace when the docs diverge.
        const prev = view.state.doc.toString();
        try {
          if (prev.length > 0 && next.startsWith(prev)) {
            view.dispatch({
              changes: { from: prev.length, insert: next.slice(prev.length) },
              userEvent: ILE_PROGRAMMATIC_USER_EVENT,
            });
          } else {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: next },
              userEvent: ILE_PROGRAMMATIC_USER_EVENT,
            });
          }
          // Only stamp lastSetRef AFTER the dispatch lands. If
          // the dispatch rolls back (e.g. @lezer/html throws
          // inside the reparse, which the exceptionSink Facet
          // handles separately), the doc is unchanged and
          // lastSetRef must stay equal to the doc content, not
          // the attempted value.
          lastSetRef.current = next;
        } catch {
          // The dispatch itself can throw if the view is being
          // torn down. Don't update lastSetRef in that case.
        }
      },
      focus: () => {
        viewRef.current?.focus();
      },
      getValue: () => viewRef.current?.state.doc.toString() ?? '',
      format: () => {
        const view = viewRef.current;
        if (!view) return;
        const formatted = formatHtml(view.state.doc.toString());
        if (formatted === view.state.doc.toString()) return;
        lastSetRef.current = formatted;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: formatted },
          userEvent: ILE_PROGRAMMATIC_USER_EVENT,
        });
      },
      openSearch: () => {
        const view = viewRef.current;
        if (!view) return;
        // CodeMirror's `openSearchPanel` is bound by `searchKeymap`
        // (registered at line 301) to the `Mod-f` key combo, but with
        // scope 'editor search-panel' — meaning the keymap only fires
        // when the editor or its panel has focus. Earlier revisions
        // dispatched a CustomEvent on `view.contentDOM` (no listener)
        // and a synthesized KeyboardEvent on `cm?.contentDOM` (the
        // CodeMirror keymap doesn't listen on `contentDOM` either).
        // Both no-ops. The actual fix: focus the editor first, then
        // dispatch the keydown on its `contentDOM` so the running
        // keymap catches it.
        view.focus();
        view.contentDOM.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'f',
            metaKey: true,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        onSearchOpen?.();
      },
    }),
    [handleRef, onSearchOpen],
  );

  return (
    <div
      ref={hostRef}
      className={className ?? 'h-full w-full overflow-auto'}
      aria-label={ariaLabel}
      role="textbox"
      aria-multiline="true"
    />
  );
}

// ─────────────────────────────────────────────────────────────────────
// HTML formatter
// ─────────────────────────────────────────────────────────────────────

/**
 * Hand-rolled HTML formatter. We deliberately avoid pulling in
 * Prettier (700KB+ of JS) or js-beautify (legacy) — the use case here
 * is "make the teacher's manual edits readable", not "produce
 * spec-perfect output". Indent + line-break is plenty.
 *
 * What it does:
 *   - Add a newline after `<tag>` and `</tag>` (when the next char
 *     is `<` or end-of-input).
 *   - Indent nested tags by 2 spaces per level.
 *   - Trim trailing whitespace inside the line.
 *
 * What it does NOT do:
 *   - Re-flow attribute lists onto multiple lines (Prettier-style).
 *   - Re-write DOCTYPE, comments, or text content.
 *   - Round-trip preserves comments and CDATA verbatim.
 *
 * The algorithm is a single forward pass with a small tag stack.
 * It's deterministic and O(n) over the input.
 */
function formatHtml(input: string): string {
  // Normalise line endings — Windows CRLF confuses the tag scanner.
  const src = input.replace(/\r\n?/g, '\n');
  const out: string[] = [];
  const stack: string[] = [];
  // void-element list per the HTML living standard — no closing tag,
  // never pushed onto the stack.
  const VOID = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
  ]);
  // Block elements get their own line; inline elements stay inline.
  const BLOCK = new Set([
    'address',
    'article',
    'aside',
    'blockquote',
    'body',
    'br',
    'details',
    'dialog',
    'dd',
    'div',
    'dl',
    'dt',
    'fieldset',
    'figcaption',
    'figure',
    'footer',
    'form',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'head',
    'header',
    'hgroup',
    'hr',
    'html',
    'li',
    'main',
    'nav',
    'ol',
    'p',
    'pre',
    'section',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'ul',
  ]);

  // Tokenise with a tiny state machine so we don't depend on a parser
  // library. We walk the string char-by-char, peeling off tags and
  // text content, and we emit each block on its own line.
  let i = 0;
  let line = '';
  const flushLine = () => {
    if (line.trim().length > 0 || out.length === 0) {
      out.push(line);
    } else if (out[out.length - 1]?.trim() !== '') {
      out.push('');
    }
    line = '';
  };
  const indent = () => '  '.repeat(stack.length);
  while (i < src.length) {
    const ch = src[i];
    if (ch === '<') {
      // Comment, doctype, or tag.
      if (src.startsWith('<!--', i)) {
        const end = src.indexOf('-->', i + 4);
        const close = end === -1 ? src.length : end + 3;
        line += src.slice(i, close);
        i = close;
        continue;
      }
      if (src.startsWith('<!', i)) {
        const close = src.indexOf('>', i);
        const end = close === -1 ? src.length : close + 1;
        line += src.slice(i, end);
        i = end;
        continue;
      }
      const close = src.indexOf('>', i);
      if (close === -1) {
        line += src.slice(i);
        break;
      }
      const tag = src.slice(i + 1, close).trim();
      const tagName = (tag.match(/^([a-zA-Z][a-zA-Z0-9-]*)/) ?? ['', ''])[1].toLowerCase();
      const isClose = src[i + 1] === '/';
      const isSelfClose = tag.endsWith('/');
      const cleanName = tagName.replace(/\/$/, '');

      if (isClose) {
        // Pop one level.
        const idx = stack.lastIndexOf(cleanName);
        if (idx >= 0) stack.length = idx + 1;
        stack.pop();
        if (BLOCK.has(cleanName)) {
          line += src.slice(i, close + 1);
          flushLine();
        } else {
          line += src.slice(i, close + 1);
        }
      } else if (isSelfClose || VOID.has(cleanName)) {
        if (BLOCK.has(cleanName)) {
          line += src.slice(i, close + 1);
          flushLine();
        } else {
          line += src.slice(i, close + 1);
        }
      } else {
        // Open tag. If the line is non-empty (we're after inline content),
        // keep it on the same line. Otherwise, indent + push.
        if (line.trim().length === 0) {
          line = indent() + src.slice(i, close + 1);
        } else {
          line += src.slice(i, close + 1);
        }
        if (BLOCK.has(cleanName)) {
          flushLine();
        }
        // Only push non-void tags.
        if (cleanName) stack.push(cleanName);
      }
      i = close + 1;
      continue;
    }
    // Text node.
    const next = src.indexOf('<', i);
    const end = next === -1 ? src.length : next;
    const text = src.slice(i, end);
    line += text;
    i = end;
  }
  if (line.length > 0) flushLine();

  return out
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
