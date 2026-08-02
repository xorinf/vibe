/**
 * Right-side inspector drawer for the teacher ILE workspace.
 *
 * Holds the four tabs the workspace exposes:
 *   - Details: title + status + save/publish (MetadataPane)
 *   - History: version snapshots (HistoryPanel)
 *   - Assets:  asset library (AssetManager)
 *   - Analytics: placeholder until the analytics endpoint ships.
 *
 * The workspace owns the persistence concerns (save, publish, etc.);
 * this drawer is presentation-only.
 */
import { forwardRef } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/utils';
import type { IleStreamState } from './ileStreamState';
import type { IleAssetKind, IleExperienceResponse } from './ileApi';
import { MetadataPane } from './MetadataPane';
import { HistoryPanel } from './HistoryPanel';
import { AssetManager } from './AssetManager';
import { PlaceholderPanel } from './PlaceholderPanel';
import { AnalyticsPanel } from './AnalyticsPanel';

export type InspectorTabId = 'details' | 'history' | 'assets' | 'analytics';

export interface InspectorDrawerProps {
  tab: InspectorTabId;
  onTabChange: (t: InspectorTabId) => void;
  onClose: () => void;
  streamState: IleStreamState;
  savedExperience: IleExperienceResponse | null | undefined;
  saving: boolean;
  publishing: boolean;
  onTitleChange: (title: string) => void;
  onSave: () => void;
  onPublish: () => void;
  onRestoredFromHistory: (params: { html: string; title: string; currentVersion: number }) => void;
  /**
   * Forwarded to AssetManager's `onPick` so picking an asset from
   * the library attaches it to the next chat message. Without this
   * the "Use" button on each card is a no-op (logs to console).
   * See the 2026-07-28 ILE audit H5.
   */
  onAttachAsset?: (asset: {
    id: string;
    filename: string;
    url: string;
    kind: IleAssetKind;
  }) => void;
  className?: string;
}

interface TabDescriptor {
  id: InspectorTabId;
  label: string;
}

const INSPECTOR_TABS: TabDescriptor[] = [
  { id: 'details', label: 'Details' },
  { id: 'history', label: 'History' },
  { id: 'assets', label: 'Assets' },
  { id: 'analytics', label: 'Analytics' },
];

export const InspectorDrawer = forwardRef<HTMLDivElement, InspectorDrawerProps>(
  function InspectorDrawer(
    {
      tab,
      onTabChange,
      onClose,
      streamState,
      savedExperience,
      saving,
      publishing,
      onTitleChange,
      onSave,
      onPublish,
      onRestoredFromHistory,
      onAttachAsset,
      className,
    },
    ref,
  ) {
    return (
      <aside
        ref={ref}
        className={cn(
          'w-[360px] flex min-h-0 shrink-0 flex-col border-l border-border  bg-background  animate-in slide-in-from-right-2 duration-200',
          className,
        )}
      >
        <InspectorTabStrip tab={tab} onTabChange={onTabChange} onClose={onClose} />
        <div className="min-h-0 flex-1">
          {tab === 'details' && (
            <MetadataPane
              state={streamState}
              savedExperience={savedExperience}
              saving={saving}
              publishing={publishing}
              onTitleChange={onTitleChange}
              onSave={onSave}
              onPublish={onPublish}
              className="h-full"
            />
          )}
          {tab === 'history' && (
            <div className="h-full overflow-y-auto">
              {savedExperience?._id ? (
                <HistoryPanel
                  experienceId={savedExperience._id}
                  onRestored={onRestoredFromHistory}
                  className="h-full"
                />
              ) : (
                <PlaceholderPanel
                  title="No history yet"
                  hint="Save this experience to start tracking versions."
                />
              )}
            </div>
          )}
          {tab === 'assets' && (
            <AssetManager
              onPick={onAttachAsset ?? ((asset) => {
                // Fallback: no editor wired, the button still gives
                // visible feedback so the user knows the click landed.
                // eslint-disable-next-line no-console
                console.info(
                  `[InspectorDrawer] Asset "${asset.filename}" available for chat context.`,
                );
              })}
              className="h-full"
            />
          )}
          {tab === 'analytics' && (
            savedExperience?._id ? (
              <AnalyticsPanel experienceId={savedExperience._id} className="h-full" />
            ) : (
              <PlaceholderPanel
                title="No analytics yet"
                hint="Save this experience to start tracking analytics."
              />
            )
          )}
        </div>
      </aside>
    );
  },
);

function InspectorTabStrip({
  tab,
  onTabChange,
  onClose,
}: {
  tab: InspectorTabId;
  onTabChange: (t: InspectorTabId) => void;
  onClose: () => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center border-b border-border  bg-card ">
      <div className="flex h-full flex-1 items-stretch overflow-x-auto">
        {INSPECTOR_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => onTabChange(t.id)}
            className={cn(
              'relative flex items-center gap-1.5 border-r border-border  px-3 text-[11px] font-medium transition-colors',
              tab === t.id
                ? 'bg-background  text-foreground '
                : 'text-muted-foreground  hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {tab === t.id && (
              <span
                aria-hidden="true"
                className="absolute inset-x-0 top-0 h-0.5 bg-primary"
              />
            )}
            {t.label}
          </button>
        ))}
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={onClose}
        aria-label="Hide inspector"
        title="Hide inspector"
        className="h-7 w-7 mr-1 text-muted-foreground  hover:text-accent-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
