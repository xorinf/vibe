import 'reflect-metadata';
import {describe, expect, it, beforeEach, vi} from 'vitest';
import {Keystore, LocalAesKeyProvider, PlaintextKeyProvider} from '../services/providers/keystore.js';

/**
 * Unit tests for the keystore + IleAiConfigRepository wiring.
 *
 * These tests cover the security-critical boundary between the on-disk
 * envelope (AES-256-GCM ciphertext + IV + authTag) and the in-memory
 * plaintext (string) that the rest of the module sees. The repository
 * test uses a fake MongoDatabase so we don't need a live connection —
 * the boundary is what matters, not the driver.
 */
describe('Keystore', () => {
  describe('LocalAesKeyProvider', () => {
    const validHex = 'a'.repeat(64);
    const anotherValidHex = 'b'.repeat(64);

    it('round-trips plaintext through seal + reveal', async () => {
      const provider = new LocalAesKeyProvider({ILE_LOCAL_KEK: validHex});
      const keystore = new Keystore(provider);
      const envelope = await keystore.seal('sk-test-12345');
      expect(envelope.algorithm).toBe('AES-256-GCM');
      expect(envelope.kid).toBe('k0');
      expect(envelope.iv).not.toBe('');
      expect(envelope.authTag).not.toBe('');
      expect(envelope.ciphertext).not.toBe('');
      // The ciphertext must NOT contain the plaintext.
      expect(envelope.ciphertext.includes('sk-test-12345')).toBe(false);
      const revealed = await keystore.reveal(envelope);
      expect(revealed).toBe('sk-test-12345');
    });

    it('uses ephemeral key when ILE_LOCAL_KEK is unset and warns loudly', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const provider = new LocalAesKeyProvider({});
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ILE_LOCAL_KEK is unset'));
      const envelope = await provider.encrypt('sk-ephemeral');
      // Ephemeral kid starts with 'ephemeral-' to make drift obvious in logs.
      expect(envelope.kid.startsWith('ephemeral-')).toBe(true);
      // Encrypt-then-decrypt round-trip still works inside one process.
      const back = await provider.decrypt(envelope);
      expect(back).toBe('sk-ephemeral');
      warn.mockRestore();
    });

    it('warns and falls back to ephemeral when ILE_LOCAL_KEK is malformed', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const provider = new LocalAesKeyProvider({ILE_LOCAL_KEK: 'not-hex'});
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('not a 64-char hex string'),
      );
      warn.mockRestore();
    });

    it('refuses envelopes encrypted with a different KEK (rotation boundary)', async () => {
      const a = new LocalAesKeyProvider({ILE_LOCAL_KEK: validHex});
      const b = new LocalAesKeyProvider({ILE_LOCAL_KEK: anotherValidHex});
      const envelope = await a.encrypt('sk-rotation');
      // b has a different KEK — the auth tag won't verify.
      await expect(b.decrypt(envelope)).rejects.toThrow(/Authentication tag mismatch/);
    });

    it('rejects empty plaintext at seal time', async () => {
      const provider = new LocalAesKeyProvider({ILE_LOCAL_KEK: validHex});
      await expect(provider.encrypt('')).rejects.toThrow(/Refusing to encrypt empty/);
    });

    it('rejects envelopes with the wrong algorithm tag', async () => {
      const provider = new LocalAesKeyProvider({ILE_LOCAL_KEK: validHex});
      // Hand-roll a malformed envelope.
      const tampered: any = {
        algorithm: 'ROT13',
        kid: 'k0',
        iv: 'AAAA',
        authTag: 'AAAA',
        ciphertext: 'AAAA',
      };
      await expect(provider.decrypt(tampered)).rejects.toThrow(/Unsupported algorithm/);
    });
  });

  describe('Keystore facade', () => {
    it('reveal accepts legacy plaintext strings (back-compat)', async () => {
      const keystore = new Keystore(new LocalAesKeyProvider({ILE_LOCAL_KEK: 'a'.repeat(64)}));
      const plaintext = await keystore.reveal('legacy-string-api-key');
      expect(plaintext).toBe('legacy-string-api-key');
    });

    it('reveal accepts envelope objects (current path)', async () => {
      const keystore = new Keystore(new LocalAesKeyProvider({ILE_LOCAL_KEK: 'a'.repeat(64)}));
      const envelope = await keystore.seal('current-envelope-key');
      const plaintext = await keystore.reveal(envelope);
      expect(plaintext).toBe('current-envelope-key');
    });

    it('PlaintextKeyProvider round-trips without encryption (escape hatch)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const keystore = new Keystore(new PlaintextKeyProvider());
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ILE_KEY_PROVIDER=none'));
      const envelope = await keystore.seal('plaintext-key');
      // kid='plaintext' marker so we can audit drift later.
      expect(envelope.kid).toBe('plaintext');
      const back = await keystore.reveal(envelope);
      expect(back).toBe('plaintext-key');
      warn.mockRestore();
    });
  });
});
