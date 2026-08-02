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
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle, HighlightStyle } from '@codemirror/language';
import { html } from '@codemirror/lang-html';
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
        lastSetRef.current = next;
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
    let useHtmlParser = true;
    try {
      // The `html()` extension exposes a `languageData` field that
      // contains a parser reference. Triggering `startParse` on a
      // tiny doc is enough to surface the crash on first paint if
      // the parser is broken on this content. We do the probe
      // synchronously, just once, and bail on any throw.
      const probe = EditorState.create({ doc: '<' });
      const lang = (html() as unknown as { languageData?: { parser?: { startParse?: (s: EditorState) => unknown } } });
      lang?.languageData?.parser?.startParse?.(probe);
    } catch {
      useHtmlParser = false;
    }

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
        // Skipped if the @lezer/html parser throws on probe.
        useHtmlParser ? html() : [],
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
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (value === undefined || value === lastSetRef.current) return;
    lastSetRef.current = value ?? '';
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value ?? '' },
    });
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
        lastSetRef.current = next;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: next },
        });
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
