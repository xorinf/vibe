import { TranscriptStrategy, StrategyResult } from './Strategy.js';
import { TranscriptLine } from '../../TranscriptCleaner.js';
import { ContextProviderError, ContextPhase } from '../../types.js';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ileLog } from '../../../services/observability.js';

/**
 * Strategy 3 — local Whisper fallback.
 *
 * Pipeline:
 *   1. Resolve `yt-dlp` and `faster-whisper` binaries on PATH.
 *   2. Run `yt-dlp` to download the audio track as 16kHz mono WAV.
 *   3. Spawn a Python child process that loads faster-whisper and
 *      transcribes the WAV with timestamps.
 *   4. Stream progress updates back to the caller.
 *   5. ALWAYS clean up the scratch directory in `finally`.
 *
 * Env vars (all optional):
 *   ILE_WHISPER_MODEL        default 'small' (also: tiny, base, small, medium, large-v3)
 *   ILE_WHISPER_TIMEOUT_MS   default 600_000 (10 min)
 *   ILE_WHISPER_BIN          default 'python3' (full path allowed)
 *   ILE_WHISPER_DEVICE       default 'cpu' (set to 'cuda' for GPU)
 *   ILE_WHISPER_COMPUTE_TYPE default 'int8' (cpu) / 'float16' (cuda)
 *
 * Failure modes:
 *   - yt-dlp missing          → `not_configured` (with install hint).
 *   - faster-whisper missing  → `not_configured` (with install hint).
 *   - download fails          → `unavailable`.
 *   - transcription empty     → `unavailable`.
 *   - timeout / SIGKILL       → `transient`.
 *
 * Cancellation:
 *   The child process is killed with SIGTERM on abort. If it doesn't
 *   exit within 5s we escalate to SIGKILL. Scratch directory is
 *   always cleaned up.
 */

// ─────────────────────────────────────────────────────────────────────
// Env helpers
// ─────────────────────────────────────────────────────────────────────

const ALLOWED_MODELS = new Set(['tiny', 'base', 'small', 'medium', 'large-v3']);

function readWhisperModel(): string {
  const raw = process.env.ILE_WHISPER_MODEL?.trim();
  if (raw && ALLOWED_MODELS.has(raw)) return raw;
  return 'small';
}

function readWhisperTimeoutMs(): number {
  const raw = process.env.ILE_WHISPER_TIMEOUT_MS?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 600_000;
}

function readWhisperBin(): string {
  return process.env.ILE_WHISPER_BIN?.trim() || 'python3';
}

function readWhisperDevice(): 'cpu' | 'cuda' {
  const v = process.env.ILE_WHISPER_DEVICE?.trim().toLowerCase();
  return v === 'cuda' ? 'cuda' : 'cpu';
}

function readWhisperComputeType(): string {
  if (process.env.ILE_WHISPER_COMPUTE_TYPE?.trim()) {
    return process.env.ILE_WHISPER_COMPUTE_TYPE.trim();
  }
  return readWhisperDevice() === 'cuda' ? 'float16' : 'int8';
}

// ─────────────────────────────────────────────────────────────────────
// Binary detection
// ─────────────────────────────────────────────────────────────────────

const binaryCache = new Map<string, string | null>();

async function which(bin: string): Promise<string | null> {
  if (binaryCache.has(bin)) return binaryCache.get(bin) ?? null;
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return new Promise<string | null>((resolve) => {
    const child = spawn(cmd, [bin], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('error', () => {
      binaryCache.set(bin, null);
      resolve(null);
    });
    child.on('close', (code) => {
      const found = code === 0 ? out.split('\n')[0]?.trim() : '';
      const resolved = found || null;
      binaryCache.set(bin, resolved);
      resolve(resolved);
    });
  });
}

let fasterWhisperProbe: Promise<boolean> | null = null;

async function isFasterWhisperInstalled(): Promise<boolean> {
  if (fasterWhisperProbe) return fasterWhisperProbe;
  fasterWhisperProbe = new Promise<boolean>((resolve) => {
    const bin = readWhisperBin();
    const child = spawn(bin, ['-c', 'import faster_whisper'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  return fasterWhisperProbe;
}

// ─────────────────────────────────────────────────────────────────────
// Scratch dir cleanup
// ─────────────────────────────────────────────────────────────────────

async function rmrf(path: string): Promise<void> {
  try {
    await fs.rm(path, { recursive: true, force: true });
  } catch {
    // Best-effort. Scratch dirs in /tmp don't need to be perfect.
  }
}

// ─────────────────────────────────────────────────────────────────────
// Strategy
// ─────────────────────────────────────────────────────────────────────

export class WhisperFallbackStrategy implements TranscriptStrategy {
  readonly name = 'whisper';

  async extract(
    videoId: string,
    signal: AbortSignal,
    onPhase: (phase: ContextPhase) => void,
  ): Promise<StrategyResult> {
    const [ytdlp, fasterOk] = await Promise.all([
      which('yt-dlp'),
      isFasterWhisperInstalled(),
    ]);

    if (!ytdlp || !fasterOk) {
      const list = [!ytdlp ? 'yt-dlp' : null, !fasterOk ? 'faster-whisper' : null]
        .filter(Boolean)
        .join(' and ');
      ileLog('warn', 'context.whisper.deps_missing', {
        ytDlp: ytdlp,
        fasterWhisper: fasterOk,
      });
      throw new ContextProviderError(
        `Whisper dependencies missing: ${list}`,
        'YouTube captions unavailable and local transcription is not configured. ' +
          'Install yt-dlp and faster-whisper to enable automatic transcription.',
        'not_configured',
      );
    }

    if (signal.aborted) {
      throw new ContextProviderError(
        'Cancelled',
        'Generation cancelled.',
        'cancelled',
      );
    }

    const scratchRoot = join(tmpdir(), 'vibe-youtube', videoId);
    await fs.mkdir(scratchRoot, { recursive: true });
    const audioPath = join(scratchRoot, 'audio.wav');

    try {
      onPhase({ id: 'downloading-audio', label: 'Analyzing educational content...' });
      await runYtDlp(videoId, audioPath, signal);

      if (signal.aborted) {
        throw new ContextProviderError(
          'Cancelled',
          'Generation cancelled.',
          'cancelled',
        );
      }

      onPhase({ id: 'transcribing', label: 'Analyzing educational content...' });
      const model = readWhisperModel();
      const timeoutMs = readWhisperTimeoutMs();
      const device = readWhisperDevice();
      const computeType = readWhisperComputeType();
      const pyBin = readWhisperBin();

      const lines = await runPythonTranscribe({
        pythonBin: pyBin,
        script: PYTHON_TRANSCRIBE_SCRIPT,
        audioPath,
        model,
        device,
        computeType,
        timeoutMs,
        signal,
        onPhase,
      });

      if (lines.length === 0) {
        throw new ContextProviderError(
          'Whisper produced empty transcript',
          'No transcript could be extracted from this video.',
          'unavailable',
        );
      }

      return { lines, language: 'auto' };
    } finally {
      await rmrf(scratchRoot);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// yt-dlp
// ─────────────────────────────────────────────────────────────────────

function runYtDlp(
  videoId: string,
  outputPath: string,
  signal: AbortSignal,
): Promise<void> {
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
    };
    const ok = () => {
      done();
      resolve();
    };
    const fail = (err: ContextProviderError) => {
      done();
      reject(err);
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(
        'yt-dlp',
        [
          '-x',
          '--audio-format', 'wav',
          '--audio-quality', '0',
          '--no-playlist',
          '--no-progress',
          '-o', outputPath,
          url,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      fail(
        new ContextProviderError(
          `Failed to spawn yt-dlp: ${(err as Error).message}`,
          'YouTube captions unavailable and local transcription is not configured. Install yt-dlp and faster-whisper to enable automatic transcription.',
          'not_configured',
          err,
        ),
      );
      return;
    }

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(-2048);
    });

    const onAbort = () => {
      try {
        proc.kill('SIGTERM');
      } catch {
        // already dead
      }
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // already dead
        }
      }, 5_000).unref();
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    proc.on('close', (code, signalName) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted || signalName === 'SIGTERM' || signalName === 'SIGKILL') {
        fail(
          new ContextProviderError(
            'yt-dlp cancelled',
            'Generation cancelled.',
            'cancelled',
          ),
        );
        return;
      }
      if (code === 0) {
        ok();
        return;
      }

      const s = stderr.toLowerCase();
      if (s.includes('private video') || s.includes('sign in to confirm')) {
        fail(
          new ContextProviderError(
            'yt-dlp: private video',
            'This video is private and cannot be transcribed.',
            'unsupported',
          ),
        );
        return;
      }
      if (s.includes('not available in your country')) {
        fail(
          new ContextProviderError(
            'yt-dlp: region blocked',
            'This video is not available in your region and cannot be transcribed.',
            'unsupported',
          ),
        );
        return;
      }
      if (s.includes('age') && s.includes('restrict')) {
        fail(
          new ContextProviderError(
            'yt-dlp: age restricted',
            'This video is age-restricted and cannot be transcribed.',
            'unsupported',
          ),
        );
        return;
      }
      if (s.includes('http error 404')) {
        fail(
          new ContextProviderError(
            'yt-dlp: video not found',
            'This video could not be found. Check the URL and try again.',
            'unavailable',
          ),
        );
        return;
      }
      fail(
        new ContextProviderError(
          `yt-dlp failed (exit ${code}): ${stderr.slice(0, 200)}`,
          'Unable to download audio from this video.',
          'transient',
        ),
      );
    });

    proc.on('error', (err) => {
      fail(
        new ContextProviderError(
          `yt-dlp spawn error: ${err.message}`,
          'YouTube captions unavailable and local transcription is not configured. Install yt-dlp and faster-whisper to enable automatic transcription.',
          'not_configured',
          err,
        ),
      );
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// Python faster-whisper
// ─────────────────────────────────────────────────────────────────────

interface TranscribeOpts {
  pythonBin: string;
  script: string;
  audioPath: string;
  model: string;
  device: 'cpu' | 'cuda';
  computeType: string;
  timeoutMs: number;
  signal: AbortSignal;
  onPhase: (phase: ContextPhase) => void;
}

function runPythonTranscribe(opts: TranscribeOpts): Promise<TranscriptLine[]> {
  const args = [
    '-c',
    opts.script,
    '--audio', opts.audioPath,
    '--model', opts.model,
    '--device', opts.device,
    '--compute-type', opts.computeType,
  ];

  return new Promise<TranscriptLine[]>((resolve, reject) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
    };
    const ok = (lines: TranscriptLine[]) => {
      done();
      resolve(lines);
    };
    const fail = (err: ContextProviderError) => {
      done();
      reject(err);
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(opts.pythonBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      fail(
        new ContextProviderError(
          `Failed to spawn python: ${(err as Error).message}`,
          'YouTube captions unavailable and local transcription is not configured. Install yt-dlp and faster-whisper to enable automatic transcription.',
          'not_configured',
          err,
        ),
      );
      return;
    }

    const lines: TranscriptLine[] = [];
    let stderr = '';
    let stdoutBuf = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as {
            start?: number;
            end?: number;
            text?: string;
          };
          if (
            typeof parsed.start === 'number' &&
            typeof parsed.end === 'number' &&
            typeof parsed.text === 'string'
          ) {
            lines.push({ startSec: parsed.start, text: parsed.text });
            // Re-emit a phase so the UI keeps ticking.
            opts.onPhase({
              id: 'transcribing-tick',
              label: 'Analyzing educational content...',
            });
          }
        } catch {
          // Not JSON — treat as a stray log line and ignore.
        }
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(-4096);
    });

    const onAbort = () => {
      try {
        proc.kill('SIGTERM');
      } catch {
        // already dead
      }
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // already dead
        }
      }, 5_000).unref();
    };
    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const timeout = setTimeout(() => {
      onAbort();
      fail(
        new ContextProviderError(
          `Whisper timed out after ${opts.timeoutMs}ms`,
          'Local transcription took too long. Try a shorter video.',
          'transient',
        ),
      );
    }, opts.timeoutMs);

    proc.on('close', (code, signalName) => {
      clearTimeout(timeout);
      opts.signal.removeEventListener('abort', onAbort);
      if (opts.signal.aborted || signalName === 'SIGTERM' || signalName === 'SIGKILL') {
        fail(
          new ContextProviderError(
            'Whisper cancelled',
            'Generation cancelled.',
            'cancelled',
          ),
        );
        return;
      }
      if (code !== 0) {
        fail(
          new ContextProviderError(
            `faster-whisper exited ${code}: ${stderr.slice(0, 200)}`,
            'Local transcription failed. Try again or use a different video.',
            'transient',
          ),
        );
        return;
      }
      ok(lines);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      fail(
        new ContextProviderError(
          `python spawn error: ${err.message}`,
          'YouTube captions unavailable and local transcription is not configured. Install yt-dlp and faster-whisper to enable automatic transcription.',
          'not_configured',
          err,
        ),
      );
    });
  });
}

/**
 * Python script (embedded as a string) that runs faster-whisper and
 * streams line-delimited JSON segments to stdout.
 *
 * Wire format per line:
 *   {"start": 0.0, "end": 2.5, "text": "Hello world"}
 */
const PYTHON_TRANSCRIBE_SCRIPT = `
import argparse, json, sys

try:
    from faster_whisper import WhisperModel
except Exception as e:
    sys.stderr.write("faster_whisper not importable: %s\\n" % e)
    sys.exit(2)

parser = argparse.ArgumentParser()
parser.add_argument("--audio", required=True)
parser.add_argument("--model", required=True)
parser.add_argument("--device", required=True)
parser.add_argument("--compute-type", required=True)
args = parser.parse_args()

try:
    model = WhisperModel(
        args.model,
        device=args.device,
        compute_type=args.compute_type,
    )
except Exception as e:
    sys.stderr.write("model load failed: %s\\n" % e)
    sys.exit(3)

segments_iter, info = model.transcribe(args.audio, beam_size=5, vad_filter=True)
for seg in segments_iter:
    out = {"start": float(seg.start), "end": float(seg.end), "text": seg.text}
    sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\\n")
    sys.stdout.flush()
`;
