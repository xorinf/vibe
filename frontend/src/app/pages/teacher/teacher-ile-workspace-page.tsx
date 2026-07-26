/**
 * Teacher ILE workspace page — full-page mount of `TeacherILEWorkspace`
 * for the "Generate new playground" flow.
 *
 * Mounted at /teacher/ile/new. Replaces the IleWorkspaceDialog modal
 * pattern for teachers who want a dedicated page experience (matches
 * the Generate Playground button they had pre-dialog-rewrite).
 *
 * Reads course context from URL search params (courseId, courseVersionId,
 * sectionId) and forwards it to the workspace's defaults.
 */
import { useSearch } from "@tanstack/react-router";
import { TeacherILEWorkspace } from "@/components/ile/TeacherILEWorkspace";

export default function TeacherILEWorkspacePage() {
  // Read course context from the URL (set by the Add Item dropdown
  // when the teacher picks "Interactive Playground").
  const search = useSearch({ strict: false }) as {
    courseId?: string;
    courseVersionId?: string;
    itemId?: string;
  };

  const defaults =
    search.courseId && search.courseVersionId
      ? {
          courseId: search.courseId,
          courseVersionId: search.courseVersionId,
          itemId: search.itemId,
        }
      : undefined;

  return <TeacherILEWorkspace defaults={defaults} />;
}
