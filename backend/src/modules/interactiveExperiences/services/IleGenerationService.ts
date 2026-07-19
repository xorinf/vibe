import { injectable, inject } from 'inversify';
import { Response } from 'express';
import { ILE_TYPES } from '../types.js';
import { IleSseService } from './IleSseService.js';
import { IleRepository } from '../repositories/IleRepository.js';
import { IleAiConfigService } from './IleAiConfigService.js';
import { IleAssetService } from './IleAssetService.js';
import { IleExperience } from '../classes/transformers/IleExperience.js';
import { ChatStream, IleAiConfig } from './providers/types.js';
import { createProvider } from './providers/index.js';

const SYSTEM_PROMPT = `You are ViBe's Interactive Learning Experience designer.
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

@injectable()
export class IleGenerationService {
  constructor(
    @inject(ILE_TYPES.IleSseService) private readonly sse: IleSseService,
    @inject(ILE_TYPES.IleRepository) private readonly repo: IleRepository,
    @inject(ILE_TYPES.IleAiConfigService)
    private readonly aiConfig: IleAiConfigService,
    @inject(ILE_TYPES.IleAssetService)
    private readonly assets: IleAssetService,
  ) {}

  /**
   * Stream a fresh generation. Saves a new draft experience document
   * and emits SSE events as the LLM produces HTML.
   *
   * @param ownerId  Firebase uid of the teacher.
   * @param req      Express request (used for SSE heartbeat / cleanup).
   * @param res      Express response, configured by sse.init().
   */
  async generate(
    ownerId: string,
    req: Parameters<IleSseService['init']>[0],
    res: Response,
    args: {
      courseId: string;
      courseVersionId: string;
      itemId?: string;
      prompt: string;
    },
  ): Promise<void> {
    this.sse.init(req, res);

    try {
      const { client } = await this.makeClientForOwner(ownerId);

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
      this.sse.emit(res, 'start', {
        experienceId: String(saved._id),
      });

      // 3. Progress: stamp each step before the corresponding phase.
      //    Step 0 fires immediately; later steps fire on chunk-count triggers.
      let nextStep = 0;
      const fireNextStep = () => {
        if (nextStep < PROGRESS_STEPS.length) {
          this.sse.emit(res, 'progress', { message: PROGRESS_STEPS[nextStep] });
          nextStep++;
        }
      };
      fireNextStep();

      // 4. Stream the response via the configured provider.
      const stream = client.stream({
        system: await this.buildSystemPrompt(ownerId),
        messages: [{ role: 'user', content: args.prompt }],
        temperature: 0.4,
        maxTokens: 8192,
      });

      let html = '';
      let chunkCount = 0;
      let lastReasoningFlush = '';
      // Provider emits exactly one `_stream_meta` chunk at the very end
      // of the stream. Default to false (no truncation) so that
      // older providers that don't emit the sentinel still behave.
      let truncated = false;

      for await (const chunk of stream) {
        if (chunk.kind === 'text') {
          html += chunk.delta;
          chunkCount++;
          this.sse.emit(res, 'html', { delta: chunk.delta });

          // Fire progress steps as we accumulate HTML.
          if (chunkCount === 8) fireNextStep();
          else if (chunkCount === 40) fireNextStep();
          else if (chunkCount === 120) fireNextStep();
        } else if (chunk.kind === 'reasoning') {
          // Emit a discrete reasoning signal so the UI can render
          // a "Thinking…" pill. The dedup logic in the hook will keep
          // it sticky until the first text delta arrives.
          this.sse.emit(res, 'reasoning', {});
          lastReasoningFlush += chunk.delta;
          if (lastReasoningFlush.length > 200) {
            // After enough reasoning has flowed, bump the progress UI
            // so the user sees forward motion even before text arrives.
            this.sse.emit(res, 'progress', {
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

      // 5. Final cleanup: ensure last step fires, persist the assistant turn.
      fireNextStep();

      const finalHtml = this.normalizeHtml(html);

      // Single history append — the earlier code path double-appended
      // once via `IleHistoryTurn` and once inline via `repo.appendHistory`.
      await this.repo.appendHistory(String(saved._id), {
        role: 'assistant',
        content: 'Generated experience',
        html: finalHtml,
      });
      await this.repo.update(String(saved._id), { html: finalHtml });

      this.sse.emit(res, 'done', {
        experienceId: String(saved._id),
        html: finalHtml,
        truncated: truncated || undefined,
      });
    } catch (err: any) {
      console.error('[ILE] generation failed:', err);
      this.sse.emit(res, 'error', {
        message: err?.message ?? 'Generation failed',
      });
    } finally {
      this.sse.cleanup(res);
    }
  }

  /**
   * Stream a conversational edit of an existing experience.
   * The assistant is given the full current HTML plus the new instruction
   * and asked to rewrite the entire document.
   */
  async edit(
    ownerId: string,
    req: Parameters<IleSseService['init']>[0],
    res: Response,
    args: { experienceId: string; prompt: string },
  ): Promise<void> {
    this.sse.init(req, res);

    try {
      const existing = await this.repo.findById(args.experienceId);
      if (!existing) {
        this.sse.emit(res, 'error', { message: 'Experience not found' });
        return;
      }
      if (existing.ownerId !== ownerId) {
        this.sse.emit(res, 'error', { message: 'Not your experience' });
        return;
      }

      // Append the user's edit instruction BEFORE the next assistant turn.
      await this.repo.appendHistory(args.experienceId, {
        role: 'user',
        content: args.prompt,
      });

      this.sse.emit(res, 'start', { experienceId: args.experienceId });

      const { client } = await this.makeClientForOwner(ownerId);
      const editUserContent = `Current HTML:\n\`\`\`html\n${existing.html}\n\`\`\`\n\nEdit instruction: ${args.prompt}\n\nReturn the full rewritten HTML document.`;
      const stream = client.stream({
        system: await this.buildSystemPrompt(ownerId),
        messages: [{ role: 'user', content: editUserContent }],
        temperature: 0.4,
        maxTokens: 8192,
      });

      let html = '';
      let chunkCount = 0;
      let truncated = false;
      for await (const chunk of stream) {
        if (chunk.kind === 'text') {
          html += chunk.delta;
          chunkCount++;
          this.sse.emit(res, 'html', { delta: chunk.delta });
          if (chunkCount === 1) {
            this.sse.emit(res, 'progress', { message: '✓ Reading the current version' });
          } else if (chunkCount === 12) {
            this.sse.emit(res, 'progress', { message: '✓ Applying the change' });
          } else if (chunkCount === 60) {
            this.sse.emit(res, 'progress', { message: '✓ Polishing the result' });
          } else if (chunkCount === 140) {
            this.sse.emit(res, 'progress', { message: '✓ Finalizing' });
          }
        } else if (chunk.kind === '_stream_meta') {
          if (chunk.truncated) truncated = true;
        }
      }

      const finalHtml = this.normalizeHtml(html);
      await this.repo.update(args.experienceId, { html: finalHtml });
      await this.repo.appendHistory(args.experienceId, {
        role: 'assistant',
        content: 'Applied edit',
        html: finalHtml,
      });

      this.sse.emit(res, 'done', {
        experienceId: args.experienceId,
        html: finalHtml,
        truncated: truncated || undefined,
      });
    } catch (err: any) {
      console.error('[ILE] edit failed:', err);
      this.sse.emit(res, 'error', {
        message: err?.message ?? 'Edit failed',
      });
    } finally {
      this.sse.cleanup(res);
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
   * Errors fetching the asset list are swallowed — a missing asset
   * list shouldn't fail generation, just produce HTML without references.
   */
  private async buildSystemPrompt(ownerId: string): Promise<string> {
    let prompt = SYSTEM_PROMPT;
    try {
      const assetFragment = await this.assets.buildAssetContextFragment(ownerId);
      if (assetFragment) {
        prompt = `${prompt}\n\n${assetFragment}`;
      }
    } catch (err) {
      console.warn('[ILE] failed to load asset context', err);
    }
    return prompt;
  }

  /**
   * Resolve the saved ILE config for the owner and construct a provider
   * client. Throws a clean error if the owner hasn't configured ILE yet —
   * the SSE layer surfaces this back to the chat pane.
   */
  private async makeClientForOwner(ownerId: string): Promise<{
    client: ChatStream;
    config: IleAiConfig;
  }> {
    const config = await this.aiConfig.loadConfigForOwner(ownerId);
    if (!config || !config.apiKey) {
      throw new Error(
        'No ILE AI configuration found. Open the AI Configuration panel and save your provider + API key.',
      );
    }
    if (!config.model) {
      throw new Error(
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
   * Strip accidental markdown fences if the model emits them anyway.
   * Otherwise leave the HTML untouched — the model is told to emit a full
   * <!DOCTYPE html> document.
   */
  private normalizeHtml(raw: string): string {
    let html = raw.trim();
    // Strip ```html ... ``` fences (defensive)
    const fence = html.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
    if (fence) html = fence[1];
    return html.trim();
  }
}