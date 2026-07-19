/**
 * ViBe Runtime SDK — the contract between a sandboxed iframe experience
 * and its parent ViBe page.
 *
 * Keep this file tiny. Future renderers (WebGL, PixiJS, custom runtimes)
 * should reuse the same wire protocol so the parent doesn't care what's
 * running inside the iframe.
 *
 * Direction is always explicit: `iframe:*` (child → parent) or
 * `host:*` (parent → child).
 */

export const VIBE_SDK_VERSION = '1';

// iframe → host
export const IFRAME_MSG_TYPES = {
  READY: 'iframe:ready',
  COMPLETE: 'iframe:complete',     // student reached an end-of-experience state
  PROGRESS: 'iframe:progress',     // { percent: number 0..100 }
  ERROR: 'iframe:error',
  /**
   * Batched analytics flush from the sandboxed runtime. Payload is
   * `{ events: IleRuntimeEvent[] }`. The host reads the array and
   * POSTs to /:id/events on the server. The host is responsible for
   * forwarding — the runtime doesn't know about fetch.
   */
  ANALYTICS: 'iframe:analytics',
} as const;

export type IframeMsgType =
  (typeof IFRAME_MSG_TYPES)[keyof typeof IFRAME_MSG_TYPES];

export interface IframeOutboundMessage {
  type: IframeMsgType;
  payload?: unknown;
}

// host → iframe (kept tiny in v1 — just expose the SDK version)
export const HOST_MSG_TYPES = {
  HANDSHAKE: 'host:handshake',
  SET_STATE: 'host:setState', // future
} as const;

export interface HostInboundMessage {
  type: (typeof HOST_MSG_TYPES)[keyof typeof HOST_MSG_TYPES];
  payload?: unknown;
}

/**
 * The tiny client snippet injected into every sandboxed experience so the
 * generated HTML can call `vibe.complete()` etc. without a build step.
 *
 * Keeps track of an `experienceId` baked into the parent URL so the
 * iframe can self-identify when it posts back analytics events. The
 * host reads `window.__vibe.experienceId` (set by the runtime snippet
 * via the VIBE_EXPERIENCE_ID placeholder) and uses it as the path for
 * the analytics POST.
 *
 * Lightweight analytics: the runtime buffers `started`, `progress`,
 * `interaction`, `complete`, `error`, `resume` events in memory and
 * flushes them in batches to the parent window via the existing
 * `postMessage` channel — the host then POSTs them to the server. The
 * server never sees the student's identity; it only sees a per-
 * experience salted hash.
 */
export const VIBE_RUNTIME_SNIPPET = `
<script>
(function(){
  if (window.__vibe) return;
  var expId = ${JSON.stringify('__VIBE_EXPERIENCE_ID_PLACEHOLDER__')};
  window.__vibe = { version: ${JSON.stringify(VIBE_SDK_VERSION)}, experienceId: expId };
  function send(type, payload){
    try { parent.postMessage(Object.assign({__vibe: true, version: window.__vibe.version, type: type, experienceId: expId}, payload ? {payload: payload} : {}), '*'); }
    catch(e){}
  }

  // Buffered event queue — flushed by the host.
  var queue = [];
  var flushTimer = null;
  function enqueue(kind, data){
    queue.push({ kind: kind, clientTs: Date.now(), data: data || null });
    if (!flushTimer) flushTimer = setTimeout(flush, 2000);
  }
  function flush(){
    if (queue.length === 0) { flushTimer = null; return; }
    var batch = queue.slice();
    queue = [];
    flushTimer = null;
    send('analytics', { events: batch });
  }

  // Flush on lifecycle events.
  document.addEventListener('visibilitychange', function(){
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);

  // Resume detection: when the tab becomes visible again after being
  // hidden for more than 30s, record a 'resume' event. Best-effort.
  var hiddenSince = null;
  document.addEventListener('visibilitychange', function(){
    if (document.visibilityState === 'hidden') {
      hiddenSince = Date.now();
    } else if (document.visibilityState === 'visible' && hiddenSince) {
      var dt = Date.now() - hiddenSince;
      if (dt > 30000) enqueue('resume', { reason: 'visibility', hiddenMs: dt });
      hiddenSince = null;
    }
  });

  window.vibe = {
    complete: function(){
      send('${IFRAME_MSG_TYPES.COMPLETE}');
      enqueue('complete', null);
      flush();
    },
    progress: function(p){
      var pct = Math.max(0, Math.min(100, Number(p) || 0));
      send('${IFRAME_MSG_TYPES.PROGRESS}', { percent: pct });
      enqueue('progress', { percent: pct });
    },
    interact: function(kind, label){
      // Explicit interaction recording. The runtime does NOT auto-
      // capture every click — that would inflate the metrics. The
      // generated HTML is expected to call vibe.interact() from
      // important controls.
      var k = String(kind || 'click');
      enqueue('interaction', { kind: k, label: label ? String(label) : null });
    },
    retry: function(kind, label){
      // Explicit retry recording — a discrete event kind so we can
      // compute retry rates independent of click volume. Distinct from
      // 'interaction' so dashboards can show "X students clicked
      // retry" without conflating it with every other tap. Wire
      // format intentionally mirrors 'interaction' so the server can
      // treat them similarly in summary.
      var k = String(kind || 'retry');
      enqueue('retry', { kind: k, label: label ? String(label) : null });
    },
    error: function(m){
      send('${IFRAME_MSG_TYPES.ERROR}', { message: String(m) });
      enqueue('error', { message: String(m) });
    },
    /** Force-flush the analytics buffer. Optional — the runtime auto-
     *  flushes on lifecycle events. Useful for tests. */
    flushAnalytics: flush,
  };
  // 'started' fires the first time the runtime loads — the host turns
  // this into the persistence row.
  enqueue('started', null);
  send('${IFRAME_MSG_TYPES.READY}');
})();
</script>
`;

/**
 * Strict CSP injected into every sandboxed experience. No network, no
 * eval sources, only inline JS+CSS.
 *
 * Asset embeds: teachers can upload images/audio/video/PDF/SVG and
 * reference them by signed GCS URL. The CSP permits https: for img,
 * media, and frame sources, but blocks general network egress via
 * `connect-src 'none'` (no fetch/XHR) and `frame-src https:` (PDFs only,
 * not arbitrary sites). Inline script stays the only JS source.
 *
 * This is the safety net behind the sandbox attribute — even if a
 * misconfigured sandbox somehow lets something through, CSP blocks it.
 */
export const VIBE_IFRAME_CSP =
  "default-src 'none'; " +
  "style-src 'unsafe-inline'; " +
  "script-src 'unsafe-inline'; " +
  // Assets: signed GCS URLs over https. The `*.googleusercontent.com`
  // form is also common for GCS and we allow both. `data:` is still
  // allowed for inline thumbnails the model might emit.
  "img-src https: data:; " +
  "media-src https: data:; " +
  // PDFs are embedded via <iframe src="...">. We pin frame-src to
  // https: so the model can't redirect the iframe to an arbitrary
  // site — but we still need a source, hence https:, not 'none'.
  "frame-src https:; " +
  "font-src https: data:; " +
  "connect-src 'none'; " +
  "object-src 'none'; " +
  "base-uri 'none'; " +
  "form-action 'none';";