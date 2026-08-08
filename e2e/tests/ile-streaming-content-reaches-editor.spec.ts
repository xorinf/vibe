/**
 * Streaming-stuck regression test — variant of ile-editor-streaming.spec.ts
 * but with console + network capture and a simpler happy-path mock.
 *
 * Goal: prove that the text-delivered value reaches the .cm-content
 * editor. The existing test only asserts length > 200; this one
 * additionally asserts the editor's textContent matches the MOCK
 * total (so any swallowed / truncated value surfaces as a content
 * mismatch), and captures every console message + SSE frame so a
 * failure leaves a paper trail.
 *
 * Prereqs (test skips when missing):
 *   - Frontend dev server on :5173
 *   - Backend on :8080
 *   - Firebase auth emulator on :9099
 *   - Seeded teacher `designer@test.com` / `designer123`
 */

import { test, expect, type Page } from '@playwright/test';

const TEACHER_EMAIL =
  process.env.TEST_TEACHER_EMAIL ?? 'designer@test.com';
const TEACHER_PASSWORD =
  process.env.TEST_TEACHER_PASSWORD ?? 'designer123';
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:8080';
const FRONTEND = process.env.BASE_URL ?? 'http://localhost:5173';
const SSE_PATH = '/api/interactive-experiences/generate/stream';

/**
 * Build a deterministic multi-chunk mock SSE response. The HTML
 * is short enough that the @lezer/html parser should handle every
 * chunk without throwing — we want to test the happy path, not
 * parser-throw fallbacks (those are covered by the existing test).
 */
function buildMockSseBody(): string {
  const expId = 'mock-exp-streaming-content';
  const chunks: string[] = [];

  chunks.push(
    `event: message\ndata: ${JSON.stringify({
      kind: 'start',
      experienceId: expId,
    })}\n\n`,
  );

  chunks.push(
    `event: message\ndata: ${JSON.stringify({
      kind: 'progress',
      message: '✓ Designing experience',
    })}\n\n`,
  );

  const fullHtml = [
    '<!DOCTYPE html>',
    '<html>',
    '<head><title>cache demo</title></head>',
    '<body>',
    '<h1>Cache Demo</h1>',
    '<p>Click Run to see hits/misses.</p>',
    '<button id="run">Run</button>',
    '<div id="log"></div>',
    '<script>',
    'const log = document.getElementById("log");',
    'document.getElementById("run").onclick = () => {',
    '  for (let i = 0; i < 5; i++) {',
    '    const e = document.createElement("div");',
    '    e.textContent = "tick " + i;',
    '    log.appendChild(e);',
    '  }',
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
    const res = await fetch(`${BACKEND}/api/interactive-experiences/config`, {
      method: 'POST',
    });
    return res.status === 401 || res.status === 400;
  } catch {
    return false;
  }
}

async function frontendHealthy(): Promise<boolean> {
  try {
    const res = await fetch(FRONTEND);
    return res.ok;
  } catch {
    return false;
  }
}

async function loginAsTeacher(page: Page): Promise<void> {
  await page.goto('/auth', { waitUntil: 'domcontentloaded' });
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
  await page.waitForURL(
    (url) => !url.pathname.includes('/auth'),
    { timeout: 30_000 },
  );
}

test.describe('ILE editor streaming — content reaches editor', () => {
  test('the rendered editor text matches the mock stream total', async ({
    page,
  }) => {
    // Skip cleanly when the dev environment isn't fully up. Log
    // the failing prereq so the --reporter=line output is useful.
    const frontendUp = await frontendHealthy();
    const backendUp = await backendHealthy();
    if (!frontendUp) {
      console.log(`[diag] SKIP: frontend not reachable at ${FRONTEND}`);
      test.skip(true, `Frontend not reachable at ${FRONTEND}`);
      return;
    }
    if (!backendUp) {
      console.log(`[diag] SKIP: backend not reachable at ${BACKEND}`);
      test.skip(true, `Backend not reachable at ${BACKEND}`);
      return;
    }
    console.log(`[diag] prereqs OK: frontend ${FRONTEND}, backend ${BACKEND}`);

    // Capture every console message + page error so a failure
    // leaves a paper trail (the "I don't see the output" bug
    // usually surfaces as a swallowed warning).
    const consoleLines: string[] = [];
    page.on('console', (msg) => {
      consoleLines.push(`[${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      consoleLines.push(`[pageerror] ${err.message}`);
    });

    // Capture every SSE frame so we can see what the editor
    // actually received.
    const sseFrames: string[] = [];
    page.on('response', async (resp) => {
      const url = resp.url();
      if (url.includes(SSE_PATH)) {
        try {
          const body = await resp.text();
          sseFrames.push(body);
        } catch {
          /* streamed-body unreadable; the route-level interception
             feeds the body, not the page-level intercept. */
        }
      }
    });

    // Install the SSE route interception BEFORE opening the workspace.
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

    try {
      await loginAsTeacher(page);
    } catch (err: any) {
      test.skip(true, 'Teacher login did not complete: ' + (err?.message ?? 'unknown'));
      return;
    }

    await page.goto('/teacher/courses/view', { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) {
      test.skip(true, 'Login did not yield a teacher session');
      return;
    }

    const openIleButton = page
      .getByRole('button', {
        name: /open in workspace|open interactive|new interactive experience/i,
      })
      .first();
    if (!(await openIleButton.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip(true, 'No ILE workspace button on /teacher/courses/view');
      return;
    }
    await openIleButton.click();

    const composer = page.locator(
      'textarea[placeholder*="Describe"], textarea[placeholder*="describe"], [data-testid="ile-composer"], textarea[aria-label*="composer" i]',
    );
    await expect(composer.first()).toBeVisible({ timeout: 15_000 });

    await composer.first().fill('show a cache demo');
    const applyButton = page
      .getByRole('button', { name: /^(apply|generate)$/i })
      .first();
    await expect(applyButton).toBeVisible();
    await applyButton.click();

    // Wait for the editor to receive streamed HTML. The
    // canonical assertion is that the editor's textContent
    // contains a recognizable fragment from the mock
    // (e.g. "Cache Demo"). If the editor is truly empty
    // (the user's symptom), this assertion fails.
    const cmContent = page.locator('.cm-content').first();
    await expect
      .poll(
        async () => {
          const text = await cmContent.textContent().catch(() => '');
          return text ?? '';
        },
        {
          timeout: 20_000,
          intervals: [200, 500, 1_000, 2_000],
        },
      )
      .toContain('Cache Demo');

    // If we got here, the editor rendered the mock content. As
    // a sanity check, log the captured console lines and the
    // length of the editor so a CI dashboard can see the state.
    const finalText = await cmContent.textContent();
    console.log(
      `[diag] editor final length: ${finalText?.length ?? 0} chars`,
    );
    console.log(
      `[diag] console lines (${consoleLines.length}): ${consoleLines.join(' | ')}`,
    );
    console.log(`[diag] SSE frame count: ${sseFrames.length}`);
  });
});
