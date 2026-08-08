import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Settings2,
  Unplug,
  Wifi,
  XCircle,
  AlertTriangle,
  Pencil,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/utils/utils';
import {
  deleteIleAiConfig,
  getIleAiConfig,
  saveIleAiConfig,
  testIleAiConfig,
  type IleAiConfigInput,
  type IleAiConfigResponse,
  type IleProviderId,
  type TestConnectionResult,
  type TestConnectionStatus,
  TEST_CONNECTION_STATUS_COPY,
} from './ileApi';
import { toast } from 'sonner';

/**
 * Per-provider defaults for the model field and base URL. These mirror the
 * backend PROVIDER_DEFAULTS map and keep the UI in sync. Keep them simple —
 * users can override freely.
 */
const PROVIDER_DEFAULTS: Record<
  Exclude<IleProviderId, 'custom'>,
  { defaultModel: string; defaultBaseUrl: string }
> = {
  anthropic: {
    defaultModel: 'claude-sonnet-4-5',
    defaultBaseUrl: 'https://api.anthropic.com',
  },
  openai: {
    defaultModel: 'gpt-4o-mini',
    defaultBaseUrl: 'https://api.openai.com/v1',
  },
  MiniMax: {
    defaultModel: 'MiniMax-M3',
    defaultBaseUrl: 'https://api.minimax.io/anthropic',
  },
  openrouter: {
    defaultModel: 'openrouter/auto',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
  },
};

const ALL_PROVIDERS: {
  value: IleProviderId;
  label: string;
  description: string;
}[] = [
  {
    value: 'anthropic',
    label: 'Anthropic',
    description: 'Claude models. Great default for lesson experiences.',
  },
  {
    value: 'openai',
    label: 'OpenAI',
    description: 'GPT-4o, GPT-4o-mini, etc. Use the OpenAI API key.',
  },
  {
    value: 'MiniMax',
    label: 'MiniMax',
    // ponytail: point teachers at the MiniMax console so they paste a
    // MiniMax key, not another vendor's sk-… key. The previous wording
    // was technically correct but didn't help the teacher diagnose the
    // 401 they get when they paste the wrong vendor's key.
    description: 'Get an API key at platform.minimax.io and paste it here. Routes through Anthropic format.',
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    description: 'Access many models through one OpenAI-compatible API.',
  },
  {
    value: 'custom',
    label: 'Custom OpenAI-Compatible',
    description: 'Any endpoint that speaks OpenAI Chat Completions + SSE.',
  },
];

/**
 * The panel's local status is the server's typed `TestConnectionStatus`
 * (the closed set of provider outcomes). The `idle` value covers the
 * "haven't tested yet" case before the first test runs.
 */
type LocalStatus = 'idle' | TestConnectionStatus;

interface StatusState {
  kind: LocalStatus;
  message?: string;
  /** When connected, the model the test endpoint echoed back. */
  modelEcho?: string;
}

export interface AiConfigPanelProps {
  className?: string;
  /**
   * Render mode:
   * - "chip" — compact inline indicator for the workspace top bar. Shows
   *   status dot + provider · model + Change button. Clicking the chip
   *   (or the Change button) calls `onRequestEdit`.
   * - "modal" — the full form. Renders directly without any wrapping
   *   chrome; the parent supplies the dialog/modal wrapper.
   *
   * "chip" is the default; it never occupies vertical space in the
   * workspace chrome.
   */
  mode?: 'chip' | 'modal';
  /** Fired when the user wants to open the full config dialog from a chip. */
  onRequestEdit?: () => void;
  /**
   * Callback when the underlying configured/unconfigured state changes.
   * Parents can use this to gate the generation submit button.
   */
  onConfiguredChange?: (configured: boolean) => void;
  /**
   * Fired exactly once per successful save. Distinct from
   * `onConfiguredChange` so the parent can close the dialog on save
   * without also closing it on every load-on-mount.
   */
  onSaved?: () => void;
  /**
   * Legacy `forceExpand` — kept for backward compatibility with any
   * callers still passing the old banner-style prop. The new design
   * ignores it (the chip never occupies vertical space).
   */
  forceExpand?: boolean;
  /** Legacy: when true, the modal-equivalent starts expanded. */
  defaultOpen?: boolean;
}

/**
 * State + handlers for the AI config form. Lifted out of `AiConfigPanel`
 * so the workspace can render the chip and the dialog body side by side
 * and have them share the same `provider`/`apiKey`/`status` etc.
 */
export interface UseAiConfigStateResult {
  loading: boolean;
  saving: boolean;
  testing: boolean;
  provider: IleProviderId;
  apiKey: string;
  model: string;
  baseUrl: string;
  showKey: boolean;
  saved: IleAiConfigResponse | null;
  status: StatusState;
  hasTested: boolean;
  needsBaseUrl: boolean;
  setProvider: (p: IleProviderId) => void;
  setApiKey: (v: string) => void;
  setModel: (v: string) => void;
  setBaseUrl: (v: string) => void;
  setShowKey: (v: boolean) => void;
  handleTest: () => void;
  handleSave: () => void;
  handleDisconnect: () => void;
  disconnecting: boolean;
}

function useAiConfigState(
  onConfiguredChange?: (configured: boolean) => void,
  onSaved?: () => void,
): UseAiConfigStateResult {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // Form state
  const [provider, setProvider] = useState<IleProviderId>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [showKey, setShowKey] = useState(false);

  // Existing config snapshot — used to render "key set" state when the
  // user opens the panel without re-entering a key.
  const [saved, setSaved] = useState<IleAiConfigResponse | null>(null);

  // Status derived from the last test-connection response. Idle until the
  // user tests.
  const [status, setStatus] = useState<StatusState>({ kind: 'idle' });
  const cancelledRef = useRef(false);

  // Whether the user has actually clicked Test (so we don't show "Not
  // Configured" before they've had a chance).
  const [hasTested, setHasTested] = useState(false);

  const needsBaseUrl = provider === 'custom' || provider === 'openrouter';

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // Load the existing config on mount so the panel reflects saved state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getIleAiConfig();
        if (cancelled) return;
        if (res.config) {
          setSaved(res.config);
          setProvider(res.config.provider);
          setModel(res.config.model);
          setBaseUrl(res.config.baseUrl ?? '');
          // Don't pre-fill apiKey — it's masked. User re-enters to change it.
          setStatus(
            res.config.hasApiKey
              ? { kind: 'connected', message: 'Saved' }
              : { kind: 'not_configured', message: 'Add an API key to start.' },
          );
          setHasTested(true);
          onConfiguredChange?.(true);
        } else {
          setStatus({
            kind: 'not_configured',
            message: 'Configure a provider to enable generation.',
          });
          onConfiguredChange?.(false);
        }
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'Failed to load ILE AI configuration';
        toast.error(message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the user picks a non-custom provider, pre-fill sensible defaults
  // — but ONLY if the field is currently empty or matches a different
  // provider's default. Never clobber an explicit value.
  const defaultsForProvider = useMemo(() => {
    if (provider === 'custom') return null;
    return PROVIDER_DEFAULTS[provider];
  }, [provider]);

  // When the teacher switches providers, overwrite the model +
  // baseUrl with the new provider's defaults. Without this, a teacher
  // who previously saved `provider='custom'` + `baseUrl='/v1'` (an
  // OpenAI-compat URL), then picks `MiniMax` from the dropdown, ends
  // up with MiniMax routing through the OpenAI-compat URL — which
  // silently breaks every subsequent request.
  //
  // The audit recommended this; the trade-off is a teacher who
  // manually overrode baseUrl for a non-custom provider (e.g. they
  // route through a proxy) loses their override on provider switch.
  // Acceptable because (a) the typical workflow is pick provider +
  // hit Save, no manual baseUrl editing for non-custom; (b) `custom`
  // is explicitly preserved below so proxy workflows still work.
  useEffect(() => {
    if (provider === 'custom') return;
    if (!defaultsForProvider) return;
    setModel(defaultsForProvider.defaultModel);
    setBaseUrl(defaultsForProvider.defaultBaseUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  function handleSave() {
    if (!model.trim()) {
      toast.error('Model is required.');
      return;
    }
    if (needsBaseUrl && !baseUrl.trim()) {
      toast.error('Base URL is required for the selected provider.');
      return;
    }
    if (apiKey && apiKey.length < 8) {
      toast.error('API key looks too short — double check it.');
      return;
    }

    setSaving(true);
    const payload: IleAiConfigInput = {
      provider,
      model: model.trim(),
      baseUrl: baseUrl.trim() || undefined,
    };
    // Only send the apiKey if the user typed one. Empty string means
    // "keep the previously stored key" — handled server-side. Trim
    // defensively so a trailing newline from copy-paste (very common
    // when grabbing a key from terminal / .env file / console) doesn't
    // make MiniMax parse the key as malformed.
    if (apiKey.trim().length > 0) payload.apiKey = apiKey.trim();

    (async () => {
      try {
        const res = await saveIleAiConfig(payload);
        if (cancelledRef.current) return;
        setSaved(res.config);
        setApiKey(''); // clear from form so the masked indicator reappears
        setStatus({
          kind: 'connected',
          message: 'Saved.',
          modelEcho: res.config?.model,
        });
        setHasTested(true);
        onConfiguredChange?.(true);
        onSaved?.();
        toast.success('AI configuration saved.');
      } catch (err: unknown) {
        if (cancelledRef.current) return;
        const message = err instanceof Error ? err.message : 'Save failed.';
        toast.error(message);
      } finally {
        if (!cancelledRef.current) setSaving(false);
      }
    })();
  }

  function handleTest() {
    setTesting(true);
    const input: Partial<IleAiConfigInput> = {};
    input.provider = provider;
    input.model = model.trim();
    if (baseUrl.trim()) input.baseUrl = baseUrl.trim();
    // ponytail: trim the key so a copy-pasted trailing newline (common
    // when grabbing the key from a terminal / console) doesn't make the
    // upstream auth layer parse it as malformed. Mirrors the pattern
    // used for every other user-input field in this panel.
    if (apiKey.trim().length > 0) input.apiKey = apiKey.trim();

    (async () => {
      try {
        const res: TestConnectionResult = await testIleAiConfig(input);
        if (cancelledRef.current) return;
        setStatus(translateStatus(res));
        setHasTested(true);
        onConfiguredChange?.(res.status === 'connected');
      } catch (err: unknown) {
        if (cancelledRef.current) return;
        const message =
          err instanceof Error ? err.message : 'Network error';
        setStatus({ kind: 'network_error', message });
        setHasTested(true);
      } finally {
        if (!cancelledRef.current) setTesting(false);
      }
    })();
  }

  /**
   * Disconnect the saved AI provider. Drops the Keystore-encrypted
   * envelope from Mongo via DELETE /interactive-experiences/config.
   * After this succeeds the teacher will see the actionable
   * "Configure AI first" toast on the next generation attempt.
   *
   * The local form state is reset so the chip + form both reflect the
   * disconnected state. The apiKey field is cleared (it was never
   * persisted client-side anyway, but be explicit) and the model/baseUrl
   * are reset to the Anthropic default so the next save is one click
   * away from working.
   */
  function handleDisconnect() {
    if (disconnecting) return;
    const confirmed = window.confirm(
      'Disconnect the saved AI provider? You can re-enter credentials any time.',
    );
    if (!confirmed) return;
    setDisconnecting(true);
    (async () => {
      try {
        await deleteIleAiConfig();
        if (cancelledRef.current) return;
        setSaved(null);
        setApiKey('');
        setProvider('anthropic');
        setModel(PROVIDER_DEFAULTS.anthropic.defaultModel);
        setBaseUrl(PROVIDER_DEFAULTS.anthropic.defaultBaseUrl);
        setStatus({
          kind: 'not_configured',
          message: 'Disconnected. Add a new provider to start generating.',
        });
        setHasTested(true);
        onConfiguredChange?.(false);
        toast.success('AI configuration disconnected.');
      } catch (err: unknown) {
        if (cancelledRef.current) return;
        const message =
          err instanceof Error ? err.message : 'Disconnect failed.';
        toast.error(message);
      } finally {
        if (!cancelledRef.current) setDisconnecting(false);
      }
    })();
  }

  return {
    loading,
    saving,
    testing,
    provider,
    apiKey,
    model,
    baseUrl,
    showKey,
    saved,
    status,
    hasTested,
    needsBaseUrl,
    setProvider,
    setApiKey,
    setModel,
    setBaseUrl,
    setShowKey: (v: boolean) => setShowKey(v),
    handleTest,
    handleSave,
    handleDisconnect,
    disconnecting,
  };
}

/**
 * AI Configuration panel for the ILE feature.
 *
 * Self-contained: loads its own state on mount, manages its own form, and
 * never touches the global AI config. Renders one of four explicit status
 * states ("Connected" / "Invalid API Key" / "Network Error" / "Not Configured")
 * plus a neutral idle state for "haven't tested yet".
 */
export function AiConfigPanel({
  className,
  mode = 'chip',
  onRequestEdit,
  onConfiguredChange,
}: AiConfigPanelProps) {
  const {
    loading,
    provider,
    model,
    saved,
    status,
  } = useAiConfigState(onConfiguredChange);

  // Chip mode — never occupies vertical space. Always clickable so the
  // teacher can change their provider/model in one tap.
  if (mode === 'chip') {
    return (
      <button
        type="button"
        onClick={onRequestEdit}
        className={cn(
          'inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors',
          status.kind === 'connected'
            ? 'bg-primary/15  text-emerald-800 hover:bg-success-soft/20'
            : loading
              ? 'bg-muted  text-muted-foreground '
              : 'bg-ai/30  text-amber-800 hover:bg-warm/20',
          className,
        )}
        aria-label={
          status.kind === 'connected'
            ? `AI configured with ${saved?.provider ?? provider} ${saved?.model ?? model}. Click to change.`
            : 'AI not configured. Click to configure.'
        }
        title={
          status.kind === 'connected'
            ? `${saved?.provider ?? provider} · ${saved?.model ?? model}`
            : 'Configure AI provider'
        }
      >
        <ChipStatusDot status={status} loading={loading} />
        <span className="max-w-[260px] truncate">
          {loading ? (
            'Checking AI…'
          ) : status.kind === 'connected' ? (
            <>
              <span className="text-primary ">Connected</span>
              <span className="mx-1 text-emerald-400">·</span>
              <span className="text-emerald-800">
                {providerLabel(saved?.provider ?? provider)} {saved?.model ?? model}
              </span>
            </>
          ) : (
            <span>Setup required · Click to configure</span>
          )}
        </span>
        <span
          className={cn(
            'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
            status.kind === 'connected'
              ? 'bg-background  text-primary '
              : 'bg-background  text-accent-foreground ',
          )}
        >
          {status.kind === 'connected' ? (
            <Pencil className="h-2.5 w-2.5" />
          ) : null}
          Change
        </span>
      </button>
    );
  }

  // Modal mode — the full form, no wrapper chrome (parent supplies the
  // dialog). Renders inside whatever container the caller chose.
  return (
    <AiConfigFormBody
      className={className}
      onConfiguredChange={onConfiguredChange}
    />
  );
}

function providerLabel(id: IleProviderId): string {
  const found = ALL_PROVIDERS.find((p) => p.value === id);
  return found?.label ?? id;
}

function translateStatus(res: TestConnectionResult): StatusState {
  return {
    kind: res.status,
    message: res.message,
    modelEcho: res.modelEcho,
  };
}

function ChipStatusDot({
  status,
  loading,
}: {
  status: StatusState;
  loading: boolean;
}) {
  if (loading) {
    return <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/80 " />;
  }
  if (status.kind === 'connected') {
    return <CheckCircle2 className="h-3 w-3 text-primary/90 " />;
  }
  if (status.kind === 'idle' || !status || status.kind === undefined) {
    return <AlertTriangle className="h-3 w-3 text-accent-foreground/90 " />;
  }
  // All other statuses (network_error, invalid_key, not_configured, etc.)
  // get the amber treatment.
  return <AlertTriangle className="h-3 w-3 text-accent-foreground/90 " />;
}

// ─────────────────────────────────────────────────────────────────────
// Full form body — extracted so the parent can compose it inside any
// wrapper (modal, dialog, etc.) without duplicating the form logic.
// ─────────────────────────────────────────────────────────────────────

interface AiConfigFormBodyProps {
  className?: string;
  /**
   * When supplied, the form body uses this shared state instead of
   * running its own. The dialog chip + form share one state so saving
   * in the dialog updates the chip immediately.
   */
  state?: UseAiConfigStateResult;
  /**
   * Fired when the user has successfully saved a config. Lets the parent
   * close the dialog without owning the state.
   */
  onSaved?: () => void;
}

/**
 * Exported so the workspace (or any consumer) can compose the full
 * config form inside its own modal/dialog wrapper without duplicating
 * the form logic. Pass an existing `state` to share with another
 * consumer (e.g. the workspace chip); otherwise the body owns its own
 * state via the hook.
 */
export function AiConfigFormBody({
  className,
  state: externalState,
  onConfiguredChange,
  onSaved,
}: AiConfigFormBodyProps & {
  onConfiguredChange?: (configured: boolean) => void;
}) {
  const internal = useAiConfigState(onConfiguredChange, onSaved);
  const s = externalState ?? internal;

  if (s.loading) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 py-8 text-sm text-muted-foreground ',
          className,
        )}
      >
        <Loader2 className="h-4 w-4 animate-spin" /> Loading configuration…
      </div>
    );
  }
  return (
    <div className={cn('space-y-4', className)}>
      {/* Provider */}
      <div className="space-y-1.5">
        <Label htmlFor="ile-ai-provider" className="text-xs text-muted-foreground ">
          Provider
        </Label>
        <select
          id="ile-ai-provider"
          className="w-full rounded-md border border-border/80  bg-background  px-3 py-2 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
          value={s.provider}
          onChange={(e) => s.setProvider(e.target.value as IleProviderId)}
          disabled={s.saving || s.testing}
        >
          {ALL_PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-muted-foreground ">
          {ALL_PROVIDERS.find((p) => p.value === s.provider)?.description}
        </p>
      </div>

      {/* API Key */}
      <div className="space-y-1.5">
        <Label htmlFor="ile-ai-key" className="text-xs text-muted-foreground ">
          API Key{' '}
          {s.saved?.hasApiKey && (
            <span className="ml-1 rounded-full bg-primary/15  px-2 py-0.5 text-[10px] font-medium text-primary ">
              Set · {s.saved.apiKeyMasked ?? '••••'}
            </span>
          )}
        </Label>
        <div className="relative">
          <Input
            id="ile-ai-key"
            type={s.showKey ? 'text' : 'password'}
            value={s.apiKey}
            onChange={(e) => s.setApiKey(e.target.value)}
            placeholder={
              s.saved?.hasApiKey
                ? 'Leave blank to keep the existing key'
                : 'Paste your API key'
            }
            className="pr-10 text-sm"
            autoComplete="off"
            spellCheck={false}
            disabled={s.saving || s.testing}
          />
          <button
            type="button"
            onClick={() => s.setShowKey(!s.showKey)}
            className="absolute inset-y-0 right-0 flex h-10 items-center px-3 text-muted-foreground/80  hover:text-accent-foreground"
            aria-label={s.showKey ? 'Hide API key' : 'Show API key'}
          >
            {s.showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground/80 ">
          Stored per teacher. Never sent back to the browser after the first save.
        </p>
      </div>

      {/* Model */}
      <div className="space-y-1.5">
        <Label htmlFor="ile-ai-model" className="text-xs text-muted-foreground ">
          Model
        </Label>
        <Input
          id="ile-ai-model"
          value={s.model}
          onChange={(e) => s.setModel(e.target.value)}
          placeholder="e.g. claude-sonnet-4-5"
          className="text-sm"
          disabled={s.saving || s.testing}
        />
      </div>

      {/* Base URL — only shown when the provider needs one */}
      {s.needsBaseUrl && (
        <div className="space-y-1.5">
          <Label htmlFor="ile-ai-baseurl" className="text-xs text-muted-foreground ">
            Base URL
          </Label>
          <Input
            id="ile-ai-baseurl"
            value={s.baseUrl}
            onChange={(e) => s.setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
            className="text-sm"
            disabled={s.saving || s.testing}
          />
          <p className="text-[10px] text-muted-foreground/80 ">
            Required for Custom. Optional override for OpenRouter.
          </p>
        </div>
      )}

      {/* Inline status detail */}
      {s.hasTested && s.status.kind !== 'connected' && (
        <StatusDetail status={s.status} />
      )}
      {s.hasTested && s.status.kind === 'connected' && s.status.modelEcho && (
        <p className="rounded-md bg-primary/15  px-3 py-2 text-xs text-primary ">
          Connection verified with <code>{s.status.modelEcho}</code>.
        </p>
      )}

      {/* Action row */}
      <div className="flex items-center justify-between gap-2 pt-1">
        {s.saved ? (
          <Button
            variant="ghost"
            size="lg"
            onClick={s.handleDisconnect}
            disabled={s.disconnecting || s.saving || s.testing}
            className="text-muted-foreground hover:text-destructive "
            aria-label="Disconnect saved AI provider"
            title="Remove the saved AI provider configuration"
          >
            {s.disconnecting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Disconnecting…
              </>
            ) : (
              <>
                <Unplug className="h-3.5 w-3.5" /> Disconnect
              </>
            )}
          </Button>
        ) : (
          <span /> /* keep the right-aligned buttons pushed right */
        )}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="lg"
            onClick={s.handleTest}
            disabled={s.testing || s.saving || !s.model.trim()}
          >
            {s.testing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Testing…
              </>
            ) : (
              <>
                <Wifi className="h-3.5 w-3.5" /> Test Connection
              </>
            )}
          </Button>
          <Button
            size="lg"
            onClick={s.handleSave}
            disabled={s.saving || s.testing}
            className="bg-primary hover:bg-primary/90"
          >
            {s.saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
              </>
            ) : (
              'Save Configuration'
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

function StatusDetail({ status }: { status: StatusState }) {
  if (status.kind === 'idle' || status.kind === 'connected') return null;
  const copy = TEST_CONNECTION_STATUS_COPY[status.kind];
  // The server provides a message; fall back to the local copy when it's
  // missing (e.g. cached client without the server update).
  const message = status.message || copy.label;
  const palette =
    copy.tone === 'error'
      ? 'border-rose-200 bg-rose-50 text-rose-700'
      : copy.tone === 'warn'
        ? 'border-amber-200 bg-amber-50 text-amber-700'
        : 'border-slate-200 bg-slate-50 text-slate-700';
  return (
    <div className={cn('rounded-md border px-3 py-2 text-xs', palette)}>
      {message}
    </div>
  );
}

// Keep these re-exported so any consumer referencing them keeps compiling.
export { Settings2, CheckCircle2, XCircle, AlertTriangle };