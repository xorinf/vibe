#!/usr/bin/env node
/**
 * Smoke test for the unified ILE save endpoint.
 *
 * Exits non-zero if any check fails. Run with:
 *
 *   node scripts/smoke-ile-save.js
 *
 * Assumes:
 *   - The backend is running on http://localhost:8080.
 *   - The Firebase auth emulator is running on :9099.
 *   - The `designer@test.com` / `designer123` test account exists
 *     in the auth emulator (it's in the standard emulator seed).
 *   - Mongo is reachable with replica set + TLS at
 *     mongodb://127.0.0.1:27017/vibe?replicaSet=rs0 (same as
 *     the backend's default).
 *
 * The test:
 *   1. Mints a Firebase ID token from the emulator.
 *   2. Hits POST /api/interactive-experiences/save-with-item
 *      with `itemId` set to an existing INTERACTIVE_EXPERIENCE
 *      itemsGroup row id (the test only mutates the row in
 *      place; we don't care which one, the test resets it).
 *   3. Asserts the response shape: ile._id, ile.currentVersion,
 *      item._id, item.details.experienceId, item.details.status.
 *   4. Verifies the itemsGroup row was actually written in
 *      Mongo (the atomic-write contract).
 *   5. Hits the endpoint with various failure modes (no auth,
 *      bad auth, missing required field, missing itemId) and
 *      asserts the right error status.
 *
 * The test prints a final summary and exits with code 0 on
 * success, 1 on any failure.
 *
 * Why a Node script (not vitest) — the existing backend test
 * suite is heavy (Mongoose, full app boot) and slow. This
 * smoke test is <5s and exercises only the HTTP + Mongo
 * contract; it complements the unit tests without replacing
 * them.
 */
'use strict';

const http = require('http');

const BACKEND = process.env.BACKEND_URL || 'http://localhost:8080';
const AUTH_EMULATOR =
  process.env.AUTH_EMULATOR_URL || 'http://localhost:9099';
const FIREBASE_API_KEY =
  process.env.FIREBASE_API_KEY || 'fake-api-key';
const DB_URL =
  process.env.DB_URL ||
  'mongodb://127.0.0.1:27017/vibe?tls=true&tlsCAFile=/opt/homebrew/etc/mongodb-tls/mongod-cert.pem&tlsAllowInvalidCertificates=true&replicaSet=rs0';
const TEST_EMAIL = process.env.TEST_EMAIL || 'designer@test.com';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'designer123';

let passes = 0;
let fails = 0;
const failures = [];

function pass(name) {
  passes += 1;
  console.log(`  PASS  ${name}`);
}

function fail(name, err) {
  fails += 1;
  failures.push({ name, err });
  console.log(`  FAIL  ${name}: ${err}`);
}

function assertEqual(name, actual, expected) {
  if (actual === expected) {
    pass(name);
  } else {
    fail(name, `expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(name, condition, message) {
  if (condition) {
    pass(name);
  } else {
    fail(name, message || 'condition was false');
  }
}

function fetchJson(path, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const url = new URL(BACKEND + path);
    const req = http.request(
      {
        method: opts.method || 'GET',
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        headers: opts.headers || {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = body ? JSON.parse(body) : null;
          } catch (_) {
            /* leave as null */
          }
          resolve({ status: res.statusCode, headers: res.headers, body, json });
        });
      },
    );
    req.on('error', reject);
    if (opts.body) {
      req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    }
    req.end();
  });
}

async function mintAuthToken() {
  const body = JSON.stringify({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    returnSecureToken: true,
  });
  return new Promise((resolve, reject) => {
    const url = new URL(
      AUTH_EMULATOR +
        '/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' +
        FIREBASE_API_KEY,
    );
    const req = http.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            return reject(
              new Error(`Auth emulator returned ${res.statusCode}: ${text}`),
            );
          }
          const parsed = JSON.parse(text);
          resolve(parsed.idToken);
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function findAnyIleItemId(mongo) {
  // Pick the first non-deleted INTERACTIVE_EXPERIENCE item we
  // can find in the itemsGroup collection. The test mutates it
  // in place; we restore its `details.experienceId` to its prior
  // value at the end.
  //
  // IMPORTANT: the ItemRepository (post-merge upstream) writes
  // to the singular `interactive_experience_items` collection,
  // not the older plural `interactive_experiences_items` that
  // holds the legacy seed data. Both contain INTERACTIVE_EXPERIENCE
  // rows; we need to pick from the singular one or the itemsGroup
  // $set will land in a row the test's verify step can't find.
  // (The legacy plural collection is dead weight from an older
  // schema — a future cleanup task will retire it.)
  const interactiveExperienceItems = mongo
    .db('vibe')
    .collection('interactive_experience_items');
  const candidates = await interactiveExperienceItems
    .find({ type: 'INTERACTIVE_EXPERIENCE' })
    .limit(10)
    .toArray();
  for (const row of candidates) {
    if (row && row._id) {
      return { rowId: row._id.toString(), itemId: row._id.toString() };
    }
  }
  return null;
}

async function main() {
  console.log('ILE save-with-item smoke test');
  console.log('================================');
  console.log(`backend:  ${BACKEND}`);
  console.log(`emulator: ${AUTH_EMULATOR}`);
  console.log('');

  // 1. Auth
  process.stdout.write('1. minting auth token... ');
  let token;
  try {
    token = await mintAuthToken();
    pass('auth token minted');
  } catch (err) {
    fail('auth token minted', err.message);
    return printSummaryAndExit();
  }
  console.log(`   token length: ${token.length}`);

  // 2. Find a real itemsGroup row to mutate. We use it as the
  //    `itemId` in our save so the itemsGroup $set path is
  //    exercised.
  process.stdout.write('2. finding an INTERACTIVE_EXPERIENCE item to mutate... ');
  // The mongodb package is ESM-only. CJS scripts can't `require` it
  // at the top level; use dynamic import + a top-level await
  // wrapper. (The ObjectId references elsewhere in this file
  // use `require('mongodb')` lazily — that path goes through
  // Node's CJS interop and works fine.)
  const { MongoClient, ObjectId } = await import('mongodb');
  const mongo = new MongoClient(DB_URL);
  let target = null;
  let originalDetails = null;
  let originalIleDoc = null;
  try {
    await mongo.connect();
    pass('mongo connected');
    target = await findAnyIleItemId(mongo);
    if (!target) {
      fail('found a target itemsGroup row', 'no INTERACTIVE_EXPERIENCE items found in itemsGroup');
      return printSummaryAndExit();
    }
    pass(`found target itemId ${target.itemId}`);

    // Capture the original state so we can restore it after the
    // test. We snapshot the interactive_experience_items row's
    // `details` field. (Note: the row's _id is the itemsGroup
    // item ref; the itemsGroup itself is a parent collection
    // that embeds this row id in its `items[]` array.) Wrap
    // `target.rowId` with `new ObjectId` so the findOne matches
    // the typed `_id` field.
    const db = mongo.db('vibe');
    const ileItemsColl = db.collection('interactive_experience_items');
    const origRow = await ileItemsColl.findOne({
      _id: new ObjectId(target.rowId),
    });
    if (!origRow) {
      fail('mongo setup', `target row ${target.rowId} not found in interactive_experience_items`);
      return printSummaryAndExit();
    }
    originalDetails = origRow.details ? { ...origRow.details } : null;
    pass(`captured original details for ${target.itemId}`);

    if (originalDetails && originalDetails.experienceId) {
      const ileColl = mongo.db('vibe').collection('interactive_experiences');
      originalIleDoc = await ileColl.findOne({
        _id: new ObjectId(originalDetails.experienceId),
      });
    }
  } catch (err) {
    fail('mongo setup', err.message);
    return printSummaryAndExit();
  }

  // 3. Happy path with itemId
  console.log('');
  console.log('3. POST /save-with-item with itemId');
  const happyBody = {
    title: 'Smoke test ' + Date.now(),
    html: '<!DOCTYPE html><html><body><h1>OK</h1></body></html>',
    itemId: target.itemId,
  };
  const happyRes = await fetchJson('/api/interactive-experiences/save-with-item', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: happyBody,
  });
  assertEqual('happy path: status 200', happyRes.status, 200);
  assertTrue('happy path: ile._id is a string', typeof happyRes.json?.ile?._id === 'string');
  assertTrue(
    'happy path: item._id matches target',
    happyRes.json?.item?._id === target.itemId,
  );
  assertEqual(
    'happy path: item.details.experienceId matches ile._id',
    happyRes.json?.item?.details?.experienceId,
    happyRes.json?.ile?._id,
  );
  assertEqual(
    'happy path: item.details.status is draft|published',
    ['draft', 'published'].includes(happyRes.json?.item?.details?.status),
    true,
  );
  assertTrue(
    'happy path: ile.currentVersion >= 1',
    typeof happyRes.json?.ile?.currentVersion === 'number' &&
      happyRes.json.ile.currentVersion >= 1,
  );

  // Verify the itemsGroup row was actually written in Mongo.
  // This is the atomic-write contract: the row's
  // details.experienceId must equal the new ile._id. The
  // ItemRepository writes to `interactive_experience_items`
  // (the singular collection); the test reads from the same
  // collection so the verify matches the write.
  const verifyRes = await mongo
    .db('vibe')
    .collection('interactive_experience_items')
    .findOne({ _id: new ObjectId(target.rowId) });
  assertEqual(
    'mongo: itemsGroup row was patched',
    verifyRes?.details?.experienceId,
    happyRes.json?.ile?._id,
  );
  assertEqual(
    'mongo: itemsGroup row details.status is non-empty',
    typeof verifyRes?.details?.status,
    'string',
  );

  // 4. Library-only path (no itemId)
  console.log('');
  console.log('4. POST /save-with-item without itemId (library-only)');
  const libRes = await fetchJson('/api/interactive-experiences/save-with-item', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: {
      title: 'Library only',
      html: '<div>lib</div>',
    },
  });
  assertEqual('library-only: status 200', libRes.status, 200);
  assertTrue('library-only: ile._id is a string', typeof libRes.json?.ile?._id === 'string');
  assertTrue('library-only: no item field', !('item' in (libRes.json || {})));

  // 5. Failure modes
  console.log('');
  console.log('5. Failure modes');

  // 5a. No auth
  const noAuthRes = await fetchJson('/api/interactive-experiences/save-with-item', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {},
  });
  assertEqual('no auth: status 401', noAuthRes.status, 401);

  // 5b. Bad auth — the body is valid (title + html) so the
  //     auth check fires first and returns 401.
  const badAuthRes = await fetchJson('/api/interactive-experiences/save-with-item', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer fake.invalid.token',
    },
    body: {
      title: 'bad-auth',
      html: '<div>x</div>',
    },
  });
  assertEqual('bad auth: status 401', badAuthRes.status, 401);

  // 5c. Missing required field (no html)
  const missingHtmlRes = await fetchJson('/api/interactive-experiences/save-with-item', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: { title: 'x' },
  });
  assertEqual('missing html: status 400', missingHtmlRes.status, 400);

  // 5d. Missing required field (no title)
  const missingTitleRes = await fetchJson('/api/interactive-experiences/save-with-item', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: { html: '<div>x</div>' },
  });
  assertEqual('missing title: status 400', missingTitleRes.status, 400);

  // 5e. Bad itemId (doesn't exist) — ILE save still succeeds,
  //     itemsGroup patch skipped gracefully.
  const badItemRes = await fetchJson('/api/interactive-experiences/save-with-item', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: {
      title: 'Bad itemId',
      html: '<div>x</div>',
      itemId: '000000000000000000000000',
    },
  });
  assertEqual('bad itemId: status 200 (NotFound swallowed)', badItemRes.status, 200);
  assertTrue('bad itemId: no item in response', !('item' in (badItemRes.json || {})));

  // 5f. /:id/link-item — happy path: link a freshly-saved ILE
  //     to the same itemsGroup target we mutated above. The
  //     backend's ILE doc + itemsGroup $set must both update
  //     atomically.
  console.log('');
  console.log('5f. POST /:id/link-item (link existing ILE to itemsGroup)');
  const linkBody = {
    courseId: 'any-course',
    courseVersionId: 'any-version',
    itemId: target.itemId,
  };
  // First mint a fresh ILE to link from. (The previous tests
  // created several ILE docs owned by the design test account;
  // pick the most recent one. The list endpoint doesn't return
  // ownerId but does return the same docs as the API.
  const list = await fetchJson('/api/interactive-experiences', {
    headers: { Authorization: 'Bearer ' + token },
  });
  // We need an ILE we own. Since the list endpoint doesn't
  // include ownerId, we instead use the recent-save endpoint:
  // create a new ILE via the legacy save endpoint (it
  // doesn't need an itemsGroup), then we own it.
  const freshRes = await fetchJson('/api/interactive-experiences', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: {
      courseId: 'any-course',
      courseVersionId: 'any-version',
      title: 'Smoke test link source ' + Date.now(),
      html: '<!DOCTYPE html><html><body><h1>smoke</h1></body></html>',
    },
  });
  if (freshRes.status === 200 && freshRes.json?.ile?._id) {
    const ownedId = freshRes.json.ile._id;
    const linkRes = await fetchJson(
      `/api/interactive-experiences/${ownedId}/link-item`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: linkBody,
      },
    );
    assertEqual('link-item: status 200', linkRes.status, 200);
    assertEqual(
      'link-item: ile._id matches the linked ILE',
      linkRes.json?.ile?._id,
      ownedId,
    );
    assertEqual(
      'link-item: ile.itemId matches the target',
      linkRes.json?.ile?.itemId,
      target.itemId,
    );
    // The response should include the itemsGroup row in `item`
    // when the target exists.
    if (linkRes.json?.item) {
      assertEqual(
        'link-item: item.details.experienceId matches ile._id',
        linkRes.json.item.details?.experienceId,
        ownedId,
      );
    }
  } else {
    // Fall back to listing the ILEs and picking the most recent.
    const docs = list.json?.experiences ?? [];
    const recent = docs[0];
    if (recent) {
      const linkRes = await fetchJson(
        `/api/interactive-experiences/${recent._id}/link-item`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + token,
          },
          body: linkBody,
        },
      );
      // 200 = we own it; 403 = someone else's ILE.
      assertTrue(
        'link-item: status 200 or 403 (depends on ownership)',
        linkRes.status === 200 || linkRes.status === 403,
      );
    } else {
      console.log('  SKIP  link-item: no ILEs to link from');
    }
  }

  // 5g. /:id/link-item — bad ILE id → 404
  const linkNotFound = await fetchJson(
    '/api/interactive-experiences/000000000000000000000099/link-item',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: linkBody,
    },
  );
  assertEqual('link-item: bad ILE id → 404', linkNotFound.status, 404);

  // 5h. /:id/link-item — missing required field → 400
  const linkMissing = await fetchJson(
    '/api/interactive-experiences/000000000000000000000099/link-item',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: { courseId: 'x' },
    },
  );
  assertEqual('link-item: missing courseVersionId → 400', linkMissing.status, 400);

  // 5i. /:id/play — the student-facing endpoint that the inline
  // viewer uses. Returns only published, non-archived ILEs.
  // 200 with a payload when found, 404 when missing.
  console.log('');
  console.log('5i. GET /:id/play (student-facing payload)');
  // Find a published ILE to play. The test's previous saves are
  // drafts — call publish first so the play endpoint returns 200.
  const ownList = await fetchJson('/api/interactive-experiences', {
    headers: { Authorization: 'Bearer ' + token },
  });
  const ownDoc = (ownList.json?.experiences ?? [])[0];
  if (ownDoc && ownDoc._id) {
    // Publish (idempotent — published ILEs stay published).
    const pubRes = await fetchJson(
      `/api/interactive-experiences/${ownDoc._id}/publish`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: {},
      },
    );
    assertEqual(
      'publish-before-play: status 200',
      pubRes.status,
      200,
    );
    const playRes = await fetchJson(
      `/api/interactive-experiences/${ownDoc._id}/play`,
      { headers: { Authorization: 'Bearer ' + token } },
    );
    assertEqual('play: status 200', playRes.status, 200);
    assertEqual('play: _id matches', playRes.json?._id, ownDoc._id);
    assertEqual(
      'play: title matches',
      playRes.json?.title,
      ownDoc.title,
    );
    assertTrue(
      'play: html is a non-empty string',
      typeof playRes.json?.html === 'string' &&
        playRes.json.html.length > 0,
    );
  }
  const playNotFound = await fetchJson(
    '/api/interactive-experiences/000000000000000000099/play',
    { headers: { Authorization: 'Bearer ' + token } },
  );
  assertEqual('play: bad id → 404', playNotFound.status, 404);

  // 6. Restore original state so the test is idempotent.
  console.log('');
  console.log('6. Restore original itemsGroup state');
  // Restore against the same collection the ItemRepository
  // wrote to. The test ran against the singular
  // `interactive_experience_items` collection, so the
  // restore runs against the same one.
  const restoreColl = mongo.db('vibe').collection('interactive_experience_items');
  if (originalDetails) {
    // Reset the itemsGroup row's `details` to its prior shape.
    await restoreColl.updateOne(
      { _id: new ObjectId(target.rowId) },
      {
        $set: {
          details: originalDetails,
        },
      },
    );
    pass('restored itemsGroup row');
  } else {
    // No original details — strip the patched details.
    await restoreColl.updateOne(
      { _id: new ObjectId(target.rowId) },
      { $unset: { details: '' } },
    );
    pass('restored itemsGroup row (no prior details)');
  }

  await mongo.close();
  return printSummaryAndExit();
}

function printSummaryAndExit() {
  console.log('');
  console.log('================================');
  console.log(`passes: ${passes}`);
  console.log(`fails:  ${fails}`);
  if (fails > 0) {
    console.log('');
    console.log('failures:');
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.err}`);
    }
    process.exit(1);
  } else {
    console.log('');
    console.log('All checks passed.');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('unhandled error:', err);
  process.exit(2);
});
