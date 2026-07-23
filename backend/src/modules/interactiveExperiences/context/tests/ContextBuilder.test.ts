import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContextBuilder } from '../ContextBuilder.js';
import { ContextProviderRegistry } from '../ContextProviderRegistry.js';
import {
  ContextInput,
  ContextPhase,
  ContextProvider,
  ContextProviderError,
  ContextSource,
  GenerationContext,
} from '../types.js';

/**
 * Pure unit tests for the ContextBuilder. No I/O, no Mongo, no LLM.
 *
 * The builder's only job is:
 *   1. locate provider
 *   2. invoke provider
 *   3. cap content
 *   4. optionally summarize
 *   5. compose a GenerationContext
 *
 * Anything else (provider-specific behaviour, branching on source
 * type, persistence) is out of scope here.
 */

const noopPhase = (_phase: ContextPhase): void => {
  // unused in these tests
};

function makeStubSource(opts: Partial<ContextSource> & { id: string }): ContextSource {
  return {
    id: opts.id,
    type: opts.type ?? 'manual',
    title: opts.title ?? `Stub ${opts.id}`,
    content: opts.content ?? `Content for ${opts.id}`,
    metadata: opts.metadata ?? {},
    provenance: opts.provenance ?? [],
    createdAt: opts.createdAt ?? new Date('2026-01-01T00:00:00Z'),
  };
}

function makeStubProvider(
  source: ContextSource,
  options: { matches?: (input: ContextInput) => boolean; throws?: ContextProviderError } = {},
): ContextProvider {
  return {
    canHandle: options.matches ?? (() => true),
    extract: options.throws
      ? async () => {
          throw options.throws;
        }
      : async () => source,
  };
}

describe('ContextBuilder', () => {
  let registry: ContextProviderRegistry;
  let mockCleaner: { summarize: ReturnType<typeof vi.fn> };
  let builder: ContextBuilder;

  beforeEach(() => {
    registry = new ContextProviderRegistry();
    mockCleaner = {
      summarize: vi.fn().mockImplementation(
        async () => ({
          shortSummary: 'mock summary',
          keyConcepts: ['mock'],
        }),
      ),
    };
    builder = new ContextBuilder(
      registry,
      mockCleaner as unknown as ConstructorParameters<typeof ContextBuilder>[1],
    );
  });

  it('throws ContextProviderError("unsupported") when no provider matches', async () => {
    await expect(
      builder.build(
        { primary: 'whatever', source: 'youtube' },
        new AbortController().signal,
        noopPhase,
      ),
    ).rejects.toMatchObject({
      kind: 'unsupported',
      userMessage: expect.stringMatching(/don't know how to use that input/i),
    });
  });

  it('wraps a single source into GenerationContext with sources[0]', async () => {
    const source = makeStubSource({
      id: 'stub-1',
      content: 'Hello world.',
    });
    registry.register(makeStubProvider(source));

    const result = await builder.build(
      { primary: 'whatever', source: 'manual' },
      new AbortController().signal,
      noopPhase,
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toEqual(source);
    expect(result.mergedContent).toBe('Hello world.');
  });

  it('passes through the provider error verbatim', async () => {
    const err = new ContextProviderError(
      'boom',
      'User-friendly boom.',
      'transient',
    );
    registry.register(
      makeStubProvider(makeStubSource({ id: 'x' }), { throws: err }),
    );

    await expect(
      builder.build(
        { primary: 'whatever', source: 'manual' },
        new AbortController().signal,
        noopPhase,
      ),
    ).rejects.toBe(err);
  });

  it('wraps a raw provider error as ContextProviderError("unknown")', async () => {
    registry.register({
      canHandle: () => true,
      extract: async () => {
        throw new Error('unwrapped library error');
      },
    });

    await expect(
      builder.build(
        { primary: 'x', source: 'manual' },
        new AbortController().signal,
        noopPhase,
      ),
    ).rejects.toMatchObject({
      kind: 'unknown',
      userMessage: expect.stringMatching(/unable to extract/i),
    });
  });

  it('caps per-source content over PER_SOURCE_CONTENT_CAP_CHARS', async () => {
    const long = 'word '.repeat(20_000); // ~100k chars
    const source = makeStubSource({ id: 'long', content: long });
    registry.register(makeStubProvider(source));

    const result = await builder.build(
      { primary: 'x', source: 'manual' },
      new AbortController().signal,
      noopPhase,
    );
    // 50_000 cap + the trailing marker.
    expect(result.sources[0].content.length).toBeLessThanOrEqual(50_000 + 30);
    expect(result.sources[0].content).toContain('…[context trimmed]…');
  });

  it('caps merged content at MERGED_CONTENT_CAP_CHARS', async () => {
    const long = 'a'.repeat(20_000);
    const source = makeStubSource({ id: 'merged', content: long });
    registry.register(makeStubProvider(source));

    const result = await builder.build(
      { primary: 'x', source: 'manual' },
      new AbortController().signal,
      noopPhase,
    );
    // Source content itself is capped at 50k; mergedContent is
    // therefore the same value (capped twice, idempotent).
    expect(result.mergedContent.length).toBeLessThanOrEqual(50_000 + 30);
  });

  it('does NOT summarize short content (cheap path)', async () => {
    const source = makeStubSource({
      id: 'short',
      content: 'Short body.', // < SUMMARIZE_THRESHOLD_CHARS (1500)
    });
    registry.register(makeStubProvider(source));

    const result = await builder.build(
      { primary: 'x', source: 'manual' },
      new AbortController().signal,
      noopPhase,
    );
    expect(result.summary).toBeUndefined();
    expect(mockCleaner.summarize).not.toHaveBeenCalled();
  });

  it('DOES summarize long content when an ownerId is provided', async () => {
    const source = makeStubSource({
      id: 'long',
      content: 'word '.repeat(2_000), // ~10k chars, well over threshold
    });
    registry.register(makeStubProvider(source));

    const result = await builder.build(
      { primary: 'x', source: 'manual', ownerId: 'owner-123' },
      new AbortController().signal,
      noopPhase,
    );
    expect(result.summary).toBeDefined();
    expect(result.summary!.shortSummary).toBe('mock summary');
    expect(mockCleaner.summarize).toHaveBeenCalledTimes(1);
    expect(mockCleaner.summarize).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ ownerId: 'owner-123' }),
    );
  });

  it('continues without a summary when the summarizer throws (non-cancellation)', async () => {
    mockCleaner.summarize = vi.fn().mockRejectedValue(new Error('boom'));
    const source = makeStubSource({
      id: 'long',
      content: 'word '.repeat(2_000),
    });
    registry.register(makeStubProvider(source));

    const result = await builder.build(
      { primary: 'x', source: 'manual', ownerId: 'owner-123' },
      new AbortController().signal,
      noopPhase,
    );
    expect(result.summary).toBeUndefined();
    // mergedContent is still populated.
    expect(result.mergedContent.length).toBeGreaterThan(0);
  });

  it('translates cancellation during summarization to ContextProviderError("cancelled")', async () => {
    const controller = new AbortController();
    mockCleaner.summarize = vi.fn(async (_text, signal: AbortSignal) => {
      signal.aborted; // pass-through; we throw the right thing below
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const source = makeStubSource({
      id: 'long',
      content: 'word '.repeat(2_000),
    });
    registry.register(makeStubProvider(source));
    // Pre-abort so the check fires.
    controller.abort();

    await expect(
      builder.build(
        { primary: 'x', source: 'manual', ownerId: 'owner-123' },
        controller.signal,
        noopPhase,
      ),
    ).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('invokes the provider with the exact input passed to build()', async () => {
    const source = makeStubSource({ id: 'echo', content: 'echo' });
    const provider = {
      canHandle: vi.fn(() => true),
      extract: vi.fn(async () => source),
    };
    registry.register(provider);

    const input: ContextInput = {
      primary: 'the primary',
      hint: 'focus on chapter 3',
      source: 'manual',
      ownerId: 'owner-1',
    };
    await builder.build(input, new AbortController().signal, noopPhase);

    expect(provider.canHandle).toHaveBeenCalledWith(input);
    expect(provider.extract).toHaveBeenCalledWith(
      input,
      expect.anything(),
      expect.any(Function),
    );
  });
});
