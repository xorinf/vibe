import { useState, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Youtube, ExternalLink } from 'lucide-react';

/**
 * Provider-specific dialog for YouTube context. The shape mirrors the
 * backend's `GenerateFromContextBody`:
 *
 *   - input: YouTube URL or bare 11-char video id
 *   - prompt: teacher's free-form instruction for what to do with
 *     the extracted material
 *
 * The dialog NEVER names which strategy runs (captions / auto / Whisper).
 * The teacher sees only "Preparing context..." / "Understanding the
 * learning material..." labels on the SSE stream.
 */
export interface AddYouTubeContextDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (args: { input: string; prompt: string }) => void;
}

const YOUTUBE_URL_RE = /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)[A-Za-z0-9_-]{11}|^[A-Za-z0-9_-]{11}$/;

function isValidYouTubeInput(s: string): boolean {
  return YOUTUBE_URL_RE.test(s.trim());
}

export function AddYouTubeContextDialog({
  open,
  onOpenChange,
  onConfirm,
}: AddYouTubeContextDialogProps) {
  const [input, setInput] = useState('');
  const [prompt, setPrompt] = useState('');
  const [touched, setTouched] = useState(false);

  const validUrl = isValidYouTubeInput(input);
  const validPrompt = prompt.trim().length >= 3;
  const canSubmit = validUrl && validPrompt;

  const handleSubmit = useCallback(() => {
    setTouched(true);
    if (!canSubmit) return;
    onConfirm({ input: input.trim(), prompt: prompt.trim() });
    // Reset for next open.
    setInput('');
    setPrompt('');
    setTouched(false);
  }, [canSubmit, input, prompt, onConfirm]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setInput('');
        setPrompt('');
        setTouched(false);
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl" data-testid="ile-add-context-youtube-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Youtube className="h-5 w-5" />
            Generate from YouTube
          </DialogTitle>
          <DialogDescription>
            Paste a YouTube link. The system will automatically find the best
            way to use the video's educational content.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label htmlFor="ile-yt-input" className="text-sm font-medium block mb-1.5">
              YouTube link
            </label>
            <Input
              id="ile-yt-input"
              type="url"
              placeholder="https://www.youtube.com/watch?v=…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onBlur={() => setTouched(true)}
              data-testid="ile-add-context-youtube-input"
              autoComplete="off"
              spellCheck={false}
            />
            {touched && !validUrl && input.length > 0 && (
              <p className="text-xs text-destructive mt-1">
                That doesn't look like a YouTube link.
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-1.5 flex items-center gap-1">
              <ExternalLink className="h-3 w-3" />
              Videos must be public, unlisted, or age-restricted public.
              Private videos aren't supported.
            </p>
          </div>

          <div>
            <label htmlFor="ile-yt-prompt" className="text-sm font-medium block mb-1.5">
              What should the experience teach?
            </label>
            <Textarea
              id="ile-yt-prompt"
              placeholder="e.g. Explain the key concept with an interactive simulation."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              maxLength={4000}
              data-testid="ile-add-context-youtube-prompt"
            />
            <p className="text-xs text-muted-foreground mt-1.5">
              The video provides the educational material. Your prompt tells
              the system what to do with it.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="ile-add-context-youtube-submit"
          >
            Generate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
