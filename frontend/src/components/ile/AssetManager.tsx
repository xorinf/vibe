import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Upload,
  Search,
  Trash2,
  Image as ImageIcon,
  Music,
  Film,
  FileText,
  Code2,
  X,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/utils/utils';
import {
  deleteIleAsset,
  getIleAssetSignedUrl,
  listIleAssets,
  uploadIleAsset,
  type IleAssetKind,
  type IleAssetListItem,
} from './ileApi';

export interface AssetManagerProps {
  /**
   * Fired when the teacher picks an asset from the library. Lets the
   * chat pane prefill the prompt with the asset reference, or the
   * actions menu paste a URL into the next message.
   */
  onPick?: (asset: { id: string; filename: string; url: string; kind: IleAssetKind }) => void;
  className?: string;
}

const KIND_LABELS: Record<IleAssetKind, string> = {
  image: 'Images',
  audio: 'Audio',
  video: 'Video',
  pdf: 'PDFs',
  svg: 'SVGs',
};

const KIND_ICONS: Record<IleAssetKind, typeof ImageIcon> = {
  image: ImageIcon,
  audio: Music,
  video: Film,
  pdf: FileText,
  svg: Code2,
};

const KIND_FROM_MIME: Record<string, IleAssetKind> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'audio',
  'audio/wav': 'audio',
  'audio/ogg': 'audio',
  'audio/mp4': 'audio',
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/quicktime': 'video',
  'application/pdf': 'pdf',
};

/**
 * Derive the asset kind from a browser File. The server re-validates
 * the mimetype + size, but the client kind is what the upload form
 * sends — getting it right means the correct size cap is enforced
 * before the bytes even leave the browser.
 */
function deriveKind(file: File): IleAssetKind | null {
  // Prefer the explicit mimetype; fall back to extension.
  if (file.type && KIND_FROM_MIME[file.type]) return KIND_FROM_MIME[file.type];
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
  if (ext === 'svg') return 'svg';
  if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) return 'audio';
  if (['mp4', 'webm', 'mov'].includes(ext)) return 'video';
  if (ext === 'pdf') return 'pdf';
  return null;
}

/**
 * Asset Manager — the teacher's library of uploaded files.
 *
 * Self-contained: lists, searches, uploads, deletes. Drag-and-drop
 * onto the dropzone kicks off an upload. Each card shows a thumbnail
 * preview (image) or a kind icon (everything else) and exposes copy /
 * pick / delete actions.
 */
export function AssetManager({ onPick, className }: AssetManagerProps) {
  const [items, setItems] = useState<IleAssetListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | IleAssetKind>('all');
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState<{ name: string; pct: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listIleAssets({
        kind: filter === 'all' ? undefined : filter,
        q: query.trim() || undefined,
      });
      setItems(res.assets);
    } catch (err: any) {
      toast.error(err?.message ?? 'Could not load assets.');
    } finally {
      setLoading(false);
    }
  }, [filter, query]);

  useEffect(() => {
    const t = setTimeout(refresh, 200); // debounce search
    return () => clearTimeout(t);
  }, [refresh]);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files);
      let acceptedCount = 0;
      let rejectedCount = 0;
      for (const file of arr) {
        const kind = deriveKind(file);
        if (!kind) {
          rejectedCount++;
          toast.error(`Unsupported file type: ${file.name}`);
          continue;
        }
        setUploading({ name: file.name, pct: 0 });
        try {
          const res = await uploadIleAsset({
            kind,
            file,
            onProgress: (pct) =>
              setUploading({ name: file.name, pct }),
          });
          acceptedCount++;
          toast.success(`Uploaded ${file.name}`);
          // Optimistic append — no full refresh needed for one item.
          setItems((prev) => [
            {
              _id: res._id,
              kind: res.kind,
              filename: res.filename,
              contentType: res.contentType,
              size: res.size,
              createdAt: res.createdAt,
            },
            ...prev,
          ]);
        } catch (err: any) {
          rejectedCount++;
          toast.error(err?.message ?? `Upload failed for ${file.name}`);
        } finally {
          setUploading(null);
        }
      }
      // Surface a single rolled-up toast for multi-file drops so the
      // teacher gets a clear "what just happened" summary at the end of
      // the loop, not just one toast per file that scrolled off.
      if (arr.length >= 3) {
        if (acceptedCount > 0 && rejectedCount === 0) {
          toast.success(`Uploaded ${acceptedCount} files.`);
        } else if (acceptedCount > 0 && rejectedCount > 0) {
          toast.warning(
            `Uploaded ${acceptedCount} of ${arr.length}; ${rejectedCount} skipped.`,
          );
        } else if (acceptedCount === 0 && rejectedCount > 0) {
          toast.error(
            `Could not upload any of the ${rejectedCount} file(s). Check the type/size limits.`,
          );
        }
      }
    },
    [],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
      }
    },
    [handleFiles],
  );

  const handleDelete = useCallback(async (asset: IleAssetListItem) => {
    const ok = window.confirm(
      `Delete "${asset.filename}"? This removes the file from your library and the cloud. AI generations that referenced it will break.`,
    );
    if (!ok) return;
    try {
      await deleteIleAsset(asset._id);
      setItems((prev) => prev.filter((i) => i._id !== asset._id));
      toast.success('Asset deleted.');
    } catch (err: any) {
      toast.error(err?.message ?? 'Delete failed.');
    }
  }, []);

  const handlePick = useCallback(
    async (asset: IleAssetListItem) => {
      try {
        const { url } = await getIleAssetSignedUrl(asset._id);
        onPick?.({
          id: asset._id,
          filename: asset.filename,
          url,
          kind: asset.kind,
        });
        toast.success('Asset attached. The next message will reference it.');
      } catch (err: any) {
        toast.error(err?.message ?? 'Could not sign asset URL.');
      }
    },
    [onPick],
  );

  // Group items by kind for the section headers.
  const grouped = useMemo(() => {
    const out: Record<IleAssetKind, IleAssetListItem[]> = {
      image: [],
      audio: [],
      video: [],
      pdf: [],
      svg: [],
    };
    for (const item of items) out[item.kind].push(item);
    return out;
  }, [items]);

  return (
    <div className={cn('flex h-full flex-col bg-slate-50 dark:bg-slate-900/60', className)}>
      {/* Toolbar */}
      <div className="border-b bg-white dark:bg-slate-900 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Upload className="h-4 w-4 text-violet-600 dark:text-violet-400" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Asset library</h2>
            {items.length > 0 && (
              <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:text-slate-400">
                {items.length}
              </span>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            className="gap-1"
            disabled={uploading !== null}
          >
            <Upload className="h-3.5 w-3.5" /> Upload
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            multiple
            onChange={(e) => e.target.files && handleFiles(e.target.files)}
          />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search filenames…"
              className="h-8 pl-8 text-sm"
            />
          </div>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
            className="h-8 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 text-sm"
          >
            <option value="all">All kinds</option>
            {(Object.keys(KIND_LABELS) as IleAssetKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
          <Button
            size="icon"
            variant="ghost"
            onClick={refresh}
            disabled={loading}
            className="h-8 w-8"
            aria-label="Refresh"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* Drop zone + list */}
      <div className="flex-1 overflow-y-auto p-3">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={cn(
            'rounded-lg border-2 border-dashed p-6 text-center transition-colors',
            dragOver
              ? 'border-violet-400 bg-violet-50/60 dark:bg-violet-950/30'
              : 'border-slate-200 dark:border-slate-700 bg-white/40 dark:bg-slate-900',
          )}
        >
          {uploading ? (
            <UploadingIndicator name={uploading.name} pct={uploading.pct} />
          ) : (
            <>
              <Upload className="mx-auto h-5 w-5 text-slate-400 dark:text-slate-500" />
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                Drop files here, or use the Upload button.
              </p>
              <p className="mt-1 text-[10px] text-slate-400 dark:text-slate-500">
                Images · Audio · Video · PDF · SVG — each with a per-kind size cap.
              </p>
            </>
          )}
        </div>

        {/* Asset grid by kind */}
        <div className="mt-4 space-y-4">
          {(Object.keys(grouped) as IleAssetKind[]).map((kind) => {
            const list = grouped[kind];
            if (list.length === 0) return null;
            const Icon = KIND_ICONS[kind];
            return (
              <section key={kind}>
                <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  <Icon className="h-3.5 w-3.5" />
                  {KIND_LABELS[kind]}
                  <span className="font-normal normal-case text-slate-400 dark:text-slate-500">
                    ({list.length})
                  </span>
                </h3>
                <ul className="grid grid-cols-2 gap-2 md:grid-cols-3">
                  {list.map((asset) => (
                    <AssetCard
                      key={asset._id}
                      asset={asset}
                      onPick={() => handlePick(asset)}
                      onDelete={() => handleDelete(asset)}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
          {!loading && items.length === 0 && (
            <p className="py-6 text-center text-xs text-slate-500 dark:text-slate-400">
              No assets match the current filters.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────

function UploadingIndicator({ name, pct }: { name: string; pct: number }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-slate-700 dark:text-slate-300">
        Uploading <span className="font-mono">{name}</span>…
      </p>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <div
          className="h-full rounded-full bg-violet-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[10px] text-slate-500 dark:text-slate-400">{pct}%</p>
    </div>
  );
}

function AssetCard({
  asset,
  onPick,
  onDelete,
}: {
  asset: IleAssetListItem;
  onPick: () => void;
  onDelete: () => void;
}) {
  const [thumb, setThumb] = useState<string | null>(null);
  const [thumbError, setThumbError] = useState(false);

  // For images and PDFs we try to render a signed-URL thumbnail.
  // Audio / video / SVG fall back to their kind icon — those types
  // don't preview cleanly inline.
  const canThumbnail = asset.kind === 'image' && !thumbError;
  useEffect(() => {
    if (!canThumbnail) {
      setThumb(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { url } = await getIleAssetSignedUrl(asset._id);
        if (!cancelled) setThumb(url);
      } catch {
        if (!cancelled) setThumbError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [asset._id, canThumbnail]);

  const Icon = KIND_ICONS[asset.kind];
  const sizeKb = asset.size < 1024 * 1024
    ? `${(asset.size / 1024).toFixed(1)} KB`
    : `${(asset.size / 1024 / 1024).toFixed(1)} MB`;

  return (
    <li className="group relative overflow-hidden rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm transition-all hover:border-violet-300 hover:shadow-md">
      <div className="relative h-20 w-full overflow-hidden bg-slate-100 dark:bg-slate-800">
        {thumb ? (
          <img
            src={thumb}
            alt={asset.filename}
            className="h-full w-full object-cover"
            onError={() => setThumbError(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-400 dark:text-slate-500">
            <Icon className="h-7 w-7" />
          </div>
        )}
        {asset.kind === 'image' && (
          <a
            href={thumb ?? '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="absolute right-1.5 top-1.5 hidden rounded-full bg-white/90 dark:bg-slate-900 p-1 text-slate-600 dark:text-slate-400 hover:text-slate-900 group-hover:block"
            title="Open in new tab"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      <div className="p-2">
        <p
          className="truncate text-xs font-medium text-slate-900 dark:text-slate-100"
          title={asset.filename}
        >
          {asset.filename}
        </p>
        <p className="mt-0.5 flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400">
          <span>{sizeKb}</span>
          <span>{new Date(asset.createdAt).toLocaleDateString()}</span>
        </p>
        <div className="mt-2 flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={onPick}
            className="h-6 flex-1 gap-1 px-1 text-[10px]"
          >
            <ExternalLink className="h-3 w-3" /> Use
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onDelete}
            className="h-6 w-6 text-slate-400 dark:text-slate-500 hover:bg-rose-50 hover:text-rose-600"
            aria-label="Delete"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </li>
  );
}