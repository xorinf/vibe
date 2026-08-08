
/**
 * Inline student viewer for an INTERACTIVE_EXPERIENCE item.
 *
 * Loads the experience payload (html + title) via the existing
 * `/interactive-experiences/:id/play` endpoint and mounts the
 * sandboxed iframe in place. The student stays on the course page
 * the whole time — no navigation, no chrome around the iframe.
 * The student route's own FloatingBackButton / course drawer /
 * AICompanion cover the chrome's prior responsibilities
 * (navigation, completion advance, help).
 */
import { useEffect, useState } from 'react';
import { SandboxIframe } from './SandboxIframe';
import { getStudentIlePayload, type StudentIlePayload } from './ileApi';

export interface InlineStudentIleViewerProps {
  experienceId: string;
}

/**
 * Bare-bones renderer. Mounts the iframe full-bleed inside its parent
 * (the ItemContainer slot). The AI owns the visual surface — no
 * chrome, no reload button, no overlays. Error / loading states
 * surface as minimal full-bleed messages (signals of failure, not
 * chrome). If the ILE is stuck, the student refreshes the page
 * (Cmd+R) — adding a "Reload" button over the AI's content is its
 * own small UX violation.
 */
export function InlineStudentIleViewer({
  experienceId,
}: InlineStudentIleViewerProps) {
  const [payload, setPayload] = useState<StudentIlePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!experienceId) {
      // ponytail: previously the early-return left `loading: true`
      // forever and the chrome rendered the "Loading experience…"
      // overlay with no path out. The teacher adding an ILE item to
      // a section creates an itemsGroup row with `experienceId = ''`
      // until the workspace saves the first experience. Surface a
      // real message so the student sees "not yet generated"
      // instead of a stuck spinner.
      setPayload(null);
      setLoading(false);
      setError('This experience has not been created yet.');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await getStudentIlePayload(experienceId);
        if (!cancelled) setPayload(result);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load experience');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [experienceId]);

  return (
    // ponytail: no chrome. The student route already provides
    // navigation (FloatingBackButton, course drawer), AI help
    // (AICompanion), and completion advancement (course onNext) —
    // the chrome was duplicating that with a thin "interactive
    // learning experience" header at the top, which the user asked
    // to remove. Render the iframe full-bleed; the AI owns the
    // visual surface. Error / loading states still surface as a
    // minimal overlay (we don't drop those — they're a signal of
    // failure, not chrome).
    <div className="absolute inset-0">
      {loading && !payload && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background  text-sm text-muted-foreground ">
          Loading experience…
        </div>
      )}
      {error && !payload && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background  p-8 text-center text-sm text-destructive-foreground">
          {error}
        </div>
      )}
      {payload && (
        <SandboxIframe
          html={payload.html}
          experienceId={experienceId}
          // ponytail: match the teacher view (IleInlineView) exactly.
          // The teacher sets injectSdk={false} + allowSameOrigin +
          // className="absolute inset-0". The student renders
          // identically now. The user explicitly asked for the
          // teacher's setup. End of story.
          injectSdk={false}
          allowSameOrigin
          className="absolute inset-0"
          emptyMessage="Loading experience…"
        />
      )}
    </div>
  );
}
