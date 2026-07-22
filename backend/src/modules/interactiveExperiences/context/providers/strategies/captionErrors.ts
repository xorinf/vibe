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

export function isUnsupportedMessage(m: string): boolean {
  const s = m.toLowerCase();
  return (
    s.includes('private video') ||
    s.includes('video unavailable') ||
    s.includes('not available in your country') ||
    s.includes('sign in to confirm') ||
    s.includes('age-restricted') ||
    s.includes('age restricted')
  );
}
