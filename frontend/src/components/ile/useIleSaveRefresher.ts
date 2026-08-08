/**
 * Custom hook that listens for the workspace's `ile:saved`
 * window event and refreshes the section tree + in-memory
 * selectedEntity when an ILE is saved from the workspace.
 *
 * Background — why this hook exists:
 *   The ILE workspace's Save button dispatches a window
 *   `ile:saved` event after the backend's unified
 *   `POST /save-with-item` endpoint commits. With the
 *   unified endpoint, the itemsGroup $set happens inside
 *   the same Mongo transaction as the ILE doc save, so
 *   this listener no longer PATCHes the row — it just
 *   refetches the affected course / section state so the
 *   status pill and item list reflect the new pointer.
 *
 * Why a hook (not a useEffect inline in the page):
 *   - One place to subscribe + unsubscribe (cleanup
 *     matters — if the teacher navigates away the listener
 *     would otherwise dangle and fire for events fired by
 *     a stale workspace).
 *   - The same hook is used by the ILE library page, the
 *     course page, and any future "list experiences here"
 *     view. They all need the same refresh.
 *   - The hook is the only place that needs the `selectedEntity`
 *     update path, so the page component doesn't have to
 *     thread that through its own render.
 */
import { useEffect, type Dispatch, type SetStateAction } from 'react';
import {
  ILE_SAVED_EVENT,
  readIleSavedEvent,
  type IleSavedEventDetail,
} from './ileEvents';

export interface UseIleSaveRefresherOptions {
  /**
   * Refetch the course version (modules + sections). Called
   * on every save — the section structure itself doesn't
   * change but the itemsGroup item rows do.
   */
  refetchVersion: () => unknown;
  /**
   * Refetch the items in the currently-selected section.
   * Optional: if not provided, the listener only refetches
   * the version (which already covers items via the
   * `sections` embed when the API returns them).
   */
  refetchItems?: () => unknown;
  /**
   * Should we refetch items right now? Used to gate the
   * `useItemsBySectionId` hook — the listener no-ops when
   * no section is selected so we don't fire a wasted GET.
   */
  shouldFetchItems?: boolean;
  /**
   * Currently-selected entity (set by the page when the
   * teacher clicks an item in the section tree). When the
   * saved ILE matches the selected entity, we update its
   * in-memory `details` so the inline view picks up the
   * new experienceId without waiting for the refetch.
   */
  selectedEntity: SelectedEntityLike | null;
  /**
   * Replace the selected entity (with the patched
   * experienceId + status) so the inline view updates
   * immediately. We accept the full `Dispatch<SetStateAction<...>>`
   * shape so the hook can be passed `setSelectedEntity`
   * directly without a wrapper.
   */
  setSelectedEntity: Dispatch<SetStateAction<SelectedEntityLike | null>>;
}

/**
 * Loose shape for the page's selectedEntity. We don't import
 * the full `selectedEntity` type from the page to avoid a
 * circular dependency; the hook only reads `type` + `data`
 * and preserves the rest of the shape (including `parentIds`)
 * when patching. Pages are free to extend this with extra
 * fields — the hook just spreads `...selectedEntity`.
 */
export interface SelectedEntityLike {
  type: 'module' | 'section' | 'item' | string;
  data?: {
    _id?: string;
    details?: Record<string, unknown>;
  } | null;
  [key: string]: unknown;
}

/**
 * The actual refresh effect. Call from a top-level component
 * (the page). The effect attaches a single window-level
 * listener for the lifetime of the component and removes
 * it on unmount.
 */
export function useIleSaveRefresher(
  opts: UseIleSaveRefresherOptions,
): void {
  useEffect(() => {
    function onIleSaved(e: Event) {
      const detail = readIleSavedEvent(e);
      if (!detail) return;
      // Always refetch — the backend has already done the
      // write; this just makes the UI catch up.
      opts.refetchVersion();
      if (opts.shouldFetchItems && opts.refetchItems) {
        opts.refetchItems();
      }
      // Patch the in-memory selectedEntity so the inline
      // view picks up the new experienceId immediately
      // (without waiting for the refetch round-trip).
      patchSelectedEntityForSave(
        opts.selectedEntity,
        detail,
        opts.setSelectedEntity,
      );
    }
    window.addEventListener(ILE_SAVED_EVENT, onIleSaved);
    return () => window.removeEventListener(ILE_SAVED_EVENT, onIleSaved);
    // The hook re-subscribes when the inputs change so the
    // listener closure always sees the latest refetch fns
    // and the latest selectedEntity. The cost is one
    // unsubscribe + subscribe per change, which is fine.
  }, [
    opts.refetchVersion,
    opts.refetchItems,
    opts.shouldFetchItems,
    opts.selectedEntity,
    opts.setSelectedEntity,
  ]);
}

/**
 * Update the in-memory selectedEntity's `details` so the
 * inline view shows the new experienceId / status without
 * a refetch round-trip. Only acts when the saved event
 * targets the currently-selected item.
 */
function patchSelectedEntityForSave(
  selectedEntity: SelectedEntityLike | null,
  detail: IleSavedEventDetail,
  setSelectedEntity: Dispatch<SetStateAction<SelectedEntityLike | null>>,
): void {
  const targetItemId = detail.itemsGroupItemId;
  if (
    !targetItemId ||
    selectedEntity?.type !== 'item' ||
    !selectedEntity.data ||
    selectedEntity.data._id !== targetItemId
  ) {
    return;
  }
  // Preserve the rest of the item shape — we only patch
  // the parts the ILE pointer touches.
  setSelectedEntity({
    ...selectedEntity,
    data: {
      ...selectedEntity.data,
      details: {
        ...(selectedEntity.data.details ?? {}),
        experienceId: detail.experienceId,
        status: detail.status,
        currentVersion: detail.currentVersion,
        updatedAt: detail.updatedAt,
      },
    },
  });
}
