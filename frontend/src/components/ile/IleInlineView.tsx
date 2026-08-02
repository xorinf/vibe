/**
 * Inline ILE view for the teacher course page.
 *
 * Renders on the right side of the course page when the teacher
 * clicks an Interactive Experience item in the section tree. Shows:
 *   - The ILE's saved HTML in a sandboxed iframe (interactive —
 *     the teacher can click buttons, fill forms, etc. inside it)
 *   - "Edit" header chip → opens the full-screen TeacherILEWorkspace
 *     Dialog so the teacher can edit the AI-generated HTML
 *   - "Link existing" / "Swap" header chip → opens the ILE library
 *     picker so the teacher can bind a different ILE doc to this
 *     itemsGroup row
 *   - Refresh ↻ → re-fetches the canonical ILE doc
 *   - X close button → clears the selection
 *
 * Two empty states:
 *   - New item (no experienceId yet) → "This experience hasn't been
 *     generated yet" + two CTAs: "Link existing" / "Open workspace"
 *   - ILE doc fetched but `html` is empty → same empty state (a doc
 *     was created with the AI but no content was saved yet)
 *
 * Props are owned by the parent (teacher-course-page) so the
 * default-on-reselect behaviour is local. The ILE doc fetch is also
 * owned here (IleInlineView is the natural owner of the ILE doc
 * lifecycle for the inline-preview case).
 */
import { useEffect, useState } from 'react';
import {
  Link2,
  Pencil,
  RefreshCw,
  X,
  Sparkles,
  Search,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { SandboxIframe } from './SandboxIframe';
import {
  getIleExperience,
  listIleExperiences,
  type IleExperienceResponse,
} from './ileApi';

// ──────────────────────────────────────────────────────────────────────
// Props
// ──────────────────────────────────────────────────────────────────────

export interface IleInlineViewProps {
  itemName: string;
  /**
   * The experienceId the itemsGroup row currently points at, if any.
   * Used to fetch the ILE doc; empty when this is a brand-new item.
   */
  experienceId?: string;
  /**
   * Open the full-screen workspace Dialog (the original ILE editor
   * UX). Called by the "Edit" / "Open workspace" chip in the header.
   * Closes the inline view first because the dialog replaces the
   * right pane.
   */
  onOpenWorkspace: () => void;
  /**
   * Bind an existing ILE to this itemsGroup row. The parent is
   * responsible for issuing the PATCH and refetching the version
   * tree. Receives the picked experience's id, status, currentVersion
   * and updatedAt — exactly the shape the workspace's `ile:saved`
   * event uses — so both flows share one persistence path.
   */
  onLinkExisting: (picked: {
    experienceId: string;
    status: string;
    currentVersion: number;
    updatedAt: number;
  }) => Promise<void> | void;
  onClose: () => void;
}

// ──────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────

export function IleInlineView({
  itemName,
  experienceId,
  onOpenWorkspace,
  onLinkExisting,
  onClose,
}: IleInlineViewProps) {
  // Fetch the ILE doc so the preview shows the canonical saved
  // HTML (same path the student runtime takes). When the ILE doc
  // doesn't exist yet (just-created itemsGroup row, no save), the
  // preview shows an empty state with a prompt to click Edit.
  const [saved, setSaved] = useState<IleExperienceResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Link-existing picker state — when open, the ILE library list is
  // fetched and the teacher can pick an experience to bind to this
  // itemsGroup row. The picked experience becomes the row's pointer
  // via PATCH /courses/.../items/... with `ileDetails` (issued by
  // the parent via the onLinkExisting callback).
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [linkSearch, setLinkSearch] = useState('');
  const [linkOptions, setLinkOptions] = useState<
    Array<{
      _id: string;
      title: string;
      status: string;
      currentVersion?: number;
      updatedAt?: string;
    }>
  >([]);
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  useEffect(() => {
    if (!experienceId) {
      setSaved(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const doc = await getIleExperience(experienceId);
        if (cancelled) return;
        setSaved(doc);
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg || 'Failed to load experience');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [experienceId, reloadKey]);

  // Fetch the ILE library when the picker opens. The list can be
  // large (every experience the teacher has authored) so we
  // debounce the search input and filter client-side. Once the
  // teacher picks an experience, we close the picker and call
  // onLinkExisting — the parent PATCHes the itemsGroup row.
  useEffect(() => {
    if (!linkPickerOpen) return;
    let cancelled = false;
    setLinkLoading(true);
    setLinkError(null);
    (async () => {
      try {
        const res = await listIleExperiences({ includeArchived: true });
        if (cancelled) return;
        setLinkOptions(res.experiences ?? []);
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setLinkError(msg || 'Failed to load ILE library');
      } finally {
        if (!cancelled) setLinkLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [linkPickerOpen]);

  // Local search filter for the picker list.
  const filteredLinkOptions = (() => {
    const q = linkSearch.trim().toLowerCase();
    if (!q) return linkOptions;
    return linkOptions.filter(
      (opt) =>
        opt.title.toLowerCase().includes(q) ||
        opt.status.toLowerCase().includes(q) ||
        opt._id.toLowerCase().includes(q),
    );
  })();

  return (
    <div
      className="flex h-full min-h-[70vh] flex-col overflow-hidden rounded-lg border bg-background"
      data-testid="ile-inline-view"
    >
      {/* Header — title + edit/swap/refresh/close chips. The chip on
          the right is "Edit" when an experience is linked, "Open
          workspace" when nothing is linked yet, so the teacher always
          has a clear next action. */}
      <header className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles className="h-4 w-4 text-ai" />
          <h2 className="truncate text-sm font-semibold text-foreground">
            {itemName}
          </h2>
          {saved?.status && saved.status !== 'draft' && (
            <span className="ml-1.5 inline-flex items-center rounded-full bg-success-soft/15 px-1.5 py-0.5 text-[10px] font-medium text-success-strong">
              {saved.status === 'published' ? 'Published' : 'Archived'}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {experienceId && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setLinkPickerOpen(true)}
                className="h-8 gap-1 px-2 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                title="Bind an existing ILE to this item"
                data-testid="ile-view-link-existing"
              >
                <Link2 className="h-3.5 w-3.5" />
                <span className="hidden md:inline">
                  {saved ? 'Swap' : 'Link existing'}
                </span>
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setReloadKey((k) => k + 1)}
                className="h-8 w-8 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                title="Refresh"
                aria-label="Refresh"
                data-testid="ile-view-refresh"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={onOpenWorkspace}
            className="h-8 gap-1 px-2 text-xs"
            title="Open the full-screen workspace editor"
            data-testid="ile-view-edit"
          >
            <Pencil className="h-3.5 w-3.5" />
            <span className="hidden md:inline">
              {experienceId ? 'Edit' : 'Open workspace'}
            </span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close ILE view"
            title="Close"
            className="h-8 w-8 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            data-testid="ile-view-close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {/* Body — when an experience is linked, this mounts the ILE
          sandboxed iframe (interactive). When nothing is linked yet,
          the empty state walks the teacher through the two paths to
          getting one:
            1. "Generate with AI" → opens the workspace Dialog where
               they describe the lesson; the AI streams the HTML
               straight into the editor; on Save the itemsGroup row
               gets the experienceId pointer.
            2. "Link existing" → opens the ILE library picker; picking
               one patches the itemsGroup row directly.
      */}
      <div className="relative min-h-[60vh] flex-1 bg-stage text-stage-foreground overflow-hidden">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-stage-foreground/80">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading experience…
          </div>
        ) : error ? (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-destructive-foreground">
            {error}
          </div>
        ) : saved?.html ? (
          <SandboxIframe
            key={`preview-${saved._id}-${saved.currentVersion ?? 0}`}
            html={saved.html}
            experienceId={saved._id}
            // No SDK in the inline view — the SDK's `setContent`
            // (document.open + document.write) was racing the AI
            // script and the inline view always shows the saved
            // snapshot anyway, not the live editor stream. The
            // workspace's centre canvas (EditorSplitPane) keeps
            // injectSdk=true for its real-time updates.
            allowSameOrigin
            className="absolute inset-0"
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center text-stage-foreground">
            <Sparkles className="h-10 w-10 text-ai" />
            <p className="text-base font-medium">
              This experience hasn't been generated yet
            </p>
            <p className="max-w-md text-xs text-stage-foreground/80">
              Click <span className="font-semibold">Edit</span> to open
              the workspace and describe the lesson. Or click{' '}
              <span className="font-semibold">Link existing</span> to
              bind an ILE you've already authored. The AI will
              stream the experience into the editor, and it'll show up here as
              soon as you save.
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="lg"
                onClick={() => setLinkPickerOpen(true)}
                className="mt-2 bg-overlay px-5 text-overlay-foreground ring-1 ring-overlay-border hover:bg-overlay-strong"
              >
                <Link2 className="mr-2 h-4 w-4" />
                Link existing
              </Button>
              <Button
                size="lg"
                onClick={onOpenWorkspace}
                className="mt-2 bg-primary px-5 text-primary-foreground hover:bg-primary/90"
              >
                <Pencil className="mr-2 h-4 w-4" />
                Open workspace
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Link-existing picker — opens on top of the inline view when
          the teacher clicks "Link existing" / "Swap" in the header.
          Lists every ILE the teacher has authored (including
          archived) with a search field; picking one calls the
          parent's onLinkExisting which PATCHes the itemsGroup row.
          We use the existing Radix Dialog so the close behavior,
          escape-to-dismiss, and focus trap are inherited. */}
      <Dialog
        open={linkPickerOpen}
        onOpenChange={(next) => {
          setLinkPickerOpen(next);
          if (!next) setLinkSearch('');
        }}
      >
        <DialogContent
          className="h-[80vh] w-[min(720px,95vw)] gap-0 overflow-hidden p-0"
          aria-describedby="ile-link-picker-description"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Link an existing experience</DialogTitle>
            <DialogDescription id="ile-link-picker-description">
              Pick an experience from your ILE library to bind to this
              itemsGroup row. The picked experience becomes the row's
              pointer; the rich content lives in the original doc.
            </DialogDescription>
          </DialogHeader>
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b bg-background px-4 py-3">
              <Link2 className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold text-foreground">
                Link existing experience
              </span>
            </div>
            <div className="shrink-0 border-b bg-background/60 px-4 py-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={linkSearch}
                  onChange={(e) => setLinkSearch(e.target.value)}
                  placeholder="Search ILE library"
                  className="h-8 pl-8 text-xs"
                  data-testid="ile-link-picker-search"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {linkLoading ? (
                <div className="flex h-full items-center justify-center py-10 text-xs text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading ILE library…
                </div>
              ) : linkError ? (
                <div className="p-4 text-sm text-destructive-foreground">
                  {linkError}
                </div>
              ) : filteredLinkOptions.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center text-sm text-muted-foreground">
                  <p className="font-medium">No matching experiences</p>
                  <p className="max-w-sm text-xs text-muted-foreground/80">
                    {linkOptions.length === 0
                      ? "You haven't authored any ILE experiences yet. Use Edit to create one, or come back after you've saved your first experience from the ILE library."
                      : 'Try a different search term.'}
                  </p>
                </div>
              ) : (
                <ul
                  className="divide-y divide-border"
                  data-testid="ile-link-picker-list"
                >
                  {filteredLinkOptions.map((opt) => {
                    const isCurrent =
                      experienceId && opt._id === experienceId;
                    return (
                      <li key={opt._id}>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              setLinkLoading(true);
                              await onLinkExisting({
                                experienceId: opt._id,
                                status: opt.status,
                                currentVersion:
                                  opt.currentVersion ?? 0,
                                updatedAt: opt.updatedAt
                                  ? new Date(opt.updatedAt).getTime()
                                  : Date.now(),
                              });
                              setLinkPickerOpen(false);
                            } catch (err: unknown) {
                              setLinkError(
                                err instanceof Error
                                  ? err.message
                                  : String(err),
                              );
                            } finally {
                              setLinkLoading(false);
                            }
                          }}
                          disabled={isCurrent || linkLoading}
                          className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-60 focus:bg-accent/40 focus:outline-none"
                          data-testid={`ile-link-picker-option-${opt._id}`}
                        >
                          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium text-foreground">
                                {opt.title || 'Untitled experience'}
                              </span>
                              {isCurrent ? (
                                <span className="inline-flex shrink-0 items-center rounded-full bg-success-soft/15 px-1.5 py-0.5 text-[10px] font-medium text-success-strong">
                                  Currently linked
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                              <span
                                className={
                                  'inline-flex items-center rounded-full px-1.5 py-0.5 font-medium ' +
                                  (opt.status === 'published'
                                    ? 'bg-success-soft/15 text-success-strong'
                                    : opt.status === 'archived'
                                      ? 'bg-warm/15 text-warm'
                                      : 'bg-accent/15 text-accent-foreground')
                                }
                              >
                                {opt.status}
                              </span>
                              {typeof opt.currentVersion === 'number' ? (
                                <span>v{opt.currentVersion}</span>
                              ) : null}
                              {opt.updatedAt ? (
                                <span>
                                  updated{' '}
                                  {new Date(opt.updatedAt).toLocaleDateString()}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="flex shrink-0 items-center justify-end gap-2 border-t bg-background/60 px-4 py-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLinkPickerOpen(false)}
                data-testid="ile-link-picker-close"
              >
                Close
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
