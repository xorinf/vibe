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
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
 * Right pane — title input + Save / Publish actions. Keeps the workspace
 * feeling lightweight: no tabs, no settings panels, just the affordances
 * the demo needs.
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
  const html = state.html || savedExperience?.html || '';
  const isDirty =
    state.status === 'done' &&
    state.html.length > 0 &&
    state.html !== (savedExperience?.html ?? '');

  function handleTitleBlur() {
    if (title.trim() !== (savedExperience?.title ?? '')) {
      onTitleChange(title.trim() || 'Untitled Experience');
    }
  }

  function studentUrl(): string | null {
    if (!savedExperience?._id || status !== 'published') return null;
    return `${window.location.origin}/student/ile/${savedExperience._id}`;
  }

  async function copyLink() {
    const url = studentUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Student link copied to clipboard.');
    } catch {
      toast.error('Could not copy — your browser blocked clipboard access.');
    }
  }

  function openStudent() {
    const url = studentUrl();
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  return (
    <div className={cn('flex h-full flex-col border-l bg-white', className)}>
      <div className="border-b px-5 py-3">
        <h2 className="text-sm font-semibold text-slate-900">Details</h2>
        <p className="text-xs text-slate-500">
          Title, status, and publish controls.
        </p>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <div className="space-y-1.5">
          <Label htmlFor="ile-title" className="text-xs text-slate-600">
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

        <div className="rounded-md border bg-slate-50 px-3 py-2.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500">Status</span>
            <StatusBadge status={status} isDirty={isDirty} />
          </div>
          {savedExperience && (
            <div className="mt-2 flex items-center justify-between text-xs">
              <span className="text-slate-500">Saved ID</span>
              <span className="font-mono text-[10px] text-slate-700">
                {savedExperience._id.slice(-8)}
              </span>
            </div>
          )}
          <div className="mt-2 flex items-center justify-between text-xs">
            <span className="text-slate-500">HTML length</span>
            <span className="text-slate-700">{html.length.toLocaleString()} chars</span>
          </div>
        </div>

        {isDirty && state.status === 'done' && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
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

        {/* Student-link affordances — only after publish. */}
        {status === 'published' && studentUrl() && (
          <div className="space-y-2 rounded-md border border-emerald-200 bg-emerald-50/50 p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-800">
              <CheckCircle2 className="h-3 w-3" />
              Published · ready for students
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={copyLink}
                className="flex-1 gap-1 border-emerald-200 bg-white hover:bg-emerald-50"
              >
                <Copy className="h-3.5 w-3.5" /> Copy link
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={openStudent}
                className="flex-1 gap-1 border-emerald-200 bg-white hover:bg-emerald-50"
              >
                <ExternalLink className="h-3.5 w-3.5" /> Open
              </Button>
            </div>
            <code className="block break-all rounded bg-white px-2 py-1 text-[10px] text-emerald-900 ring-1 ring-emerald-100">
              {studentUrl()}
            </code>
          </div>
        )}

        <div className="rounded-md border border-dashed border-slate-200 bg-slate-50/60 px-3 py-2.5 text-[11px] text-slate-500">
          <p className="font-medium text-slate-600">Demo notes</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            <li>Save persists your current draft to Mongo.</li>
            <li>Publish makes the experience playable by students.</li>
            <li>Edits after publishing require a new publish.</li>
          </ul>
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
        className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600"
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
        className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700"
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
        className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700"
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
      className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700"
      role="status"
      aria-label="Draft — not yet published"
    >
      <Save className="h-3 w-3" aria-hidden="true" />
      Draft
    </span>
  );
}