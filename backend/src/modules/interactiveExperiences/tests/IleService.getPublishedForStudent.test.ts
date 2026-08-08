import { describe, expect, it, vi, beforeEach } from 'vitest';

// Repository stub — we replace the repo on the service instance
// directly so the test doesn't need to touch Mongo or Inversify.
// We're testing the gating logic of `getPublishedForStudent`,
// not the DB read path.
const repoStub = { findById: vi.fn() };
vi.mock('../repositories/IleRepository.js', () => ({
  IleRepository: class {
    findById = repoStub.findById;
  },
}));

// Minimal ItemRepository stub — the service injects it but
// getPublishedForStudent doesn't call it.
vi.mock('#shared/database/interfaces/IItemRepository.js', () => ({
  IItemRepository: class {},
}));

import { IleService } from '../services/IleService.js';

function makeIle(status: string, html: string) {
  return {
    _id: 'ile-1',
    title: 'Test ILE',
    status,
    html,
    courseId: 'c1',
    courseVersionId: 'v1',
  };
}

describe('IleService.getPublishedForStudent', () => {
  let service: IleService;

  beforeEach(() => {
    repoStub.findById.mockReset();
    service = new IleService(
      {} as any, // db — not used by this method
      repoStub as any, // repo — exposes findById
      {} as any, // itemRepo — not used by this method
    );
  });

  it('returns the ILE when status is draft and html is present', async () => {
    repoStub.findById.mockResolvedValue(makeIle('draft', '<div>hello</div>'));
    const result = await service.getPublishedForStudent('ile-1');
    expect(result).toMatchObject({
      _id: 'ile-1',
      title: 'Test ILE',
      html: '<div>hello</div>',
    });
  });

  it('returns the ILE when status is published', async () => {
    repoStub.findById.mockResolvedValue(makeIle('published', '<div>hello</div>'));
    const result = await service.getPublishedForStudent('ile-1');
    expect(result).not.toBeNull();
    expect(result?.html).toBe('<div>hello</div>');
  });

  it('returns null when status is archived', async () => {
    repoStub.findById.mockResolvedValue(makeIle('archived', '<div>hello</div>'));
    const result = await service.getPublishedForStudent('ile-1');
    expect(result).toBeNull();
  });

  it('returns null when html is empty (no content yet)', async () => {
    repoStub.findById.mockResolvedValue(makeIle('draft', ''));
    const result = await service.getPublishedForStudent('ile-1');
    expect(result).toBeNull();
  });

  it('returns null when html is whitespace-only', async () => {
    repoStub.findById.mockResolvedValue(makeIle('draft', '   \n  '));
    const result = await service.getPublishedForStudent('ile-1');
    expect(result).toBeNull();
  });

  it('returns null when the doc does not exist', async () => {
    repoStub.findById.mockResolvedValue(null);
    const result = await service.getPublishedForStudent('ile-1');
    expect(result).toBeNull();
  });

  it('intentionally omits the chat history in the student payload', async () => {
    repoStub.findById.mockResolvedValue({
      ...makeIle('draft', '<div>hello</div>'),
      history: [{ role: 'user', content: 'secret' }],
    });
    const result = await service.getPublishedForStudent('ile-1');
    expect(result).not.toHaveProperty('history');
  });
});
