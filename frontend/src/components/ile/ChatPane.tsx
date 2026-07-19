import { useCallback, useEffect, useRef, useState } from 'react';
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

export interface ChatPaneProps {
  state: IleEditorState;
  api: IleEditorApi;
  /**
   * Fired when the teacher submits text. The editor (api.send) handles
   * routing between generate/edit, so this is a passthrough.
   */
  onSubmit: (text: string) => void;
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
    onSubmit(text);
  }, [draft, isStreaming, onSubmit]);

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

  return (
    <div className={cn('flex h-full flex-col border-r bg-slate-50/40', className)}>
      <Header
        state={state}
        api={api}
        hasExperience={hasExperience}
        isStreaming={isStreaming}
      />

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {/* Empty state for the very first message. */}
        {state.messages.length === 0 && !isStreaming && state.stream.status === 'idle' && (
          <EmptyState hasExperience={hasExperience} />
        )}

        {showReasoning && (
          <div className="mb-3 inline-flex items-center gap-2 rounded-md bg-violet-50 px-2.5 py-1.5 text-xs text-violet-800 ring-1 ring-violet-100">
            <Brain className="h-3.5 w-3.5 animate-pulse" />
            Thinking about the next change…
          </div>
        )}

        {/* Chat thread */}
        <ol className="space-y-3">
          {state.messages.map((m, idx) => (
            <MessageBubble
              key={m._msgId ?? `${m.role}-${idx}-${m.createdAt ?? ''}`}
              message={m}
            />
          ))}
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
                        isLast ? 'bg-emerald-50 text-emerald-900' : 'text-slate-500',
                      )}
                    >
                      <span className="mt-0.5 text-emerald-600">
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

        {state.stream.status === 'error' && state.stream.error && (
          <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            <p className="font-medium">Edit failed</p>
            <p className="mt-1">{state.stream.error}</p>
          </div>
        )}
      </div>

      {/* Quick actions — only when not currently editing. */}
      {hasExperience && !isStreaming && activeFollowup === null && (
        <div className="border-t border-slate-200 bg-white px-3 py-2">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-400">
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
                  className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 transition-colors hover:border-violet-300 hover:bg-violet-50 hover:text-violet-800"
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
        <div className="border-t bg-white p-4">
          <div className="rounded-md border border-dashed border-violet-200 bg-violet-50/40 px-3 py-2.5 text-xs text-violet-800">
            <p className="font-medium">Configure an AI provider to start.</p>
            {configHint && <p className="mt-1 text-violet-700">{configHint}</p>}
          </div>
        </div>
      ) : (
        <div className="border-t bg-white p-3">
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
            <span className="text-[11px] text-slate-400">
              {hasExperience
                ? state.pending
                  ? 'Queued — current edit will finish first'
                  : 'Editing existing draft'
                : 'New experience'}{' '}
              · ⌘↩ to send
            </span>
            <div className="flex items-center gap-2">
              {isStreaming ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={api.cancel}
                  className="gap-1 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
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
}: {
  state: IleEditorState;
  api: IleEditorApi;
  hasExperience: boolean;
  isStreaming: boolean;
}) {
  return (
    <div className="flex items-center justify-between border-b px-4 py-2">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Designer</h2>
        <p className="text-[11px] text-slate-500">
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
              className="h-7 w-7 p-0 text-slate-500 hover:text-slate-900 disabled:opacity-40"
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
              className="h-7 w-7 p-0 text-slate-500 hover:text-slate-900 disabled:opacity-40"
            >
              <Redo2 className="h-3.5 w-3.5" />
            </Button>
            <span className="mx-1 h-5 w-px bg-slate-200" />
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
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-medium text-rose-700">
        <AlertCircle className="h-3 w-3" />
        Error
      </span>
    );
  }
  if (state.stream.status === 'streaming') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700">
        <Loader2 className="h-3 w-3 animate-spin" />
        {state.stream.reasoning ? 'Thinking' : 'Editing'}
      </span>
    );
  }
  if (state.stream.status === 'done') {
    if (state.stream.truncated) {
      return (
        <span
          className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800"
          title="The provider truncated this response at max_tokens. Try a shorter or more specific prompt."
        >
          <AlertCircle className="h-3 w-3" />
          Truncated
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
        <CheckCircle2 className="h-3 w-3" />
        Applied
      </span>
    );
  }
  return null;
}

function EmptyState({ hasExperience }: { hasExperience: boolean }) {
  return (
    <div className="flex h-full items-center justify-center text-center text-sm text-slate-400">
      <div className="max-w-[280px] space-y-3">
        <p className="text-base text-slate-600">
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

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <li className="flex items-start gap-2">
      <span
        className={cn(
          'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
          isUser
            ? 'bg-slate-200 text-slate-600'
            : 'bg-violet-100 text-violet-700',
        )}
      >
        {isUser ? <User className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
      </span>
      <div
        className={cn(
          'min-w-0 flex-1 rounded-md px-3 py-2 text-[13px] leading-relaxed',
          isUser ? 'bg-white ring-1 ring-slate-200' : 'bg-violet-50/60 ring-1 ring-violet-100',
        )}
      >
        <p className="break-words text-slate-800">{message.content}</p>
        {message.html && message.role === 'assistant' && !message.inFlight && (
          <p className="mt-1 text-[10px] text-slate-500">
            {formatKb(message.html.length)} HTML applied
          </p>
        )}
        {message.inFlight && (
          <p className="mt-1 flex items-center gap-1 text-[10px] text-violet-600">
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
    <div className="border-t border-slate-200 bg-violet-50/40 px-3 py-2">
      <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-violet-800">
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
          className="flex-1 rounded-md border border-violet-200 bg-white px-2 py-1 text-sm focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100"
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