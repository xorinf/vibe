import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Send,
  Loader2,
  Square,
  Brain,
  Undo2,
  Redo2,
  Sparkles,
  User,
  Languages,
  CheckCircle2,
  AlertCircle,
  GitFork,
  RotateCcw,
  Check,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/utils/utils';
import {
  QUICK_ACTIONS,
  resolveInstruction,
  type QuickActionId,
} from './quickActions';
import type { ChatMessage, IleEditorApi, IleEditorState } from './useIleEditor';
import { AddContextMenu } from './AddContextMenu';
import { AssetAttachments } from './AssetAttachments';

export interface ChatPaneProps {
  state: IleEditorState;
  api: IleEditorApi;
  /**
   * Fired when the teacher submits text. The editor (api.send) handles
   * routing between generate/edit, so this is a passthrough.
   */
  onSubmit: (text: string) => void;
  /**
   * Fired when the teacher confirms context (YouTube URL in v1) in
   * the Add Context dialog. The workspace owns the actual stream
   * because it has the course context — the chat pane just hosts the
   * menu UI. Pass undefined to hide the Add Context button.
   */
  onContextSelected?: (args: {
    source: 'youtube';
    input: string;
    prompt: string;
  }) => void;
  /** Disables the Add Context button (e.g. while AI is streaming). */
  contextDisabled?: boolean;
  /** Hides the composer entirely (used when no AI provider is configured). */
  composerHidden?: boolean;
  /** Show a hint above the composer pointing the teacher to the config panel. */
  configHint?: string;
  className?: string;
}

const FOLLOWUP_PROMPTS: Partial<Record<QuickActionId, { label: string; placeholder: string }>> = {
  translate: { label: 'Target language', placeholder: 'e.g. Spanish, Japanese, French…' },
};

/**
 * Left pane of the Teacher ILE Workspace. Renders the conversational
 * thread (user + assistant bubbles), quick-action chips, and a composer
 * with undo/redo in the header. Drives the iterative edit model.
 *
 * Stays self-contained — the editor (passed via `api`) handles all
 * routing and persistence concerns.
 */
export function ChatPane({
  state,
  api,
  onSubmit,
  onContextSelected,
  contextDisabled,
  composerHidden,
  configHint,
  className,
}: ChatPaneProps) {
  const [draft, setDraft] = useState('');
  const [activeFollowup, setActiveFollowup] = useState<QuickActionId | null>(null);
  const [followupValue, setFollowupValue] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to the latest message as the thread grows.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [state.messages.length, state.stream.status]);

  const isStreaming = state.stream.status === 'streaming';
  const hasExperience = Boolean(state.stream.experienceId) || state.initialHtml.length > 0;
  const showReasoning =
    isStreaming && state.stream.reasoning && !state.stream.lastProgress;

  const handleSubmit = useCallback(() => {
    const text = draft.trim();
    if (!text || isStreaming) return;
    setDraft('');
    // Persist the latest prompt so retry() can resend it. The hook
    // owns the ref; the chat pane just needs to call the writer.
    api.setLatestRetryPrompt(text);
    onSubmit(text);
  }, [draft, isStreaming, onSubmit, api]);

  const handleQuickAction = useCallback(
    (id: QuickActionId) => {
      const prompt = FOLLOWUP_PROMPTS[id];
      // Actions that need a follow-up value pause for input.
      if (prompt && resolveInstruction(id, '') === null) {
        setActiveFollowup(id);
        setFollowupValue('');
        return;
      }
      api.sendQuickAction(id);
    },
    [api],
  );

  const handleFollowupSubmit = useCallback(() => {
    if (!activeFollowup) return;
    const v = followupValue.trim();
    if (!v) return;
    api.sendQuickAction(activeFollowup, v);
    setActiveFollowup(null);
    setFollowupValue('');
  }, [activeFollowup, followupValue, api]);

  // ───────────────────────────────────────────────────────────────────
  // Conversation controls — accept / reject / retry / fork.
  //
  // These are the buttons that appear under each finished assistant
  // bubble. Accept and Reject operate on the most recent turn;
  // Retry re-sends the latest user prompt against the current head;
  // Fork trims the conversation to a chosen index so the teacher can
  // explore an alternative branch.
  const lastAssistantIdx = useMemo(() => {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === 'assistant') return i;
    }
    return -1;
  }, [state.messages]);

  const handleAccept = useCallback(() => {
    api.accept();
  }, [api]);

  const handleReject = useCallback(() => {
    // The workspace owns the manualHtml reset; we just clear the
    // lastAppliedHtml flag so the diff view goes away.
    api.reject();
  }, [api]);

  const handleRetry = useCallback(() => {
    if (isStreaming) return;
    void api.retry();
  }, [api, isStreaming]);

  const handleFork = useCallback((index: number) => {
    if (isStreaming) return;
    api.forkFromIndex(index);
  }, [api, isStreaming]);

  return (
    <div className={cn('flex h-full flex-col border-r bg-card ', className)}>
      <Header
        state={state}
        api={api}
        hasExperience={hasExperience}
        isStreaming={isStreaming}
        onRetry={handleRetry}
        onAccept={handleAccept}
        onReject={handleReject}
      />

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {/* Empty state for the very first message. */}
        {state.messages.length === 0 && !isStreaming && state.stream.status === 'idle' && (
          <EmptyState hasExperience={hasExperience} />
        )}

        {showReasoning && (
          <div className="mb-3 inline-flex items-center gap-2 rounded-md bg-ai/30  px-2.5 py-1.5 text-xs text-primary  ring-1 ring-primary/30 ">
            <Brain className="h-3.5 w-3.5 animate-pulse" />
            Thinking about the next change…
          </div>
        )}

        {/* Chat thread */}
        <ol className="space-y-3">
          {state.messages.map((m, idx) => {
            const isLastAssistant = idx === lastAssistantIdx;
            // Accept/Reject surface on the most recent assistant bubble
            // whenever the stream is settled (idle or done). When the
            // teacher is in the middle of streaming, the buttons would
            // just be noise — hide them.
            const showAccept = m.role === 'assistant' && isLastAssistant && !isStreaming && state.stream.status !== 'error';
            return (
              <MessageBubble
                key={m._msgId ?? `${m.role}-${idx}-${m.createdAt ?? ''}`}
                message={m}
                onRetry={idx > 0 && !isStreaming ? handleRetry : undefined}
                onAccept={showAccept ? handleAccept : undefined}
                onReject={showAccept ? handleReject : undefined}
                onFork={m.role === 'assistant' && !isStreaming ? () => handleFork(idx) : undefined}
                isLastAssistant={isLastAssistant}
              />
            );
          })}
          {/* Streaming progress as its own compact pill, separate from
              the message bubbles so the teacher can see what's about to
              land. We keep ALL recent progress messages (up to 8) — the
              max dispatched by the server — so the final step never
              drops off. */}
          {isStreaming && state.stream.progress.length > 0 && (
            <li className="ml-8">
              <ul className="space-y-1">
                {state.stream.progress.map((msg, idx) => {
                  const isLast = idx === state.stream.progress.length - 1;
                  return (
                    <li
                      key={`${msg}-${idx}`}
                      className={cn(
                        'flex items-start gap-2 rounded-md px-2 py-1 text-xs transition-colors',
                        isLast ? 'bg-primary/15  text-emerald-900' : 'text-muted-foreground ',
                      )}
                    >
                      <span className="mt-0.5 text-primary/90 ">
                        {isLast && !state.stream.reasoning ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          '✓'
                        )}
                      </span>
                      <span>{msg.replace(/^✓\s*/, '')}</span>
                    </li>
                  );
                })}
              </ul>
            </li>
          )}
        </ol>

        <StreamFooter state={state} />

        {state.stream.status === 'error' && state.stream.error && (
          <div className="mt-3 rounded-md border border-destructive/30  bg-destructive/15  px-3 py-2 text-xs text-destructive ">
            <p className="font-medium">
              {state.stream.experienceId ? 'Edit failed' : 'Generation failed'}
            </p>
            <p className="mt-1">{state.stream.error}</p>
          </div>
        )}
      </div>

      {/* Quick actions — only when not currently editing. */}
      {hasExperience && !isStreaming && activeFollowup === null && (
        <div className="border-t border-border  bg-background  px-3 py-2">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80 ">
            Quick actions
          </div>
          <div className="flex flex-wrap gap-1.5">
            {QUICK_ACTIONS.map((action) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.id}
                  type="button"
                  onClick={() => handleQuickAction(action.id)}
                  className="inline-flex items-center gap-1 rounded-full border border-border  bg-background  px-2.5 py-1 text-[11px] font-medium text-foreground/80  transition-colors hover:border-violet-300 hover:bg-violet-50 hover:text-violet-800"
                >
                  <Icon className="h-3 w-3" />
                  {action.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Follow-up prompt for actions that need one (e.g. translate). */}
      {activeFollowup && (
        <FollowupPrompt
          prompt={FOLLOWUP_PROMPTS[activeFollowup]!}
          value={followupValue}
          onChange={setFollowupValue}
          onSubmit={handleFollowupSubmit}
          onCancel={() => {
            setActiveFollowup(null);
            setFollowupValue('');
          }}
        />
      )}

      {/* Composer */}
      {composerHidden ? (
        <div className="border-t bg-background  p-4">
          <div className="rounded-md border border-dashed border-primary/30  bg-ai/30  px-3 py-2.5 text-xs text-primary ">
            <p className="font-medium">Configure an AI provider to start.</p>
            {configHint && <p className="mt-1 text-primary ">{configHint}</p>}
          </div>
        </div>
      ) : (
        <>
          {state.attachedAssets.length > 0 && (
            <AssetAttachments
              assets={state.attachedAssets}
              onRemove={api.detachAsset}
            />
          )}
          <div className="border-t bg-background  p-3">
            <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              hasExperience
                ? 'Make this more visual. Add a timer. Translate to Spanish…'
                : 'Describe the lesson and what should happen…'
            }
            disabled={isStreaming || activeFollowup !== null}
            className="min-h-[64px] resize-none text-sm"
            onKeyDown={(e) => {
              // ⌘/Ctrl+Enter — submit. Esc during streaming cancels mid-edit
              // so the teacher can abort a runaway generation without
              // reaching for the toolbar button.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSubmit();
                return;
              }
              if (e.key === 'Escape' && isStreaming) {
                e.preventDefault();
                api.cancel();
              }
            }}
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground/80 ">
              {hasExperience
                ? state.pending
                  ? 'Queued — current edit will finish first'
                  : 'Editing existing draft'
                : 'New experience'}{' '}
              · ⌘↩ to send
            </span>
            <div className="flex items-center gap-2">
              {onContextSelected && (
                <AddContextMenu
                  disabled={Boolean(contextDisabled) || isStreaming || activeFollowup !== null}
                  onContextSelected={onContextSelected}
                />
              )}
              {isStreaming ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={api.cancel}
                  className="gap-1 text-destructive/90  hover:bg-rose-50 hover:text-rose-700"
                >
                  <Square className="h-3.5 w-3.5" />
                  Cancel
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={handleSubmit}
                  disabled={!draft.trim() || activeFollowup !== null}
                  className="gap-1"
                >
                  <Send className="h-3.5 w-3.5" />
                  {hasExperience ? 'Apply' : 'Generate'}
                </Button>
              )}
            </div>
          </div>
        </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Subcomponents

function Header({
  state,
  api,
  hasExperience,
  isStreaming,
  onRetry,
  onAccept,
  onReject,
}: {
  state: IleEditorState;
  api: IleEditorApi;
  hasExperience: boolean;
  isStreaming: boolean;
  onRetry: () => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <div className="flex items-center justify-between border-b px-4 py-2">
      <div>
        <h2 className="text-sm font-semibold text-foreground ">Designer</h2>
        <p className="text-[11px] text-muted-foreground ">
          {hasExperience ? 'Iterate by chat or quick action' : 'Describe the lesson to start'}
        </p>
      </div>
      <div className="flex items-center gap-1">
        {hasExperience && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={api.undo}
              disabled={!api.canUndo || isStreaming}
              aria-label="Undo last edit"
              title="Undo last edit"
              className="h-7 w-7 p-0 text-muted-foreground  hover:text-slate-900 disabled:opacity-40"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={api.redo}
              disabled={!api.canRedo || isStreaming}
              aria-label="Redo"
              title="Redo"
              className="h-7 w-7 p-0 text-muted-foreground  hover:text-slate-900 disabled:opacity-40"
            >
              <Redo2 className="h-3.5 w-3.5" />
            </Button>
            <span className="mx-1 h-5 w-px bg-muted " />
            <Button
              size="sm"
              variant="ghost"
              onClick={onRetry}
              disabled={isStreaming}
              aria-label="Retry last prompt"
              title="Resend the most recent user prompt"
              className="h-7 w-7 p-0 text-muted-foreground  hover:text-slate-900 disabled:opacity-40"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onAccept}
              disabled={isStreaming || state.stream.status !== 'done'}
              aria-label="Accept latest version"
              title="Mark the latest version as the new baseline"
              className="h-7 w-7 p-0 text-primary/90  hover:text-emerald-800 disabled:opacity-40"
            >
              <Check className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onReject}
              disabled={isStreaming}
              aria-label="Reject latest version"
              title="Revert to the previous version"
              className="h-7 w-7 p-0 text-destructive/90  hover:text-rose-800 disabled:opacity-40"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
            <span className="mx-1 h-5 w-px bg-muted " />
            <EditingBadge state={state} />
          </>
        )}
      </div>
    </div>
  );
}

function EditingBadge({ state }: { state: IleEditorState }) {
  if (state.stream.status === 'error') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-destructive/25  px-2 py-0.5 text-[10px] font-medium text-destructive ">
        <AlertCircle className="h-3 w-3" />
        Error
      </span>
    );
  }
  if (state.stream.status === 'streaming') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-ai/40  px-2 py-0.5 text-[10px] font-medium text-primary ">
        <Loader2 className="h-3 w-3 animate-spin" />
        {state.stream.reasoning ? 'Thinking' : 'Editing'}
      </span>
    );
  }
  if (state.stream.status === 'done') {
    if (state.stream.truncated) {
      return (
        <span
          className="inline-flex items-center gap-1 rounded-full bg-ai/40  px-2 py-0.5 text-[10px] font-medium text-amber-800"
          title="The provider truncated this response at max_tokens. Try a shorter or more specific prompt."
        >
          <AlertCircle className="h-3 w-3" />
          Truncated
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/25  px-2 py-0.5 text-[10px] font-medium text-primary ">
        <CheckCircle2 className="h-3 w-3" />
        Applied
      </span>
    );
  }
  return null;
}

function EmptyState({ hasExperience }: { hasExperience: boolean }) {
  return (
    <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground/80 ">
      <div className="max-w-[280px] space-y-3">
        <p className="text-base text-muted-foreground ">
          {hasExperience
            ? 'Refine the experience in plain language.'
            : 'What should students experience?'}
        </p>
        <p className="text-xs">
          Try: <em>"Make this more visual"</em> or <em>"Add a timer"</em> or
          click a quick action above the composer.
        </p>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  onRetry,
  onAccept,
  onReject,
  onFork,
}: {
  message: ChatMessage;
  onRetry?: () => void;
  onAccept?: () => void;
  onReject?: () => void;
  onFork?: () => void;
  isLastAssistant?: boolean;
}) {
  const isUser = message.role === 'user';
  return (
    <li className="flex items-start gap-2">
      <span
        className={cn(
          'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
          isUser
            ? 'bg-muted  text-muted-foreground '
            : 'bg-ai/40  text-primary ',
        )}
      >
        {isUser ? <User className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
      </span>
      <div
        className={cn(
          'min-w-0 flex-1 rounded-md px-3 py-2 text-[13px] leading-relaxed',
          isUser ? 'bg-background  ring-1 ring-ring ' : 'bg-ai/30  ring-1 ring-primary/30 ',
        )}
      >
        <p className="break-words text-foreground/90 ">{message.content}</p>
        {message.html && message.role === 'assistant' && !message.inFlight && (
          <p className="mt-1 text-[10px] text-muted-foreground ">
            {formatKb(message.html.length)} HTML applied
          </p>
        )}
        {message.role === 'assistant' && !message.inFlight && (onAccept || onReject || onRetry || onFork) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {onAccept && (
              <button
                type="button"
                onClick={onAccept}
                className="inline-flex items-center gap-1 rounded-full border border-primary/30  bg-primary/15  px-2 py-0.5 text-[10px] font-medium text-primary  transition-colors hover:bg-emerald-100"
                title="Mark this version as the new baseline"
              >
                <Check className="h-2.5 w-2.5" /> Accept
              </button>
            )}
            {onReject && (
              <button
                type="button"
                onClick={onReject}
                className="inline-flex items-center gap-1 rounded-full border border-destructive/30  bg-destructive/15  px-2 py-0.5 text-[10px] font-medium text-destructive  transition-colors hover:bg-rose-100"
                title="Revert to the previous version"
              >
                <X className="h-2.5 w-2.5" /> Reject
              </button>
            )}
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1 rounded-full border border-border  bg-background  px-2 py-0.5 text-[10px] font-medium text-foreground/80  transition-colors hover:bg-slate-50"
                title="Re-send the most recent user prompt"
              >
                <RotateCcw className="h-2.5 w-2.5" /> Retry
              </button>
            )}
            {onFork && (
              <button
                type="button"
                onClick={onFork}
                className="inline-flex items-center gap-1 rounded-full border border-border  bg-background  px-2 py-0.5 text-[10px] font-medium text-foreground/80  transition-colors hover:bg-slate-50"
                title="Start a new branch from this point"
              >
                <GitFork className="h-2.5 w-2.5" /> Fork
              </button>
            )}
          </div>
        )}
        {message.inFlight && (
          <p className="mt-1 flex items-center gap-1 text-[10px] text-primary/90 ">
            <Loader2 className="h-3 w-3 animate-spin" /> streaming…
          </p>
        )}
      </div>
    </li>
  );
}

function FollowupPrompt({
  prompt,
  value,
  onChange,
  onSubmit,
  onCancel,
}: {
  prompt: { label: string; placeholder: string };
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="border-t border-border  bg-ai/30  px-3 py-2">
      <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-primary ">
        <Languages className="h-3 w-3" />
        {prompt.label}
      </label>
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onSubmit();
            }
            if (e.key === 'Escape') onCancel();
          }}
          placeholder={prompt.placeholder}
          className="flex-1 rounded-md border border-primary/30  bg-background  px-2 py-1 text-sm focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100"
        />
        <Button size="sm" variant="ghost" onClick={onCancel} className="h-7 text-xs">
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={onSubmit}
          disabled={!value.trim()}
          className="h-7 bg-violet-600 text-xs hover:bg-violet-700"
        >
          Apply
        </Button>
      </div>
    </div>
  );
}

function formatKb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Compact observability strip under the chat thread. Renders after
 * the last finished stream so the teacher can see provider / model /
 * token count / latency without scrolling back through the message.
 *
 * Hidden when the stream is still going (the in-flight progress pill
 * already takes the space).
 */
function StreamFooter({ state }: { state: IleEditorState }) {
  const s = state.stream;
  if (s.status === 'idle' || s.status === 'error' || s.status === 'streaming') {
    return null;
  }
  const tokens = s.tokens;
  const latency = s.latencyMs;
  const provider = s.provider;
  const model = s.model;
  if (tokens == null && latency == null && !provider && !model) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/50  px-1 pt-2 text-[10px] text-muted-foreground ">
      {provider && (
        <span className="inline-flex items-center gap-1">
          <span className="rounded bg-muted  px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground ">
            {provider}
          </span>
        </span>
      )}
      {model && (
        <span className="inline-flex items-center gap-1 truncate font-mono text-[10px] text-foreground/80 " title={model}>
          {model}
        </span>
      )}
      {tokens != null && (
        <span className="inline-flex items-center gap-1" title="Approximate streamed tokens (4 chars/token)">
          <Sparkles className="h-2.5 w-2.5" />
          ~{tokens.toLocaleString()} tokens
        </span>
      )}
      {latency != null && (
        <span className="inline-flex items-center gap-1" title="Wall-clock from stream start to done">
          {formatDuration(latency)}
        </span>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.floor(s % 60)}s`;
}