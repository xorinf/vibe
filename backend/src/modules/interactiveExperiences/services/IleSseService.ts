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

  attach(req: Request, res: Response): this {
    this.init(req, res);
    return this;
  }

  init(req: Request, res: Response): void {
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
      if (!this.closed && this.currentRes === res) {
        res.write(': ping\n\n');
      }
    }, 15000);

    req.once('close', () => this.close());
  }

  /** Emit a typed event with JSON payload. */
  emit(event: string, payload: unknown): void {
    if (this.closed || !this.currentRes) return;
    this.currentRes.write(`event: ${event}\n`);
    this.currentRes.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    const res = this.currentRes;
    if (res) {
      try {
        res.end();
      } catch {
        // response already closed by client — ignore
      }
    }
    this.currentRes = null;
  }

  cleanup(res: Response): void {
    this.close();
  }
}
