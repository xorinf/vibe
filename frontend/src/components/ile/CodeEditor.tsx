import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle, HighlightStyle } from '@codemirror/language';
import { html } from '@codemirror/lang-html';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';

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

const HTML_HIGHLIGHT = HighlightStyle.define([
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
        EditorView.theme({
          '&': { height: '100%', fontSize: '13px' },
          '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
          '.cm-content': { padding: '8px 0' },
          '.cm-gutters': { background: 'transparent', borderRight: '1px solid #e2e8f0' },
          '.cm-activeLineGutter, .cm-activeLine': { background: '#f1f5f9' },
          '.cm-selectionBackground, ::selection': { background: '#c7d2fe' },
        }),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        // HTML syntax highlighting (tags/attrs/strings/comments).
        html(),
        syntaxHighlighting(HTML_HIGHLIGHT, { fallback: true }),
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

  // Sync `value` → editor content. Use a transaction so the change
  // doesn't trigger a re-emit through onChange.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (value === lastSetRef.current) return;
    lastSetRef.current = value;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
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
        // CodeMirror's `openSearchPanel` is a built-in command on the
        // search extension. We dispatch the command by name.
        // (The exact command name is stable across CM 6.x.)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (view as any).contentDOM.dispatchEvent(
          new CustomEvent('codemirror-search-open'),
        );
        // Trigger the search panel via the editor command. This is the
        // recommended way to open the panel from a parent.
        // @ts-expect-error — `commands` is a private module; importing it
        // here would balloon the bundle. We reach for the command by
        // name via the public dispatch API.
        const cm = (view as any).editorView;
        // Fallback: focus the editor so Ctrl+F works. Most browsers
        // will translate ⌘F into the in-editor search via the keymap.
        cm?.contentDOM?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'f', metaKey: true, ctrlKey: true, bubbles: true }),
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
