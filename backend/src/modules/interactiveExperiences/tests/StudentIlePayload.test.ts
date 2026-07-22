import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

describe('StudentIlePayload', () => {
  it('does not expose context in the student payload', () => {
    const source = readFileSync(new URL('../controllers/IleController.ts', import.meta.url), 'utf8');
    const match = source.match(/class StudentIlePayload\s*{([^}]*)}/s);
    expect(match).toBeTruthy();
    expect(match?.[1]).not.toContain('context');
  });
});
