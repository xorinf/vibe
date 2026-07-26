/**
 * Teacher ILE library page — full-page mount of `ExperienceList`.
 *
 * Renders the manager view (every experience the teacher has authored)
 * and reuses the same `IleWorkspaceDialog` pattern the course page
 * uses. The teacher picks an experience from the list and the workspace
 * opens in-place as a Dialog; "New experience" opens a fresh-canvas
 * dialog (no `experienceId`).
 *
 * This is the standalone URL counterpart to the in-place dialog on
 * `/teacher/courses/view`. Teachers can land here directly from a
 * sidebar link without first opening a course.
 */
import { useState } from 'react';
import { ExperienceList } from '@/components/ile/ExperienceList';
import { IleWorkspaceDialog } from '@/components/ile/IleWorkspaceDialog';

export default function TeacherILELibraryPage() {
  // Same dialog state shape as teacher-course-page.tsx — single dialog
  // instance, re-keyed via the dialog itself on each open. Keeping the
  // state local to this page (not shared with the course page) is
  // deliberate: a teacher browsing the library is in a different mental
  // model than one mid-edit on a specific course item.
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceExperienceId, setWorkspaceExperienceId] = useState<
    string | undefined
  >(undefined);

  const handleOpen = (id: string) => {
    setWorkspaceExperienceId(id);
    setWorkspaceOpen(true);
  };

  const handleCreate = () => {
    setWorkspaceExperienceId(undefined);
    setWorkspaceOpen(true);
  };

  return (
    <>
      <ExperienceList onOpen={handleOpen} onCreate={handleCreate} />
      <IleWorkspaceDialog
        open={workspaceOpen}
        onOpenChange={setWorkspaceOpen}
        experienceId={workspaceExperienceId}
      />
    </>
  );
}