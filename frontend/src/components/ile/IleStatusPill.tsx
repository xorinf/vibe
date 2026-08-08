/**
 * Status pill for an Interactive Experience item.
 *
 * Single source of truth — used in three places that previously
 * each had their own copy:
 *   1. The section-tree item row in the teacher course page.
 *   2. The inline view header above the iframe preview.
 *   3. (future) The ILE library's history list.
 *
 * Why a component instead of a plain function: the pill
 * supports two input shapes (a full `item` with nested
 * `details.status`/`details.experienceId` for the section tree,
 * OR a flat `status` + `hasExperience` for the inline view where
 * the ILE doc is fetched separately). One component, two prop
 * shapes — saves a fourth copy in the next caller.
 *
 * Visual contract:
 *   - "Published" (green) — students can play it now.
 *   - "Draft"     (gray)  — itemsGroup row exists, ILE doc
 *                            saved but either no `html` yet or
 *                            status is 'draft'. Most common
 *                            state right after a teacher creates
 *                            a new item.
 *   - "Archived"  (amber) — soft-deleted, not playable.
 *
 * Always renders a pill when called with an `item.type` of
 * `INTERACTIVE_EXPERIENCE` (so the section tree always shows
 * the state, never a blank spot). For the inline view the
 * caller passes the flat shape and we always render.
 */
import { Sparkles } from 'lucide-react';

export type IlePillStatus = 'draft' | 'published' | 'archived' | undefined;

export interface IleStatusPillFromItem {
  /** The itemsGroup row. Only `type` and `details.{status,
   *  experienceId}` are read. */
  item: {
    type?: string;
    details?: { experienceId?: string; status?: string };
  };
  /**
   * When true, treat the item as having an ILE doc linked
   * even if `details.experienceId` is empty (e.g. we have a
   * freshly fetched doc in the inline view). The section-tree
   * use case doesn't need this; the inline view does.
   */
  hasExperience?: boolean;
}

export interface IleStatusPillFromStatus {
  item?: undefined;
  status: IlePillStatus;
  hasExperience?: boolean;
}

export type IleStatusPillProps =
  | IleStatusPillFromItem
  | IleStatusPillFromStatus;

/**
 * Pill content + color. Internal so the component owns the
 * style table — callers don't pass colors directly.
 */
function resolvePill(
  status: IlePillStatus,
  hasExperience: boolean,
): { label: string; className: string; testId: string } {
  // Anything not explicitly 'published' or 'archived' is a
  // draft. The fallback chain lets a freshly-created itemsGroup
  // row (no `details.status` yet) still render the right pill.
  if (status === 'published') {
    return {
      label: 'Published',
      className: 'bg-success-soft/15 text-success-strong',
      testId: 'ile-status-published',
    };
  }
  if (status === 'archived') {
    return {
      label: 'Archived',
      className: 'bg-warm/15 text-warm',
      testId: 'ile-status-archived',
    };
  }
  // Default — covers the no-doc, no-status, and explicit-draft
  // cases. hasExperience is currently unused but kept in the
  // signature so we can add a "Draft (no content)" sub-state
  // later without changing every call site.
  void hasExperience;
  return {
    label: 'Draft',
    className: 'bg-muted/40 text-muted-foreground',
    testId: 'ile-status-draft',
  };
}

/**
 * Status pill for an Interactive Experience item. Returns
 * `null` for non-ILE items so the section-tree caller can
 * render `<IleStatusPill item={item} />` unconditionally.
 */
export function IleStatusPill(props: IleStatusPillProps) {
  // Non-ILE items: bail out so the section tree renders an
  // icon-and-label without a pill (matching the pre-refactor
  // behavior).
  if (props.item !== undefined && props.item.type !== 'INTERACTIVE_EXPERIENCE') {
    return null;
  }

  const status: IlePillStatus =
    props.item !== undefined
      ? ((props.item.details?.status as IlePillStatus) ??
        (props.item.details?.experienceId ? 'draft' : 'draft'))
      : props.status;

  const hasExperience = Boolean(
    props.item !== undefined
      ? props.item.details?.experienceId
      : props.hasExperience,
  );

  const pill = resolvePill(status, hasExperience);
  return (
    <span
      data-testid={pill.testId}
      // Sparkle only on the section-tree variant — the inline
      // view header already has its own sparkles icon.
      className={
        props.item !== undefined
          ? `ml-1.5 inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${pill.className}`
          : `ml-1.5 inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${pill.className}`
      }
      title={`This Interactive Experience is ${pill.label.toLowerCase()}.`}
    >
      {props.item !== undefined && <Sparkles className="h-2.5 w-2.5" />}
      {pill.label}
    </span>
  );
}
