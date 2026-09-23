/**
 * One-shot acceptance suite for the cue-deviation service.
 *
 * Runs against the compose network (API_URL / WEB_URL) and verifies:
 *   1. small reference cases with known exact distances,
 *   2. 50_000-item sparse-edit samples (exact value / exceeded signal),
 *   3. stable error codes for invalid JSON, non-integers and out-of-range input,
 *   4. the web page and its /api proxy integration,
 *   5. the performance session console lifecycle through the web proxy,
 *      including refresh reload and the sealed read-only timeline,
 *   6. the host-published WEB_PORT override reaches the same stack.
 *
 * Exits 0 when every check passes, 1 otherwise.
 */

const API_URL = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const WEB_URL = (process.env.WEB_URL ?? 'http://localhost:4173').replace(/\/$/, '');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function waitFor(name, url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`Service not ready: ${name} (${url})`);
  return false;
}

async function postDistance(base, payload) {
  const res = await fetch(`${base}/api/distance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function postRaw(base, raw) {
  const res = await fetch(`${base}/api/distance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* keep null */
  }
  return { status: res.status, body };
}

// ----------------------------------------------------- performance commands

let commandSeq = 0;
function commandRequestId(label) {
  commandSeq += 1;
  return `verify-${label}-${Date.now()}-${commandSeq}`;
}

async function sendCommand(base, payload, { raw = false } = {}) {
  const res = await fetch(`${base}/api/performances/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? payload : JSON.stringify(payload),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* keep null */
  }
  return { status: res.status, body };
}

async function getPerformance(base, id) {
  const res = await fetch(`${base}/api/performances/${id}`);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* keep null */
  }
  return { status: res.status, body };
}

function expectExact(name, response, distance, k) {
  check(
    name,
    response.status === 200 &&
      response.body?.status === 'ok' &&
      response.body?.distance === distance &&
      response.body?.k === k,
    `got ${response.status} ${JSON.stringify(response.body)}`,
  );
}

function expectExceeded(name, response, k) {
  check(
    name,
    response.status === 200 &&
      response.body?.status === 'exceeded' &&
      response.body?.k === k &&
      !('distance' in (response.body ?? {})),
    `got ${response.status} ${JSON.stringify(response.body)}`,
  );
}

function expectError(name, response, status, code) {
  check(
    name,
    response.status === status && response.body?.error?.code === code,
    `got ${response.status} ${JSON.stringify(response.body)}`,
  );
}

// ---------------------------------------------------------------- 50k samples

function buildSparseSample() {
  // 100 deletions + 100 insertions + 50 substitutions (x2) => distance 300.
  const N = 50_000;
  const a = Array.from({ length: N }, (_, i) => i + 1);
  const del = new Set();
  for (let d = 0; d < 100; d++) del.add(499 + d * 500);
  const sub = new Map();
  for (let s = 0; s < 50; s++) sub.set(250 + s * 500, 2_000_000 + s);
  const insAfter = new Map();
  for (let t = 0; t < 100; t++) insAfter.set(374 + t * 500, 1_000_000 + t);
  const b = [];
  for (let i = 0; i < N; i++) {
    if (del.has(i)) continue;
    b.push(sub.has(i) ? sub.get(i) : a[i]);
    if (insAfter.has(i)) b.push(insAfter.get(i));
  }
  return { a, b };
}

function buildSubstitutionSample(count, seedOffset, valueBase) {
  const N = 50_000;
  const a = Array.from({ length: N }, (_, i) => i + 1);
  const b = a.slice();
  for (let s = 0; s < count; s++) b[seedOffset + s * 199] = valueBase + s;
  return { a, b };
}

// ---------------------------------------------------------------------- main

console.log(`verify: API_URL=${API_URL} WEB_URL=${WEB_URL}`);

const ready =
  (await waitFor('api', `${API_URL}/api/health`)) && (await waitFor('web', `${WEB_URL}/`));
if (!ready) process.exit(1);

console.log('\n[1] small reference cases');
const smallCases = [
  // [a, b, k, expected ('exceeded' or exact distance)]
  [[], [], 0, 0],
  [[], [1, 2, 3], 3, 3],
  [[], [1, 2, 3], 2, 'exceeded'],
  [[7, 8, 9], [], 3, 3],
  [[1, 2, 3], [1, 2, 3], 0, 0],
  [[1], [2], 2, 2],
  [[1], [2], 1, 'exceeded'],
  [[1, 2, 3], [1, 3], 1, 1],
  [[1, 3], [1, 2, 3], 1, 1],
  [[7, 7, 7], [7, 7], 1, 1],
  [[1, 2, 1, 2], [2, 1, 2, 1], 2, 2],
  [[1, 2, 3, 4, 5], [4, 5], 3, 3],
  [[1, 2, 3, 4, 5], [1, 2], 3, 3],
  [[1, 2, 3, 4, 5], [1, 2], 2, 'exceeded'],
  [[1, 2, 3], [4, 5, 6], 6, 6],
  [[1, 2, 3], [4, 5, 6], 5, 'exceeded'],
  [[1, 2, 3, 4, 5], [5, 4, 3, 2, 1], 8, 8],
  [[1, 2, 3, 4, 5], [5, 4, 3, 2, 1], 7, 'exceeded'],
  [[-2147483648, 2147483647], [-2147483648, 2147483647], 0, 0],
  [[-2147483648], [2147483647], 2, 2],
  [[10, 20, 30], [10, 20, 30, 40, 50], 2, 2],
  [[10, 20, 30], [10, 20, 30, 40, 50], 1, 'exceeded'],
];
for (const [i, [a, b, k, expected]] of smallCases.entries()) {
  const res = await postDistance(API_URL, { a, b, k });
  const name = `case #${i + 1} (|a|=${a.length}, |b|=${b.length}, k=${k})`;
  if (expected === 'exceeded') expectExceeded(name, res, k);
  else expectExact(name, res, expected, k);
}

console.log('\n[2] 50k sparse-edit samples');
{
  const { a, b } = buildSparseSample();
  expectExact('50k sparse edits, k=500 -> 300', await postDistance(API_URL, { a, b, k: 500 }), 300, 500);
  expectExact('50k sparse edits, k=300 -> 300', await postDistance(API_URL, { a, b, k: 300 }), 300, 300);
  expectExceeded('50k sparse edits, k=299 -> exceeded', await postDistance(API_URL, { a, b, k: 299 }), 299);
}
{
  const { a, b } = buildSubstitutionSample(250, 100, 3_000_000);
  expectExact('50k with 250 substitutions, k=500 -> 500', await postDistance(API_URL, { a, b, k: 500 }), 500, 500);
}
{
  const { a, b } = buildSubstitutionSample(251, 50, 4_000_000);
  expectExceeded('50k with 251 substitutions, k=500 -> exceeded', await postDistance(API_URL, { a, b, k: 500 }), 500);
}
{
  const a = Array.from({ length: 50_000 }, (_, i) => i + 1);
  const b = a.slice(0, 49_499); // length gap 501 > k
  expectExceeded('length gap 501 > k=500 -> exceeded', await postDistance(API_URL, { a, b, k: 500 }), 500);
}

console.log('\n[3] stable validation errors');
expectError('malformed JSON', await postRaw(API_URL, '{"a": [1, 2],'), 400, 'INVALID_JSON');
expectError('empty body', await postRaw(API_URL, ''), 400, 'INVALID_JSON');
expectError('non-object body', await postDistance(API_URL, [1, 2, 3]), 400, 'INVALID_BODY');
expectError('missing k', await postDistance(API_URL, { a: [1], b: [1] }), 400, 'INVALID_K');
expectError('non-integer element', await postDistance(API_URL, { a: [1.5], b: [], k: 0 }), 400, 'INVALID_ELEMENT');
expectError('string element', await postDistance(API_URL, { a: ['1'], b: [], k: 0 }), 400, 'INVALID_ELEMENT');
expectError('element above int32', await postDistance(API_URL, { a: [2147483648], b: [], k: 0 }), 400, 'INVALID_ELEMENT');
expectError('element below int32', await postDistance(API_URL, { a: [-2147483649], b: [], k: 0 }), 400, 'INVALID_ELEMENT');
expectError('k = 501', await postDistance(API_URL, { a: [], b: [], k: 501 }), 400, 'INVALID_K');
expectError('k = -1', await postDistance(API_URL, { a: [], b: [], k: -1 }), 400, 'INVALID_K');
expectError('k = 1.5', await postDistance(API_URL, { a: [], b: [], k: 1.5 }), 400, 'INVALID_K');
expectError('k as string', await postDistance(API_URL, { a: [], b: [], k: '3' }), 400, 'INVALID_K');
expectError(
  'array too long',
  await postDistance(API_URL, { a: new Array(50_001).fill(0), b: [], k: 0 }),
  400,
  'ARRAY_TOO_LONG',
);

console.log('\n[4] web page integration');
{
  const res = await fetch(`${WEB_URL}/`);
  const html = await res.text();
  check(
    'web page serves the app shell',
    res.ok && html.includes('id="root"') && html.includes('工作台'),
    `got ${res.status}`,
  );
}
{
  const res = await fetch(`${WEB_URL}/api/health`);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* keep null */
  }
  check('web proxy reaches the API', res.ok && body?.status === 'ok', `got ${res.status}`);
}
{
  const res = await postDistance(WEB_URL, { a: [1, 2, 3], b: [1, 3, 4], k: 5 });
  expectExact('distance request through the web proxy', res, 2, 5);
}

console.log('\n[5] performance session lifecycle through the web proxy');
let perfId;
{
  // Create: pending, version 1, empty cues.
  const create = await sendCommand(WEB_URL, {
    command: 'create',
    name: '9 月 17 日晚场（验收）',
    requestId: commandRequestId('create'),
  });
  check(
    'create performance via web proxy -> 200 pending v1',
    create.status === 200 &&
      typeof create.body?.performance?.id === 'string' &&
      create.body.performance.status === 'pending' &&
      create.body.performance.version === 1 &&
      Array.isArray(create.body.performance.cues) &&
      create.body.performance.cues.length === 0,
    `got ${create.status} ${JSON.stringify(create.body)}`,
  );
  perfId = create.body.performance.id;

  // pending -> running is the only legal first advance.
  const illegal = await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: perfId,
    status: 'ended',
    expectedVersion: 1,
    requestId: commandRequestId('illegal'),
  });
  check(
    'pending -> ended rejected as ILLEGAL_TRANSITION',
    illegal.status === 409 &&
      illegal.body?.error?.code === 'COMMAND_REJECTED' &&
      illegal.body?.error?.reason === 'ILLEGAL_TRANSITION',
    `got ${illegal.status} ${JSON.stringify(illegal.body)}`,
  );

  const start = await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: perfId,
    status: 'running',
    expectedVersion: 1,
    requestId: commandRequestId('start'),
  });
  check(
    'advance to running -> v2',
    start.status === 200 && start.body?.performance?.status === 'running' &&
      start.body?.performance?.version === 2,
    `got ${start.status} ${JSON.stringify(start.body)}`,
  );

  // Register cues one by one while running, including int32 extremes.
  const cues = [101, 205, -2147483648, 2147483647, 330];
  for (let i = 0; i < cues.length; i++) {
    const res = await sendCommand(WEB_URL, {
      command: 'registerCue',
      performanceId: perfId,
      cue: cues[i],
      expectedVersion: 2 + i,
      requestId: commandRequestId(`cue-${i}`),
    });
    check(
      `register cue ${cues[i]} -> version ${3 + i}`,
      res.status === 200 &&
        res.body?.performance?.version === 3 + i &&
        res.body?.performance?.cues?.length === i + 1,
      `got ${res.status} ${JSON.stringify(res.body)}`,
    );
  }

  // Toggle running -> paused -> running; writes must fail while paused.
  const pause = await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: perfId,
    status: 'paused',
    expectedVersion: 7,
    requestId: commandRequestId('pause'),
  });
  check('pause -> v8 paused', pause.status === 200 &&
    pause.body?.performance?.status === 'paused' &&
    pause.body?.performance?.version === 8,
    `got ${pause.status}`);

  const writeWhilePaused = await sendCommand(WEB_URL, {
    command: 'registerCue',
    performanceId: perfId,
    cue: 999,
    expectedVersion: 8,
    requestId: commandRequestId('paused-write'),
  });
  check(
    'cue write while paused rejected as NOT_RUNNING',
    writeWhilePaused.status === 409 &&
      writeWhilePaused.body?.error?.reason === 'NOT_RUNNING',
    `got ${writeWhilePaused.status} ${JSON.stringify(writeWhilePaused.body)}`,
  );

  const resume = await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: perfId,
    status: 'running',
    expectedVersion: 8,
    requestId: commandRequestId('resume'),
  });
  check('resume -> v9 running', resume.status === 200 &&
    resume.body?.performance?.version === 9,
    `got ${resume.status}`);

  // Stale expectedVersion is rejected and changes nothing.
  const stale = await sendCommand(WEB_URL, {
    command: 'registerCue',
    performanceId: perfId,
    cue: 777,
    expectedVersion: 2,
    requestId: commandRequestId('stale'),
  });
  check(
    'stale expectedVersion rejected as VERSION_CONFLICT',
    stale.status === 409 && stale.body?.error?.reason === 'VERSION_CONFLICT',
    `got ${stale.status} ${JSON.stringify(stale.body)}`,
  );

  // A repeated request id is a no-op duplicate (same id as the resume).
  const duplicate = await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: perfId,
    status: 'ended',
    expectedVersion: 9,
    requestId: resume.body?.performance?.requestId ?? 'unknown',
  });
  check(
    'reused requestId rejected as DUPLICATE_REQUEST',
    duplicate.status === 409 && duplicate.body?.error?.reason === 'DUPLICATE_REQUEST',
    `got ${duplicate.status} ${JSON.stringify(duplicate.body)}`,
  );

  // End the show.
  const end = await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: perfId,
    status: 'ended',
    expectedVersion: 9,
    requestId: commandRequestId('end'),
  });
  check('end -> v10 ended', end.status === 200 &&
    end.body?.performance?.status === 'ended' &&
    end.body?.performance?.version === 10,
    `got ${end.status}`);

  const writeAfterEnd = await sendCommand(WEB_URL, {
    command: 'registerCue',
    performanceId: perfId,
    cue: 1,
    expectedVersion: 10,
    requestId: commandRequestId('after-end'),
  });
  check(
    'cue write after end rejected as NOT_RUNNING',
    writeAfterEnd.status === 409 && writeAfterEnd.body?.error?.reason === 'NOT_RUNNING',
    `got ${writeAfterEnd.status} ${JSON.stringify(writeAfterEnd.body)}`,
  );

  // Refresh = load the snapshot by id through the web proxy; the timeline
  // is sealed and preserves every cue in registration order.
  const reloaded = await getPerformance(WEB_URL, perfId);
  check(
    'GET by id after refresh loads sealed timeline',
    reloaded.status === 200 &&
      reloaded.body?.performance?.status === 'ended' &&
      reloaded.body?.performance?.version === 10 &&
      JSON.stringify(reloaded.body?.performance?.cues) === JSON.stringify(cues),
    `got ${reloaded.status} ${JSON.stringify(reloaded.body)}`,
  );

  // Missing object -> SESSION_NOT_FOUND.
  const missing = await getPerformance(WEB_URL, 'no-such-session-id');
  check(
    'GET missing performance -> 404 SESSION_NOT_FOUND',
    missing.status === 404 && missing.body?.error?.code === 'SESSION_NOT_FOUND',
    `got ${missing.status} ${JSON.stringify(missing.body)}`,
  );

  const invalidCue = await sendCommand(WEB_URL, {
    command: 'create',
    name: ['not', 'a', 'string'],
    requestId: commandRequestId('bad-envelope'),
  });
  check(
    'invalid command envelope -> 400 INVALID_BODY',
    invalidCue.status === 400 && invalidCue.body?.error?.code === 'INVALID_BODY',
    `got ${invalidCue.status} ${JSON.stringify(invalidCue.body)}`,
  );
}

// Rejections must not consume the request id, and paused sessions can be
// sealed straight to ended without a resume.
{
  const create = await sendCommand(WEB_URL, {
    command: 'create',
    name: '失败更正重试',
    requestId: commandRequestId('fix-create'),
  });
  const id = create.body.performance.id;

  const replayEnvelope = {
    command: 'transition',
    performanceId: id,
    status: 'running',
    expectedVersion: 1,
    requestId: commandRequestId('fix-replay'),
  };

  // Wrong target status first (pending -> ended): rejected, no side effect.
  replayEnvelope.status = 'ended';
  const illegal = await sendCommand(WEB_URL, replayEnvelope);
  check(
    'first attempt rejected as ILLEGAL_TRANSITION',
    illegal.status === 409 && illegal.body?.error?.reason === 'ILLEGAL_TRANSITION',
    `got ${illegal.status} ${JSON.stringify(illegal.body)}`,
  );

  // Correct the condition while reusing the same request id: must commit.
  replayEnvelope.status = 'running';
  const retried = await sendCommand(WEB_URL, replayEnvelope);
  check(
    'same requestId commits after correction -> v2 running',
    retried.status === 200 &&
      retried.body?.performance?.version === 2 &&
      retried.body?.performance?.status === 'running',
    `got ${retried.status} ${JSON.stringify(retried.body)}`,
  );

  // Pause, then seal directly from paused (no resume required).
  const pause = await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: id,
    status: 'paused',
    expectedVersion: 2,
    requestId: commandRequestId('fix-pause'),
  });
  check('fix session paused v3', pause.status === 200 &&
    pause.body?.performance?.status === 'paused',
    `got ${pause.status}`);

  const sealed = await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: id,
    status: 'ended',
    expectedVersion: 3,
    requestId: commandRequestId('fix-end'),
  });
  check(
    'paused -> ended directly -> v4 ended',
    sealed.status === 200 &&
      sealed.body?.performance?.status === 'ended' &&
      sealed.body?.performance?.version === 4,
    `got ${sealed.status} ${JSON.stringify(sealed.body)}`,
  );

  // Stale-version rejection followed by same-id corrected retry on a fresh
  // session: VERSION_CONFLICT must not poison the request id either.
  const c2 = await sendCommand(WEB_URL, {
    command: 'create',
    name: '版本冲突重试',
    requestId: commandRequestId('fix2-create'),
  });
  const id2 = c2.body.performance.id;
  const cueEnvelope = {
    command: 'registerCue',
    performanceId: id2,
    cue: 808,
    expectedVersion: 1,
    requestId: commandRequestId('fix2-replay'),
  };
  const stale = await sendCommand(WEB_URL, cueEnvelope);
  check(
    'cue at pending v1 rejected as NOT_RUNNING',
    stale.status === 409 && stale.body?.error?.reason === 'NOT_RUNNING',
    `got ${stale.status}`,
  );
  await sendCommand(WEB_URL, {
    command: 'transition',
    performanceId: id2,
    status: 'running',
    expectedVersion: 1,
    requestId: commandRequestId('fix2-start'),
  });
  cueEnvelope.expectedVersion = 2;
  const cueOk = await sendCommand(WEB_URL, cueEnvelope);
  check(
    'same cue requestId commits after start -> v3',
    cueOk.status === 200 &&
      cueOk.body?.performance?.version === 3 &&
      JSON.stringify(cueOk.body?.performance?.cues) === '[808]',
    `got ${cueOk.status} ${JSON.stringify(cueOk.body)}`,
  );
}

// Same-version concurrency against the API directly: exactly one commit.
{
  const create = await sendCommand(API_URL, {
    command: 'create',
    name: '并发场次',
    requestId: commandRequestId('cc-create'),
  });
  const id = create.body.performance.id;
  await sendCommand(API_URL, {
    command: 'transition',
    performanceId: id,
    status: 'running',
    expectedVersion: 1,
    requestId: commandRequestId('cc-start'),
  });

  const burst = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      sendCommand(API_URL, {
        command: 'registerCue',
        performanceId: id,
        cue: 1000 + i,
        expectedVersion: 2,
        requestId: commandRequestId(`cc-cue-${i}`),
      }),
    ),
  );
  const committed = burst.filter((r) => r.status === 200);
  const conflicts = burst.filter(
    (r) => r.status === 409 && r.body?.error?.reason === 'VERSION_CONFLICT',
  );
  check(
    'five same-version concurrent cues: exactly one commits',
    committed.length === 1 && conflicts.length === 4,
    `statuses=${burst.map((r) => r.status).join(',')}`,
  );

  const final = await getPerformance(API_URL, id);
  check(
    'winner cue committed once, version 3',
    final.body?.performance?.cues?.length === 1 &&
      final.body?.performance?.cues[0] === committed[0].body.performance.cues[0] &&
      final.body?.performance?.version === 3,
    `got ${JSON.stringify(final.body)}`,
  );
}

console.log('\n[6] published WEB_PORT override');
{
  const webPort = process.env.WEB_PORT ?? '8080';
  // In compose the published host port is reached via host-gateway; a local
  // run (outside compose) may instead point WEB_PORT_URL at the proxy.
  const hostBase = process.env.WEB_PORT_URL ?? `http://host.docker.internal:${webPort}`;
  let reached = false;
  let health = null;
  for (let attempt = 0; attempt < 30 && !reached; attempt++) {
    try {
      const res = await fetch(`${hostBase}/api/health`);
      health = res.status;
      reached = res.ok;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  check(
    `web stack reachable on host-published WEB_PORT=${webPort}`,
    reached,
    health ? `HTTP ${health}` : 'host.docker.internal not reachable',
  );
  if (reached) {
    const throughHost = await sendCommand(hostBase, {
      command: 'create',
      name: '宿主端口核验',
      requestId: commandRequestId('hostport'),
    });
    check(
      'command through published WEB_PORT proxy commits',
      throughHost.status === 200 &&
        throughHost.body?.performance?.status === 'pending' &&
        throughHost.body?.performance?.version === 1,
      `got ${throughHost.status} ${JSON.stringify(throughHost.body)}`,
    );
  }
}

console.log(`\nverify: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
