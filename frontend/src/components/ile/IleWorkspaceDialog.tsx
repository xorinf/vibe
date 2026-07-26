/**
 * Dialog wrapper around the teacher ILE workspace.
 *
 * The teacher clicks "Generate experience" or "Open in workspace" on a
 * course item and the workspace opens *over* the course page — no
 * navigation. The dialog owns its own `experienceId` state so opening
 * a different experience resets cleanly. Closing hands control back to
 * the page underneath.
 */
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TeacherILEWorkspace } from './TeacherILEWorkspace';

export interface IleWorkspaceDialogProps {
  /** Whether the dialog is currently open. */
  open: boolean;
  /** Called when the dialog wants to close (× button, Back, Escape, etc.). */
  onOpenChange: (open: boolean) => void;
  /**
   * When `undefined`, opens a fresh-canvas workspace tied to the
   * course + item context. When set, opens an existing experience.
   */
  experienceId?: string;
  /** Course context the workspace uses for the first generate / save. */
  defaults?: {
    courseId: string;
    courseVersionId: string;
    itemId?: string;
  };
}

export function IleWorkspaceDialog({
  open,
  onOpenChange,
  experienceId,
  defaults,
}: IleWorkspaceDialogProps) {
  // Re-key the inner workspace on open so each opening starts from a
  // clean editor state. Otherwise reopening the same id after closing
  // would carry the old streamed HTML into the new mount.
  const [mountKey, setMountKey] = useState(0);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          // Bump the key so the workspace remounts on each open.
          setMountKey((k) => k + 1);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent
        // Near-fullscreen. We keep a small padding so the close (×)
        // button stays visible without crowding the workspace.
        // [&>button:has(span.sr-only)]:hidden — Radix injects an X close
        // button at absolute right-4 top-4 with a hidden "Close" label
        // for screen readers. The workspace owns its own close button
        // in the header, so we suppress the default to avoid the two
        // competing for the same corner. Selector targets the Radix
        // button specifically — the only <button> whose only child is
        // a sr-only span — our header close has an icon.
        className="h-[95vh] w-[min(1400px,95vw)] max-w-none gap-0 overflow-hidden border-slate-200 bg-slate-50 p-0 [&>button:has(>span.sr-only)]:hidden"
        aria-describedby="ile-workspace-description"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Interactive Learning Experience workspace</DialogTitle>
          <DialogDescription id="ile-workspace-description">
            Generate, edit, and publish an AI-powered interactive learning
            experience. Save attaches it to the current course item.
          </DialogDescription>
        </DialogHeader>
        <div className="h-full w-full">
          <TeacherILEWorkspace
            key={mountKey}
            experienceId={experienceId}
            defaults={defaults}
            onClose={() => onOpenChange(false)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}