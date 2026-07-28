import { injectable } from 'inversify';
import { Request, Response } from 'express';

/**
 * SSE writer for the interactive-experiences module.
 *
 * Module-local copy of the genAI SSE primitive — these are different streams
 * (ILE generates HTML, genAI streams job task progress) and a shared service
 * would just couple them. If we need a generic SSE helper later, extract it
 * into shared/ — for now keep duplication small.
 */
@injectable()
export class IleSseService {
  private heartbeat: NodeJS.Timeout | null = null;
  private closed = false;
  private currentRes: Response | null = null;
  // Track the close-listener we registered on the current req so we
  // can detach it on close() / on a fresh attach(). Without this,
  // a workspace that navigates away + back leaks one listener per
  // attach (the prior req's 'close' handler keeps holding `this`).
  private currentReq: Request | null = null;
  private onCurrentReqClose: (() => void) | null = null;

  attach(req: Request, res: Response): this {
    this.init(req, res);
    return this;
  }

  init(req: Request, res: Response): void {
    // If a previous attach() is still live (the caller forgot to
    // close), tear it down before re-initialising. This keeps the
    // service re-entrant without leaking listeners / intervals.
    this.close();
    this.currentReq = req;
    this.currentRes = res;
    this.closed = false;
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering
    });
    res.flushHeaders?.();
    res.write(': connected\n\n');

    this.heartbeat = setInterval(() => {
      if (!this.closed && this.currentRes === res && this.canWrite()) {
        res.write(': ping\n\n');
      }
    }, 15000);

    this.onCurrentReqClose = () => this.close();
    req.once('close', this.onCurrentReqClose);
  }

  /** True if the current response is still in a writable state. */
  private canWrite(): boolean {
    const res = this.currentRes;
    if (!res) return false;
    // `writableEnded` is set the moment `res.end()` runs OR the
    // socket tears down. `destroyed` covers the case where the
    // client closed mid-flight (ECONNRESET / browser navigation).
    // Either flag means the next `res.write()` will throw
    // ERR_STREAM_DESTROYED — check before each write so a late
    // SSE event after disconnect doesn't crash the request handler.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return !(res as any).writableEnded && !(res as any).destroyed;
  }

  /** Emit a typed event with JSON payload. */
  emit(event: string, payload: unknown): void {
    if (this.closed || !this.currentRes) return;
    if (!this.canWrite()) {
      // Late event after disconnect — silently drop instead of
      // throwing. The client is gone; the only signal left is the
      // server-side abort path (IleGenerationService watches
      // `req.on('close')` to tear down the upstream provider).
      this.close();
      return;
    }
    try {
      this.currentRes.write(`event: ${event}\n`);
      this.currentRes.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // Defensive: any unexpected write failure (e.g. socket torn
      // down between canWrite() and write()) is treated as a
      // disconnect. Same as the late-event path above.
      this.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    // Detach the close listener so a future attach() on the same
    // `req` (rare, but happens in tests) doesn't double-fire.
    if (this.currentReq && this.onCurrentReqClose) {
      this.currentReq.off('close', this.onCurrentReqClose);
    }
    this.currentReq = null;
    this.onCurrentReqClose = null;
    const res = this.currentRes;
    this.currentRes = null;
    if (res) {
      try {
        if (this.canWriteRaw(res)) {
          res.end();
        }
      } catch {
        // response already closed by client — ignore
      }
    }
  }

  /** Lower-level check used by close() — does not depend on `this`. */
  private canWriteRaw(res: Response): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return !(res as any).writableEnded && !(res as any).destroyed;
  }

  cleanup(res: Response): void {
    this.close();
  }
}
