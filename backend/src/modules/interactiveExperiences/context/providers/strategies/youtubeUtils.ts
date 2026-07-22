/**
 * YouTube URL parsing + lightweight metadata fetching.
 *
 * We support the URL shapes YouTube actually issues:
 *   - https://www.youtube.com/watch?v=ID
 *   - https://youtu.be/ID
 *   - https://www.youtube.com/shorts/ID
 *   - https://www.youtube.com/embed/ID
 *   - https://m.youtube.com/watch?v=ID
 *   - bare 11-char id (validated against YouTube's id alphabet)
 *
 * We use the public `noembed.com` oEmbed proxy for metadata — it
 * returns title/author/thumbnail without an API key. If the proxy is
 * unavailable we fall back to a minimal placeholder; the URL parser
 * is the load-bearing piece, the metadata is just nice-to-have for
 * the "Context: …" chip.
 */

import { ContextProviderError } from '../../types.js';

/** YouTube video ids are exactly 11 chars from [A-Za-z0-9_-]. */
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const YT_URL_PATTERNS: RegExp[] = [
  // Standard watch URL
  /(?:youtube\.com|youtu\.be)\/watch\?(?:.*&)?v=([A-Za-z0-9_-]{11})/,
  // Short URL
  /youtu\.be\/([A-Za-z0-9_-]{11})/,
  // Shorts URL
  /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/,
  // Embed URL
  /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/,
  // youtube-nocookie
  /youtube-nocookie\.com\/embed\/([A-Za-z0-9_-]{11})/,
];

/**
 * Extract the 11-char video id from a YouTube URL. Returns null when
 * the input doesn't match any known shape. Does NOT throw — callers
 * decide whether a null result is fatal.
 */
export function parseYouTubeId(input: string): string | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (YT_ID_RE.test(trimmed)) return trimmed;
  for (const re of YT_URL_PATTERNS) {
    const m = trimmed.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

/**
 * Lightweight metadata about a YouTube video. Used for the "Context: …"
 * chip in the workspace and for the system prompt's header.
 */
export interface YouTubeVideoMeta {
  title: string;
  author: string;
  thumbnailUrl: string;
  /** Best-effort duration in seconds. 0 if unknown. */
  durationSec: number;
}

const OEMBED_TIMEOUT_MS = 5_000;

/**
 * Fetch metadata via the public noembed.com proxy. Returns a minimal
 * placeholder on any failure — never throws. The proxy is free, no
 * API key, and CORS-friendly enough for server-side use.
 *
 * Provider failures here are NOT fatal. The YouTube context provider
 * uses whatever metadata it has; if the title is missing the system
 * prompt just gets "YouTube video — {videoId}" instead.
 */
export async function fetchVideoMeta(
  videoId: string,
  signal: AbortSignal,
): Promise<YouTubeVideoMeta> {
  const fallback: YouTubeVideoMeta = {
    title: `YouTube video ${videoId}`,
    author: '',
    thumbnailUrl: '',
    durationSec: 0,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OEMBED_TIMEOUT_MS);
  // Plumb caller cancellation through.
  const onCallerAbort = () => ctrl.abort();
  signal.addEventListener('abort', onCallerAbort, { once: true });

  try {
    const url = `https://noembed.com/embed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return fallback;
    const data = (await res.json().catch(() => null)) as
      | {
          title?: string;
          author_name?: string;
          thumbnail_url?: string;
        }
      | null;
    if (!data) return fallback;
    return {
      title: data.title || fallback.title,
      author: data.author_name || '',
      thumbnailUrl: data.thumbnail_url || '',
      durationSec: 0,
    };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * Throw a `ContextProviderError('invalid_input')` when the URL is not
 * a YouTube URL. Centralised so every strategy uses the same friendly
 * error message.
 */
export function requireYouTubeId(input: string): string {
  const id = parseYouTubeId(input);
  if (!id) {
    throw new ContextProviderError(
      `Could not parse YouTube id from ${input.slice(0, 80)}`,
      "That doesn't look like a YouTube link. Paste a full YouTube URL and try again.",
      'invalid_input',
    );
  }
  return id;
}
