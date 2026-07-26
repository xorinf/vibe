import { useEffect, useState } from 'react';
import { Paperclip, X, ExternalLink, Sparkles } from 'lucide-react';
import { cn } from '@/utils/utils';
import type { IleAssetKind } from './ileApi';

export interface AttachedAsset {
  id: string;
  filename: string;
  kind: IleAssetKind;
  url: string;
}

export interface AssetAttachmentsProps {
  /** Currently attached assets that will be referenced in the next message. */
  assets: AttachedAsset[];
  /** Fired when the teacher removes an attachment. */
  onRemove: (id: string) => void;
  /** Optional: when set, renders a "Send to AI" button that previews how
   * the attachments will be referenced. */
  onSendToAi?: () => void;
  className?: string;
}

/**
 * Inline row of asset chips the teacher has attached to the next message.
 * Lives above the composer in the chat pane. Each chip is removable.
 *
 * The chips are pure presentation — the actual reference happens in
 * `useIleEditor.send()` which appends a "Attached assets" footer to
 * the prompt. This component is just the affordance.
 */
export function AssetAttachments({
  assets,
  onRemove,
  onSendToAi,
  className,
}: AssetAttachmentsProps) {
  if (assets.length === 0) return null;

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1.5 border-b border-border  bg-ai/30  px-3 py-2',
        className,
      )}
    >
      <Paperclip className="h-3.5 w-3.5 text-primary/90 " />
      <span className="text-[10px] font-medium uppercase tracking-wider text-primary ">
        Attached
      </span>
      {assets.map((asset) => (
        <AttachedChip
          key={asset.id}
          asset={asset}
          onRemove={() => onRemove(asset.id)}
        />
      ))}
      {onSendToAi && (
        <button
          type="button"
          onClick={onSendToAi}
          className="ml-auto inline-flex items-center gap-1 rounded-full bg-violet-600 px-2.5 py-1 text-[10px] font-medium text-white hover:bg-primary/90"
        >
          <Sparkles className="h-3 w-3" /> Reference in next message
        </button>
      )}
    </div>
  );
}

function AttachedChip({
  asset,
  onRemove,
}: {
  asset: AttachedAsset;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-primary/30  bg-background  py-0.5 pl-2 pr-1 text-[10px] text-foreground/80 ">
      <a
        href={asset.url}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        className="inline-flex items-center gap-1 hover:text-accent-foreground"
      >
        <span className="max-w-[140px] truncate">{asset.filename}</span>
        <ExternalLink className="h-2.5 w-2.5" />
      </a>
      <button
        type="button"
        onClick={onRemove}
        className="rounded-full p-0.5 text-muted-foreground/80  hover:bg-destructive/15 hover:text-destructive/90"
        aria-label={`Remove ${asset.filename}`}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

/**
 * Helper hook for the AssetAttachments state. Keeps it tiny — just an
 * array with add/remove, and a clear. The workspace owns the "what
 * assets are currently attached" state; this hook is just the
 * convenience.
 */
export function useAssetAttachments() {
  const [assets, setAssets] = useState<AttachedAsset[]>([]);

  useEffect(() => {
    // Sanity: if the user changes course context (rare) the attached
    // assets stop being relevant. We don't auto-clear — explicit is
    // better than surprising.
  }, []);

  function add(asset: AttachedAsset) {
    setAssets((prev) => (prev.find((a) => a.id === asset.id) ? prev : [...prev, asset]));
  }
  function remove(id: string) {
    setAssets((prev) => prev.filter((a) => a.id !== id));
  }
  function clear() {
    setAssets([]);
  }

  return { assets, add, remove, clear };
}