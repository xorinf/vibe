import { injectable, inject } from 'inversify';
import { Response, Request } from 'express';
import { ILE_TYPES } from '../types.js';
import { IleSseService } from './IleSseService.js';
import { IleRepository } from '../repositories/IleRepository.js';
import { IleAiConfigService } from './IleAiConfigService.js';
import { IleAssetService } from './IleAssetService.js';
import { IleExperience } from '../classes/transformers/IleExperience.js';
import {
  ChatStream,
  IleAiConfig,
  ProviderError,
  ProviderCancelledError,
  ProviderUnknownError,
  asProviderError,
} from './providers/types.js';
import { createProvider } from './providers/index.js';
import { ileLog } from './observability.js';
import { ContextBuilder } from '../context/ContextBuilder.js';
import {
  CONTEXT_PHASES,
  ContextPhase,
  ContextProviderError,
  GenerationContext,
} from '../context/types.js';

const SYSTEM_PROMPT = `# HARD RULE — your entire response is rendered into a sandboxed iframe.

Your reply MUST be EXACTLY ONE complete \`<!DOCTYPE html>...</html>\` document,
starting with the literal text \`<!DOCTYPE\` and ending with \`</html>\`.
No prose, no explanation, no preamble, no markdown fences, no narration,
no \`<think>...</think>\` blocks, no \`\`\` fences. Anything before \`<!DOCTYPE\`
or after \`</html>\` is silently discarded. If you violate this rule the
teacher sees garbage in their iframe.

## Conversational prompts
When the teacher asks a conversational question (e.g. "I want to understand
how X works", "explain Y to me", "show me how Z works"), the answer MUST
still be a working HTML experience. Embed any explanatory text inside
\`<!-- … -->\` HTML comments at the top of the document, or as static
\`section\`/\`p\` content rendered visibly in the page. Do NOT refuse with
prose. The iframe is the only surface the teacher sees — an answer that
isn't HTML is invisible.

You are ViBe's Interactive Learning Experience designer.
Your job is to design a single self-contained interactive HTML experience
for the lesson described by the teacher.

You operate inside an ITERATIVE workspace. The teacher will give you
follow-up instructions to refine what you produced. Treat each request
as a collaborative edit on the same artifact.

Output rules — non-negotiable:
- Emit EXACTLY ONE complete <!DOCTYPE html>...</html> document. No prose
  before or after. No markdown fences.
- Use ONLY inline <style> and inline <script>. No external assets. No
  <script src>, no <link href>, no <img src> pointing anywhere except data:
  URs, no fetch/XMLHttpRequest to remote URLs. The HTML runs inside a
  sandboxed iframe with no network access.
- The page should be visually polished: readable typography, sensible
  spacing, consistent colors. Aim for a modern educational app feel.
- FILL THE WHOLE SCREEN — design for one-screen viewing, no scrolling.
  Use viewport units (`vh`, `vw`, `dvh`, `dvw`) plus `width:100%;
  height:100dvh` on `<body>` so the experience fills the user's
  viewport edge-to-edge. Lay out content with flex/grid that adapts
  to aspect ratio (a 13" laptop vs a portrait phone should both see
  the whole experience). If the teacher has to scroll to discover
  the next interaction, the design failed.
- Include interactive controls that demonstrate the concept (buttons,
  sliders, drag/drop, canvas — whatever fits).
- Open with an HTML comment describing the interaction type and lesson.

When the teacher gives a follow-up edit instruction, rewrite the FULL
document to incorporate the change. Do not append; do not produce a diff.
The full HTML is what gets saved.

Collaboration heuristics:
- If the teacher's instruction is small (e.g. "add a timer", "make the
  text bigger", "translate to Spanish"), keep every other element of
  the experience intact — don't redesign the layout, don't rename
  controls, don't reorder sections. Just apply the change precisely.
- If the instruction is structural (e.g. "turn this into a simulation",
  "add a timeline", "make it a quiz"), refactor what's needed to honour
  the request while preserving the lesson's pedagogical intent.
- Preserve any existing interactive controls the teacher didn't ask to
  change. Removing a working button to add a different feature is a
  regression unless the instruction explicitly asks for it.
- Match the visual language of the original (palette, spacing, type
  scale). The teacher is iterating, not starting over.
- Quick-action labels like "Improve", "Simplify", "Add Quiz", or
  "Make Interactive" describe the kind of refinement wanted — apply the
  principle to the existing artifact rather than producing a new one
  from scratch.

Using teacher-uploaded assets:
- When the teacher uploads an asset (image, audio, video, PDF, SVG), the
  server appends an "Available assets" block to this prompt with a
  fresh signed URL for each.
- Reference assets by their absolute URL in the generated HTML:
  <img src="https://..."> for images, <audio src="..."> for audio,
  <video src="..."> for video, <iframe src="..."> for PDF.
- If the teacher's instruction references "the uploaded image" or "this
  PDF", pick the matching asset by filename or by id from the list.
- The HTML runs inside a sandboxed iframe with a Content Security Policy
  that allows data: and (after recent updates) https: for asset hosts.
  Inline <style>/<script> and data: URIs remain the default.

Output a complete document on the FIRST try. Do not narrate your reasoning
in the HTML itself.`;

/**
 * Friendly progress labels that map to AGENT.md's "✓ Understanding lesson"
 * pattern. We surface these as soon as we see the first delta; reasoning
 * deltas (if any) get folded into the same channel.
 */
const PROGRESS_STEPS = [
  '✓ Understanding lesson',
  '✓ Selecting interaction type',
  '✓ Designing experience',
  '✓ Building preview',
  '✓ Finalizing',
];

/**
 * Cancellation reason — surfaced to logs + the structured SSE `error`
 * event so the frontend can tell the teacher *why* their stream stopped.
 */
type CancellationReason =
  | 'client_disconnect'
  | 'client_abort'
  | 'upstream_timeout'
  | 'editor_cancel';

@injectable()
export class IleGenerationService {
  constructor(
    @inject(ILE_TYPES.IleSseService) private readonly sse: IleSseService,
    @inject(ILE_TYPES.IleRepository) private readonly repo: IleRepository,
    @inject(ILE_TYPES.IleAiConfigService)
    private readonly aiConfig: IleAiConfigService,
    @inject(ILE_TYPES.IleAssetService)
    private readonly assets: IleAssetService,
    @inject(ILE_TYPES.ContextBuilder)
    private readonly contextBuilder: ContextBuilder,
  ) {}

  /**
   * Stream a fresh generation. Saves a new draft experience document
   * and emits SSE events as the LLM produces HTML.
   *
   * Cancellation is wired through:
   *   - `req.on('close')`  → client disconnected (closed browser tab,
   *     lost network mid-stream). We abort the upstream provider so the
   *     fetch tears down and we don't keep paying for tokens.
   *   - `signal`           → external AbortController (used by tests,
   *     the editor's Cancel button, and the SSE layer itself when the
   *     teacher hits Back).
   *   - The provider's own internal 120s deadline (defence in depth).
   *
   * @param ownerId  Firebase uid of the teacher.
   * @param req      Express request (used for SSE heartbeat / cleanup).
   * @param res      Express response, configured by sse.attach().
   * @param requestId  Structured-log correlation id (optional; one is
   *                  generated if absent).
   */
  async generate(
    ownerId: string,
    req: Parameters<IleSseService['attach']>[0],
    res: Response,
    args: {
      courseId: string;
      courseVersionId: string;
      itemId?: string;
      prompt: string;
      requestId?: string;
    },
  ): Promise<void> {
    const requestId = args.requestId ?? cryptoRandomId();
    const sse = this.sse.attach(req, res);

    // Cancellation wiring:
    //   - `req.on('close')`  — the browser disconnected (closed tab,
    //      navigated away). We tear down the upstream so we don't keep
    //      paying for tokens we'll never deliver.
    //   - The provider's own 120s deadline (defence in depth).
    //
    // We don't read `req.signal` directly — Express's @types don't
    // expose it; the `close` event fires for all the cases we care
    // about (browser navigation, network drop, abort).
    const abort = new AbortController();
    let cancellationReason: CancellationReason | null = null;
    const onClose = () => {
      cancellationReason = 'client_disconnect';
      abort.abort();
    };
    req.once('close', onClose);
    abort.signal.addEventListener('abort', () => {
      req.off('close', onClose);
    });

    const t0 = Date.now();
    let tokenCount = 0;
    let responseBytes = 0;
    let cancelled = false;

    try {
      const { client, config } = await this.makeClientForOwner(ownerId);
      ileLog('info', 'stream.start', {
        requestId,
        ownerId,
        provider: config.provider,
        model: config.model,
        kind: 'generate',
      });

      // 1. Persist a fresh draft so we have an _id we can reference later.
      const draft = new IleExperience({
        ownerId,
        courseId: args.courseId,
        courseVersionId: args.courseVersionId,
        itemId: args.itemId,
        title: this.deriveTitle(args.prompt),
        prompt: args.prompt,
        history: [{ role: 'user', content: args.prompt }],
        html: '',
        status: 'draft',
      });
      const saved = await this.repo.insert(draft);

      // 2. Tell the client we've started. They can already open the preview
      //    iframe — it'll just be empty until 'html' events arrive.
      sse.emit( 'start', {
        experienceId: String(saved._id),
      });

      // 3. Progress: stamp each step before the corresponding phase.
      //    Step 0 fires immediately; later steps fire on chunk-count triggers.
      let nextStep = 0;
      const fireNextStep = () => {
        if (nextStep < PROGRESS_STEPS.length) {
          sse.emit( 'progress', { message: PROGRESS_STEPS[nextStep] });
          nextStep++;
        }
      };
      fireNextStep();

      // 4. Stream the response via the configured provider. We pass
      //    `abort.signal` so the provider tears down on client disconnect.
      const stream = client.stream({
        system: await this.buildSystemPrompt(ownerId),
        messages: [{ role: 'user', content: args.prompt }],
        temperature: 0.4,
        maxTokens: 32768,
        signal: abort.signal,
      });

      let html = '';
      let chunkCount = 0;
      let lastReasoningFlush = '';
      // Provider emits exactly one `_stream_meta` chunk at the very end
      // of the stream. Default to false (no truncation) so that
      // older providers that don't emit the sentinel still behave.
      let truncated = false;

      for await (const chunk of stream) {
        if (abort.signal.aborted) break;
        if (chunk.kind === 'text') {
          const cleanDelta = this.sanitizeDeltaForHtml(html, chunk.delta);
          if (cleanDelta) {
            html += cleanDelta;
            chunkCount++;
            tokenCount += approximateTokens(cleanDelta);
            responseBytes += Buffer.byteLength(cleanDelta, 'utf8');
            sse.emit( 'html', { delta: cleanDelta });
          }

          // Fire progress steps as we accumulate HTML.
          if (chunkCount === 8) fireNextStep();
          else if (chunkCount === 40) fireNextStep();
          else if (chunkCount === 120) fireNextStep();
        } else if (chunk.kind === 'reasoning') {
          // Emit a discrete reasoning signal so the UI can render
          // a "Thinking…" pill. The dedup logic in the hook will keep
          // it sticky until the first text delta arrives.
          sse.emit( 'reasoning', {});
          lastReasoningFlush += chunk.delta;
          if (lastReasoningFlush.length > 200) {
            // After enough reasoning has flowed, bump the progress UI
            // so the user sees forward motion even before text arrives.
            sse.emit( 'progress', {
              message: '✓ Designing experience',
            });
            lastReasoningFlush = '';
          }
        } else if (chunk.kind === '_stream_meta') {
          // Provider finished — capture the truncation flag for the
          // eventual `done` event. We DON'T emit anything on the SSE
          // channel here; the frontend combines truncated + the rest
          // of `done` into a single toast.
          if (chunk.truncated) truncated = true;
        }
      }

      // Distinguish cancelled vs completed vs upstream timeout.
      if (abort.signal.aborted) {
        cancelled = true;
        // Provider throws ProviderCancelledError on its own abort path;
        // if it didn't (e.g. abort fired between chunks), we still need
        // a uniform reason here.
        if (cancellationReason === null) cancellationReason = 'client_abort';
        ileLog('info', 'stream.cancelled', {
          requestId,
          ownerId,
          reason: cancellationReason,
          partialBytes: responseBytes,
          partialTokens: tokenCount,
          elapsedMs: Date.now() - t0,
        });
        sse.emit( 'error', {
          message: 'Generation cancelled.',
          kind: 'cancelled',
          reason: cancellationReason,
        });
        sse.close();
        return;
      }

      // 5. Final cleanup: ensure last step fires, persist the assistant turn.
      //    The new html + history append happen in a SINGLE Mongo write
      //    (see repo.appendAssistantTurn) so a crash between them can't
      //    leave the doc with stale `html` but a fresh history entry.
      fireNextStep();

      const finalHtml = this.normalizeHtml(html);

      // Guard: catch the model-ignored-prompt case where the
      // provider emits prose narration instead of a `<!DOCTYPE
      // html>` document. The MiniMax provider in particular will
      // reply conversationally when the prompt is short. Without
      // this guard the narration text would be persisted as the
      // ILE and the iframe would render plain text. Emit a clear
      // error and bail out so the teacher gets actionable feedback
      // instead of garbage in their workspace.
      if (finalHtml.length > 100 && !this.looksLikeHtmlDoc(finalHtml)) {
        ileLog('warn', 'stream.model_output_not_html', {
          requestId,
          ownerId,
          provider: config.provider,
          model: config.model,
          htmlLength: finalHtml.length,
          first120: finalHtml.slice(0, 120),
        });
        sse.emit('error', {
          message:
            'The model returned prose instead of an HTML document. ' +
            'Try a more specific prompt (e.g. "interactive button that ' +
            'toggles a CSS class on click") or pick a different model.',
          kind: 'provider_output_not_html',
        });
        sse.close();
        return;
      }

      await this.repo.appendAssistantTurn(String(saved._id), {
        role: 'assistant',
        content: 'Generated experience',
        html: finalHtml,
      });

      sse.emit( 'done', {
        experienceId: String(saved._id),
        html: finalHtml,
        truncated: truncated || undefined,
        // Observability — the chat footer renders tokens + latency.
        tokens: tokenCount,
        bytes: responseBytes,
        provider: config.provider,
        model: config.model,
        elapsedMs: Date.now() - t0,
      });

      ileLog('info', 'stream.complete', {
        requestId,
        ownerId,
        provider: config.provider,
        model: config.model,
        elapsedMs: Date.now() - t0,
        tokens: tokenCount,
        bytes: responseBytes,
        truncated,
      });
    } catch (err: any) {
      const pe = err instanceof ProviderError ? err : asProviderError(err, 'unknown');
      if (pe instanceof ProviderCancelledError) {
        cancelled = true;
        ileLog('info', 'stream.cancelled', {
          requestId,
          ownerId,
          reason: cancellationReason ?? 'upstream_timeout',
          partialBytes: responseBytes,
          partialTokens: tokenCount,
          elapsedMs: Date.now() - t0,
        });
        sse.emit( 'error', {
          message: 'Generation cancelled.',
          kind: 'cancelled',
          reason: cancellationReason ?? 'client_abort',
        });
        return;
      }
      ileLog('error', 'stream.error', {
        requestId,
        ownerId,
        kind: pe.kind,
        upstreamStatus: pe.upstreamStatus,
        message: pe.message,
        elapsedMs: Date.now() - t0,
      });
      sse.emit( 'error', {
        message: pe.message || 'Generation failed',
        kind: pe.kind,
        upstreamStatus: pe.upstreamStatus,
      });
    } finally {
      req.off('close', onClose);
      sse.close();
    }
    void cancelled; // referenced for completeness in logs above
  }

  /**
   * Stream a generation from external context (YouTube URL in v1).
   *
   * Flow:
   *   1. Run the ContextBuilder — provider extracts ONE ContextSource,
   *      builder wraps it into a GenerationContext (merged content +
   *      optional summary).
   *   2. Re-use the SAME streaming LLM pipeline as `generate`, with
   *      a context-aware system prompt.
   *   3. Persist the lightweight IleContextRef on the experience doc.
   *
   * Generation code here NEVER branches on `source.type` or any
   * YouTube-specific field — it consumes the merged context the
   * builder produced. That's the load-bearing invariant.
   */
  async generateFromContext(
    ownerId: string,
    req: Parameters<IleSseService['attach']>[0],
    res: Response,
    args: {
      courseId: string;
      courseVersionId: string;
      itemId?: string;
      prompt: string;
      source: string;       // ContextSourceType string
      input: string;        // URL / file id / raw text
      hint?: string;
      requestId?: string;
    },
  ): Promise<void> {
    const requestId = args.requestId ?? cryptoRandomId();
    const sse = this.sse.attach(req, res);

    // Cancellation wiring mirrors generate().
    const abort = new AbortController();
    let cancellationReason: CancellationReason | null = null;
    const onClose = () => {
      cancellationReason = 'client_disconnect';
      abort.abort();
    };
    req.once('close', onClose);
    abort.signal.addEventListener('abort', () => {
      req.off('close', onClose);
    });

    const t0 = Date.now();
    let tokenCount = 0;
    let responseBytes = 0;
    let cancelled = false;

    let context: GenerationContext | null = null;
    try {
      // ── Phase 1: build context ────────────────────────────────────
      // The ContextBuilder emits the user-facing phases itself; we just
      // forward them onto the SSE progress channel so the UI ticks.
      const onPhase = (phase: ContextPhase) => {
        sse.emit('progress', { message: phase.label });
      };
      context = await this.contextBuilder.build(
        {
          source: args.source as Parameters<typeof this.contextBuilder.build>[0]['source'],
          primary: args.input,
          hint: args.hint,
          ownerId,
        },
        abort.signal,
        onPhase,
      );

      if (abort.signal.aborted) {
        cancelled = true;
        ileLog('info', 'stream.cancelled', {
          requestId,
          ownerId,
          reason: cancellationReason ?? 'client_abort',
          kind: 'context',
          elapsedMs: Date.now() - t0,
        });
        sse.emit('error', {
          message: 'Generation cancelled.',
          kind: 'cancelled',
          reason: cancellationReason ?? 'client_abort',
        });
        return;
      }

      // ── Phase 2: persist draft + context ref ──────────────────────
      const draft = new IleExperience({
        ownerId,
        courseId: args.courseId,
        courseVersionId: args.courseVersionId,
        itemId: args.itemId,
        title: this.deriveTitle(args.prompt),
        prompt: args.prompt,
        history: [{ role: 'user', content: args.prompt }],
        html: '',
        status: 'draft',
      });
      const saved = await this.repo.insert(draft);

      // Persist the lightweight context ref (NEVER raw transcript).
      // v1 only stores the first source's provenance.
      const primarySource = context.sources[0];
      if (primarySource) {
        await this.repo.setContext(String(saved._id), {
          source: primarySource.type,
          sourceUrl: primarySource.id,
          title: primarySource.title,
          provider: String(primarySource.metadata.winningStrategy ?? primarySource.type),
          transcriptHash:
            typeof primarySource.metadata.transcriptHash === 'string'
              ? primarySource.metadata.transcriptHash
              : '',
          createdAt: primarySource.createdAt,
        });
      }

      // ── Phase 3: stream the LLM response ───────────────────────────
      const { client, config } = await this.makeClientForOwner(ownerId);
      ileLog('info', 'stream.start', {
        requestId,
        ownerId,
        provider: config.provider,
        model: config.model,
        kind: 'generate-from-context',
        source: primarySource?.type ?? args.source,
      });

      sse.emit('start', { experienceId: String(saved._id) });

      let nextStep = 0;
      const fireNextStep = () => {
        if (nextStep < PROGRESS_STEPS.length) {
          sse.emit('progress', { message: PROGRESS_STEPS[nextStep] });
          nextStep++;
        }
      };
      fireNextStep();

      const stream = client.stream({
        system: await this.buildSystemPrompt(ownerId, context),
        messages: [{ role: 'user', content: args.prompt }],
        temperature: 0.4,
        maxTokens: 32768,
        signal: abort.signal,
      });

      let html = '';
      let chunkCount = 0;
      let truncated = false;

      for await (const chunk of stream) {
        if (abort.signal.aborted) break;
        if (chunk.kind === 'text') {
          const cleanDelta = this.sanitizeDeltaForHtml(html, chunk.delta);
          if (cleanDelta) {
            html += cleanDelta;
            chunkCount++;
            tokenCount += approximateTokens(cleanDelta);
            responseBytes += Buffer.byteLength(cleanDelta, 'utf8');
            sse.emit('html', { delta: cleanDelta });
          }
          if (chunkCount === 8) fireNextStep();
          else if (chunkCount === 40) fireNextStep();
          else if (chunkCount === 120) fireNextStep();
        } else if (chunk.kind === 'reasoning') {
          sse.emit('reasoning', {});
        } else if (chunk.kind === '_stream_meta') {
          if (chunk.truncated) truncated = true;
        }
      }

      if (abort.signal.aborted) {
        cancelled = true;
        ileLog('info', 'stream.cancelled', {
          requestId,
          ownerId,
          reason: cancellationReason ?? 'client_abort',
          kind: 'generate-from-context',
          partialBytes: responseBytes,
          elapsedMs: Date.now() - t0,
        });
        sse.emit('error', {
          message: 'Generation cancelled.',
          kind: 'cancelled',
          reason: cancellationReason ?? 'client_abort',
        });
        return;
      }

      fireNextStep();
      const finalHtml = this.normalizeHtml(html);

      // Guard: catch the model-ignored-prompt case where the
      // provider emits prose narration instead of a `<!DOCTYPE
      // html>` document. The MiniMax provider in particular will
      // reply conversationally when the prompt is short. Without
      // this guard the narration text would be persisted as the
      // ILE and the iframe would render plain text. Emit a clear
      // error and bail out so the teacher gets actionable feedback
      // instead of garbage in their workspace.
      if (finalHtml.length > 100 && !this.looksLikeHtmlDoc(finalHtml)) {
        ileLog('warn', 'stream.model_output_not_html', {
          requestId,
          ownerId,
          provider: config.provider,
          model: config.model,
          htmlLength: finalHtml.length,
          first120: finalHtml.slice(0, 120),
        });
        sse.emit('error', {
          message:
            'The model returned prose instead of an HTML document. ' +
            'Try a more specific prompt (e.g. "interactive button that ' +
            'toggles a CSS class on click") or pick a different model.',
          kind: 'provider_output_not_html',
        });
        sse.close();
        return;
      }

      await this.repo.appendHistory(String(saved._id), {
        role: 'assistant',
        content: 'Generated experience from context',
        html: finalHtml,
      });
      await this.repo.update(String(saved._id), { html: finalHtml });

      sse.emit('done', {
        experienceId: String(saved._id),
        html: finalHtml,
        truncated: truncated || undefined,
        tokens: tokenCount,
        bytes: responseBytes,
        provider: config.provider,
        model: config.model,
        elapsedMs: Date.now() - t0,
        // Surface a hint of what was used as context, so the workspace
        // chip can render without a second round-trip.
        contextTitle: primarySource?.title,
      });

      ileLog('info', 'stream.complete', {
        requestId,
        ownerId,
        provider: config.provider,
        model: config.model,
        kind: 'generate-from-context',
        elapsedMs: Date.now() - t0,
        tokens: tokenCount,
        bytes: responseBytes,
        truncated,
        sourceType: primarySource?.type ?? args.source,
      });
    } catch (err: any) {
      // Translate provider errors uniformly — same shape as generate().
      const pe =
        err instanceof ProviderError ? err : asProviderError(err, 'unknown');
      if (pe instanceof ProviderCancelledError) {
        cancelled = true;
        ileLog('info', 'stream.cancelled', {
          requestId,
          ownerId,
          reason: cancellationReason ?? 'upstream_timeout',
          kind: 'generate-from-context',
          partialBytes: responseBytes,
          elapsedMs: Date.now() - t0,
        });
        sse.emit('error', {
          message: 'Generation cancelled.',
          kind: 'cancelled',
          reason: cancellationReason ?? 'client_abort',
        });
      } else if (err instanceof ContextProviderError) {
        // The friendly userMessage on a ContextProviderError is
        // intentionally the only string the UI is allowed to display.
        ileLog('warn', 'context.provider_error.surface', {
          requestId,
          ownerId,
          kind: err.kind,
        });
        sse.emit('error', {
          message: err.userMessage,
          kind: err.kind,
        });
      } else {
        ileLog('error', 'stream.error', {
          requestId,
          ownerId,
          kind: pe.kind,
          upstreamStatus: pe.upstreamStatus,
          message: pe.message,
          elapsedMs: Date.now() - t0,
        });
        sse.emit('error', {
          message: pe.message || 'Generation failed',
          kind: pe.kind,
          upstreamStatus: pe.upstreamStatus,
        });
      }
    } finally {
      req.off('close', onClose);
      sse.close();
    }
    void cancelled; // referenced for completeness in logs above
    void context;
  }

  /**
   * Stream a conversational edit of an existing experience.
   * The assistant is given the full current HTML plus the new instruction
   * and asked to rewrite the entire document.
   */
  async edit(
    ownerId: string,
    req: Parameters<IleSseService['attach']>[0],
    res: Response,
    args: { experienceId: string; prompt: string; requestId?: string },
  ): Promise<void> {
    const requestId = args.requestId ?? cryptoRandomId();
    const sse = this.sse.attach(req, res);

    // See the cancellation note on `generate` above.
    const abort = new AbortController();
    let cancellationReason: CancellationReason | null = null;
    const onClose = () => {
      cancellationReason = 'client_disconnect';
      abort.abort();
    };
    req.once('close', onClose);

    const t0 = Date.now();
    let tokenCount = 0;
    let responseBytes = 0;

    try {
      const existing = await this.repo.findById(args.experienceId);
      if (!existing) {
        sse.emit( 'error', { message: 'Experience not found' });
        return;
      }
      if (existing.ownerId !== ownerId) {
        sse.emit( 'error', { message: 'Not your experience' });
        return;
      }

      // Append the user's edit instruction BEFORE the next assistant turn.
      // Cap the prompt at 16KB so a runaway input (paste of a 5MB log,
      // adversarial upload, etc.) can't balloon the LLM request or
      // get past the upstream timeout budget.
      const safePrompt = args.prompt.length > 16_000
        ? args.prompt.slice(0, 16_000) +
          '\n\n[teacher input truncated at 16KB]'
        : args.prompt;
      await this.repo.appendHistory(args.experienceId, {
        role: 'user',
        content: safePrompt,
      });

      sse.emit( 'start', { experienceId: args.experienceId });

      const { client, config } = await this.makeClientForOwner(ownerId);
      ileLog('info', 'stream.start', {
        requestId,
        ownerId,
        provider: config.provider,
        model: config.model,
        kind: 'edit',
        experienceId: args.experienceId,
      });
      const editUserContent = `Current HTML:\n\`\`\`html\n${existing.html}\n\`\`\`\n\nEdit instruction: ${safePrompt}\n\nReturn the full rewritten HTML document.`;
      const stream = client.stream({
        system: await this.buildSystemPrompt(ownerId),
        messages: [{ role: 'user', content: editUserContent }],
        temperature: 0.4,
        maxTokens: 32768,
        signal: abort.signal,
      });

      let html = '';
      let chunkCount = 0;
      let truncated = false;
      for await (const chunk of stream) {
        if (abort.signal.aborted) break;
        if (chunk.kind === 'text') {
          const cleanDelta = this.sanitizeDeltaForHtml(html, chunk.delta);
          if (cleanDelta) {
            html += cleanDelta;
            chunkCount++;
            tokenCount += approximateTokens(cleanDelta);
            responseBytes += Buffer.byteLength(cleanDelta, 'utf8');
            sse.emit( 'html', { delta: cleanDelta });
          }
          if (chunkCount === 1) {
            sse.emit( 'progress', { message: '✓ Reading the current version' });
          } else if (chunkCount === 12) {
            sse.emit( 'progress', { message: '✓ Applying the change' });
          } else if (chunkCount === 60) {
            sse.emit( 'progress', { message: '✓ Polishing the result' });
          } else if (chunkCount === 140) {
            sse.emit( 'progress', { message: '✓ Finalizing' });
          }
        } else if (chunk.kind === '_stream_meta') {
          if (chunk.truncated) truncated = true;
        }
      }

      if (abort.signal.aborted) {
        ileLog('info', 'stream.cancelled', {
          requestId,
          ownerId,
          reason: cancellationReason ?? 'client_abort',
          kind: 'edit',
          experienceId: args.experienceId,
          partialBytes: responseBytes,
          partialTokens: tokenCount,
          elapsedMs: Date.now() - t0,
        });
        sse.emit( 'error', {
          message: 'Edit cancelled.',
          kind: 'cancelled',
          reason: cancellationReason ?? 'client_abort',
        });
        return;
      }

      const finalHtml = this.normalizeHtml(html);

      // Guard: catch the model-ignored-prompt case where the
      // provider emits prose narration instead of a `<!DOCTYPE
      // html>` document. The MiniMax provider in particular will
      // reply conversationally when the prompt is short. Without
      // this guard the narration text would be persisted as the
      // ILE and the iframe would render plain text. Emit a clear
      // error and bail out so the teacher gets actionable feedback
      // instead of garbage in their workspace.
      if (finalHtml.length > 100 && !this.looksLikeHtmlDoc(finalHtml)) {
        ileLog('warn', 'stream.model_output_not_html', {
          requestId,
          ownerId,
          provider: config.provider,
          model: config.model,
          htmlLength: finalHtml.length,
          first120: finalHtml.slice(0, 120),
        });
        sse.emit('error', {
          message:
            'The model returned prose instead of an HTML document. ' +
            'Try a more specific prompt (e.g. "interactive button that ' +
            'toggles a CSS class on click") or pick a different model.',
          kind: 'provider_output_not_html',
        });
        sse.close();
        return;
      }
      await this.repo.appendAssistantTurn(args.experienceId, {
        role: 'assistant',
        content: 'Applied edit',
        html: finalHtml,
      });

      sse.emit( 'done', {
        experienceId: args.experienceId,
        html: finalHtml,
        truncated: truncated || undefined,
        tokens: tokenCount,
        bytes: responseBytes,
        provider: config.provider,
        model: config.model,
        elapsedMs: Date.now() - t0,
      });
      // End the response so routing-controllers' ExpressDriver
      // doesn't try to send a final JSON body when the controller
      // method returns — sending after the SSE body has been
      // streamed triggers `Cannot set headers after they are
      // sent to the client` and Sentry noise. The frontend's
      // fetch-based SSE parser treats the connection close as a
      // clean end-of-stream.
      sse.close();

      ileLog('info', 'stream.complete', {
        requestId,
        ownerId,
        provider: config.provider,
        model: config.model,
        kind: 'edit',
        experienceId: args.experienceId,
        elapsedMs: Date.now() - t0,
        tokens: tokenCount,
        bytes: responseBytes,
        truncated,
      });
    } catch (err: any) {
      const pe = err instanceof ProviderError ? err : asProviderError(err, 'unknown');
      if (pe instanceof ProviderCancelledError) {
        ileLog('info', 'stream.cancelled', {
          requestId,
          ownerId,
          reason: cancellationReason ?? 'client_abort',
          kind: 'edit',
          experienceId: args.experienceId,
          elapsedMs: Date.now() - t0,
        });
        sse.emit( 'error', {
          message: 'Edit cancelled.',
          kind: 'cancelled',
          reason: cancellationReason ?? 'client_abort',
        });
        return;
      }
      ileLog('error', 'stream.error', {
        requestId,
        ownerId,
        kind: pe.kind,
        upstreamStatus: pe.upstreamStatus,
        message: pe.message,
        elapsedMs: Date.now() - t0,
        kindOperation: 'edit',
        experienceId: args.experienceId,
      });
      sse.emit( 'error', {
        message: pe.message || 'Edit failed',
        kind: pe.kind,
        upstreamStatus: pe.upstreamStatus,
      });
    } finally {
      req.off('close', onClose);
      sse.close();
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // Helpers

  /**
   * Build the system prompt for a generation/edit. Augments the base
   * SYSTEM_PROMPT with a "Available assets" block listing the teacher's
   * recent uploads and their signed URLs. The model can then reference
   * those URLs directly in the generated HTML.
   *
   * When `ctx` is provided, a "Available context" block is appended
   * with the merged content and (optional) summary. Generation code
   * NEVER branches on the source type — it just renders the merged
   * content the builder produced.
   *
   * Errors fetching the asset list are swallowed — a missing asset
   * list shouldn't fail generation, just produce HTML without references.
   */
  private async buildSystemPrompt(
    ownerId: string,
    ctx?: GenerationContext,
  ): Promise<string> {
    let prompt = SYSTEM_PROMPT;
    try {
      const assetFragment = await this.assets.buildAssetContextFragment(ownerId);
      if (assetFragment) {
        prompt = `${prompt}\n\n${assetFragment}`;
      }
    } catch (err) {
      ileLog('warn', 'asset.context.failed', { ownerId, error: (err as Error).message });
    }
    if (ctx && (ctx.mergedContent || ctx.summary)) {
      const summaryBlock = ctx.summary
        ? `\nSummary:\n${ctx.summary.shortSummary}\n\nKey concepts:\n${ctx.summary.keyConcepts.map((c) => `- ${c}`).join('\n')}`
        : '';
      const contextBlock = `Available context:\n${ctx.mergedContent}${summaryBlock}\n\nUse this material to ground the interactive experience. The teacher's follow-up instructions take priority — context is reference material, not a script.`;
      prompt = `${prompt}\n\n${contextBlock}`;
    }
    return prompt;
  }

  /**
   * Sanity check: does the streamed output actually look like HTML?
   * The MiniMax (and other OpenAI-compatible) providers sometimes
   * ignore the "emit `<!DOCTYPE html>...</html>`" instruction in
   * the system prompt and emit conversational prose instead —
   * especially when the user's prompt is short or ambiguous. We
   * catch this at `done` time so the teacher doesn't get narration
   * text saved as their ILE.
   *
   * Heuristic: a real HTML doc has at least one of `<!doctype`,
   * `<html`, `<body`, or `</html>`. If none of these are present
   * AND the content has more than 100 characters of plain text,
   * it's almost certainly prose, not HTML.
   *
   * The threshold is intentionally low — anything below 100 chars
   * is probably an incomplete stream (the model got cut off
   * mid-`<html>`). Above 100 chars with no HTML markers at all is
   * a model-output failure.
   */
  private looksLikeHtmlDoc(html: string): boolean {
    if (!html) return false;
    if (/<!doctype/i.test(html)) return true;
    if (/<html[\s>]/i.test(html)) return true;
    if (/<body[\s>]/i.test(html)) return true;
    if (/<\/html>/i.test(html)) return true;
    return false;
  }



  /**
   * Resolve the saved ILE config for the owner and construct a provider
   * client. Throws a typed ProviderUnknownError when the owner hasn't
   * configured ILE — the SSE layer emits an `error` event whose message
   * tells the teacher exactly what to do (open the AI Configuration panel).
   *
   * We use ProviderUnknownError (not a new `not_configured` kind) because:
   *   - the upstream taxonomy is provider-only, not config-state
   *   - the actionable signal is the MESSAGE, not a new taxonomy bucket
   *   - the kind field still distinguishes upstream failures from "you
   *     forgot to set up ILE"
   * The teacher's `AI Configuration panel` UI surfaces a button regardless
   * of kind; the toast copy comes from the message.
   */
  private async makeClientForOwner(ownerId: string): Promise<{
    client: ChatStream;
    config: IleAiConfig;
  }> {
    const config = await this.aiConfig.loadConfigForOwner(ownerId);
    if (!config || !config.apiKey) {
      throw new ProviderUnknownError(
        'No ILE AI configuration found. Open the AI Configuration panel and save your provider + API key.',
      );
    }
    if (!config.model) {
      throw new ProviderUnknownError(
        'ILE AI configuration is missing a model. Open the AI Configuration panel and set one.',
      );
    }
    const client = createProvider(config);
    return { client, config };
  }

  /**
   * Pull a short title out of the prompt — falls back to "Untitled".
   * Pure heuristic so we don't make a second LLM call just for a title.
   */
  private deriveTitle(prompt: string): string {
    const trimmed = prompt.trim();
    if (!trimmed) return 'Untitled Experience';
    const firstSentence = trimmed.split(/[.!?\n]/)[0] ?? trimmed;
    const capped = firstSentence.length > 60
      ? firstSentence.slice(0, 57) + '...'
      : firstSentence;
    return capped || 'Untitled Experience';
  }

  /**
   * Strip the markdown-fence prefix from a streaming delta. The model
   * is told "no markdown fences" in the system prompt but still emits
   * them ~30% of the time (especially when the response starts with
   * `\`\`\`html\n`). If we forward the raw delta to the SSE channel,
   * the frontend's CodeMirror lang-html parser chokes on the
   * `\`\`\`` text (MixedParse.startInner → _TreeNode.nextChild
   * reading .length on undefined), the CodeEditorErrorBoundary fires,
   * and the editor falls back to a plain <textarea> for the rest of
   * the session.
   *
   * This helper is idempotent: it strips the fence prefix once
   * (when the cumulative HTML so far starts with `\`\`\`html\n` or
   * bare `\`\`\`\n`) and the fence suffix once (when the cumulative
   * ends with `\`\`\`\n`). Everything else passes through. The
   * result: the very first delta that carries the opening fence
   * emits an empty string (the consumer advances `html.length` but
   * the visible preview stays empty until the actual `<!DOCTYPE>`
   * arrives), and the very last delta that carries the closing
   * fence emits an empty string. The interim deltas pass through
   * verbatim.
   */
  private sanitizeDeltaForHtml(cumulative: string, delta: string): string {
    if (!delta) return delta;
    let trimmed = delta;
    // Strip `think` reasoning blocks. Providers like MiniMax
    // emit reasoning inline in delta.content rather than via a
    // separate SSE event; the `<` `>` chars inside crash the
    // CodeMirror @lezer/html parser. Strip them before the
    // editor ever sees them. Looped so consecutive blocks all
    // come out, with a length cap as a safety net against a
    // runaway model.
    // Strip `think` reasoning blocks. The MiniMax (and similar)
    // providers emit the model's chain-of-thought inline in
    // `delta.content` rather than via a separate SSE event. Two
    // variants we have to handle:
    //   (a) Full `<think>...</think>` block (Anthropic-style)
    //   (b) Unclosed `<think>...EOF` (model cut off mid-think)
    //   (c) Loose `...think>` closing tag with no opener — the
    //       MiniMax provider emits narration prose that ends in
    //       a stray `think>` closing marker, NOT wrapped in
    //       `<think>...</think>`. We handle (c) by anchoring on
    //       `<!doctype` and discarding everything before it.
    // Looped until no more matches; length cap as a safety net.
    let previous: string;
    // ponytail: model emissions vary. Cover (a) plain ``...`` blocks
    // and (b) the Anthropic-specific `<redacted_thinking>...</redacted_thinking>`
    // blocks that the SDK emits when extended-thinking hits a sensitive
    // context. Both shapes use the same stripping strategy: anything
    // inside a tagged block is reasoning, not HTML.
    do {
      previous = trimmed;
      trimmed = trimmed.replace(
        /<think>[\s\S]*?(?:<\/think>|$)|<redacted_thinking>[\s\S]*?(?:<\/redacted_thinking>|$)/gi,
        '',
      );
    } while (trimmed !== previous && trimmed.length < 200000);
    // Anchor strip: if `trimmed` has a `<!doctype` somewhere,
    // anything before it is the model's chain-of-thought and
    // should be discarded (handles the (c) case above). The
    // rstrip removes trailing whitespace so the doc starts
    // cleanly on the HTML opener.
    const dt = /<!doctype/i.exec(trimmed);
    if (dt && dt.index > 0) {
      trimmed = trimmed.slice(dt.index);
    }
    // Strip leading fence on the first delta (cumulative is still empty
    // or contains only whitespace when this kicks in).
    // ponytail: the language tag after ``` is model-dependent — html, HTML,
    // htm, html5, xml, text. Match any tag (or no tag) so the strip doesn't
    // miss variants the model chose for itself.
    const FENCE_PREFIX = /^\s*```(?:\w+)?\s*\n?/i;
    const leadingFence = cumulative.match(FENCE_PREFIX);
    if (leadingFence && trimmed.startsWith(leadingFence[0])) {
      trimmed = trimmed.slice(leadingFence[0].length);
    } else if (FENCE_PREFIX.test(cumulative + trimmed)) {
      // The fence prefix is split across the boundary between
      // cumulative and this delta. Drop just the fence prefix from
      // this delta; the cumulative already had the backticks.
      const m = (cumulative + trimmed).match(FENCE_PREFIX);
      if (m) {
        const fenceLen = m[0].length - cumulative.length;
        if (fenceLen > 0 && trimmed.length >= fenceLen) {
          trimmed = trimmed.slice(fenceLen);
        }
      }
    }
    // Strip trailing fence on the last delta. We approximate "last
    // delta" by checking if the cumulative + trimmed ends with the
    // fence pattern. This isn't strictly the last delta (we may see
    // a partial ```, then more HTML, then ``` again) but the helper
    // is idempotent — calling it twice on the same string produces
    // the same result.
    const combined = cumulative + trimmed;
    const trailingFence = combined.match(/\n?```\s*$/);
    if (trailingFence) {
      const tailStart = combined.length - trailingFence[0].length;
      if (tailStart >= cumulative.length) {
        trimmed = trimmed.slice(0, trimmed.length - (combined.length - tailStart));
      } else {
        // Trailing fence is split across the boundary — drop the
        // portion that falls in this delta.
        trimmed = trimmed.slice(0, trimmed.length - (combined.length - tailStart));
      }
    }
    return trimmed;
  }

  /**
   * Strip accidental markdown fences AND leading `<think>...</think>`
   * reasoning blocks if the model emits them. Otherwise leave the HTML
   * untouched — the model is told to emit a full <!DOCTYPE html> document.
   */
  private normalizeHtml(raw: string): string {
    let html = raw.trim();
    // Strip ```...``` fences (defensive) — any language tag.
    const fence = html.match(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/i);
    if (fence) html = fence[1];
    // Strip leading `` / `<redacted_thinking>...</redacted_thinking>`
    // blocks (defensive — the custom provider emits them inline in
    // delta.content instead of a separate reasoning channel).
    html = html
      .replace(
        /^<think>[\s\S]*?(?:<\/think>|$)|^<redacted_thinking>[\s\S]*?(?:<\/redacted_thinking>|$)/i,
        '',
      )
      .trim();
    // Strip anything past the last </html> — the model sometimes emits
    // trailing reasoning or a stray ``` after the document ends.
    const lastHtmlClose = html.toLowerCase().lastIndexOf('</html>');
    if (lastHtmlClose !== -1) {
      html = html.slice(0, lastHtmlClose + '</html>'.length);
    }
    return html.trim();
  }
}

/**
 * Cheap token approximation for observability — 4 chars ≈ 1 token. The
 * actual provider returns a `usage` block on non-streaming calls, but
 * we don't have that for streaming. This is good enough to bucket
 * streams in the log pipeline.
 */
function approximateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Generate a short, sortable correlation id for log lines. */
function cryptoRandomId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}