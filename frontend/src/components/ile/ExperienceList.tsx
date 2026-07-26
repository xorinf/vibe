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
  /** When true, show archived items too. */
  includeArchived?: boolean;
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
  includeArchived: initialArchived = false,
  className,
}: ExperienceListProps) {
  const [items, setItems] = useState<IleExperienceListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [includeArchived, setIncludeArchived] = useState(initialArchived);
  const [query, setQuery] = useState('');
  const cancelledRef = useRef(false);
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'draft' | 'published' | 'archived'
  >('all');

  const refresh = useCallback(async () => {
    if (cancelledRef.current) return;
    setLoading(true);
    try {
      const res = await listIleExperiences({ includeArchived });
      if (cancelledRef.current) return;
      setItems(res.experiences);
    } catch (err: unknown) {
      if (cancelledRef.current) return;
      toast.error(err instanceof Error ? err.message : 'Could not load experiences.');
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [includeArchived]);

  useEffect(() => {
    cancelledRef.current = false;
    void refresh();
    return () => {
      cancelledRef.current = true;
    };
  }, [refresh]);

  const filtered = items.filter((e) => {
    if (statusFilter !== 'all' && e.status !== statusFilter) return false;
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
    <div className={cn('flex h-full flex-col bg-slate-50', className)}>
      {/* Header */}
      <div className="border-b bg-white px-5 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-base font-semibold text-slate-900">
              <Sparkles className="h-4 w-4 text-primary" />
              Interactive Learning Experiences
            </h1>
            <p className="text-xs text-slate-500">
              Manage every experience you've authored — drafts, published, archived.
            </p>
          </div>
          <Button
            size="lg"
            onClick={createNew}
            className="gap-1 bg-primary hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            New experience
          </Button>
        </div>

        {/* Filters */}
        <div className="mt-3 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by title…"
              className="w-full rounded-md border border-slate-300 bg-white py-1.5 pl-8 pr-3 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as typeof statusFilter)
            }
            className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
          >
            <option value="all">All statuses</option>
            <option value="draft">Drafts</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-300"
            />
            Show archived
          </label>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-5 py-3">
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : items.length === 0 ? (
          <EmptyState onCreate={createNew} />
        ) : filtered.length === 0 ? (
          <p className="py-12 text-center text-sm text-slate-500">
            No experiences match the current filters.
          </p>
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
    <li
      className={cn(
        'group flex flex-col rounded-lg border bg-white p-4 shadow-sm transition-all hover:shadow-md',
        archived ? 'border-slate-200 opacity-75' : 'border-slate-200 hover:border-primary/30',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="line-clamp-2 text-sm font-semibold text-slate-900">
          {item.title || 'Untitled Experience'}
        </h3>
        <StatusBadge status={item.status} />
      </div>

      <dl className="mt-3 space-y-1 text-[11px] text-slate-500">
        <div className="flex items-center justify-between">
          <dt>Version</dt>
          <dd className="font-mono text-slate-700">v{item.currentVersion}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt>Updated</dt>
          <dd>{updated.toLocaleDateString()}</dd>
        </div>
        {item.authorName && (
          <div className="flex items-center justify-between">
            <dt>Author</dt>
            <dd className="truncate text-slate-700">{item.authorName}</dd>
          </div>
        )}
        {archived && item.archivedAt && (
          <div className="flex items-center justify-between">
            <dt>Archived</dt>
            <dd>{new Date(item.archivedAt).toLocaleDateString()}</dd>
          </div>
        )}
      </dl>

      <div className="mt-3 flex items-center justify-end">
        <Button
          size="sm"
          variant="outline"
          onClick={onOpen}
          className="h-10 gap-1 text-xs"
        >
          Open
          <ArrowRight className="h-3 w-3" />
        </Button>
      </div>
    </li>
  );
}

function StatusBadge({ status }: { status: IleExperienceListItem['status'] }) {
  if (status === 'published') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
        Published
      </span>
    );
  }
  if (status === 'archived') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
        <Archive className="h-2.5 w-2.5" />
        Archived
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
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
        <p className="text-base font-medium text-slate-900">
          No experiences yet
        </p>
        <p className="text-sm text-slate-500">
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