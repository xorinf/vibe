import { injectable, inject } from 'inversify';
import { Collection, ObjectId } from 'mongodb';
import { MongoDatabase } from '#shared/database/index.js';
import { GLOBAL_TYPES } from '#root/types.js';
import { IleAiConfig } from '../services/providers/types.js';
import { ILE_TYPES } from '../types.js';
import { Keystore } from '../services/providers/keystore.js';
import { ileLog } from '../services/observability.js';

const COLLECTION = 'ile_ai_configs';

/**
 * On-disk shape for the `ile_ai_configs` collection.
 *
 * `apiKey` is persisted as a Keystore envelope (plaintext-in-Mongo is
 * banned). The `IleAiConfig` application type still carries a `string`
 * apiKey — the conversion happens at this boundary only.
 *
 * Backwards compatibility: pre-Keystore rows may have `apiKey` as a
 * raw string. `findByOwner` reads both shapes via `Keystore.reveal`,
 * which already detects legacy plaintext (`kind: 'plaintext'`) and
 * envelopes (`kind: 'envelope'`).
 */
interface IleAiConfigDoc {
  _id?: ObjectId;
  ownerId: string;
  provider: IleAiConfig['provider'];
  apiKey: unknown; // string (legacy) | EnvelopeCiphertext (current)
  model: string;
  baseUrl?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Per-owner ILE AI configuration. One document per teacher.
 *
 * The Keystore is wired here so `apiKey` is encrypted at rest. The
 * `Keystore.reveal()` call in `findByOwner` is what makes this safe
 * to expose the plaintext to the generation service: the disk holds
 * only envelopes, the boundary holds only plaintext.
 */
@injectable()
export class IleAiConfigRepository {
  constructor(
    @inject(GLOBAL_TYPES.Database) private readonly db: MongoDatabase,
    @inject(ILE_TYPES.Keystore) private readonly keystore: Keystore,
  ) {}

  private async col(): Promise<Collection<IleAiConfigDoc>> {
    return this.db.getCollection(COLLECTION) as unknown as Collection<IleAiConfigDoc>;
  }

  /**
   * Read a config and reveal its API key as plaintext.
   *
   * Errors from `Keystore.reveal` (auth-tag mismatch, kid mismatch,
   * KMS unreachable) propagate. The generation service treats those
   * as `not_configured` and asks the teacher to re-enter the key —
   * the recommended recovery path is also the safest one.
   */
  async findByOwner(ownerId: string): Promise<IleAiConfig | null> {
    const col = await this.col();
    const doc = await col.findOne({ ownerId });
    if (!doc) return null;
    let apiKey: string;
    try {
      apiKey = await this.keystore.reveal(doc.apiKey);
    } catch (err) {
      // The envelope is unreadable — never expose the raw `doc` to the
      // caller. The service layer maps this to "configure AI first".
      ileLog('warn', 'ile.ai_config.reveal_failed', {
        ownerId,
        provider: doc.provider,
        errorName: err instanceof Error ? err.name : 'unknown',
      });
      return null;
    }
    const { _id, apiKey: _stored, ...rest } = doc;
    void _stored;
    return { ...rest, apiKey } as IleAiConfig;
  }

  /**
   * Upsert a config. The plaintext `apiKey` from the input is sealed
   * via the Keystore before being written. The shape on disk is now
   * always an envelope — legacy plaintext rows are read transparently
   * but no new ones are written.
   *
   * Empty `apiKey` is rejected: we never overwrite an existing key
   * with the empty string (the service layer's "preserve previous key
   * on empty input" rule means an empty string never reaches this
   * method in normal flow, but the guard defends against bad callers).
   */
  async upsert(ownerId: string, patch: IleAiConfig): Promise<IleAiConfig> {
    if (!patch.apiKey || patch.apiKey.length === 0) {
      throw new Error(
        'Refusing to upsert ILE AI config with empty apiKey — service layer should preserve previous key.',
      );
    }
    const envelope = await this.keystore.seal(patch.apiKey);
    const col = await this.col();
    const now = new Date();
    await col.updateOne(
      { ownerId },
      {
        $set: {
          ownerId,
          provider: patch.provider,
          apiKey: envelope,
          model: patch.model,
          baseUrl: patch.baseUrl,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
    const found = await this.findByOwner(ownerId);
    if (!found) {
      // Should be unreachable — upsert succeeded. If the envelope is
      // immediately unreadable we surface the typed error so callers
      // can distinguish "config broken" from "config missing".
      throw new Error('Failed to read back upserted ILE AI config');
    }
    return found;
  }

  async delete(ownerId: string): Promise<void> {
    const col = await this.col();
    await col.deleteOne({ ownerId });
  }
}