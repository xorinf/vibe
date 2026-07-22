import 'reflect-metadata';
import {EventEmitter} from 'node:events';
import {describe, expect, it, beforeEach, vi} from 'vitest';
import {IleController} from '../controllers/IleController.js';
import {IleGenerationService} from '../services/IleGenerationService.js';
import {ContextProviderError} from '../context/types.js';
import {ProviderRateLimitError} from '../services/providers/types.js';

const mocks = vi.hoisted(() => ({
  build: vi.fn(),
  insert: vi.fn(),
  setContext: vi.fn(),
  appendHistory: vi.fn(),
  update: vi.fn(),
  loadConfigForOwner: vi.fn(),
  stream: vi.fn(),
  createProvider: vi.fn(),
}));

vi.mock('../context/ContextBuilder.js', () => ({ContextBuilder: class {build = mocks.build;}}));
vi.mock('../services/providers/index.js', () => ({createProvider: mocks.createProvider}));
vi.mock('../repositories/IleRepository.js', () => ({IleRepository: class {
  insert = mocks.insert;
  setContext = mocks.setContext;
  appendHistory = mocks.appendHistory;
  update = mocks.update;
}}));

const source = {
  id: 'dQw4w9WgXcQ',
  type: 'youtube' as const,
  title: 'A lesson',
  content: 'transcript text',
  metadata: {
    winningStrategy: 'creator-captions',
    transcriptHash: 'hash-123',
  },
  provenance: [],
  createdAt: new Date('2026-07-23T00:00:00.000Z'),
};
const context = {sources: [source], mergedContent: source.content};
const body = {
  source: 'youtube' as const,
  input: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  prompt: 'Explain X',
  courseId: 'course-1',
  courseVersionId: 'version-1',
};

function request() {
  const req = new EventEmitter() as EventEmitter & {headers: Record<string, string>};
  req.headers = {};
  return req;
}
function response() {
  return {set: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn()} as any;
}
function sse() {
  const session = {emit: vi.fn(), close: vi.fn()};
  return {session, service: {attach: vi.fn().mockReturnValue(session)} as any};
}
function controller(overrides: Record<string, unknown> = {}) {
  const {service, session} = sse();
  const generation = new IleGenerationService(
    service,
    {insert: mocks.insert, setContext: mocks.setContext, appendHistory: mocks.appendHistory, update: mocks.update} as any,
    {loadConfigForOwner: mocks.loadConfigForOwner} as any,
    {buildAssetContextFragment: vi.fn().mockResolvedValue('')} as any,
    {build: mocks.build} as any,
  );
  Object.assign(generation as any, overrides);
  const c = new IleController(
    generation,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return {c, generation, service, session};
}
function events(session: {emit: ReturnType<typeof vi.fn>}) {
  return session.emit.mock.calls.map(([event, payload]) => ({event, payload}));
}
function configureProvider(chunks: AsyncIterable<any> = (async function* () {
  yield {kind: 'text', delta: '<!DOCTYPE html><html></html>'};
})()) {
  mocks.loadConfigForOwner.mockResolvedValue({ownerId: 'teacher-123', provider: 'openai', apiKey: 'key', model: 'model'});
  mocks.createProvider.mockReturnValue({stream: mocks.stream});
  mocks.stream.mockReturnValue(chunks);
  mocks.insert.mockResolvedValue({_id: 'exp-1'});
  mocks.setContext.mockResolvedValue(undefined);
  mocks.appendHistory.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue(undefined);
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  configureProvider();
  mocks.build.mockResolvedValue(context);
});

describe('IleController.generateFromContextStream', () => {
  it('delegates a valid body to generation with the authenticated owner', async () => {
    const {c, session} = controller();
    await c.generateFromContextStream(body as any, {_id: 'teacher-123'} as any, request() as any, response());
    expect(mocks.build).toHaveBeenCalledWith(
      expect.objectContaining({source: 'youtube', primary: body.input, ownerId: 'teacher-123'}),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(events(session)[0].event).toBe('start');
  });

  it.each([
    ['missing source', {...body, source: undefined}],
    ['invalid source', {...body, source: 'pdf'}],
    ['empty input', {...body, input: ''}],
    ['empty prompt', {...body, prompt: ''}],
    ['missing courseId', {...body, courseId: undefined}],
    ['missing courseVersionId', {...body, courseVersionId: undefined}],
  ])('passes %s to the routing-controllers validator contract', async (_name, invalid) => {
    const {c} = controller();
    await c.generateFromContextStream(invalid as any, {_id: 'teacher-123'} as any, request() as any, response());
    expect(mocks.build).toHaveBeenCalled();
  });

  it('emits start, progress, html, and done and persists only a context reference', async () => {
    const {c, session} = controller();
    await c.generateFromContextStream(body as any, {_id: 'teacher-123'} as any, request() as any, response());
    const emitted = events(session);
    expect(emitted.map((e) => e.event)).toEqual(['start', 'progress', 'html', 'progress', 'done']);
    expect(mocks.setContext).toHaveBeenCalledWith('exp-1', {
      source: 'youtube', sourceUrl: source.id, title: source.title,
      provider: 'creator-captions', transcriptHash: 'hash-123', createdAt: source.createdAt,
    });
    expect(mocks.appendHistory).toHaveBeenCalledWith('exp-1', expect.objectContaining({
      role: 'assistant', html: '<!DOCTYPE html><html></html>',
    }));
    expect(JSON.stringify(mocks.setContext.mock.calls)).not.toContain('transcript text');
    expect(JSON.stringify(mocks.insert.mock.calls)).not.toContain('ContextSource');
  });

  it.each([
    ['unsupported', 'We don\'t know how to use that input yet. Try a different source.'],
    ['invalid_input', 'That YouTube link is not valid. Check the URL and try again.'],
    ['not_configured', expect.stringContaining('Whisper')],
    ['cancelled', 'Generation cancelled.'],
  ] as const)('surfaces context error %s', async (kind, message) => {
    mocks.build.mockRejectedValue(new ContextProviderError('internal', typeof message === 'string' ? message : 'missing dependencies', kind));
    const {c, session} = controller();
    await c.generateFromContextStream(body as any, {_id: 'teacher-123'} as any, request() as any, response());
    expect(events(session).at(-1)?.payload).toEqual(expect.objectContaining({kind, message: expect.any(String)}));
    if (kind === 'not_configured') {
      expect(events(session).at(-1)?.payload.message).toContain('missing dependencies');
    }
  });

  it('surfaces the private-video friendly unsupported message', async () => {
    mocks.build.mockRejectedValue(new ContextProviderError('private', 'This video is private or unavailable. Try a public video.', 'unsupported'));
    const {c, session} = controller();
    await c.generateFromContextStream(body as any, {_id: 'teacher-123'} as any, request() as any, response());
    expect(events(session).at(-1)?.payload).toEqual({message: 'This video is private or unavailable. Try a public video.', kind: 'unsupported'});
  });

  it('surfaces a provider rate limit with upstream status', async () => {
    mocks.stream.mockReturnValue((async function* () {
      yield {kind: 'text', delta: '<p>partial</p>'};
      throw new ProviderRateLimitError('Upstream rate limited', {upstreamStatus: 429});
    })());
    const {c, session} = controller();
    await c.generateFromContextStream(body as any, {_id: 'teacher-123'} as any, request() as any, response());
    expect(events(session).at(-1)?.payload).toEqual(expect.objectContaining({kind: 'rate_limit', upstreamStatus: 429}));
  });

  it('emits client_disconnect cancellation during the stream', async () => {
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const req = request();
    mocks.stream.mockReturnValue((async function* () {
      yield {kind: 'text', delta: '<p>partial</p>'};
      await next;
      yield {kind: 'text', delta: '<p>ignored</p>'};
    })());
    const {c, session} = controller();
    const promise = c.generateFromContextStream(body as any, {_id: 'teacher-123'} as any, req as any, response());
    await Promise.resolve();
    req.emit('close');
    release();
    await promise;
    expect(events(session).at(-1)?.payload).toEqual(expect.objectContaining({kind: 'cancelled', reason: 'client_disconnect'}));
  });

  it('surfaces missing AI configuration', async () => {
    mocks.loadConfigForOwner.mockResolvedValue(null);
    const {c, session} = controller();
    await c.generateFromContextStream(body as any, {_id: 'teacher-123'} as any, request() as any, response());
    expect(events(session).at(-1)?.payload).toEqual(expect.objectContaining({
      message: expect.stringContaining('No ILE AI configuration found'),
    }));
  });
});
