import {describe, expect, it} from 'vitest';
import {parseYouTubeId} from '../providers/strategies/youtubeUtils.js';

describe('parseYouTubeId', () => {
  describe('supported URL shapes', () => {
    it('extracts id from a standard watch URL', () => {
      expect(parseYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
        'dQw4w9WgXcQ',
      );
    });

    it('extracts id from a youtu.be short URL', () => {
      expect(parseYouTubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    it('extracts id from a Shorts URL', () => {
      expect(
        parseYouTubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'),
      ).toBe('dQw4w9WgXcQ');
    });

    it('extracts id from an embed URL', () => {
      expect(
        parseYouTubeId('https://www.youtube.com/embed/dQw4w9WgXcQ'),
      ).toBe('dQw4w9WgXcQ');
    });

    it('extracts id from a youtube-nocookie embed URL', () => {
      expect(
        parseYouTubeId('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'),
      ).toBe('dQw4w9WgXcQ');
    });

    it('extracts id from a mobile m.youtube.com watch URL', () => {
      expect(
        parseYouTubeId('https://m.youtube.com/watch?v=dQw4w9WgXcQ'),
      ).toBe('dQw4w9WgXcQ');
    });

    it('accepts a bare 11-character id', () => {
      expect(parseYouTubeId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    it('extracts id when the watch URL has additional query params', () => {
      expect(
        parseYouTubeId(
          'https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ',
        ),
      ).toBe('dQw4w9WgXcQ');
    });

    it('extracts id when the watch URL uses http (no s)', () => {
      expect(parseYouTubeId('http://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
        'dQw4w9WgXcQ',
      );
    });

    it('trims surrounding whitespace around an id', () => {
      expect(parseYouTubeId('  dQw4w9WgXcQ  ')).toBe('dQw4w9WgXcQ');
    });

    it('accepts alternative ids that are valid in the YouTube alphabet', () => {
      // Underscore + dash are part of the YouTube id alphabet.
      expect(parseYouTubeId('_-_-_-_-_-_')).toBe('_-_-_-_-_-_');
    });
  });

  describe('rejected inputs', () => {
    it('returns null for the empty string', () => {
      expect(parseYouTubeId('')).toBeNull();
    });

    it('returns null for whitespace-only input', () => {
      expect(parseYouTubeId('   ')).toBeNull();
      expect(parseYouTubeId('\t\n')).toBeNull();
    });

    it('returns null for garbage / non-YouTube URLs', () => {
      expect(parseYouTubeId('not a url at all')).toBeNull();
      expect(parseYouTubeId('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
      expect(parseYouTubeId('https://vimeo.com/123456')).toBeNull();
    });

    it('returns null for an id that is too short', () => {
      expect(parseYouTubeId('abc')).toBeNull();
      expect(parseYouTubeId('dQw4w9WgXc')).toBeNull(); // 10 chars
    });

    it('returns null for an id that is too long', () => {
      expect(parseYouTubeId('dQw4w9WgXcQa')).toBeNull(); // 12 chars
    });

    it('returns null for an id with characters outside the alphabet', () => {
      // 11 chars but contains characters outside [A-Za-z0-9_-].
      expect(parseYouTubeId('dQw4w9WgXc!')).toBeNull();
      expect(parseYouTubeId('dQw4w9WgXc ')).toBeNull(); // space
    });

    it('returns null for a YouTube URL without a video id', () => {
      expect(parseYouTubeId('https://www.youtube.com/')).toBeNull();
      expect(parseYouTubeId('https://www.youtube.com/watch')).toBeNull();
      expect(parseYouTubeId('https://www.youtube.com/watch?v=')).toBeNull();
      expect(parseYouTubeId('https://www.youtube.com/embed/')).toBeNull();
    });
  });

  describe('defensive non-string handling', () => {
    it('returns null when called with null', () => {
      // The TS signature is `(input: string)` but the runtime guard
      // returns null for any non-string / empty input. We cast to
      // bypass the type to assert the runtime contract.
      expect(parseYouTubeId(null as unknown as string)).toBeNull();
    });

    it('returns null when called with undefined', () => {
      expect(parseYouTubeId(undefined as unknown as string)).toBeNull();
    });

    it('returns null when called with a number', () => {
      expect(parseYouTubeId(123 as unknown as string)).toBeNull();
    });

    it('returns null when called with an object', () => {
      expect(parseYouTubeId({} as unknown as string)).toBeNull();
    });
  });
});
