import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { X, ArrowLeft, Copy, AlertTriangle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SandboxIframe } from './SandboxIframe';
import { useIleEventReporter } from './useIleEventReporter';
import {
  getStudentIlePayload,
  type StudentIlePayload,
} from './ileApi';

/**
 * Student workspace — fullscreen immersive player for a published
 * interactive experience.
 *
 * States:
 *  - loading: shimmer skeleton + a "Cancel" button so the student can
 *    bail if loading takes too long.
 *  - error: friendly retry-via-Go-back.
 *  - ready: header with title + close; Resume Lesson surfaces after
 *    the embedded page calls `vibe.complete()`.
 */
export function StudentILEWorkspace() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [payload, setPayload] = useState<StudentIlePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  // Bumping this remounts the iframe — used after a runtime error so the
  // teacher can recover without leaving the experience.
  const [remountKey, setRemountKey] = useState(0);

  // Listen to the sandboxed runtime's analytics batches. The hook
  // reads the student's Firebase token from localStorage on every
  // flush, so a logout or token refresh Just Works.
  const { reportAnalytics } = useIleEventReporter({ experienceId: id });

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await getStudentIlePayload(id);
        if (!cancelled) setPayload(result);
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? 'Failed to load experience');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Intercept browser-level navigation while the experience is open.
  // This keeps the unsubscribe/leave-confirm away from a blocking
  // window.confirm and gives a more natural back / forward experience.
  useEffect(() => {
    // Push a placeholder entry on mount so the back button stays in-app
    // unless the student explicitly clicks our Exit button.
    window.history.pushState({ ile: true }, '');
    function onPopState(_e: PopStateEvent) {
      if (payload && !completed) {
        toast.message(
          'Use the × button to exit — your progress is saved automatically.',
        );
        // Restore our placeholder so the student stays in the workspace.
        window.history.pushState({ ile: true }, '');
      } else {
        navigate(-1);
      }
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, completed]);

  const handleExit = useCallback(() => {
    if (completed) {
      navigate(-1);
      return;
    }
    // Soft confirm: the spec asks for exit confirmation. We use a sonner
    // dialog rather than window.confirm because native dialogs block the
    // test thread and have inconsistent behaviour across browsers.
    const go = window.confirm(
      'Exit this experience? Your progress so far is saved — you can come back any time.',
    );
    if (!go) return;
    navigate(-1);
  }, [completed, navigate]);

  const handleReload = useCallback(() => {
    setRemountKey((v) => v + 1);
  }, []);

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success('Link copied.');
    } catch {
      toast.error('Could not copy — your browser blocked clipboard access.');
    }
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950 text-slate-100">
      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 px-5 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-violet-500/20 text-violet-300 text-xs font-bold">
            ✦
          </span>
          <div>
            <h1 className="text-sm font-semibold">
              {payload?.title ?? 'Interactive Experience'}
            </h1>
            <p className="text-[11px] text-muted-foreground/80 ">Interactive learning experience</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {completed && (
            <Button
              size="sm"
              variant="secondary"
              onClick={handleExit}
              className="gap-1 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Resume Lesson
            </Button>
          )}
          {payload && !loading && !error && (
            <Button
              size="icon"
              variant="ghost"
              onClick={handleCopyLink}
              aria-label="Copy link"
              title="Copy link"
              className="text-slate-300 hover:bg-slate-800 hover:text-accent-foreground"
            >
              <Copy className="h-4 w-4" />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            onClick={handleReload}
            aria-label="Reload experience"
            title="Reload"
            className="text-slate-300 hover:bg-slate-800 hover:text-accent-foreground"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={handleExit}
            aria-label="Exit experience"
            title="Exit"
            className="text-slate-300 hover:bg-slate-800 hover:text-accent-foreground"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {/* Body */}
      <div className="relative flex-1 bg-background ">
        {loading && <LoadingState onCancel={handleExit} />}
        {error && <ErrorState message={error} onBack={handleExit} />}
        {payload && (
          <SandboxIframe
            html={payload.html}
            experienceId={id}
            remountKey={remountKey}
            onComplete={() => {
              setCompleted(true);
              toast.success('Nice work — you finished the experience!');
            }}
            onError={() => {
              // Soft-fail. Surface a reload action so the student
              // doesn't have to dig into the chrome to recover.
              toast.error(
                'The experience hit a small error. Tap Reload to try again.',
                {
                  duration: 10_000,
                  action: {
                    label: 'Reload',
                    onClick: () => handleReload(),
                  },
                },
              );
            }}
            onAnalytics={reportAnalytics}
          />
        )}
      </div>

      {/* Completion banner */}
      {completed && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-emerald-500/95 px-5 py-2 text-sm font-medium text-white shadow-lg">
          You finished the experience 🎉
        </div>
      )}
    </div>
  );
}

function LoadingState({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background  text-sm text-muted-foreground ">
      <div className="flex items-center gap-2">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-violet-500" />
        Loading experience…
      </div>
      <Button size="sm" variant="ghost" onClick={onCancel} className="text-muted-foreground/80 ">
        Cancel
      </Button>
    </div>
  );
}

function ErrorState({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background  px-6 text-center">
      <div className="max-w-md space-y-3">
        <AlertTriangle className="mx-auto h-8 w-8 text-rose-400" />
        <p className="text-base font-medium text-foreground ">
          Couldn't load this experience
        </p>
        <p className="text-sm text-muted-foreground ">{message}</p>
        <Button size="sm" variant="outline" onClick={onBack} className="mt-2">
          Go back
        </Button>
      </div>
    </div>
  );
}