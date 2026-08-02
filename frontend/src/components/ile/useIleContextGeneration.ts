import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GenerateFromContextArgs,
  IleStreamEvent,
  streamIleGenerationFromContext,
} from './ileApi';

/**
 * State surface for a context-driven generation stream. Mirrors the
 * shape of `useIleGeneration`'s state so the workspace can swap
 * between zero-context and context-driven flows without changing
 * downstream rendering.
 *
 * The `context` field carries the source title once the server
 * confirms it (`done.contextTitle`). The UI renders this as the
 * "Context: …" chip.
 */
export interface ContextStreamState {
  status: 'idle' | 'streaming' | 'done' | 'error';
  html: string;
  progress: string[];
  lastProgress?: string;
  experienceId?: string;
  error?: string;
  contextTitle?: string;
}

const initial: ContextStreamState = {
  status: 'idle',
  html: '',
  progress: [],
};

export interface UseIleContextGenerationApi {
  state: ContextStreamState;
  /** Start a stream from a context input. Returns a cancel function. */
  start: (args: GenerateFromContextArgs) => () => void;
  cancel: () => void;
  reset: () => void;
}

/**
 * Hook wrapping the ILE context-generation SSE stream. One instance
 * per workspace. Calling `start()` while a stream is active cancels
 * the prior one first.
 */
export function useIleContextGeneration(): UseIleContextGenerationApi {
  const [state, setState] = useState<ContextStreamState>(initial);
  const cancelRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      cancelRef.current?.();
      cancelRef.current = null;
    };
  }, []);

  const start = useCallback((args: GenerateFromContextArgs) => {
    cancelRef.current?.();
    setState({ ...initial, status: 'streaming' });

    // Safety net: if neither `done` nor `error` ever arrives (the
    // connection drops silently), force the state out of
    // `'streaming'` after 90s. This mirrors the watchdog on the
    // background FIFO queue (`ileStreamQueue.ts`) and prevents
    // the same "stuck streaming" symptom from appearing on the
    // context-driven path, which doesn't go through the queue.
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      setState((prev) =>
        prev.status === 'streaming'
          ? {
              ...prev,
              status: 'error',
              error:
                'Stream stalled (no events for 90s). The provider may have dropped the connection.',
            }
          : prev,
      );
    }, 90_000);

    const onEvent = (ev: IleStreamEvent) => {
      if (watchdogFired) return; // already settled; ignore late events
      switch (ev.kind) {
        case 'done':
        case 'error':
          clearTimeout(watchdog);
          break;
      }
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
            };
          case 'reasoning':
            return prev;
          case 'html':
            return { ...prev, html: prev.html + ev.delta };
          case 'done':
            return {
              ...prev,
              status: 'done',
              html: ev.html || prev.html,
              experienceId: ev.experienceId,
              contextTitle:
                typeof (ev as { contextTitle?: unknown }).contextTitle === 'string'
                  ? ((ev as { contextTitle?: string }).contextTitle as string)
                  : prev.contextTitle,
            };
          case 'error':
            return {
              ...prev,
              status: 'error',
              error: ev.message,
            };
        }
      });
    };

    const cancel = streamIleGenerationFromContext(args, onEvent);
    cancelRef.current = () => {
      clearTimeout(watchdog);
      cancel();
    };
    return cancel;
  }, []);

  const cancel = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    setState((prev) => ({ ...prev, status: 'idle' }));
  }, []);

  const reset = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    setState(initial);
  }, []);

  return { state, start, cancel, reset };
}
