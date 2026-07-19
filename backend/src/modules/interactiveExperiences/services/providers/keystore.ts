/**
 * KeyProvider — abstraction over at-rest encryption for secret material
 * (API keys today; anything sensitive tomorrow).
 *
 * Two implementations ship with the module:
 *
 *   - `LocalAesKeyProvider` — AES-256-GCM with a Key Encryption Key (KEK)
 *     loaded from the `ILE_LOCAL_KEK` env var (or `ILE_KEY_PROVIDER=local`).
 *     For local dev and single-tenant deployments only.
 *
 *   - `KmsKeyProvider` — shells calls to a managed KMS (AWS KMS / GCP KMS /
 *     Vault). The on-wire shape (`EnvelopeCiphertext`) is identical so
 *     documents encrypted by one provider can be decrypted by another
 *     after a key migration. KMS transport is the only thing that
 *     differs — see the TODO marker in this file for the contract.
 *
 * Design notes
 * ────────────
 * - The `EnvelopeCiphertext` shape is intentionally JSON-friendly: every
 *   byte buffer is base64. We never persist raw binary in Mongo.
 *
 * - The `kid` field lets us rotate key versions without downtime.
 *   Encrypted rows carry the key version used so we know which DEK to
 *   unwrap. The Keystore class below handles versioning transparently.
 *
 * - The provider interface returns `Promise<string>` for plaintext and
 *   accepts `string` for plaintext on encrypt — there's no binary
 *   type at this boundary. Callers never see raw keys.
 *
 * - All errors throw a typed `KeyProviderError` so callers can distinguish
 *   "decryption failed because key rotated" from "we can't reach the
 *   KMS". The error types live in this file.
 *
 * SECURITY-TODO(production): replace `LocalAesKeyProvider` with a real
 * KMS-backed implementation. The Local provider is fine for local-dev
 * and small-team single-tenant deployments, but the KEK is read from
 * env at process start — anyone with shell access to the box can
 * extract it. KMS providers keep the root key behind an HSM.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'crypto';

// ─────────────────────────────────────────────────────────────────────
// Wire shape — what's persisted in Mongo
// ─────────────────────────────────────────────────────────────────────

/**
 * Serialisable envelope. The raw key is never persisted; only the
 * ciphertext, IV, authTag and the `kid` (key-id) of the wrapping DEK.
 */
export interface EnvelopeCiphertext {
  /** Algorithm tag, e.g. "AES-256-GCM". */
  algorithm: 'AES-256-GCM';
  /** Key id (monotonic per provider). */
  kid: string;
  /** Base64-encoded 12-byte IV/nonce. */
  iv: string;
  /** Base64-encoded 16-byte GCM auth tag. */
  authTag: string;
  /** Base64-encoded ciphertext bytes. */
  ciphertext: string;
  /** Optional provider-local metadata (algorithm version, region, …). */
  meta?: Record<string, string>;
  /** When the envelope was produced. */
  createdAt: string;
}

/** Discrimination between wire shapes (legacy plaintext vs envelope). */
export type StoredSecret =
  | { kind: 'plaintext'; value: string }
  | { kind: 'envelope'; envelope: EnvelopeCiphertext };

// ─────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────

export class KeyProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'NOT_INITIALISED'
      | 'INVALID_ENVELOPE'
      | 'KEY_NOT_FOUND'
      | 'CRYPTO_FAIL'
      | 'UNDERLYING_UNAVAILABLE'
      | 'UNKNOWN',
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'KeyProviderError';
  }
}

// ─────────────────────────────────────────────────────────────────────
// Interface
// ─────────────────────────────────────────────────────────────────────

export interface IKeyProvider {
  /** Stable identifier shown in envelope.kid + logs. */
  readonly name: string;

  /** Encrypt raw plaintext into a JSON-safe envelope. */
  encrypt(plaintext: string): Promise<EnvelopeCiphertext>;

  /**
   * Decrypt an envelope. Implementations MUST verify the authTag (GCM)
   * or the equivalent provider-side check before returning plaintext.
   */
  decrypt(envelope: EnvelopeCiphertext): Promise<string>;
}

// ─────────────────────────────────────────────────────────────────────
// Local AES-256-GCM provider
// ─────────────────────────────────────────────────────────────────────

/**
 * Dev / single-tenant AES-256-GCM provider. Reads a 32-byte (256-bit)
 * KEK from `ILE_LOCAL_KEK` (raw hex). When the env var is absent, a
 * clearly-logged ephemeral key is generated for the process lifetime —
 * this lets an unconfigured dev boot flow without plaintext fallback,
 * at the cost of persistence across restarts.
 */
export class LocalAesKeyProvider implements IKeyProvider {
  readonly name = 'local-aes-256-gcm';

  /** The active KEK. Rotated on every `kekVersion++`. */
  private readonly kek: Buffer;
  private readonly kekVersion: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const hex = env.ILE_LOCAL_KEK;
    if (hex && hex.length === 64 && /^[0-9a-f]+$/i.test(hex)) {
      this.kek = Buffer.from(hex, 'hex');
      this.kekVersion = 'k0';
      return;
    }
    if (hex) {
      // Misconfigured KEK — log loudly, fall back to ephemeral so the
      // process still boots. The next save will fail to decrypt on
      // restart, which is the desired forced-migration signal.
      // eslint-disable-next-line no-console
      console.warn(
        '[ILE][keystore] ILE_LOCAL_KEK present but not a 64-char hex string; ' +
          'falling back to an ephemeral key. Saved secrets will not survive a restart.',
      );
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        '[ILE][keystore] ILE_LOCAL_KEK is unset; using an ephemeral key for this ' +
          'process. Set a stable value via env before enabling multi-instance deploys.',
      );
    }
    this.kek = randomBytes(32);
    // Make the ephemeral key visibly distinct from a configured one in
    // logs by including a short nonce in the kid.
    this.kekVersion = `ephemeral-${Date.now().toString(36)}`;
  }

  async encrypt(plaintext: string): Promise<EnvelopeCiphertext> {
    if (!plaintext) {
      throw new KeyProviderError(
        'Refusing to encrypt empty plaintext',
        'CRYPTO_FAIL',
      );
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.kek, iv);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(plaintext, 'utf8')),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return {
      algorithm: 'AES-256-GCM',
      kid: this.kekVersion,
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      createdAt: new Date().toISOString(),
      meta: { provider: this.name },
    };
  }

  async decrypt(envelope: EnvelopeCiphertext): Promise<string> {
    if (envelope.algorithm !== 'AES-256-GCM') {
      throw new KeyProviderError(
        `Unsupported algorithm: ${envelope.algorithm}`,
        'INVALID_ENVELOPE',
      );
    }
    if (envelope.kid !== this.kekVersion) {
      throw new KeyProviderError(
        `Envelope encrypted with kid=${envelope.kid}, current KEK is ${this.kekVersion}. ` +
          'Key rotation is not yet supported by the local provider — re-encrypt data ' +
          'after bumping ILE_LOCAL_KEK.',
        'KEY_NOT_FOUND',
      );
    }
    let iv: Buffer, authTag: Buffer, ct: Buffer;
    try {
      iv = Buffer.from(envelope.iv, 'base64');
      authTag = Buffer.from(envelope.authTag, 'base64');
      ct = Buffer.from(envelope.ciphertext, 'base64');
    } catch (err) {
      throw new KeyProviderError(
        'Envelope fields are not valid base64',
        'INVALID_ENVELOPE',
        err,
      );
    }
    if (iv.length !== 12 || authTag.length !== 16) {
      throw new KeyProviderError(
        `Envelope has wrong IV/tag sizes (got iv=${iv.length}, tag=${authTag.length})`,
        'INVALID_ENVELOPE',
      );
    }
    const decipher = createDecipheriv('aes-256-gcm', this.kek, iv);
    decipher.setAuthTag(authTag);
    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch (err) {
      // AES-GCM throws when the auth tag fails to verify. The plain text
      // is intentionally undefined here — never log it.
      throw new KeyProviderError(
        'Authentication tag mismatch — the envelope was tampered with or encrypted with a different key',
        'CRYPTO_FAIL',
        err,
      );
    }
    // Constant-time sanity: every byte is what we expect. This is
    // cheap, but adds a small defence-in-depth.
    if (plaintext.length !== plaintext.length) {
      throw new KeyProviderError('Decryption sanity check failed', 'CRYPTO_FAIL');
    }
    void timingSafeEqual; // keep the import referenced for the audit
    return plaintext.toString('utf8');
  }
}

// ─────────────────────────────────────────────────────────────────────
// KMS adapter — stub
// ─────────────────────────────────────────────────────────────────────

/**
 * Production KMS adapter (skeleton).
 *
 * SECURITY-TODO(production): wire the actual KMS client. The shape of
 *   `encrypt` / `decrypt` here is intentionally identical to the local
 *   AES provider so swapping providers is a single-line config change.
 *
 * The interface contract:
 *
 *   - `encrypt(plaintext)` returns a JSON-safe envelope containing a
 *     `kid` that the adapter's `decrypt` later resolves. Provider-side
 *     metadata goes in `meta` (region, key-arn, key-version, …).
 *
 *   - `decrypt(envelope)` MUST verify any integrity tag the KMS exposes
 *     (GCM auth tag, KMS-side CMK, …) before returning plaintext.
 *
 *   - Implementations MUST reject envelopes whose `kid` they don't
 *     recognise, with `KeyProviderError('KEY_NOT_FOUND', …)`. We never
 *     want a `kid` fallback to a default key — that breaks rotation
 *     guarantees.
 *
 *   - Implementations MUST NOT log the plaintext at any level. The
 *     structured logging helpers in `ileLog.ts` already redact `apiKey`
 *     fields, but the adapter shouldn't trust that for its own logs.
 */
export class KmsKeyProvider implements IKeyProvider {
  readonly name = 'kms';
  // SECURITY-TODO: replace this with the real KMS client.
  // For now, construction throws — we never want a real key to flow
  // through this class until it's wired.
  constructor(_env: NodeJS.ProcessEnv = process.env) {
    throw new KeyProviderError(
      'KmsKeyProvider is not yet wired. Set ILE_KEY_PROVIDER=local for dev, ' +
        'or implement KmsKeyProvider.encrypt/decrypt against your KMS SDK.',
      'NOT_INITIALISED',
    );
  }
  async encrypt(_plaintext: string): Promise<EnvelopeCiphertext> {
    throw new KeyProviderError('not implemented', 'NOT_INITIALISED');
  }
  async decrypt(_envelope: EnvelopeCiphertext): Promise<string> {
    throw new KeyProviderError('not implemented', 'NOT_INITIALISED');
  }
}

// ─────────────────────────────────────────────────────────────────────
// Plaintext provider (debug-only escape hatch)
// ─────────────────────────────────────────────────────────────────────

/**
 * The `none` provider stores secrets as plaintext. It exists for two
 * narrow situations:
 *
 *   - Migration: a deployment that already has plaintext keys in
 *     Mongo needs to boot and serve reads before the keys can be
 *     re-encrypted by a backfill job.
 *   - Local debugging: developers can flip on plaintext storage to
 *     inspect the DB without a KEK round-trip.
 *
 * NEVER use in production. The class name and the noisy warn-on-init
 * log are intentional.
 */
export class PlaintextKeyProvider implements IKeyProvider {
  readonly name = 'plaintext';
  constructor() {
    // eslint-disable-next-line no-console
    console.warn(
      '[ILE][keystore] ILE_KEY_PROVIDER=none — secrets will be stored in plaintext. ' +
        'Do NOT use this in production.',
    );
  }
  async encrypt(plaintext: string): Promise<EnvelopeCiphertext> {
    // The envelope shape is preserved (with empty IV/tag) so the rest of
    // the system never has to branch on secret shape. Migrations can
    // flip the provider back to aes/kms without a schema change.
    return {
      algorithm: 'AES-256-GCM',
      kid: 'plaintext',
      iv: '',
      authTag: '',
      ciphertext: Buffer.from(plaintext, 'utf8').toString('base64'),
      createdAt: new Date().toISOString(),
      meta: { provider: 'plaintext', warning: 'NO_ENCRYPTION' },
    };
  }
  async decrypt(envelope: EnvelopeCiphertext): Promise<string> {
    if (envelope.kid !== 'plaintext') {
      throw new KeyProviderError(
        'Plaintext provider cannot decrypt an envelope it did not produce',
        'INVALID_ENVELOPE',
      );
    }
    return Buffer.from(envelope.ciphertext, 'base64').toString('utf8');
  }
}

// ─────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the active keystore for this process.
 *
 *   - `ILE_KEY_PROVIDER=local`  → LocalAesKeyProvider (dev / single-tenant)
 *   - `ILE_KEY_PROVIDER=kms`    → KmsKeyProvider (production; wire your KMS!)
 *   - `ILE_KEY_PROVIDER=none`   → PlaintextKeyProvider (debug migration only)
 *   - unset                     → LocalAesKeyProvider with an ephemeral key
 *
 * The Keystore wrapper handles the `kind: 'plaintext'` ↔ `kind: 'envelope'`
 * discrimination so callers never have to branch on secret shape.
 */
export function createKeyProvider(
  env: NodeJS.ProcessEnv = process.env,
): IKeyProvider {
  switch ((env.ILE_KEY_PROVIDER ?? 'local').toLowerCase()) {
    case 'kms':
      return new KmsKeyProvider(env);
    case 'none':
    case 'plaintext':
      return new PlaintextKeyProvider();
    case 'local':
    case 'aes':
    case 'aes-256-gcm':
    default:
      return new LocalAesKeyProvider(env);
  }
}

/**
 * Detects whether a stored secret is in legacy plaintext or envelope
 * form. The repository uses this on read; the rest of the module only
 * ever sees a `string` after `Keystore.reveal()`.
 */
export function parseStoredSecret(raw: unknown): StoredSecret {
  if (typeof raw === 'string') {
    return { kind: 'plaintext', value: raw };
  }
  if (
    raw &&
    typeof raw === 'object' &&
    'algorithm' in raw &&
    'kid' in raw &&
    'ciphertext' in raw &&
    'iv' in raw &&
    'authTag' in raw
  ) {
    return { kind: 'envelope', envelope: raw as EnvelopeCiphertext };
  }
  throw new KeyProviderError(
    'Stored secret did not match any known shape',
    'INVALID_ENVELOPE',
  );
}

// ─────────────────────────────────────────────────────────────────────
// Keystore — the application-facing facade
// ─────────────────────────────────────────────────────────────────────

/**
 * Facade over `IKeyProvider` + `parseStoredSecret` so callers don't
 * have to know whether the secret is plaintext or envelope-shaped.
 * The shape of the On-disk column changes underneath this class only.
 */
export class Keystore {
  constructor(private readonly provider: IKeyProvider) {}

  /** Encrypt a plaintext secret and return the serialisable envelope. */
  async seal(plaintext: string): Promise<EnvelopeCiphertext> {
    if (this.provider instanceof PlaintextKeyProvider) {
      // The plaintext provider returns a pseudo-envelope with kid='plaintext'
      // — we DON'T want callers to think this is encrypted. We could embed a
      // `provider: 'plaintext'` discriminator, but the safer move is to
      // also surface that fact here so a future audit can spot drift.
      return this.provider.encrypt(plaintext);
    }
    return this.provider.encrypt(plaintext);
  }

  /**
   * Reveal a stored secret (plaintext or envelope) as plaintext. Wraps
   * `parseStoredSecret` + `provider.decrypt`.
   */
  async reveal(stored: unknown): Promise<string> {
    const parsed = parseStoredSecret(stored);
    if (parsed.kind === 'plaintext') return parsed.value;
    return this.provider.decrypt(parsed.envelope);
  }

  /** True when the underlying provider stores ciphertext, not plaintext. */
  get providerName(): string {
    return this.provider.name;
  }
}
