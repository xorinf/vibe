/**
 * Shared constants for the ILE module's window-level event
 * contract.
 *
 * The teacher workspace's `TeacherILEWorkspace` dispatches
 * `ile:saved` after a successful save (or save+publish). The
 * course page listens for it and refreshes its section tree.
 *
 * The event detail shape is the ILE pointer + status the
 * section's itemsGroup row needs to mirror. With the unified
 * save endpoint on the backend, the itemsGroup $set happens
 * inside the same Mongo transaction as the ILE doc save —
 * this event is now a "please re-fetch" signal, not a "PATCH
 * the row" signal.
 *
 * Centralized here so:
 *   - the dispatch site (`TeacherILEWorkspace.handleSave`) and
 *     the listen site (`useIleSaveRefresher` hook + course page)
 *     share the same shape and won't drift apart;
 *   - future listeners (the ILE library's refresh-on-save,
 *     analytics refresh, etc.) can subscribe without parsing
 *     inline `as CustomEvent<{ ... }>` casts.
 */

/**
 * Name of the window event the workspace dispatches after
 * a successful ILE save.
 */
export const ILE_SAVED_EVENT = 'ile:saved';

/**
 * Detail shape carried by the `ile:saved` event.
 *
 * `itemsGroupItemId` is the itemsGroup row's _id. The course
 * page uses it to know which row to update in the section tree
 * without a follow-up GET.
 *
 * `experienceId` is the ILE doc's _id (the pointer the itemsGroup
 * row's `details.experienceId` was just set to by the backend).
 *
 * `currentVersion`, `status`, and `updatedAt` mirror the
 * post-save ILE doc fields so the section's status pill flips
 * to the right color without a network round-trip.
 */
export interface IleSavedEventDetail {
  itemsGroupItemId?: string;
  experienceId: string;
  currentVersion: number;
  status: string;
  updatedAt: number;
}

/**
 * Type guard for the `ile:saved` event detail. Centralized
 * so listeners don't have to repeat the same `as CustomEvent<
 * IleSavedEventDetail >` cast and so we can extend the shape
 * in one place.
 */
export function readIleSavedEvent(
  event: Event,
): IleSavedEventDetail | null {
  // CustomEvent is a structural type — runtime detail is on
  // .detail. We don't use `instanceof CustomEvent` because
  // some event polyfills (for example EventSourcePolyfill)
  // don't implement the constructor.
  const detail = (event as CustomEvent).detail as
    | Partial<IleSavedEventDetail>
    | undefined;
  if (!detail) return null;
  if (typeof detail.experienceId !== 'string') return null;
  return {
    itemsGroupItemId: detail.itemsGroupItemId,
    experienceId: detail.experienceId,
    currentVersion: Number(detail.currentVersion ?? 0),
    status: String(detail.status ?? 'draft'),
    updatedAt: Number(detail.updatedAt ?? Date.now()),
  };
}
