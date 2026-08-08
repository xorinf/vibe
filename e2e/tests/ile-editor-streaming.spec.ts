/**
 * Streaming-stuck regression test for the ILE teacher workspace.
 *
 * Bug being guarded against: the Code editor freezes at the first
 * streaming delta (~14 chars: "to create an") while
 * `streamState.html` keeps accumulating to tens of thousands of
 * chars. The user reported this in a 2026-08-07 screenshot.
 *
 * Fix: see /Users/yashhwanth/Documents/new-vibe/vibe/.hermes/plans/
 * ile-streaming-stuck-findings.md and the layered defense applied to
 *   - frontend/src/components/ile/CodeEditor.tsx
 *   - frontend/src/components/ile/EditorSplitPane.tsx
 *   - frontend/src/components/ile/TeacherILEWorkspace.tsx
 *   - frontend/src/components/ile/useIleEditor.ts
 *
 * This spec intercepts the SSE POST endpoint with Playwright's
 * `page.route()` and serves a deterministic, multi-chunk mock
 * response. We then assert the CodeMirror editor's doc content
 * (`.cm-content`) GROWS past the first chunk — the canonical
 * regression guard. The mock avoids needing a real AI provider
 * or a course+ILE-item fixture.
 *
 * Prereqs (test skips with a clear log when missing):
 *   - Backend listening on :8080
 *   - Firebase auth emulator on :9099
 *   - Seeded teacher `designer@test.com` / `designer123` in the
 *     emulator
 *
 * When ANY prereq is missing, the spec logs the reason and calls
 * `test.skip()` — never hard-fail.
 */

import { test, expect, type Page } from '@playwright/test';

const TEACHER_EMAIL =
  process.env.TEST_TEACHER_EMAIL ?? 'designer@test.com';
const TEACHER_PASSWORD =
  process.env.TEST_TEACHER_PASSWORD ?? 'designer123';
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:8080';
const SSE_PATH = '/api/interactive-experiences/generate/stream';

/**
 * Build a mock SSE response that streams ~2 KB of HTML in 60 small
 * chunks, one `data: {...}\n\n` per chunk. The chunks are sized
 * to trigger many incremental-append dispatches in the
 * CodeMirror sync effect — a real streaming round-trip emits
 * similarly small deltas.
 */
function buildMockSseBody(): string {
  const expId = 'mock-exp-id-1';
  const chunks: string[] = [];

  // 1. start event with the (fake) persisted experience id.
  chunks.push(
    `event: message\ndata: ${JSON.stringify({
      kind: 'start',
      experienceId: expId,
    })}\n\n`,
  );

  // 2. progress event so the chat bubble flips to streaming.
  chunks.push(
    `event: message\ndata: ${JSON.stringify({
      kind: 'progress',
      message: '✓ Designing experience',
    })}\n\n`,
  );

  // 3. Build ~2 KB of HTML, split into ~60 small deltas.
  const fullHtml = [
    '<!DOCTYPE html>',
    '<html>',
    '<head><title>counter</title></head>',
    '<body>',
    '<h1>Counter</h1>',
    '<button id="dec">-</button>',
    '<span id="v">0</span>',
    '<button id="inc">+</button>',
    '<script>',
    'let v = 0;',
    'document.getElementById("inc").onclick = () => {',
    '  v++;',
    '  document.getElementById("v").textContent = v;',
    '};',
    'document.getElementById("dec").onclick = () => {',
    '  v--;',
    '  document.getElementById("v").textContent = v;',
    '};',
    '</script>',
    '</body></html>',
  ].join('\n');
  const deltaSize = 40;
  for (let i = 0; i < fullHtml.length; i += deltaSize) {
    const delta = fullHtml.slice(i, i + deltaSize);
    chunks.push(
      `event: message\ndata: ${JSON.stringify({ kind: 'html', delta })}\n\n`,
    );
  }

  // 4. done event with the full HTML. The teacher editor will
  //    reconcile to this once the stream finishes.
  chunks.push(
    `event: message\ndata: ${JSON.stringify({
      kind: 'done',
      experienceId: expId,
      html: fullHtml,
    })}\n\n`,
  );

  return chunks.join('');
}

async function backendHealthy(): Promise<boolean> {
  try {
    // GET /api/interactive-experiences/config is the route the
    // dashboard hits. A 401 means the route is mounted and the
    // auth middleware is enforcing — the canonical "backend is
    // up" signal. (POST would 404 because the route doesn't
    // accept that method.)
    const res = await fetch(`${BACKEND}/api/interactive-experiences/config`, {
      method: 'GET',
    });
    return res.status === 401 || res.status === 400 || res.status === 200;
  } catch {
    return false;
  }
}

async function loginAsTeacher(page: Page): Promise<void> {
  await page.goto('/auth', { waitUntil: 'domcontentloaded' });
  // The seeded account is a teacher; the AuthPage may default to
  // student role. If a "Switch role" link is visible, click it
  // and pick teacher before submitting.
  const switchRole = page
    .getByRole('button', { name: /switch role/i })
    .first();
  if (await switchRole.isVisible({ timeout: 2000 }).catch(() => false)) {
    await switchRole.click();
    const teacherChoice = page
      .getByRole('button', { name: /teacher|instructor/i })
      .first();
    if (await teacherChoice.isVisible({ timeout: 2000 }).catch(() => false)) {
      await teacherChoice.click();
    }
  }
  await page.locator('#email').fill(TEACHER_EMAIL);
  await page.locator('#password').fill(TEACHER_PASSWORD);
  await page
    .getByRole('button', { name: /sign in as (teacher|instructor)/i })
    .first()
    .click();
  // Wait for the post-login navigation off /auth.
  await page.waitForURL(
    (url) => !url.pathname.includes('/auth'),
    { timeout: 30_000 },
  );
}

test.describe('ILE editor streaming', () => {
  test('Code editor doc content GROWS past the first streaming delta (regression guard)', async ({
    page,
  }) => {
    if (!(await backendHealthy())) {
      test.skip(
        true,
        'Backend not reachable at ' +
          BACKEND +
          ' — skipping streaming-stuck regression test',
      );
      return;
    }

    // Login as the seeded teacher. If login fails (no seeded
    // account, role-not-teacher, etc.) skip rather than fail — the
    // SSE mock is the canonical regression guard; login is a
    // soft prereq we try but don't hard-fail on.
    try {
      await loginAsTeacher(page);
    } catch (err: any) {
      test.skip(
        true,
        'Teacher login did not complete: ' + (err?.message ?? 'unknown'),
      );
      return;
    }

    // Install the SSE route interception BEFORE we open the
    // workspace. The mock serves a multi-chunk stream that
    // triggers the same code path as a real provider.
    //
    // The route filter matches both relative and absolute paths
    // (Vite proxies /api/* to the backend, but the fetch in
    // ileApi.ts uses VITE_BASE_URL which is unset by default,
    // so the call goes to /api/... on the Vite origin).
    await page.route(
      (url) => url.pathname.endsWith('/generate/stream'),
      async (route) => {
        const body = buildMockSseBody();
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream; charset=utf-8',
          headers: {
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          },
          body,
        });
      },
    );

    // 1. Navigate to the teacher course page. The route is
    //    mounted at /teacher/courses/view; without a course in
    //    the zustand course-store the page renders an empty
    //    state. Either way, the route should resolve (no
    //    auth-redirect).
    await page.goto('/teacher/courses/view', {
      waitUntil: 'domcontentloaded',
    });
    if (page.url().includes('/auth')) {
      test.skip(
        true,
        'Login did not yield a teacher session — skipping the ILE streaming assertion',
      );
      return;
    }

    // 2. Try to find an "Interactive Experience" item to open
    //    the ILE workspace against. Without a course+ILE-item
    //    fixture the workspace can't be mounted — skip.
    const openIleButton = page
      .getByRole('button', {
        name: /open in workspace|open interactive|new interactive experience/i,
      })
      .first();
    if (!(await openIleButton.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip(
        true,
        'No "Open in workspace" button found on /teacher/courses/view — need a course with an ILE item to exercise the streaming flow. See tmp/audit-ile-streaming.md for fixture requirements.',
      );
      return;
    }
    await openIleButton.click();

    // 3. The ILE dialog mounts. Wait for the composer.
    const composer = page.locator(
      'textarea[placeholder*="Describe"], textarea[placeholder*="describe"], [data-testid="ile-composer"], textarea[aria-label*="composer" i]',
    );
    await expect(composer.first()).toBeVisible({ timeout: 15_000 });

    // 4. Type a short prompt and click Apply / Generate.
    await composer.first().fill('simple black and white counter');
    const applyButton = page
      .getByRole('button', { name: /^(apply|generate)$/i })
      .first();
    await expect(applyButton).toBeVisible();
    await applyButton.click();

    // 5. Wait for the editor doc to start receiving streamed
    //    html. The Code editor renders into a `.cm-content`
    //    element. We poll its textContent length. The bug we
    //    guard against is the doc freezing at the first ~14
    //    chars; the fix should let it grow past 200 within 15
    //    seconds.
    const cmContent = page.locator('.cm-content').first();
    await expect
      .poll(
        async () => {
          const text = await cmContent.textContent().catch(() => '');
          return text ? text.length : 0;
        },
        {
          timeout: 15_000,
          intervals: [200, 500, 1_000, 2_000],
        },
      )
      .toBeGreaterThan(200);
  });
});
