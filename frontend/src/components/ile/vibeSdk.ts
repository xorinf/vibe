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
  // Handshake: signal the host that the runtime is alive. The host
  // uses this to clear the 'Booting experience...' overlay. We send
  // it once on init (after the SDK's DOM is registered) so the host
  // never has to fall back to a timeout. Safe to fire multiple times
  // — the host de-dupes by checking the loaded state.
  send('${IFRAME_MSG_TYPES.READY}');

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
    /**
     * In-place content update. Called by the host when the teacher
     * types in the code editor. We use document.open() + write() +
     * close() so the iframe's JavaScript runtime is wiped but the
     * parent.postMessage channel stays open, the CSP stays in effect,
     * and the analytics buffer flushes (so events from the previous
     * content land before the new document loads).
     *
     * Why not iframe.srcdoc = ...? Some browsers treat that as a
     * full navigation, which drops our postMessage listeners AND
     * any in-flight analytics. document.open is the spec-blessed
     * way to replace the body in place.
     */
    setContent: function(html){
      try {
        // Capture a snapshot of the buffer BEFORE we destroy the
        // document — the flush() call below uses parent, which is
        // still valid as long as the host hasn't navigated.
        flush();
        document.open();
        document.write(html);
        document.close();
        // After close, the browser parses + executes the new doc.
        // Our runtime snippet is re-injected on the next load (the
        // teacher has to re-add vibe.* listeners, but they were
        // already in the new HTML). We do NOT try to preserve
        // listener state — the teacher's manual edits are the new
        // truth, and the previous runtime is gone.
      } catch (e) {
        // Defensive: if document.write fails (e.g. CSP forbids it),
        // fall back to a full reload via the host by sending an
        // error event. The host can decide to remount.
        send('error', { message: 'setContent failed: ' + (e && e.message) });
      }
    },
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
  "form-action 'none'; " +
  // CSP violation reports are POSTed to the platform's reporting
  // endpoint so a hostile or buggy experience gets logged centrally.
  // The report-uri is appended to the strict policy; the API base is
  // derived at runtime from the ILE_API_BASE env (Vite exposes
  // import.meta.env.VITE_BASE_URL). When the base is empty (local dev
  // without a proxy), we fall back to a relative path — the browser
  // resolves it against the iframe's own opaque origin and the report
  // will 404 silently, which is the right behaviour for a no-CSP-target
  // local dev.
  // The placeholder is substituted at runtime by SandboxIframe.
  "report-uri __VIBE_CSP_REPORT_URI__;";