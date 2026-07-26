/**
 * Shared chrome for the student-facing ILE experience player.
 *
 * The student surfaces — `StudentILEWorkspace` (legacy routed) and
 * `InlineStudentIleViewer` (current inline mount) — share ~90% of their
 * presentation: the impersonation banner, the top header with title /
 * reload / copy-link / coach triggers, the progress bar, the loading
 * + error overlays, and the completion banner. This component is the
 * single source of truth for that chrome.
 *
 * Each consumer owns the iframe itself (the `SandboxIframe` mount is
 * the one thing that genuinely differs — routed workspace also owns
 * popstate intercept and full-screen state). The chrome-only Iframe
 * child is passed in via `children`.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Copy,
  Eye,
  Maximize2,
  Minimize2,
  X,
  ArrowLeft,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/utils';
import { useAuthStore } from '@/store/auth-store';
import { AICoachPanel } from './AICoachPanel';

export interface StudentPlayerChromeProps {
  /** Heading shown in the header (e.g. "Interactive Experience"). */
  title: string;
  /** Live progress 0–100 from the iframe runtime. 0 hides the bar. */
  progress: number;
  /** Set by the iframe's `iframe:complete` message. */
  completed: boolean;
  /** Set by the iframe's `iframe:error` message. */
  errorMessage?: string | null;
  /** Friendly message shown over a blank iframe (e.g. "Loading experience…"). */
  emptyMessage?: string;
  /** True after the initial payload fetch is in flight. */
  loading?: boolean;
  /** Experience id — used by the AI coach. Required when `showCoach` is true. */
  experienceId?: string;
  /** True for the routed/standalone player; false for the inline mount. */
  fullscreen?: boolean;
  /** Heading tone. Routed workspace uses a dark surface; inline uses the page surface. */
  theme?: 'dark' | 'light';
  /** Hide the fullscreen toggle (the inline mount owns its own toggle). */
  showFullscreen?: boolean;
  /** Hide the coach button (used by the inline mount which has its own coach wiring). */
  showCoach?: boolean;
  /** Hide the copy-link button (routed-only). */
  showCopyLink?: boolean;
  /** Show an "exit / resume lesson" affordance. Routed-only. */
  onExit?: () => void;
  /** Iframe (or any other) body — replaces the chrome body. */
  children: ReactNode;
  className?: string;
}

const PROGRESS_BAR_HIDDEN_MAX = 0;

export function StudentPlayerChrome({
  title,
  progress,
  completed,
  errorMessage = null,
  emptyMessage,
  loading = false,
  experienceId,
  fullscreen = false,
  theme = 'dark',
  showFullscreen = false,
  showCoach = true,
  showCopyLink = true,
  onExit,
  children,
  className,
}: StudentPlayerChromeProps) {
  const isTeacher = useAuthStore().user?.role === 'teacher';
  const [coachOpen, setCoachOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Track browser-level fullscreen so the icon flips correctly.
  useEffect(() => {
    function onChange() {
      setIsFullscreen(Boolean(document.fullscreenElement));
    }
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success('Link copied.');
    } catch {
      toast.error('Could not copy — your browser blocked clipboard access.');
    }
  };

  const handleFullscreenToggle = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen?.();
      } else {
        await document.exitFullscreen?.();
      }
    } catch {
      toast.error('Fullscreen not available in this browser.');
    }
  };

  const isDark = theme === 'dark';

  const progressValue = Math.max(0, Math.min(100, progress));
  const showProgressStrip = progressValue > PROGRESS_BAR_HIDDEN_MAX && progressValue < 100;

  return (
    <div
      className={cn(
        'relative flex h-full w-full flex-col',
        isDark ? 'bg-slate-950 text-slate-100' : 'bg-background  text-foreground ',
        className,
      )}
      data-testid="student-player-chrome"
      data-fullscreen={fullscreen || undefined}
    >
      {/* Impersonation banner — only rendered when a teacher is viewing. */}
      {isTeacher && (
        <div
          role="status"
          aria-live="polite"
          data-testid="ile-impersonation-banner"
          className="flex w-full items-center justify-center gap-2 bg-ai/40  px-4 py-2 text-sm font-medium text-amber-800 border-b border-amber-300"
        >
          <Eye className="h-4 w-4" aria-hidden="true" />
          <span>You are viewing this as a student. Your actions here are not recorded.</span>
        </div>
      )}

      {/* Top bar */}
      <header
        className={cn(
          'flex items-center justify-between px-4 py-2 backdrop-blur',
          isDark
            ? 'border-b border-slate-800 bg-slate-900/80'
            : 'border-b border-border  bg-card ',
        )}
      >
        <div className="flex items-center gap-3">
          <span
            className={cn(
              'inline-flex h-7 w-7 items-center justify-center rounded-md text-xs font-bold',
              isDark ? 'bg-primary/20 text-primary/70' : 'bg-primary/15 text-primary',
            )}
          >
            ✦
          </span>
          <div>
            <h1 className={cn('text-sm font-semibold', isDark ? '' : 'text-foreground ')}>
              {title}
            </h1>
            <p
              className={cn(
                'text-[11px]',
                isDark ? 'text-muted-foreground/80 ' : 'text-muted-foreground ',
              )}
            >
              {progressValue > 0 && progressValue < 100
                ? `${Math.round(progressValue)}% complete`
                : completed
                ? 'Completed'
                : 'Interactive learning experience'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {completed && onExit && (
            <Button
              size="lg"
              variant="secondary"
              onClick={onExit}
              className="gap-1 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Resume Lesson
            </Button>
          )}
          {showCopyLink && !loading && !errorMessage && (
            <Button
              size="icon"
              variant="ghost"
              onClick={handleCopyLink}
              aria-label="Copy link"
              title="Copy link"
              className={cn(
                'h-10 w-10',
                isDark
                  ? 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  : 'text-muted-foreground  hover:bg-slate-100 hover:text-slate-900',
              )}
            >
              <Copy className="h-4 w-4" />
            </Button>
          )}
          {showCoach && !loading && !errorMessage && (
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setCoachOpen(true)}
              aria-label="Ask the AI coach"
              title="Coach"
              className={cn(
                'h-10 w-10',
                isDark
                  ? 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  : 'text-muted-foreground  hover:bg-slate-100 hover:text-slate-900',
              )}
            >
              <Eye className="h-4 w-4" />
            </Button>
          )}
          {showFullscreen && (
            <Button
              size="icon"
              variant="ghost"
              onClick={handleFullscreenToggle}
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              className={cn(
                'h-10 w-10',
                isDark
                  ? 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  : 'text-muted-foreground  hover:bg-slate-100 hover:text-slate-900',
              )}
            >
              {isFullscreen ? (
                <Minimize2 className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )}
            </Button>
          )}
          {onExit && (
            <Button
              size="icon"
              variant="ghost"
              onClick={onExit}
              aria-label="Exit experience"
              title="Exit"
              className={cn(
                'h-10 w-10',
                isDark
                  ? 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  : 'text-muted-foreground  hover:bg-slate-100 hover:text-slate-900',
              )}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </header>

      {/* Progress strip — hidden at 0% and 100% to keep the chrome clean. */}
      <div
        className={cn('h-0.5', isDark ? 'bg-slate-800' : 'bg-muted ')}
        role="progressbar"
        aria-valuenow={progressValue}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn(
            'h-full transition-[width] duration-150 ease-out',
            isDark ? 'bg-primary/70' : 'bg-primary',
          )}
          style={{
            width: `${progressValue}%`,
            opacity: showProgressStrip ? 1 : 0,
          }}
          data-testid="student-progress-bar"
        />
      </div>

      {/* Body */}
      <div className={cn('relative flex-1', isDark ? 'bg-background ' : 'bg-background ')}>
        {loading && (
          <LoadingOverlay message={emptyMessage} />
        )}
        {errorMessage && !loading && (
          <ErrorOverlay message={errorMessage} onRetry={onExit} />
        )}
        {children}
      </div>

      {/* Completion banner */}
      {completed && (
        <div className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-emerald-500/95 px-5 py-2 text-sm font-medium text-white shadow-lg">
          You finished the experience 🎉
        </div>
      )}

      <AICoachPanel
        open={coachOpen}
        onClose={() => setCoachOpen(false)}
        experienceId={experienceId}
      />
    </div>
  );
}

function LoadingOverlay({ message }: { message?: string }) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-background  text-sm text-muted-foreground ">
      <div className="flex items-center gap-2">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
        {message ?? 'Loading experience…'}
      </div>
    </div>
  );
}

function ErrorOverlay({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background  px-6 text-center">
      <div className="max-w-md space-y-3">
        <AlertTriangle className="mx-auto h-8 w-8 text-rose-400" />
        <p className="text-base font-medium text-foreground ">
          Couldn&apos;t load this experience
        </p>
        <p className="text-sm text-muted-foreground ">{message}</p>
        {onRetry && (
          <Button size="lg" variant="outline" onClick={onRetry} className="mt-2">
            Go back
          </Button>
        )}
      </div>
    </div>
  );
}
