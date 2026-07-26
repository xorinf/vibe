/**
 * The toolbar that sits above the code/preview area in the teacher
 * workspace. Shared by `EditorSplitPane` (code + split modes) and the
 * standalone `SplitCanvas` variant. Surfaces:
 *   - view-mode switch (code / split / preview)
 *   - quick actions (Find, Format, Word wrap)
 *   - live state pill (streaming / live)
 */
import {
  Code,
  Columns2,
  Eye,
  Search,
  Wand2,
  WrapText,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/utils';

export type ViewMode = 'code' | 'split' | 'preview';

export interface EditorToolbarProps {
  viewMode: ViewMode;
  onViewModeChange: (m: ViewMode) => void;
  wordWrap: boolean;
  onWordWrapChange: (w: boolean) => void;
  onOpenSearch: () => void;
  onFormat: () => void;
  isEditorReady: boolean;
}

export function EditorToolbar({
  viewMode,
  onViewModeChange,
  wordWrap,
  onWordWrapChange,
  onOpenSearch,
  onFormat,
  isEditorReady,
}: EditorToolbarProps) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-200 bg-white px-2 [&>*]:shrink-0">
      <ViewModeSwitch value={viewMode} onChange={onViewModeChange} />

      <Divider />

      <ToolbarButton
        icon={<Search className="h-3.5 w-3.5" />}
        label="Find"
        shortcut="⌘F"
        onClick={onOpenSearch}
        disabled={!isEditorReady}
      />
      <ToolbarButton
        icon={<Wand2 className="h-3.5 w-3.5" />}
        label="Format"
        shortcut="⌘⇧F"
        onClick={onFormat}
        disabled={!isEditorReady}
      />
      <ToolbarButton
        icon={<WrapText className="h-3.5 w-3.5" />}
        label={wordWrap ? 'Word wrap on' : 'Word wrap off'}
        onClick={() => onWordWrapChange(!wordWrap)}
        active={wordWrap}
        disabled={!isEditorReady}
      />

      <Divider />

    </div>
  );
}

function Divider() {
  return (
    <span
      className="mx-0.5 h-5 w-px shrink-0 bg-slate-200"
      aria-hidden="true"
    />
  );
}

interface ToolbarButtonProps {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}

function ToolbarButton({
  icon,
  label,
  shortcut,
  onClick,
  active,
  disabled,
}: ToolbarButtonProps) {
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      aria-label={shortcut ? `${label} (${shortcut})` : label}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={cn(
        'h-7 gap-1 px-2 text-xs whitespace-nowrap',
        active
          ? 'bg-primary/10 text-primary hover:bg-primary/15'
          : 'text-slate-600 hover:text-slate-900',
        disabled && 'opacity-40',
      )}
    >
      {icon}
      <span className="hidden xl:inline">{label}</span>
      {shortcut && (
        <span className="hidden 2xl:inline text-[10px] text-slate-400">
          {shortcut}
        </span>
      )}
    </Button>
  );
}

function ViewModeSwitch({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  return (
    <div
      className="inline-flex shrink-0 items-center rounded-md border border-slate-200 bg-slate-50 p-0.5"
      role="radiogroup"
      aria-label="View mode"
    >
      <ViewModeButton
        current={value}
        target="code"
        icon={<Code className="h-3.5 w-3.5" />}
        onChange={onChange}
      />
      <ViewModeButton
        current={value}
        target="split"
        icon={<Columns2 className="h-3.5 w-3.5" />}
        onChange={onChange}
      />
      <ViewModeButton
        current={value}
        target="preview"
        icon={<Eye className="h-3.5 w-3.5" />}
        onChange={onChange}
      />
    </div>
  );
}

function ViewModeButton({
  current,
  target,
  icon,
  onChange,
}: {
  current: ViewMode;
  target: ViewMode;
  icon: React.ReactNode;
  onChange: (v: ViewMode) => void;
}) {
  const active = current === target;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={() => onChange(target)}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-sm transition-colors',
        active
          ? 'bg-white text-primary shadow-sm'
          : 'text-slate-500 hover:text-slate-800',
      )}
      title={target === 'code' ? 'Code only' : target === 'split' ? 'Split view' : 'Preview only'}
      aria-label={target === 'code' ? 'Code only' : target === 'split' ? 'Split view' : 'Preview only'}
    >
      {icon}
    </button>
  );
}

