import { describe, it, expect } from 'vitest';
import { MarkdownContextProvider } from '../providers/MarkdownContextProvider.js';
import { ContextProviderError } from '../types.js';

const validInput = (body = '# Hello\n\nSome content.') => ({
  source: 'markdown' as const,
  primary: body,
  hint: undefined,
});

describe('MarkdownContextProvider', () => {
  const provider = new MarkdownContextProvider();

  it('claims input.source === "markdown"', () => {
    expect(provider.canHandle({ source: 'markdown', primary: 'x' })).toBe(true);
  });

  it('does not claim other source types', () => {
    expect(provider.canHandle({ source: 'youtube', primary: 'x' })).toBe(false);
    expect(provider.canHandle({ source: 'pdf', primary: 'x' })).toBe(false);
    expect(provider.canHandle({ source: 'manual', primary: 'x' })).toBe(false);
  });

  it('returns a markdown ContextSource with deterministic id from content hash', async () => {
    const phases: unknown[] = [];
    const result = await provider.extract(
      validInput('# Title\n\nBody'),
      new AbortController().signal,
      (p) => phases.push(p),
    );
    expect(result.type).toBe('markdown');
    expect(result.title).toBe('Title');
    expect(result.content).toContain('Body');
    expect(result.id).toMatch(/^md-[0-9a-f]{24}$/);
    // At least one phase was reported.
    expect(phases.length).toBeGreaterThan(0);
  });

  it('throws invalid_input when body is empty', async () => {
    await expect(
      provider.extract(
        validInput(''),
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toMatchObject({
      name: 'ContextProviderError',
      kind: 'invalid_input',
      userMessage: expect.stringContaining('Paste the markdown'),
    });
  });

  it('throws invalid_input when body is whitespace-only', async () => {
    await expect(
      provider.extract(
        validInput('   \n\n\t  '),
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toBeInstanceOf(ContextProviderError);
  });

  it('throws cancelled when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      provider.extract(validInput('content'), ac.signal, () => {}),
    ).rejects.toMatchObject({
      kind: 'cancelled',
    });
  });

  it('strips UTF-8 BOM at start', async () => {
    const result = await provider.extract(
      validInput('\uFEFF# BOM title\n\nbody'),
      new AbortController().signal,
      () => {},
    );
    expect(result.content.startsWith('# BOM title')).toBe(true);
    expect(result.title).toBe('BOM title');
  });

  it('collapses 3+ blank lines down to one', async () => {
    const result = await provider.extract(
      validInput('a\n\n\n\n\nb'),
      new AbortController().signal,
      () => {},
    );
    expect(result.content).toBe('a\n\nb');
  });

  it('falls back to first non-blank line for title when there is no heading', async () => {
    const result = await provider.extract(
      validInput('This is the first line of a plain document\n\nthen more'),
      new AbortController().signal,
      () => {},
    );
    expect(result.title).toBe('This is the first line of a plain document');
  });

  it('truncates content past MARKDOWN_PROMPT_CHARS (32KB) and flags metadata', async () => {
    // 40KB of body to push past the cap.
    const body = 'a'.repeat(40_000);
    const result = await provider.extract(
      validInput(body),
      new AbortController().signal,
      () => {},
    );
    expect(result.content.length).toBeLessThanOrEqual(32_000 + 64);
    expect(result.content).toContain('truncated at 32000');
    expect((result.metadata as { truncated?: boolean }).truncated).toBe(true);
  });

  it('produces the same id for identical content (cache-key invariant)', async () => {
    const a = await provider.extract(
      validInput('# same\n\ncontent'),
      new AbortController().signal,
      () => {},
    );
    const b = await provider.extract(
      validInput('# same\n\ncontent'),
      new AbortController().signal,
      () => {},
    );
    expect(a.id).toBe(b.id);
  });
});
