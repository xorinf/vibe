/**
 * Placeholder panel for ILE features that the backend hasn't shipped
 * yet (Analytics, future tabs). Renders the same shape so the
 * inspector's tab body stays consistent while we're waiting on the
 * real implementation.
 */
import { Sparkles } from 'lucide-react';

export interface PlaceholderPanelProps {
  title?: string;
  hint?: string;
  variant?: 'inline' | 'inspector';
}

export function PlaceholderPanel({
  title = 'Coming soon',
  hint,
  variant = 'inspector',
}: PlaceholderPanelProps) {
  const defaultHint =
    variant === 'inspector'
      ? 'This panel will populate once the matching backend endpoint ships.'
      : 'Coming soon.';
  return (
    <div
      className={
        variant === 'inspector'
          ? 'flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-slate-500'
          : 'flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-slate-500'
      }
    >
      <Sparkles className="h-5 w-5 text-primary/40" aria-hidden="true" />
      <p className="text-slate-700 dark:text-slate-300">{title}</p>
      <p className="text-xs text-slate-500 dark:text-slate-400">{hint ?? defaultHint}</p>
    </div>
  );
}
