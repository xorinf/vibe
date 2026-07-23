import { useState, useCallback } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Plus, Youtube, FileText, Globe, BookOpen, AudioLines, Image, Presentation } from 'lucide-react';
import { AddYouTubeContextDialog } from './AddYouTubeContextDialog';

/**
 * Context provider registry — the FRONTEND mirror of the backend
 * `ContextProviderRegistry`.
 *
 * Adding a new provider is a one-line change here + one matching
 * dialog component. Everything else (the menu, the button, the
 * trigger) is generic.
 *
 * `enabled: false` rows render as disabled "Coming soon" items so
 * the menu's shape is correct before the backend ships a provider.
 */
export interface ContextProviderMenuItem {
  id: string;
  label: string;
  Icon: typeof Youtube;
  enabled: boolean;
}

const CONTEXT_PROVIDERS: ContextProviderMenuItem[] = [
  { id: 'youtube', label: 'YouTube', Icon: Youtube, enabled: true },
  { id: 'pdf', label: 'PDF', Icon: FileText, enabled: false },
  { id: 'markdown', label: 'Markdown', Icon: FileText, enabled: false },
  { id: 'website', label: 'Website', Icon: Globe, enabled: false },
  { id: 'course_item', label: 'Course Item', Icon: BookOpen, enabled: false },
  { id: 'audio', label: 'Audio', Icon: AudioLines, enabled: false },
  { id: 'image', label: 'Image (OCR)', Icon: Image, enabled: false },
  { id: 'slides', label: 'Slides', Icon: Presentation, enabled: false },
];

export interface AddContextMenuProps {
  /**
   * Disabled while the AI is streaming or while the teacher has
   * unsaved manual edits. The Hero prompt area enforces the same
   * gate; we just disable the trigger to be defensive.
   */
  disabled?: boolean;
  /**
   * Called when the teacher confirms context in any dialog. The
   * hook in the workspace fires the generation stream from there.
   */
  onContextSelected: (args: {
    source: 'youtube';
    input: string;
    prompt: string;
  }) => void;
}

/**
 * "Add Context" button + dropdown menu. Lives in the hero prompt
 * row of the Teacher Workspace. Future providers register here as
 * `enabled: true` rows.
 */
export function AddContextMenu({ disabled, onContextSelected }: AddContextMenuProps) {
  const [openYouTube, setOpenYouTube] = useState(false);

  const handleSelect = useCallback(
    (providerId: string) => {
      if (providerId === 'youtube') setOpenYouTube(true);
      // Other providers: no-op for now (disabled). When a provider
      // is enabled, open its specific dialog here.
    },
    [],
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            data-testid="ile-add-context-trigger"
            aria-label="Add learning context"
          >
            <Plus className="h-4 w-4 mr-1.5" />
            Add Context
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Context sources</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {CONTEXT_PROVIDERS.map((p) => (
            <DropdownMenuItem
              key={p.id}
              disabled={!p.enabled}
              onSelect={() => handleSelect(p.id)}
              data-testid={`ile-add-context-${p.id}`}
            >
              <p.Icon className="h-4 w-4 mr-2 shrink-0" />
              <span className="flex-1">{p.label}</span>
              {!p.enabled && (
                <Badge variant="secondary" className="ml-2 text-[10px]">
                  Coming soon
                </Badge>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <AddYouTubeContextDialog
        open={openYouTube}
        onOpenChange={setOpenYouTube}
        onConfirm={(args) => {
          setOpenYouTube(false);
          onContextSelected({
            source: 'youtube',
            input: args.input,
            prompt: args.prompt,
          });
        }}
      />
    </>
  );
}
