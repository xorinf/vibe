import { describe, it, expect, beforeEach } from 'vitest';
import { ContextProviderRegistry } from '../ContextProviderRegistry.js';
import {
  ContextInput,
  ContextPhase,
  ContextProvider,
  ContextSource,
} from '../types.js';

function makeStubProvider(opts: {
  id: string;
  matches?: (input: ContextInput) => boolean;
  source?: ContextSource;
}): ContextProvider {
  return {
    canHandle: opts.matches ?? (() => true),
    extract: async () =>
      opts.source ?? {
        id: opts.id,
        type: 'manual',
        title: `Stub ${opts.id}`,
        content: `Content for ${opts.id}`,
        metadata: {},
        provenance: [],
        createdAt: new Date(),
      },
  };
}

const noopPhase = (_phase: ContextPhase): void => {
  // unused in these tests
};

describe('ContextProviderRegistry', () => {
  let registry: ContextProviderRegistry;

  beforeEach(() => {
    registry = new ContextProviderRegistry();
  });

  it('starts empty', () => {
    expect(registry.size()).toBe(0);
    expect(registry.all()).toEqual([]);
    expect(
      registry.findProvider({ primary: 'anything', source: 'youtube' }),
    ).toBeUndefined();
  });

  it('register() adds providers in order', () => {
    const a = makeStubProvider({ id: 'a' });
    const b = makeStubProvider({ id: 'b' });
    registry.register(a);
    registry.register(b);
    expect(registry.size()).toBe(2);
    expect(registry.all()).toEqual([a, b]);
  });

  it('register() is idempotent for the same instance', () => {
    const a = makeStubProvider({ id: 'a' });
    registry.register(a);
    registry.register(a);
    expect(registry.size()).toBe(1);
  });

  it('findProvider returns the FIRST matching provider', () => {
    const a = makeStubProvider({
      id: 'a',
      matches: (i) => i.source === 'youtube',
    });
    const b = makeStubProvider({
      id: 'b',
      matches: (i) => i.source === 'youtube' || i.source === 'pdf',
    });
    const c = makeStubProvider({
      id: 'c',
      matches: () => true,
    });
    registry.register(a);
    registry.register(b);
    registry.register(c);

    expect(registry.findProvider({ primary: 'x', source: 'youtube' })).toBe(a);
    expect(registry.findProvider({ primary: 'x', source: 'pdf' })).toBe(b);
    expect(registry.findProvider({ primary: 'x', source: 'manual' })).toBe(c);
  });

  it('findProvider returns undefined when nothing matches', () => {
    const a = makeStubProvider({
      id: 'a',
      matches: (i) => i.source === 'youtube',
    });
    registry.register(a);
    expect(
      registry.findProvider({ primary: 'x', source: 'pdf' }),
    ).toBeUndefined();
  });

  it('all() returns the providers currently registered', () => {
    const a = makeStubProvider({ id: 'a' });
    const b = makeStubProvider({ id: 'b' });
    registry.register(a);
    registry.register(b);
    const view = registry.all();
    expect(view).toHaveLength(2);
    expect(view).toContain(a);
    expect(view).toContain(b);
  });

  it('all() reflects subsequent register() calls', () => {
    const a = makeStubProvider({ id: 'a' });
    registry.register(a);
    const first = registry.all();
    expect(first).toHaveLength(1);
    const b = makeStubProvider({ id: 'b' });
    registry.register(b);
    // The returned array is a live view; subsequent registers are
    // visible through the same reference.
    expect(registry.all()).toHaveLength(2);
    expect(first).toHaveLength(2);
  });

  it('extract() round-trips through the registry', async () => {
    const expected: ContextSource = {
      id: 'x',
      type: 'manual',
      title: 'Round-trip',
      content: 'hello world',
      metadata: {},
      provenance: [],
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    const provider = makeStubProvider({
      id: 'rt',
      source: expected,
      matches: () => true,
    });
    registry.register(provider);
    const found = registry.findProvider({
      primary: 'p',
      source: 'manual',
    });
    expect(found).toBe(provider);
    const source = await found!.extract(
      { primary: 'p', source: 'manual' },
      new AbortController().signal,
      noopPhase,
    );
    expect(source).toEqual(expected);
  });
});
