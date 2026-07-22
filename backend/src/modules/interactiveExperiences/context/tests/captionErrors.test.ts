import {describe, expect, it} from 'vitest';
import {
  isUnavailableMessage,
  isUnsupportedMessage,
} from '../providers/strategies/captionErrors.js';

describe('isUnavailableMessage', () => {
  it('matches the canonical "no transcripts are available" message', () => {
    expect(
      isUnavailableMessage('No transcripts are available for this video'),
    ).toBe(true);
  });

  it('matches the shorter "no transcript" phrasing', () => {
    expect(isUnavailableMessage('No transcript found for this video')).toBe(
      true,
    );
  });

  it('matches "subtitles are disabled"', () => {
    expect(isUnavailableMessage('Subtitles are disabled by the uploader')).toBe(
      true,
    );
  });

  it('matches "no captions"', () => {
    expect(isUnavailableMessage('There are no captions on this video.')).toBe(
      true,
    );
  });

  it('matches "transcript is disabled"', () => {
    expect(isUnavailableMessage('Transcript is disabled.')).toBe(true);
  });

  it('matches the Pascal-case "TranscriptsDisabled" YouTube error name', () => {
    expect(isUnavailableMessage('TranscriptsDisabled')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isUnavailableMessage('NO TRANSCRIPTS ARE AVAILABLE')).toBe(true);
    expect(isUnavailableMessage('transcriptsdisabled')).toBe(true);
    expect(isUnavailableMessage('SuBtItLeS aRe DiSaBlEd')).toBe(true);
  });

  it('returns false for the empty string', () => {
    expect(isUnavailableMessage('')).toBe(false);
  });

  it('returns false for messages that look unrelated', () => {
    expect(isUnavailableMessage('Video uploaded successfully')).toBe(false);
    expect(isUnavailableMessage('Network error')).toBe(false);
  });

  it('does NOT match messages that belong to the unsupported family', () => {
    // Adversarial inputs: these LOOK like they could be unavailability
    // messages but they describe a video that is unreachable —
    // unsupported, not unavailable. The classifier must keep them
    // separated so the provider can return the right error kind.
    expect(isUnavailableMessage('Private video')).toBe(false);
    expect(isUnavailableMessage('Video unavailable')).toBe(false);
    expect(isUnavailableMessage('Sign in to confirm you’re not a bot')).toBe(
      false,
    );
    expect(isUnavailableMessage('Age-restricted video')).toBe(false);
  });
});

describe('isUnsupportedMessage', () => {
  it('matches "Private video"', () => {
    expect(isUnsupportedMessage('Private video')).toBe(true);
  });

  it('matches "Video unavailable"', () => {
    expect(isUnsupportedMessage('Video unavailable')).toBe(true);
  });

  it('matches "not available in your country"', () => {
    expect(
      isUnsupportedMessage(
        'Sorry, this video is not available in your country.',
      ),
    ).toBe(true);
  });

  it('matches the YouTube bot-check "Sign in to confirm" message', () => {
    expect(
      isUnsupportedMessage('Sign in to confirm you’re not a bot'),
    ).toBe(true);
  });

  it('matches the hyphenated "age-restricted" form', () => {
    expect(isUnsupportedMessage('This video is age-restricted.')).toBe(true);
  });

  it('matches the spaced "age restricted" form', () => {
    expect(isUnsupportedMessage('This video is age restricted.')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isUnsupportedMessage('PRIVATE VIDEO')).toBe(true);
    expect(isUnsupportedMessage('video Unavailable')).toBe(true);
    expect(isUnsupportedMessage('AGE-RESTRICTED')).toBe(true);
  });

  it('returns false for the empty string', () => {
    expect(isUnsupportedMessage('')).toBe(false);
  });

  it('returns false for messages that look unrelated', () => {
    expect(isUnsupportedMessage('Hello world')).toBe(false);
    expect(isUnsupportedMessage('Lecture 3: Quantum Mechanics')).toBe(false);
  });

  it('does NOT match messages that belong to the unavailable family', () => {
    // Adversarial inputs: these LOOK like they could be unsupported
    // (the video is "off-limits") but they describe a video that is
    // reachable but has no captions. The classifier must keep them
    // separated.
    expect(isUnsupportedMessage('No transcripts are available')).toBe(false);
    expect(isUnsupportedMessage('subtitles are disabled')).toBe(false);
    expect(isUnsupportedMessage('TranscriptsDisabled')).toBe(false);
  });
});

describe('isUnavailableMessage / isUnsupportedMessage are disjoint', () => {
  it('classifies a "no captions" string as unavailable but not unsupported', () => {
    const m = 'No captions available for this video';
    expect(isUnavailableMessage(m)).toBe(true);
    expect(isUnsupportedMessage(m)).toBe(false);
  });

  it('classifies a "private video" string as unsupported but not unavailable', () => {
    const m = 'Private video. Sign in to watch.';
    expect(isUnsupportedMessage(m)).toBe(true);
    expect(isUnavailableMessage(m)).toBe(false);
  });
});
