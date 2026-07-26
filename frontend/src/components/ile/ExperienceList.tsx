import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Archive,
  FileText,
  Loader2,
  Plus,
  Sparkles,
  Search,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/utils';
import {
  listIleExperiences,
  type IleExperienceListItem,
} from './ileApi';

export interface ExperienceListProps {
  /** Required callback when the teacher picks an experience — the
   *  parent (Dialog on the course page) decides how to open it. */
  onOpen: (id: string) => void;
  /** Optional callback for "new experience" — same dialog owner. */
  onCreate?: () => void;
  className?: string;
}

/**
 * Manager / library view for the teacher's ILE workspace. Lists every
 * non-archived (or all, with the toggle) experience, with quick filters
 * and an "Open" affordance per row.
 *
 * Lives as a standalone component so it can be embedded in a future
 * /teacher/ile library page without dragging the TeacherILEWorkspace
 * along.
 */
export function ExperienceList({
  onOpen,
  onCreate,
  className,
}: ExperienceListProps) {
  const [items, setItems] = useState<IleExperienceListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    if (cancelledRef.current) return;
    setLoading(true);
    try {
      const res = await listIleExperiences({ includeArchived: true });
      if (cancelledRef.current) return;
      setItems(res.experiences);
    } catch (err: unknown) {
      if (cancelledRef.current) return;
      toast.error(err instanceof Error ? err.message : 'Could not load experiences.');
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    void refresh();
    return () => {
      cancelledRef.current = true;
    };
  }, [refresh]);

  const filtered = items.filter((e) => {
    if (query.trim()) {
      return e.title.toLowerCase().includes(query.trim().toLowerCase());
    }
    return true;
  });

  function openExperience(id: string) {
    onOpen(id);
  }

  function createNew() {
    if (onCreate) {
      onCreate();
      return;
    }
    // Fallback for callers who forgot to wire onCreate — open an
    // empty-canvas dialog would be the right thing, but without the
    // dialog context we surface a clear toast instead of silently
    // dropping the click.
    toast.info('Open this list from the course page to create a new experience.');
  }

  return (
    <div className={cn('flex h-full flex-col bg-slate-50 dark:bg-slate-900/60', className)}>
      {/* Header — one big "Create new experience" button is the primary
          action. The "Manage every experience you've authored" copy
          makes the purpose explicit. The search is collapsed into a
          small icon button at the right that expands to a full input
          when activated — most lists are short, so the input taking up
          half the toolbar width was wasted real estate. The global
          status filter and "Show archived" toggle were overbuilt: the
          same controls exist per-card via the Actions menu (Archive /
          Unarchive), so the user doesn't need them at the top. */}
      <div className="border-b bg-white dark:bg-slate-900 px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100">
              <Sparkles className="h-4 w-4 text-primary" />
              Interactive Learning Experiences
            </h1>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Every experience you've authored — drafts, published, archived.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {items.length > 3 && (
              <SearchInput value={query} onChange={setQuery} />
            )}
            <Button
              size="lg"
              onClick={createNew}
              className="gap-1 bg-primary hover:bg-primary/90"
              data-testid="ile-new-experience"
            >
              <Plus className="h-4 w-4" />
              New experience
            </Button>
          </div>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-500 dark:text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : items.length === 0 ? (
          <EmptyState onCreate={createNew} />
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
            <p>No experiences match "{query}".</p>
            <button
              type="button"
              onClick={() => setQuery('')}
              className="mt-2 text-xs font-medium text-primary hover:underline"
            >
              Clear search
            </button>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((e) => (
              <ExperienceCard
                key={e._id}
                item={e}
                onOpen={() => openExperience(e._id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Small, dismissible search field. Renders as a magnifying-glass
 * icon button when empty; expands to a real input when the user
 * clicks or starts typing. Saves toolbar real estate on the common
 * "I have a handful of experiences" case.
 */
function SearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(Boolean(value));
  return (
    <div className="flex items-center">
      {open ? (
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
          <input
            autoFocus
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => {
              if (!value) setOpen(false);
            }}
            placeholder="Search by title…"
            className="w-56 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 py-1.5 pl-8 pr-3 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-slate-500 dark:text-slate-400 hover:bg-slate-100 hover:text-slate-900"
          aria-label="Search"
          title="Search experiences"
        >
          <Search className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function ExperienceCard({
  item,
  onOpen,
}: {
  item: IleExperienceListItem;
  onOpen: () => void;
}) {
  const updated = new Date(item.updatedAt);
  const archived = item.status === 'archived';
  return (
    <li>
      {/* The whole card is a single button — clicking anywhere on it
          opens the experience, with the chevron and "Open" label
          reinforcing the affordance. Stops the user from having to
          find a small "Open" button inside a card of metadata. */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${item.title || 'Untitled Experience'}`}
        className={cn(
          'group flex w-full flex-col items-stretch rounded-lg border bg-white dark:bg-slate-900 p-4 text-left shadow-sm transition-all hover:shadow-md focus:outline-none focus:ring-2 focus:ring-primary/40',
          archived ? 'border-slate-200 dark:border-slate-700 opacity-75' : 'border-slate-200 dark:border-slate-700 hover:border-primary/30',
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <h3 className="line-clamp-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            {item.title || 'Untitled Experience'}
          </h3>
          <StatusBadge status={item.status} />
        </div>

        <dl className="mt-3 space-y-1 text-[11px] text-slate-500 dark:text-slate-400">
          <div className="flex items-center justify-between">
            <dt>Version</dt>
            <dd className="font-mono text-slate-700 dark:text-slate-300">v{item.currentVersion}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt>Updated</dt>
            <dd>{updated.toLocaleDateString()}</dd>
          </div>
          {item.authorName && (
            <div className="flex items-center justify-between">
              <dt>Author</dt>
              <dd className="truncate text-slate-700 dark:text-slate-300">{item.authorName}</dd>
            </div>
          )}
          {archived && item.archivedAt && (
            <div className="flex items-center justify-between">
              <dt>Archived</dt>
              <dd>{new Date(item.archivedAt).toLocaleDateString()}</dd>
            </div>
          )}
        </dl>

        <div className="mt-3 flex items-center justify-end gap-1 text-xs font-medium text-primary">
          Open
          <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
        </div>
      </button>
    </li>
  );
}

function StatusBadge({ status }: { status: IleExperienceListItem['status'] }) {
  if (status === 'published') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-900/40 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
        Published
      </span>
    );
  }
  if (status === 'archived') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:text-slate-400">
        <Archive className="h-2.5 w-2.5" />
        Archived
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
      Draft
    </span>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 px-6 py-20 text-center">
      <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary">
        <FileText className="h-5 w-5" />
      </div>
      <div className="max-w-sm space-y-1">
        <p className="text-base font-medium text-slate-900 dark:text-slate-100">
          No experiences yet
        </p>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Generate your first interactive experience. Describe the lesson, pick
          a provider in the AI Configuration panel, and the AI will stream an
          HTML experience into the preview.
        </p>
      </div>
      <Button
        onClick={onCreate}
        className="gap-1 bg-primary hover:bg-primary/90"
      >
        <Plus className="h-3.5 w-3.5" />
        Create your first experience
      </Button>
    </div>
  );
}