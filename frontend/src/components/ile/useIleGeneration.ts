import { useCallback, useEffect, useRef, useState } from 'react';
import {
  IleStreamEvent,
  streamIleGeneration,
  streamIleEdit,
} from './ileApi';

/**
 * Shared state for a single streaming session.
 *
 * The teacher workspace mounts one of these at a time. Resetting between
 * prompts avoids stale HTML leaking into the next stream.
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
}

const initial: IleStreamState = {
  html: '',
  progress: [],
  reasoning: false,
  status: 'idle',
};

export interface UseIleGenerationApi {
  state: IleStreamState;
  generate: (args: {
    prompt: string;
    courseId: string;
    courseVersionId: string;
    itemId?: string;
  }) => void;
  edit: (args: { experienceId: string; prompt: string }) => void;
  /** Cancel any in-flight stream and reset to idle. */
  cancel: () => void;
  /** Drop state back to initial (used when leaving the workspace). */
  reset: () => void;
}

/**
 * React hook wrapping the ILE streaming API. One instance = one in-flight
 * stream. Calling generate() while a stream is active cancels the prior
 * one first.
 */
export function useIleGeneration(): UseIleGenerationApi {
  const [state, setState] = useState<IleStreamState>(initial);
  const cancelRef = useRef<(() => void) | null>(null);

  // Cancel any in-flight stream when the component unmounts.
  useEffect(() => {
    return () => {
      cancelRef.current?.();
      cancelRef.current = null;
    };
  }, []);

  const start = useCallback(
    (
      args:
        | { kind: 'generate'; prompt: string; courseId: string; courseVersionId: string; itemId?: string }
        | { kind: 'edit'; experienceId: string; prompt: string },
    ) => {
      cancelRef.current?.();
      setState({ ...initial, status: 'streaming', lastDeltaAt: Date.now() });

      const onEvent = (ev: IleStreamEvent) => {
        setState((prev) => {
          switch (ev.kind) {
            case 'start':
              return { ...prev, experienceId: ev.experienceId };
            case 'progress':
              if (prev.progress.includes(ev.message)) return prev;
              return {
                ...prev,
                progress: [...prev.progress, ev.message].slice(-8),
                lastProgress: ev.message,
                // First user-visible progress tick clears the
                // "Thinking…" indicator — the user has something to
                // read now.
                reasoning: false,
              };
            case 'reasoning':
              return { ...prev, reasoning: true };
            case 'html':
              return {
                ...prev,
                html: prev.html + ev.delta,
                reasoning: false,
                lastDeltaAt: Date.now(),
              };
            case 'done':
              return {
                ...prev,
                status: 'done',
                html: ev.html || prev.html,
                experienceId: ev.experienceId,
                reasoning: false,
                truncated: ev.truncated ?? prev.truncated,
              };
            case 'error':
              return {
                ...prev,
                status: 'error',
                error: ev.message,
                reasoning: false,
              };
          }
        });
      };

      const startStream =
        args.kind === 'generate'
          ? streamIleGeneration(
              {
                prompt: args.prompt,
                courseId: args.courseId,
                courseVersionId: args.courseVersionId,
                itemId: args.itemId,
              },
              onEvent,
            )
          : streamIleEdit(
              { experienceId: args.experienceId, prompt: args.prompt },
              onEvent,
            );

      cancelRef.current = startStream;
    },
    [],
  );

  const generate = useCallback(
    (args: { prompt: string; courseId: string; courseVersionId: string; itemId?: string }) =>
      start({ kind: 'generate', ...args }),
    [start],
  );

  const edit = useCallback(
    (args: { experienceId: string; prompt: string }) =>
      start({ kind: 'edit', ...args }),
    [start],
  );

  const cancel = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    setState((prev) => ({ ...prev, status: 'idle', reasoning: false }));
  }, []);

  const reset = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    setState(initial);
  }, []);

  return { state, generate, edit, cancel, reset };
}