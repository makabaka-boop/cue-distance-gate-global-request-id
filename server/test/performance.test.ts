import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Performance } from '../src/performance.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function sendCommand(payload: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/performances/commands',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

async function getPerformance(id: string) {
  return app.inject({ method: 'GET', url: `/api/performances/${id}` });
}

function createSession(name: string, requestId: string): Promise<Performance> {
  return sendCommand({ command: 'create', name, requestId }).then((res) => {
    expect(res.statusCode).toBe(200);
    return res.json().performance as Performance;
  });
}

function expectRejected(body: any, reason: string) {
  expect(body.error.code).toBe('COMMAND_REJECTED');
  expect(body.error.reason).toBe(reason);
}

describe('performance console — lifecycle', () => {
  it('creates a session at pending with version 1 and empty cues', async () => {
    const session = await createSession('晚场', 'req-create-1');
    expect(session).toMatchObject({
      name: '晚场',
      status: 'pending',
      version: 1,
      requestId: 'req-create-1',
      cues: [],
    });
    expect(session.id).toBeTruthy();
  });

  it('advances pending -> running, running <-> paused, -> ended with version bumps', async () => {
    const s = await createSession('状态机', 'req-lc-1');

    let res = await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'running',
      expectedVersion: 1,
      requestId: 'req-lc-2',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().performance).toMatchObject({ status: 'running', version: 2 });

    res = await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'paused',
      expectedVersion: 2,
      requestId: 'req-lc-3',
    });
    expect(res.json().performance).toMatchObject({ status: 'paused', version: 3 });

    res = await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'running',
      expectedVersion: 3,
      requestId: 'req-lc-4',
    });
    expect(res.json().performance).toMatchObject({ status: 'running', version: 4 });

    res = await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'ended',
      expectedVersion: 4,
      requestId: 'req-lc-5',
    });
    expect(res.json().performance).toMatchObject({ status: 'ended', version: 5 });
  });

  it('registers int32 cues in order only while running', async () => {
    const s = await createSession('cue 登记', 'req-cue-1');
    await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'running',
      expectedVersion: 1,
      requestId: 'req-cue-2',
    });

    for (const [i, cue] of [101, -2147483648, 2147483647, 0].entries()) {
      const res = await sendCommand({
        command: 'registerCue',
        performanceId: s.id,
        cue,
        expectedVersion: 2 + i,
        requestId: `req-cue-${3 + i}`,
      });
      expect(res.statusCode).toBe(200);
    }

    const loaded = (await getPerformance(s.id)).json().performance;
    expect(loaded.cues).toEqual([101, -2147483648, 2147483647, 0]);
    expect(loaded.version).toBe(6);
  });
});

describe('performance console — rejections leave state untouched', () => {
  it('rejects illegal transitions (pending -> ended, ended -> running)', async () => {
    const s = await createSession('非法迁移', 'req-il-1');
    const res = await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'ended',
      expectedVersion: 1,
      requestId: 'req-il-2',
    });
    expect(res.statusCode).toBe(409);
    expectRejected(res.json(), 'ILLEGAL_TRANSITION');

    // Data and version unchanged: the same version still succeeds.
    const retry = await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'running',
      expectedVersion: 1,
      requestId: 'req-il-3',
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().performance).toMatchObject({ status: 'running', version: 2 });

    const end = await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'ended',
      expectedVersion: 2,
      requestId: 'req-il-4',
    });
    expect(end.json().performance).toMatchObject({ status: 'ended', version: 3 });

    const restart = await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'running',
      expectedVersion: 3,
      requestId: 'req-il-5',
    });
    expect(restart.statusCode).toBe(409);
    expectRejected(restart.json(), 'ILLEGAL_TRANSITION');
  });

  it('rejects cue writes outside running with NOT_RUNNING and appends nothing', async () => {
    const s = await createSession('非运行写入', 'req-nr-1');
    const whilePending = await sendCommand({
      command: 'registerCue',
      performanceId: s.id,
      cue: 7,
      expectedVersion: 1,
      requestId: 'req-nr-2',
    });
    expect(whilePending.statusCode).toBe(409);
    expectRejected(whilePending.json(), 'NOT_RUNNING');

    await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'running',
      expectedVersion: 1,
      requestId: 'req-nr-3',
    });
    await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'paused',
      expectedVersion: 2,
      requestId: 'req-nr-4',
    });

    const whilePaused = await sendCommand({
      command: 'registerCue',
      performanceId: s.id,
      cue: 7,
      expectedVersion: 3,
      requestId: 'req-nr-5',
    });
    expect(whilePaused.statusCode).toBe(409);
    expectRejected(whilePaused.json(), 'NOT_RUNNING');

    const loaded = (await getPerformance(s.id)).json().performance;
    expect(loaded.cues).toEqual([]);
    expect(loaded.version).toBe(3);
  });

  it('rejects stale expectedVersion with VERSION_CONFLICT and keeps the version', async () => {
    const s = await createSession('过期版本', 'req-vc-1');
    await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'running',
      expectedVersion: 1,
      requestId: 'req-vc-2',
    });

    const stale = await sendCommand({
      command: 'registerCue',
      performanceId: s.id,
      cue: 1,
      expectedVersion: 1, // current version is 2
      requestId: 'req-vc-3',
    });
    expect(stale.statusCode).toBe(409);
    expectRejected(stale.json(), 'VERSION_CONFLICT');

    const loaded = (await getPerformance(s.id)).json().performance;
    expect(loaded.version).toBe(2);
    expect(loaded.cues).toEqual([]);
  });

  it('allows paused -> ended directly without resuming', async () => {
    const s = await createSession('暂停后封存', 'req-pe-1');
    await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'running',
      expectedVersion: 1,
      requestId: 'req-pe-2',
    });
    const paused = await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'paused',
      expectedVersion: 2,
      requestId: 'req-pe-3',
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().performance.status).toBe('paused');

    const ended = await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'ended',
      expectedVersion: 3,
      requestId: 'req-pe-4',
    });
    expect(ended.statusCode).toBe(200);
    expect(ended.json().performance).toMatchObject({ status: 'ended', version: 4 });
  });

  it('lets a rejected request id be replayed after the precondition is corrected', async () => {
    const s = await createSession('失败后重试', 'req-rt-1');
    await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'running',
      expectedVersion: 1,
      requestId: 'req-rt-2',
    });

    // Same envelope, same request id: first rejected for a stale version,
    // then for NOT_RUNNING after pausing; the id must remain reusable.
    const envelope = {
      command: 'registerCue' as const,
      performanceId: s.id,
      cue: 512,
      expectedVersion: 1,
      requestId: 'req-rt-replay',
    };
    const stale = await sendCommand(envelope);
    expect(stale.statusCode).toBe(409);
    expectRejected(stale.json(), 'VERSION_CONFLICT');

    await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'paused',
      expectedVersion: 2,
      requestId: 'req-rt-3',
    });
    envelope.expectedVersion = 3;
    const whilePaused = await sendCommand(envelope);
    expect(whilePaused.statusCode).toBe(409);
    expectRejected(whilePaused.json(), 'NOT_RUNNING');

    // Correct both conditions, keep the original request id: it must commit.
    await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'running',
      expectedVersion: 3,
      requestId: 'req-rt-4',
    });
    envelope.expectedVersion = 4;
    const retried = await sendCommand(envelope);
    expect(retried.statusCode).toBe(200);
    expect(retried.json().performance).toMatchObject({
      status: 'running',
      version: 5,
      requestId: 'req-rt-replay',
      cues: [512],
    });

    // After commit the id is spent: replay is now a true duplicate.
    const again = await sendCommand(envelope);
    expect(again.statusCode).toBe(409);
    expectRejected(again.json(), 'DUPLICATE_REQUEST');
  });

  it('lets an illegal-transition request id be replayed as a legal transition', async () => {
    const s = await createSession('非法迁移后重试', 'req-ir-1');
    const replayId = 'req-ir-replay';
    const illegal = await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'ended',
      expectedVersion: 1,
      requestId: replayId,
    });
    expect(illegal.statusCode).toBe(409);
    expectRejected(illegal.json(), 'ILLEGAL_TRANSITION');

    // pending -> ended stays illegal, but the same id works for running.
    const ok = await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'running',
      expectedVersion: 1,
      requestId: replayId,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().performance).toMatchObject({
      status: 'running',
      version: 2,
      requestId: replayId,
    });
  });

  it('rejects duplicate request ids for create and follow-up commands without side effects', async () => {
    const first = await sendCommand({
      command: 'create',
      name: '重复创建',
      requestId: 'dup-create',
    });
    expect(first.statusCode).toBe(200);

    const again = await sendCommand({
      command: 'create',
      name: '重复创建',
      requestId: 'dup-create',
    });
    expect(again.statusCode).toBe(409);
    expectRejected(again.json(), 'DUPLICATE_REQUEST');

    // The duplicate create must not have produced a second session.
    const id = first.json().performance.id;
    await sendCommand({
      command: 'transition',
      performanceId: id,
      status: 'running',
      expectedVersion: 1,
      requestId: 'dup-start',
    });

    const cueRes = await sendCommand({
      command: 'registerCue',
      performanceId: id,
      cue: 42,
      expectedVersion: 2,
      requestId: 'dup-cue',
    });
    expect(cueRes.statusCode).toBe(200);
    expect(cueRes.json().performance.cues).toEqual([42]);

    const cueAgain = await sendCommand({
      command: 'registerCue',
      performanceId: id,
      cue: 42,
      expectedVersion: 2,
      requestId: 'dup-cue',
    });
    expect(cueAgain.statusCode).toBe(409);
    expectRejected(cueAgain.json(), 'DUPLICATE_REQUEST');

    const loaded = (await getPerformance(id)).json().performance;
    expect(loaded.cues).toEqual([42]);
    expect(loaded.version).toBe(3);
  });

  it('returns SESSION_NOT_FOUND for missing objects', async () => {
    const missingGet = await getPerformance('does-not-exist');
    expect(missingGet.statusCode).toBe(404);
    expect(missingGet.json().error.code).toBe('SESSION_NOT_FOUND');

    const missingCmd = await sendCommand({
      command: 'transition',
      performanceId: 'does-not-exist',
      status: 'running',
      expectedVersion: 1,
      requestId: 'req-missing-1',
    });
    expect(missingCmd.statusCode).toBe(404);
    expect(missingCmd.json().error.code).toBe('SESSION_NOT_FOUND');
  });
});

describe('performance console — same-version concurrency', () => {
  it('commits exactly one of two concurrent same-version cues; the other loses', async () => {
    const s = await createSession('并发 cue', 'req-cc-1');
    await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'running',
      expectedVersion: 1,
      requestId: 'req-cc-2',
    });

    const [a, b] = await Promise.all([
      sendCommand({
        command: 'registerCue',
        performanceId: s.id,
        cue: 1001,
        expectedVersion: 2,
        requestId: 'req-cc-3',
      }),
      sendCommand({
        command: 'registerCue',
        performanceId: s.id,
        cue: 2002,
        expectedVersion: 2,
        requestId: 'req-cc-4',
      }),
    ]);

    const results = [a, b];
    const committed = results.filter((r) => r.statusCode === 200);
    const rejected = results.filter((r) => r.statusCode === 409);
    expect(committed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expectRejected(rejected[0]!.json(), 'VERSION_CONFLICT');

    const final = (await getPerformance(s.id)).json().performance;
    expect(final.cues).toHaveLength(1);
    expect(final.cues[0]).toBe(committed[0]!.json().performance.cues[0]);
    expect(final.version).toBe(3);
  });

  it('serialises a burst of same-version transitions: one commit, rest VERSION_CONFLICT', async () => {
    const s = await createSession('并发推进', 'req-burst-1');

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        sendCommand({
          command: 'transition',
          performanceId: s.id,
          status: 'running',
          expectedVersion: 1,
          requestId: `req-burst-${i + 2}`,
        }),
      ),
    );

    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const conflicts = results.filter((r) => r.statusCode === 409);
    expect(conflicts).toHaveLength(7);
    for (const r of conflicts) expectRejected(r.json(), 'VERSION_CONFLICT');

    const final = (await getPerformance(s.id)).json().performance;
    expect(final.status).toBe('running');
    expect(final.version).toBe(2);
  });

  it('concurrent duplicate requests have no effect even against an in-flight winner', async () => {
    const s = await createSession('并发重复', 'req-cd-1');
    await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'running',
      expectedVersion: 1,
      requestId: 'req-cd-2',
    });

    const payload = {
      command: 'registerCue',
      performanceId: s.id,
      cue: 909,
      expectedVersion: 2,
      requestId: 'req-cd-dup',
    };
    const [first, second, third] = await Promise.all([
      sendCommand(payload),
      sendCommand(payload),
      sendCommand(payload),
    ]);

    const statuses = [first.statusCode, second.statusCode, third.statusCode];
    expect(statuses.filter((code) => code === 200)).toHaveLength(1);
    expect(statuses.filter((code) => code === 409)).toHaveLength(2);
    for (const res of [second, third]) {
      if (res.statusCode === 409) expectRejected(res.json(), 'DUPLICATE_REQUEST');
    }

    const final = (await getPerformance(s.id)).json().performance;
    expect(final.cues).toEqual([909]);
    expect(final.version).toBe(3);
  });
});

describe('performance console — envelope validation', () => {
  it('malformed JSON -> 400 INVALID_JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/performances/commands',
      headers: { 'content-type': 'application/json' },
      payload: '{"command": "create",',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_JSON');
  });

  it('non-object body / unknown command -> 400 INVALID_BODY', async () => {
    const arr = await sendCommand([1, 2, 3]);
    expect(arr.statusCode).toBe(400);
    expect(arr.json().error.code).toBe('INVALID_BODY');

    const unknown = await sendCommand({ command: 'pause', requestId: 'x' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('INVALID_BODY');

    const noRequestId = await sendCommand({ command: 'create', name: 'x' });
    expect(noRequestId.statusCode).toBe(400);
    expect(noRequestId.json().error.code).toBe('INVALID_BODY');
  });

  it('non-int32 cue -> 400 INVALID_CUE', async () => {
    const s = await createSession('cue 校验', 'req-cv-1');
    await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'running',
      expectedVersion: 1,
      requestId: 'req-cv-2',
    });

    for (const cue of [1.5, '7', true, 2147483648, null]) {
      const res = await sendCommand({
        command: 'registerCue',
        performanceId: s.id,
        cue,
        expectedVersion: 2,
        requestId: `req-cv-${String(cue)}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_CUE');
    }

    // Invalid envelopes never reached adjudication: state unchanged.
    const loaded = (await getPerformance(s.id)).json().performance;
    expect(loaded.version).toBe(2);
    expect(loaded.cues).toEqual([]);
  });
});
