/**
 * Shared caption-error classifiers. Split out so creator + auto
 * strategies stay in sync as YouTube's error surface evolves.
 */

export function isUnavailableMessage(m: string): boolean {
  const s = m.toLowerCase();
  return (
    s.includes('no transcripts are available') ||
    s.includes('no transcript') ||
    s.includes('subtitles are disabled') ||
    s.includes('no captions') ||
    s.includes('transcript is disabled') ||
    s.includes('transcriptsdisabled')
  );
}

/**
 * Detect region-block / private / age-restricted errors. The matchers
 * are intentionally a bit loose because YouTube's error surface has
 * shifted several times — better to catch the common phrasings and
 * occasionally over-flag a transient as unsupported than to surface
 * the wrong user message.
 */
export function isUnsupportedMessage(m: string): boolean {
  const s = m.toLowerCase();
  return (
    s.includes('private video') ||
    s.includes('video unavailable') ||
    s.includes('not available in your country') ||
    s.includes('available in your country') ||
    // "has not made this video available in your country" — common
    // alternate phrasing. Matches if the error mentions BOTH "not"
    // (anywhere) and "in your country".
    (s.includes(' not ') && s.includes('in your country')) ||
    s.includes('sign in to confirm') ||
    s.includes('age-restricted') ||
    s.includes('age restricted')
  );
}
