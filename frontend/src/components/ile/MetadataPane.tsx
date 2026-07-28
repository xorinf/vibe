import { useEffect, useState } from 'react';
import {
  Save,
  Send,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Copy,
  ExternalLink,
  Archive,
  Link as LinkIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/utils/utils';
import type { IleStreamState } from './useIleGeneration';
import type { IleExperienceResponse } from './ileApi';

export interface MetadataPaneProps {
  state: IleStreamState;
  savedExperience?: IleExperienceResponse | null;
  saving: boolean;
  publishing: boolean;
  onTitleChange: (title: string) => void;
  onSave: () => void;
  onPublish: () => void;
  className?: string;
}

/**
 * Right pane — title input + Save / Publish actions. Kept for backward
 * compatibility with any tests or alternate consumers. The new
 * Teacher Workspace uses `InlineMetadataCluster` instead (the metadata
 * lives in the top bar).
 */
export function MetadataPane({
  state,
  savedExperience,
  saving,
  publishing,
  onTitleChange,
  onSave,
  onPublish,
  className,
}: MetadataPaneProps) {
  const [title, setTitle] = useState(savedExperience?.title ?? '');

  // Sync title when a saved experience arrives (after the first stream).
  useEffect(() => {
    if (savedExperience?.title) setTitle(savedExperience.title);
  }, [savedExperience?._id, savedExperience?.title]);

  const status = savedExperience?.status ?? 'draft';
  const html = state?.html || savedExperience?.html || '';
  const isDirty =
    state?.status === 'done' &&
    state.html.length > 0 &&
    state.html !== (savedExperience?.html ?? '');

  function handleTitleBlur() {
    if (title.trim() !== (savedExperience?.title ?? '')) {
      onTitleChange(title.trim() || 'Untitled Experience');
    }
  }

  return (
    <div className={cn('flex h-full flex-col border-l bg-background ', className)}>
      <div className="border-b px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground ">Details</h2>
        <p className="text-xs text-muted-foreground ">
          Title, status, and publish controls.
        </p>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <div className="space-y-1.5">
          <Label htmlFor="ile-title" className="text-xs text-muted-foreground ">
            Title
          </Label>
          <Input
            id="ile-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={handleTitleBlur}
            placeholder="e.g. Binary Search Visualizer"
            className="text-sm"
          />
        </div>

        <div className="rounded-md border bg-card  px-3 py-2.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground ">Status</span>
            <StatusBadge status={status} isDirty={isDirty} />
          </div>
          {savedExperience && (
            <div className="mt-2 flex items-center justify-between text-xs">
              <span className="text-muted-foreground ">Saved ID</span>
              <span className="font-mono text-[10px] text-foreground/80 ">
                {savedExperience._id.slice(-8)}
              </span>
            </div>
          )}
          {savedExperience?.context && (
            <div className="mt-2 flex items-start justify-between gap-2 text-xs">
              <span className="shrink-0 text-muted-foreground ">Context</span>
              <span
                className="text-right font-medium text-foreground/80 "
                title={`via ${savedExperience.context.provider}`}
                data-testid="ile-context-chip"
              >
                {savedExperience.context.title}
              </span>
            </div>
          )}
          <div className="mt-2 flex items-center justify-between text-xs">
            <span className="text-muted-foreground ">HTML length</span>
            <span className="text-foreground/80 ">{html.length.toLocaleString()} chars</span>
          </div>
        </div>

        {isDirty && state.status === 'done' && (
          <div className="rounded-md border border-accent/40  bg-ai/30  px-3 py-2 text-[11px] text-amber-800">
            You have unsaved changes since the last save.
          </div>
        )}

        <div className="space-y-2">
          <Button
            variant="outline"
            className="w-full"
            onClick={onSave}
            disabled={
              saving ||
              publishing ||
              state.status === 'streaming' ||
              !state.html ||
              (!isDirty && Boolean(savedExperience?._id))
            }
            title={
              !isDirty && savedExperience?._id
                ? 'No new changes to save.'
                : undefined
            }
          >
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
              </>
            ) : (
              <>
                <Save className="h-3.5 w-3.5" /> {savedExperience ? 'Save changes' : 'Save draft'}
              </>
            )}
          </Button>
          <Button
            className="w-full"
            onClick={onPublish}
            disabled={
              publishing ||
              saving ||
              state.status === 'streaming' ||
              !savedExperience?._id ||
              status === 'published'
            }
          >
            {publishing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Publishing…
              </>
            ) : status === 'published' ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5" /> Published
              </>
            ) : (
              <>
                <Send className="h-3.5 w-3.5" /> Publish for students
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({
  status,
  isDirty,
}: {
  status: 'draft' | 'published' | 'archived';
  isDirty: boolean;
}) {
  if (status === 'archived') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-muted  px-2 py-0.5 text-[11px] font-medium text-muted-foreground "
        role="status"
        aria-label="Archived — hidden from students"
      >
        <Archive className="h-3 w-3" aria-hidden="true" />
        Archived
      </span>
    );
  }
  if (status === 'published' && isDirty) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-ai/40  px-2 py-0.5 text-[11px] font-medium text-accent-foreground "
        role="status"
        aria-label="Republish needed — published draft has unsaved changes"
      >
        <AlertCircle className="h-3 w-3" aria-hidden="true" />
        Republish needed
      </span>
    );
  }
  if (status === 'published') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-primary/25  px-2 py-0.5 text-[11px] font-medium text-primary "
        role="status"
        aria-label="Published and ready for students"
      >
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
        Published
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-ai/40  px-2 py-0.5 text-[11px] font-medium text-accent-foreground "
      role="status"
      aria-label="Draft — not yet published"
    >
      <Save className="h-3 w-3" aria-hidden="true" />
      Draft
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Inline metadata cluster — the new top-bar shape.
// ─────────────────────────────────────────────────────────────────────

export interface InlineMetadataClusterProps {
  /** Current experience title (uncontrolled internally). */
  title: string;
  /** Status pill source: 'saving' overrides everything; otherwise derive from state. */
  status: 'draft' | 'published' | 'archived';
  saving: boolean;
  publishing: boolean;
  isDirty: boolean;
  lastSavedAt: Date | null;
  /** True once the experience has been saved at least once (controls which buttons show). */
  hasSavedExperience: boolean;
  /** Stream status — disables Save while streaming. */
  streamStatus: IleStreamState['status'];
  /** HTML is non-empty. */
  hasHtml: boolean;
  onTitleChange: (title: string) => void;
  onSave: () => void;
  onPublish: () => void;
  /** Optional extra slot for trailing buttons (e.g. lifecycle menu). */
  trailing?: React.ReactNode;
  className?: string;
}

/**
 * Compact inline cluster — title input, save status pill, save button,
 * publish button. Designed to live in a horizontal top bar.
 *
 * Render shape (single row, all inline):
 *   [Title input] | [Saved HH:MM / Saving… / Unsaved] | [Save] | [Publish]
 *
 * The cluster shrinks gracefully: on narrow viewports the title
 * input collapses and the status text becomes an icon-only dot.
 */
export function InlineMetadataCluster({
  title,
  status,
  saving,
  publishing,
  isDirty,
  lastSavedAt,
  hasSavedExperience,
  streamStatus,
  hasHtml,
  onTitleChange,
  onSave,
  onPublish,
  trailing,
  className,
}: InlineMetadataClusterProps) {
  const isStreaming = streamStatus === 'streaming';
  const canPublish =
    hasSavedExperience &&
    !publishing &&
    !saving &&
    !isStreaming &&
    status !== 'published';
  const canSave =
    !saving &&
    !publishing &&
    !isStreaming &&
    Boolean(hasHtml) &&
    (!hasSavedExperience || isDirty);

  const showStudentLink =
    status === 'published' && hasSavedExperience;

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Input
        value={title}
        onChange={(e) => onTitleChange(e.target.value)}
        placeholder="Untitled Experience"
        aria-label="Experience title"
        className="h-7 w-44 border-transparent bg-transparent px-2 text-sm font-medium text-foreground/90  shadow-none hover:bg-accent focus-visible:bg-white focus-visible:border-slate-200 focus-visible:ring-0"
      />
      <SaveStatusPill
        saving={saving}
        isDirty={isDirty}
        lastSavedAt={lastSavedAt}
        hasSavedExperience={hasSavedExperience}
      />
      <Button
        variant="outline"
        size="sm"
        onClick={onSave}
        disabled={!canSave}
        className="h-7 gap-1 px-2 text-xs"
        aria-label={hasSavedExperience ? 'Save changes' : 'Save draft'}
        title={hasSavedExperience ? 'Save changes' : 'Save draft'}
      >
        {saving ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Save className="h-3 w-3" />
        )}
        <span className="hidden md:inline">
          {hasSavedExperience ? 'Save' : 'Save'}
        </span>
      </Button>
      {showStudentLink ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              disabled={!canPublish}
              className="h-7 gap-1 bg-violet-600 px-2 text-xs hover:bg-primary/90"
              aria-label="Published — view student link"
              title="Published — click for student link"
            >
              <CheckCircle2 className="h-3 w-3" />
              <span className="hidden md:inline">Published</span>
              <LinkIcon className="h-3 w-3 opacity-70" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <StudentLinkMenu />
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button
          size="sm"
          onClick={onPublish}
          disabled={!canPublish}
          className="h-7 gap-1 bg-violet-600 px-2 text-xs hover:bg-primary/90"
          aria-label="Publish for students"
          title="Publish for students"
        >
          {publishing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Send className="h-3 w-3" />
          )}
          <span className="hidden md:inline">Publish</span>
        </Button>
      )}
      {trailing}
    </div>
  );
}

function StudentLinkMenu() {
  // We don't have the saved experience id directly in this component
  // because the publish flow is owned by the workspace. The popover is
  // a thin wrapper that delegates to the workspace's handler via a
  // custom event — but to keep this self-contained, we read the
  // current URL on click. The workspace can also pass an explicit
  // student URL via a context if needed. For now we show the URL
  // template; clicking copy picks up the most recently set value
  // through a data attribute the workspace maintains.
  const studentUrl = readStudentUrlFromDom();
  return (
    <div className="space-y-1 p-1">
      <div className="px-2 pb-1 text-[11px] font-medium text-muted-foreground ">
        Student link
      </div>
      <code className="block break-all rounded bg-card  px-2 py-1.5 text-[11px] text-foreground/80 ">
        {studentUrl ?? '/student/ile/…'}
      </code>
      <DropdownMenuItem
        onSelect={(event) => {
          event.preventDefault();
          void copyStudentLink(studentUrl);
        }}
        className="gap-2"
      >
        <Copy className="h-3.5 w-3.5" />
        Copy link
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={(event) => {
          event.preventDefault();
          if (studentUrl) window.open(studentUrl, '_blank', 'noopener,noreferrer');
        }}
        className="gap-2"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Open in new tab
      </DropdownMenuItem>
    </div>
  );
}

/**
 * Reads the student URL the workspace stashes on <body data-student-share-url>
 * each time a publish succeeds. This keeps the popover self-contained
 * while letting the workspace own the actual experience id state.
 */
function readStudentUrlFromDom(): string | null {
  if (typeof document === 'undefined') return null;
  // The workspace writes `data-student-share-url` (camelCase → kebab
  // by the DOM dataset API). Earlier revisions read `data-student-url`
  // here, which never matched — the published-link popover always
  // showed the placeholder. See the 2026-07-28 ILE audit H4.
  const value = document.body.dataset.studentShareUrl;
  return value && value.length > 0 ? value : null;
}

async function copyStudentLink(url: string | null) {
  if (!url) {
    toast.error('No published link yet.');
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast.success('Student link copied to clipboard.');
  } catch {
    toast.error('Could not copy — your browser blocked clipboard access.');
  }
}

interface SaveStatusPillProps {
  saving: boolean;
  isDirty: boolean;
  lastSavedAt: Date | null;
  hasSavedExperience: boolean;
}

function SaveStatusPill({
  saving,
  isDirty,
  lastSavedAt,
  hasSavedExperience,
}: SaveStatusPillProps) {
  let label: string;
  let toneClasses: string;
  let icon: React.ReactNode;

  if (saving) {
    label = 'Saving…';
    toneClasses = 'bg-slate-100 text-slate-500';
    icon = <Loader2 className="h-2.5 w-2.5 animate-spin" />;
  } else if (isDirty) {
    label = 'Unsaved';
    toneClasses = 'bg-amber-50 text-amber-700';
    icon = <AlertCircle className="h-2.5 w-2.5" />;
  } else if (lastSavedAt && hasSavedExperience) {
    label = `Saved ${lastSavedAt.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })}`;
    toneClasses = 'bg-emerald-50 text-emerald-700';
    icon = <CheckCircle2 className="h-2.5 w-2.5" />;
  } else {
    label = 'New';
    toneClasses = 'bg-slate-100 text-slate-500';
    icon = <CheckCircle2 className="h-2.5 w-2.5" />;
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
        toneClasses,
      )}
      title={
        lastSavedAt
          ? `Last saved at ${lastSavedAt.toLocaleString()}`
          : 'Not yet saved'
      }
      aria-live="polite"
    >
      {icon}
      {label}
    </span>
  );
}