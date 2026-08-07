import 'reflect-metadata';
import {ObjectId} from 'mongodb';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {IleRepository} from '../repositories/IleRepository.js';

/**
 * One focused check for `saveAndAppendVersion`: the assigned version
 * number returned from step 1 is the same one stamped on the snapshot
 * pushed in step 2. If this drifts, version history corrupts silently.
 *
 * Bypasses Mongo by subclassing IleRepository and overriding the private
 * `col()` accessor. Less ceremony than wiring mongodb-memory-server for
 * one assertion; the wiring lives in the controller integration tests.
 */
class FakeRepo extends IleRepository {
  // Override the private col() by re-declaring it with the same name.
  // The base class uses `this.col()` everywhere, so this shadows it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private fakeCol: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(fakeCol: any) {
    super({getCollection: () => fakeCol} as any);
    this.fakeCol = fakeCol;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async col(): Promise<any> {
    return this.fakeCol;
  }
}

describe('IleRepository.saveAndAppendVersion', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let findOneAndUpdate: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let updateOne: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let repo: FakeRepo;
  const id = new ObjectId().toHexString();

  beforeEach(() => {
    findOneAndUpdate = vi.fn();
    updateOne = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repo = new FakeRepo({findOneAndUpdate, updateOne});
  });

  it('stamps the snapshot with the post-increment version number', async () => {
    // Step 1 returns the bumped doc with currentVersion=7.
    const bumpedDoc = {
      _id: new ObjectId(id),
      currentVersion: 7,
      title: 'new title',
      html: '<html>x</html>',
    };
    findOneAndUpdate.mockResolvedValue(bumpedDoc);
    updateOne.mockResolvedValue({acknowledged: true});

    const result = await repo.saveAndAppendVersion(
      id,
      {title: 'new title', html: '<html>x</html>'} as any,
      {
        savedBy: 'teacher-1',
        title: 'new title',
        html: '<html>x</html>',
        prompt: 'p',
      } as any,
    );

    // Two writes total (step 1 + step 2).
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(updateOne).toHaveBeenCalledTimes(1);

    // Step 2's $push must carry the assigned version number.
    const pushArg = updateOne.mock.calls[0][1];
    expect(pushArg.$push.versions.version).toBe(7);
    expect(pushArg.$push.versions.savedAt).toBeInstanceOf(Date);
    expect(pushArg.$push.versions.htmlLength).toBe('<html>x</html>'.length);

    // Returns the bumped doc (no extra findById round-trip).
    expect(result?.currentVersion).toBe(7);
    expect(result?.title).toBe('new title');
  });

  it('returns null when the doc id is not found', async () => {
    findOneAndUpdate.mockResolvedValue(null);
    const result = await repo.saveAndAppendVersion(id, {} as any, {} as any);
    expect(result).toBeNull();
    // Step 2 must not run when step 1 found nothing — otherwise we'd
    // push a phantom snapshot onto a non-existent doc.
    expect(updateOne).not.toHaveBeenCalled();
  });
});
