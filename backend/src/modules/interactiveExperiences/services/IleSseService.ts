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

  init(req: Request, res: Response): void {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering
    });
    res.flushHeaders?.();
    res.write(': connected\n\n');

    this.heartbeat = setInterval(() => {
      if (!this.closed) res.write(': ping\n\n');
    }, 15000);

    req.once('close', () => this.cleanup(res));
  }

  /** Emit a typed event with JSON payload. */
  emit(res: Response, event: string, payload: unknown): void {
    if (this.closed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  cleanup(res: Response): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    try {
      res.end();
    } catch {
      // response already closed by client — ignore
    }
  }
}