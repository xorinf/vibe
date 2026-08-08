import 'reflect-metadata';
import {describe, expect, it} from 'vitest';
import {IleGenerationService} from '../services/IleGenerationService.js';

/**
 * Focused tests for the sanitizer + normalizeHtml pair in
 * IleGenerationService. Both are private; we reach them via `as any`
 * which mirrors the pattern used in IleRepository.saveAndAppendVersion.
 *
 * What we're guarding against:
 *   - `` blocks (full, unclosed, split across deltas)
 *   - `<redacted_thinking>` blocks (Anthropic extended-thinking sensitive context)
 *   - ``` with language tags other than `html` (HTML5, htm, XML, etc.)
 *   - `<!doctype` anchor strip (anything before the document opener)
 *   - Trailing ``` after `</html>`
 */
class TestableGen extends IleGenerationService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor() {
    super({} as any, {} as any, {} as any, {} as any, {} as any);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sanitize(cumulative: string, delta: string): string {
    return (this as any).sanitizeDeltaForHtml(cumulative, delta);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  normalize(raw: string): string {
    return (this as any).normalizeHtml(raw);
  }
}

describe('ILE sanitizer + normalizeHtml', () => {
  const gen = new TestableGen();

  describe('think blocks', () => {
    it('strips a full <think>...</think> block', () => {
      const out = gen.sanitize('', '<think>reasoning</think><!DOCTYPE html><html></html>');
      expect(out).toBe('<!DOCTYPE html><html></html>');
    });

    it('strips an unclosed <think> to end-of-delta (model never finished reasoning)', () => {
      // When the model emits `<think>partial thought` mid-delta and never
      // closes, the regex consumes to end-of-delta. The follow-up deltas
      // (or the anchor strip + normalizeHtml) recover the actual document.
      const out = gen.sanitize('', '<think>partial thought');
      expect(out).toBe('');
    });

    it('strips <redacted_thinking> blocks (Anthropic extended-thinking)', () => {
      const out = gen.sanitize(
        '',
        '<redacted_thinking>sensitive context</redacted_thinking><!DOCTYPE html><html></html>',
      );
      expect(out).toBe('<!DOCTYPE html><html></html>');
    });

    it('handles a mix of think and redacted_thinking blocks', () => {
      const out = gen.sanitize(
        '',
        '<think>first</think>noise<redacted_thinking>two</redacted_thinking>\n<!DOCTYPE html><html></html>',
      );
      expect(out).toBe('<!DOCTYPE html><html></html>');
    });
  });

  describe('fence stripping', () => {
    it('strips ```html when it precedes the document on the first delta', () => {
      const out = gen.sanitize('', '```html\n<!DOCTYPE html><html></html>');
      expect(out).toBe('<!DOCTYPE html><html></html>');
    });

    it('strips ```HTML5 (any language tag)', () => {
      const out = gen.sanitize('', '```HTML5\n<!DOCTYPE html><html></html>');
      expect(out).toBe('<!DOCTYPE html><html></html>');
    });

    it('strips ```xml fence variants', () => {
      const out = gen.sanitize('', '```xml\n<!DOCTYPE html><html></html>');
      expect(out).toBe('<!DOCTYPE html><html></html>');
    });

    it('strips a bare ``` fence (no language)', () => {
      const out = gen.sanitize('', '```\n<!DOCTYPE html><html></html>');
      expect(out).toBe('<!DOCTYPE html><html></html>');
    });

    it('strips the trailing ``` after </html> on the last delta', () => {
      const fullDoc = '<!DOCTYPE html><html>content</html>';
      const out = gen.sanitize(fullDoc, '\n```');
      expect(out).toBe('');
    });
  });

  describe('anchor strip', () => {
    it('discards chain-of-thought prose that ends with a stray think> closing marker', () => {
      // MiniMax quirk: emits prose like "Let me think about this design..."
      // then a stray `think>` closing marker, NOT wrapped in <think>...</think>.
      const out = gen.sanitize(
        '',
        'Let me think about this design>\n<!DOCTYPE html><html></html>',
      );
      expect(out).toBe('<!DOCTYPE html><html></html>');
    });
  });

  describe('normalizeHtml defensive pass', () => {
    it('strips a wrapping ```html ... ``` fence', () => {
      const doc = '```html\n<!DOCTYPE html><html></html>\n```';
      expect(gen.normalize(doc)).toBe('<!DOCTYPE html><html></html>');
    });

    it('strips wrapping ```HTML5 fence via normalize (after the per-delta sanitizer missed it)', () => {
      const doc = '```HTML5\n<!DOCTYPE html><html>body</html>\n```';
      expect(gen.normalize(doc)).toBe('<!DOCTYPE html><html>body</html>');
    });

    it('strips trailing junk after </html>', () => {
      const doc = '<!DOCTYPE html><html></html>\nfinal thought here';
      expect(gen.normalize(doc)).toBe('<!DOCTYPE html><html></html>');
    });
  });
});
