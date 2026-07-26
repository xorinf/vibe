import { useCallback, useEffect, useRef, useState } from 'react';
import { History, RotateCcw, Loader2, Tag, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/utils';
import {
  listIleVersions,
  restoreIleVersion,
  type IleVersionListItem,
} from './ileApi';

export interface HistoryPanelProps {
  experienceId: string;
  /**
   * Called when the user restores a previous version. Parent uses this to
   * refresh its in-memory `saved` snapshot and to clear any in-progress
   * streaming state so the restored version flows through the preview.
   */
  onRestored?: (newSaved: {
    html: string;
    title: string;
    currentVersion: number;
  }) => void;
  className?: string;
}

/**
 * Version history list for an experience.
 *
 * Fetches the version array on mount and after every save, and renders
 * a chronological list (newest first). The current version is marked;
 * older versions expose a Restore button.
 *
 * Stays self-contained — no global state, no router navigation. The
 * Teacher Workspace mounts one of these inside a collapsible drawer at the
 * bottom of the workspace.
 */
export function HistoryPanel({
  experienceId,
  onRestored,
  className,
}: HistoryPanelProps) {
  const [versions, setVersions] = useState<IleVersionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!experienceId || cancelledRef.current) return;
    setLoading(true);
    try {
      const res = await listIleVersions(experienceId);
      if (cancelledRef.current) return;
      setVersions(res.versions);
    } catch (err: any) {
      if (cancelledRef.current) return;
      // 404 — experience was deleted out from under us; let the parent
      // catch that with its own refresh.
      toast.error(err?.message ?? 'Could not load version history.');
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [experienceId]);

  useEffect(() => {
    cancelledRef.current = false;
    void refresh();
    return () => {
      cancelledRef.current = true;
    };
  }, [refresh]);

  const handleRestore = useCallback(
    async (version: number) => {
      const ok = window.confirm(
        `Restore v${version}? The current head becomes a new version snapshot — nothing is lost.`,
      );
      if (!ok) return;
      setRestoringVersion(version);
      try {
        const restored = await restoreIleVersion(experienceId, version);
        toast.success(`Restored v${version}. This created a new head snapshot.`);
        // Re-fetch so the list shows the new head and marks it current.
        await refresh();
        onRestored?.({
          html: restored.html,
          title: restored.title,
          currentVersion: restored.currentVersion,
        });
      } catch (err: any) {
        toast.error(err?.message ?? 'Restore failed.');
      } finally {
        setRestoringVersion(null);
      }
    },
    [experienceId, refresh, onRestored],
  );

  return (
    <div className={cn('flex h-full flex-col bg-white dark:bg-slate-900', className)}>
      <div className="border-b px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          <History className="h-3.5 w-3.5 text-primary" />
          Version history
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Every Save creates a snapshot. Restore any version — nothing is lost.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {loading && versions.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-slate-500 dark:text-slate-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading history…
          </div>
        ) : versions.length === 0 ? (
          <p className="py-10 text-center text-xs text-slate-500 dark:text-slate-400">
            No history yet. Save the experience to create the first version.
          </p>
        ) : (
          <ol className="space-y-2">
            {versions.map((v) => (
              <VersionRow
                key={v.version}
                version={v}
                restoring={restoringVersion === v.version}
                onRestore={handleRestore}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function VersionRow({
  version,
  restoring,
  onRestore,
}: {
  version: IleVersionListItem;
  restoring: boolean;
  onRestore: (v: number) => void;
}) {
  const date = new Date(version.savedAt);
  const when = date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const sizeKb = (version.htmlLength / 1024).toFixed(1);

  return (
    <li
      className={cn(
        'rounded-md border px-3 py-2 text-sm transition-colors',
        version.isCurrent
          ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/30'
          : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-primary/30',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-semibold text-slate-700 dark:text-slate-300">
              v{version.version}
            </span>
            {version.isCurrent && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-900/40 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-2.5 w-2.5" />
                Current
              </span>
            )}
            {version.label && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                <Tag className="h-2.5 w-2.5" />
                {version.label}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[13px] font-medium text-slate-900 dark:text-slate-100">
            {version.title || 'Untitled'}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            {when} · by {version.savedBy || 'unknown'} · {sizeKb} KB
          </p>
        </div>
        {!version.isCurrent && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onRestore(version.version)}
            disabled={restoring}
            className="h-10 gap-1 px-2 text-xs text-primary hover:bg-primary/10 hover:text-primary/80"
          >
            {restoring ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RotateCcw className="h-3 w-3" />
            )}
            Restore
          </Button>
        )}
      </div>
    </li>
  );
}