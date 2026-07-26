import { useEffect, useRef, useState } from 'react';
import {
  MoreVertical,
  Copy,
  Archive,
  ArchiveRestore,
  Trash2,
  Edit3,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/utils';
import {
  archiveIleExperience,
  deleteIleExperience,
  duplicateIleExperience,
  renameIleExperience,
  unarchiveIleExperience,
} from './ileApi';

export interface ActionsMenuProps {
  experienceId: string;
  currentTitle: string;
  isArchived: boolean;
  /**
   * Fired after each lifecycle action. The parent uses this to refresh
   * its `saved` snapshot, navigate on duplicate, etc.
   */
  onAction: (
    action: 'renamed' | 'duplicated' | 'archived' | 'unarchived' | 'deleted',
    payload?: { newId?: string; newTitle?: string },
  ) => void;
  className?: string;
}

/**
 * Top-right overflow menu in the Teacher Workspace. Surfaces the
 * lifecycle actions (Rename / Duplicate / Archive / Unarchive / Delete)
 * that don't deserve real-estate in the main action row.
 *
 * Self-contained — owns its dropdown open-state and the action handlers.
 * Closes itself after every successful action so the menu never lingers.
 */
export function ActionsMenu({
  experienceId,
  currentTitle,
  isArchived,
  onAction,
  className,
}: ActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newTitle, setNewTitle] = useState(currentTitle);
  const [busy, setBusy] = useState<'rename' | 'duplicate' | 'archive' | 'delete' | null>(
    null,
  );
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Sync local rename input when current title changes (e.g. after
  // a successful save that updated the title).
  useEffect(() => {
    if (!renaming) setNewTitle(currentTitle);
  }, [currentTitle, renaming]);

  // Click-outside to close
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  async function handleRename() {
    const trimmed = newTitle.trim();
    if (!trimmed || trimmed === currentTitle) {
      setRenaming(false);
      setNewTitle(currentTitle);
      return;
    }
    setBusy('rename');
    try {
      await renameIleExperience(experienceId, trimmed);
      toast.success('Renamed.');
      onAction('renamed', { newTitle: trimmed });
      setRenaming(false);
      setOpen(false);
    } catch (err: any) {
      toast.error(err?.message ?? 'Rename failed.');
    } finally {
      setBusy(null);
    }
  }

  async function handleDuplicate() {
    setBusy('duplicate');
    try {
      const copy = await duplicateIleExperience(experienceId);
      toast.success('Duplicated as a new draft.');
      onAction('duplicated', { newId: copy._id });
      setOpen(false);
    } catch (err: any) {
      toast.error(err?.message ?? 'Duplicate failed.');
    } finally {
      setBusy(null);
    }
  }

  async function handleArchive() {
    setBusy('archive');
    try {
      await archiveIleExperience(experienceId);
      toast.success('Archived. Students can no longer see this experience.');
      onAction('archived');
      setOpen(false);
    } catch (err: any) {
      toast.error(err?.message ?? 'Archive failed.');
    } finally {
      setBusy(null);
    }
  }

  async function handleUnarchive() {
    setBusy('archive');
    try {
      await unarchiveIleExperience(experienceId);
      toast.success('Restored to draft.');
      onAction('unarchived');
      setOpen(false);
    } catch (err: any) {
      toast.error(err?.message ?? 'Unarchive failed.');
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    const ok = window.confirm(
      'Delete this experience? It will be archived and hidden from students. You can restore it later from the archive.',
    );
    if (!ok) return;
    setBusy('delete');
    try {
      await deleteIleExperience(experienceId);
      toast.success('Deleted (archived).');
      onAction('deleted');
      setOpen(false);
    } catch (err: any) {
      toast.error(err?.message ?? 'Delete failed.');
    } finally {
      setBusy(null);
    }
  }

  const isBusy = busy !== null;

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen((v) => !v)}
        disabled={isBusy}
        aria-label="Experience actions"
        className="h-10 gap-1 px-2 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-900"
      >
        {isBusy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <MoreVertical className="h-3.5 w-3.5" />
        )}
        Actions
      </Button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg">
          {/* Inline rename */}
          {renaming ? (
            <div className="space-y-2 p-3">
              <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400">
                Rename experience
              </label>
              <input
                autoFocus
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleRename();
                  }
                  if (e.key === 'Escape') {
                    setRenaming(false);
                    setNewTitle(currentTitle);
                  }
                }}
                className="w-full rounded-md border border-slate-300 dark:border-slate-600 px-2 py-1.5 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
              <div className="flex items-center justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRenaming(false);
                    setNewTitle(currentTitle);
                  }}
                  className="h-10 text-xs"
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleRename}
                  disabled={busy === 'rename'}
                  className="h-10 bg-primary text-xs hover:bg-primary/90"
                >
                  {busy === 'rename' ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    'Save'
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 py-1">
              <MenuItem
                icon={<Edit3 className="h-3.5 w-3.5" />}
                label="Rename…"
                onClick={() => {
                  setNewTitle(currentTitle);
                  setRenaming(true);
                }}
                disabled={isBusy}
              />
              <MenuItem
                icon={<Copy className="h-3.5 w-3.5" />}
                label="Duplicate"
                hint="Creates a new draft"
                onClick={handleDuplicate}
                disabled={isBusy}
              />
              {isArchived ? (
                <MenuItem
                  icon={<ArchiveRestore className="h-3.5 w-3.5" />}
                  label="Unarchive"
                  hint="Restore as draft"
                  onClick={handleUnarchive}
                  disabled={isBusy}
                />
              ) : (
                <MenuItem
                  icon={<Archive className="h-3.5 w-3.5" />}
                  label="Archive"
                  hint="Hide from students"
                  onClick={handleArchive}
                  disabled={isBusy}
                />
              )}
              <MenuItem
                icon={<Trash2 className="h-3.5 w-3.5" />}
                label="Delete"
                hint="Soft delete — reversible"
                tone="danger"
                onClick={handleDelete}
                disabled={isBusy}
              />
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  hint,
  tone,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  tone?: 'danger';
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          'flex min-h-10 w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors',
          'hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50',
          tone === 'danger' && 'text-rose-700 hover:bg-rose-50/60',
        )}
      >
        <span
          className={cn(
            'mt-0.5 text-slate-400',
            tone === 'danger' && 'text-rose-500',
          )}
        >
          {icon}
        </span>
        <span className="flex-1">
          <span className="block text-[13px] font-medium">{label}</span>
          {hint && (
            <span className="block text-[11px] text-slate-500 dark:text-slate-400">{hint}</span>
          )}
        </span>
      </button>
    </li>
  );
}