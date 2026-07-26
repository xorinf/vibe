
/**
 * Inline student viewer for an INTERACTIVE_EXPERIENCE item.
 *
 * Loads the experience payload (html + title) via the existing
 * `/interactive-experiences/:id/play` endpoint and mounts the
 * sandboxed iframe in place. The student stays on the course page
 * the whole time — no navigation, no chrome around the iframe.
 *
 * Hosts the same analytics hooks as the legacy routed
 * `StudentILEWorkspace` (event reporter) so postMessage → server
 * analytics still work. The presentation chrome (banner, header,
 * progress bar, completion banner) is shared with `StudentILEWorkspace`
 * via `StudentPlayerChrome`.
 */
import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SandboxIframe } from './SandboxIframe';
import { useIleEventReporter } from './useIleEventReporter';
import { getStudentIlePayload, type StudentIlePayload } from './ileApi';
import { StudentPlayerChrome } from './StudentPlayerChrome';

export interface InlineStudentIleViewerProps {
  experienceId: string;
  courseId?: string;
  courseVersionId?: string;
}

/**
 * Bare-bones renderer. Mounts the iframe full-bleed inside its parent
 * (the ItemContainer slot) and overlays a minimal exit / refresh bar
 * so the student can return to the course list without depending on a
 * browser back gesture.
 */
export function InlineStudentIleViewer({
  experienceId,
  courseId,
  courseVersionId,
}: InlineStudentIleViewerProps) {
  const [payload, setPayload] = useState<StudentIlePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [remountKey, setRemountKey] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [progress, setProgress] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Same analytics plumbing the routed workspace used. The hook reads
  // the student's Firebase token on every flush, so logout / token
  // refresh Just Works.
  const { reportAnalytics } = useIleEventReporter({
    experienceId,
    courseId,
    courseVersionId,
  });

  useEffect(() => {
    if (!experienceId) return;
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

  const handleReload = () => setRemountKey((v) => v + 1);

  return (
    <StudentPlayerChrome
      title={payload?.title ?? 'Interactive Experience'}
      progress={progress}
      completed={completed}
      errorMessage={error}
      loading={loading}
      experienceId={experienceId}
      theme="light"
      showFullscreen
      showCopyLink={false}
      showCoach={false}
    >
      <div ref={containerRef} className="absolute inset-0">
        {payload && (
          <SandboxIframe
            html={payload.html}
            experienceId={experienceId}
            remountKey={remountKey}
            onProgress={setProgress}
            emptyMessage="Loading experience…"
            onComplete={() => {
              setCompleted(true);
              toast.success('Nice work — you finished the experience!');
            }}
            onError={() => {
              toast.error(
                'The experience hit a small error. Tap Reload to try again.',
                {
                  duration: 10_000,
                  action: {
                    label: 'Reload',
                    onClick: handleReload,
                  },
                },
              );
            }}
            onAnalytics={reportAnalytics}
          />
        )}
        {!loading && !error && payload && (
          <Button
            size="icon"
            variant="ghost"
            onClick={handleReload}
            aria-label="Reload experience"
            title="Reload"
            className="absolute right-3 top-3 z-10 h-9 w-9 bg-white/80 dark:bg-slate-900 shadow-sm hover:bg-white"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        )}
      </div>
    </StudentPlayerChrome>
  );
}
