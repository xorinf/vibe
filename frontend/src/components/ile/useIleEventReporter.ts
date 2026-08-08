import { useCallback, useRef } from 'react';
import { useSearch } from '@tanstack/react-router';
import {
  getAuthToken,
  ingestIleStudentEvents,
  type IleRuntimeEvent,
} from './ileApi';
import { useAuthStore } from '@/store/auth-store';

type IleAnalyticsEvent = {
  kind: string;
  clientTs: number;
  data?: unknown;
};

export type { IleAnalyticsEvent };

/**
 * Host-side analytics reporter for the sandboxed runtime.
 *
 * SandboxIframe owns the postMessage listener because it knows which
 * iframe instance is mounted. This hook only consumes validated batches
 * from that component and POSTs them to the server, tagging the request
 * with the student's auth token from localStorage.
 */
export function useIleEventReporter(args: {
  /** Current experience id (from the route or the editor head). */
  experienceId?: string;
  /** Optional course context for the server-side row. */
  courseId?: string;
  courseVersionId?: string;
}) {
  const { experienceId, courseId, courseVersionId } = args;
  const search = useSearch({ strict: false }) as {
    courseId?: string;
    courseVersionId?: string;
  };
  const authTokenRef = useRef<string | null>(null);

  // Re-read the auth token via the canonical ileApi helper. The student
  // may have logged in / out mid-session.
  const readToken = useCallback((): string | null => getAuthToken(), []);

  // P2-3: when no auth token is available (cold-boot race, post-logout,
  // hard refresh while unauthed), buffer the most recent batch in a
  // ref and flush it the next time a token is observed. The runtime
  // buffers up to 8s of events internally and flushes on visibility
  // / pagehide, so we only need to hold the LAST batch (newer events
  // are strictly more useful than older ones for diagnostics).
  const pendingBatchRef = useRef<IleRuntimeEvent[] | null>(null);

  const reportAnalytics = useCallback(
    (eventExperienceId: string, events: IleAnalyticsEvent[]) => {
      if (!experienceId) return;
      if (eventExperienceId && eventExperienceId !== experienceId) return;
      if (!Array.isArray(events) || events.length === 0) return;

      // A.3: impersonation gate. If the current user is a teacher (route
      // guard now admits them), we receive the runtime's analytics batch
      // but do NOT POST it. This is the entire point of the impersonation
      // feature — "Your actions here are not recorded."
      if (useAuthStore.getState().user?.role === 'teacher') {
        // eslint-disable-next-line no-console
        console.debug(
          '[ILE] impersonation: analytics suppressed',
          { experienceId, droppedEvents: events.length },
        );
        return;
      }

      // Refresh the token at the flush boundary so token refresh/logout
      // during an active experience is reflected without waiting for a
      // React render.
      const token = readToken();
      authTokenRef.current = token;
      if (!token) {
        // Buffer the latest batch; older ones are dropped.
        pendingBatchRef.current = events as IleRuntimeEvent[];
        return;
      }

      // Fire-and-forget. The server returns 202 Accepted; we don't
      // surface errors because retrying from the host adds complexity
      // for a non-critical analytics stream.
      void ingestIleStudentEvents(experienceId, events as IleRuntimeEvent[], {
        authToken: token,
        courseId: courseId ?? search.courseId,
        courseVersionId: courseVersionId ?? search.courseVersionId,
      }).catch(() => {
        /* swallow — best-effort */
      });
    },
    [courseId, courseVersionId, experienceId, readToken, search],
  );

  // Refresh the token ref on every render. Cheap, and keeps the
  // drain path current.
  const prevTokenRef = useRef<string | null>(null);
  authTokenRef.current = readToken();
  // A.3 (impersonation): also short-circuit the drain path. If a teacher
  // somehow accumulated a buffered batch (e.g. token transitioned from
  // null → set while in impersonation mode), drop it before POST. Buffer
  // is cleared regardless so it doesn't sit forever.
  const impersonating = useAuthStore.getState().user?.role === 'teacher';
  // If a token just appeared, drain any buffered batch from the
  // pre-auth window.
  const currentToken = authTokenRef.current;
  if (
    currentToken &&
    pendingBatchRef.current &&
    prevTokenRef.current !== currentToken
  ) {
    prevTokenRef.current = currentToken;
    const token = currentToken;
    const pending = pendingBatchRef.current;
    pendingBatchRef.current = null;
    if (pending && pending.length > 0) {
      if (impersonating) {
        // eslint-disable-next-line no-console
        console.debug('[ILE] impersonation: analytics suppressed (drain)', {
          experienceId: experienceId ?? '',
          droppedEvents: pending.length,
        });
      } else {
        void ingestIleStudentEvents(experienceId ?? '', pending, {
          authToken: token,
          courseId: courseId ?? search.courseId,
          courseVersionId: courseVersionId ?? search.courseVersionId,
        }).catch(() => {
          /* swallow */
        });
      }
    }
  } else {
    prevTokenRef.current = currentToken;
  }

  return { reportAnalytics };
}
