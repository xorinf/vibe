/**
 * Canonical state shape for a single ILE streaming session.
 *
 * The teacher workspace mounts one of these at a time. Resetting between
 * prompts avoids stale HTML leaking into the next stream.
 *
 * Lives next to `ileStreamQueue.ts` (the FIFO queue that produces it)
 * rather than next to the React hook that consumes it (`useIleEditor.ts`)
 * because the state is **transport-owned** — any future consumer
 * (WebSocket, polling, replay tool) should see the same shape.
 *
 * The original `useIleGeneration.ts` module that used to define this
 * type also exported a `useIleGeneration` hook that owned the SSE
 * transport. That hook has been removed — the actual streaming goes
 * through `useIleEditor.startEditStream` and
 * `useIleContextGeneration.start`. The type was kept because it is
 * the canonical "stream state" shape consumed by the editor, the
 * preview, and the inspector drawer.
 */
export interface IleStreamState {
  /** What the LLM has produced so far. Empty until first html event. */
  html: string;
  /** Friendly progress messages — deduped by the hook. */
  progress: string[];
  /** Most recent progress message (lets the UI flash the new tick). */
  lastProgress?: string;
  /** True while reasoning/thinking deltas are flowing from the model. */
  reasoning: boolean;
  /** Lifecycle. */
  status: 'idle' | 'streaming' | 'done' | 'error';
  /** Set once the backend hands us a persisted experience _id. */
  experienceId?: string;
  /** Error message on `status === 'error'`. */
  error?: string;
  /**
   * Error kind — populated when the error came from the upstream
   * transport (REST or SSE) so the UI can show a friendly toast
   * without re-classifying the raw message. Empty string when the
   * error came from a client-side invariant (stream cancelled,
   * socket dropped) rather than a server response.
   */
  errorKind?: 'auth' | 'forbidden' | 'not_found' | 'server' | 'network' | 'unknown' | 'cancelled' | 'provider_output_not_html' | '';
  /**
   * Wall-clock time of the most recent HTML delta — lets the UI show a
   * "still working…" indicator if the stream stalls.
   */
  lastDeltaAt?: number;
  /**
   * True when the provider truncated the response at `max_tokens`. The
   * saved draft is incomplete; the workspace surfaces a warning toast
   * asking the teacher to retry or shorten the prompt.
   */
  truncated?: boolean;
  /**
   * The HTML that was on screen before the stream started. Used by
   * the chat-pane diff view to render a side-by-side before/after
   * when the teacher clicks "View diff" on the assistant bubble.
   * Always empty for the first generation.
   */
  previousHtml?: string;
  /**
   * Stream observability — surfaced in the StreamFooter so the
   * teacher can see how expensive a prompt was. The provider/model
   * come from the workspace's saved config; tokens is approximated
   * server-side at 4 chars/token.
   */
  provider?: string;
  model?: string;
  /** Approximate token count (server-side approximation, 4 chars/token). */
  tokens?: number;
  /** Wall-clock latency from stream start to done/error/cancel. */
  latencyMs?: number;
  /** The most recent computed estimated cost in USD (server-side). */
  costUsd?: number;
  /**
   * Bumped on accept()/reject() so consumers (the workspace, the
   * chat diff banner) can react without watching the full stream
   * object. Same epoch millis convention as lastDeltaAt.
   */
  lastAppliedAt?: number;
}
