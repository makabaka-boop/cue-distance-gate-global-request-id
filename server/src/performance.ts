/**
 * Performance session domain.
 *
 * A session (场次) is an event-sourced-looking aggregate kept in memory:
 *   id        - server assigned, stable for the life of the session
 *   name      - stage-manager supplied label
 *   status    - pending -> running <-> paused -> ended
 *   version   - optimistic-concurrency token, starts at 1, +1 per commit
 *   requestId - id of the last command that was committed to the session
 *   cues      - ordered int32 cues registered while the session is running
 *
 * Two-level serial adjudication:
 *
 *   1. A single process-wide FIFO *admission gate*. Request ids are a global
 *      commitment for the whole service lifetime: the same requestId may be
 *      committed exactly once, regardless of which session (or the create
 *      chain) it targets. Inside one synchronous gate slot a command either
 *      claims its request id and is enqueued onto its session chain, or is
 *      rejected as a duplicate. Two commands racing on different session
 *      chains therefore cannot both pass the duplicate check: the loser is
 *      rejected at admission and never touches any session.
 *   2. A per-session serial chain (a CREATE chain plus one chain per session
 *      id) in which validation, precondition checks and the state mutation
 *      happen as one synchronous step, so each admitted command is either
 *      committed exactly once or rejected with the stored data and version
 *      untouched. A rejection releases the id claim, so the caller may
 *      correct the precondition and replay the very same request id.
 */

import { randomUUID } from 'node:crypto';
import { ApiError } from './validation.js';

export const PERFORMANCE_STATUSES = ['pending', 'running', 'paused', 'ended'] as const;
export type PerformanceStatus = (typeof PERFORMANCE_STATUSES)[number];

export interface Performance {
  id: string;
  name: string;
  status: PerformanceStatus;
  version: number;
  requestId: string | null;
  cues: number[];
}

export interface CreateCommand {
  type: 'create';
  name: string;
  requestId: string;
}

export interface TransitionCommand {
  type: 'transition';
  performanceId: string;
  status: PerformanceStatus;
  expectedVersion: number;
  requestId: string;
}

export interface RegisterCueCommand {
  type: 'registerCue';
  performanceId: string;
  cue: number;
  expectedVersion: number;
  requestId: string;
}

export type PerformanceCommand = CreateCommand | TransitionCommand | RegisterCueCommand;

/** Rejection reasons surfaced alongside code COMMAND_REJECTED. */
export type RejectReason =
  | 'DUPLICATE_REQUEST'
  | 'VERSION_CONFLICT'
  | 'ILLEGAL_TRANSITION'
  | 'NOT_RUNNING';

// Legal status advance table. pending -> running, running <-> paused,
// running/paused -> ended (no resume required to seal). ended is terminal.
const LEGAL_TRANSITIONS: Record<PerformanceStatus, readonly PerformanceStatus[]> = {
  pending: ['running'],
  running: ['paused', 'ended'],
  paused: ['running', 'ended'],
  ended: [],
};

const CREATE_CHAIN_KEY = '__create__';

/** A claimed request id: held in flight while adjudicating, then frozen at commit. */
interface InFlightClaim {
  state: 'inflight';
}

interface CommittedClaim {
  state: 'committed';
  /** Session that the request id was first (and only) committed to. */
  sessionId: string;
}

type RequestClaim = InFlightClaim | CommittedClaim;

const INFLIGHT_CLAIM: InFlightClaim = { state: 'inflight' };

function reject(reason: RejectReason, message: string): never {
  throw new ApiError('COMMAND_REJECTED', message, 409, reason);
}

export class PerformanceStore {
  private readonly sessions = new Map<string, Performance>();
  private readonly chains = new Map<string, Promise<unknown>>();
  // Process-wide request-id claims: one entry per claimed id, global across
  // every session and the create chain. Only committed ids outlive a command.
  private readonly claims = new Map<string, RequestClaim>();
  // Tail of the process-wide FIFO admission gate.
  private gate: Promise<void> = Promise.resolve();

  /**
   * Run `task` in one synchronous slot of the process-wide admission gate.
   * Gate slots are FIFO and release as soon as `task` returns (the returned
   * adjudication promise is chained afterwards), so cross-session commands
   * still run their state work in parallel on their own session chains.
   */
  private admit(task: () => void): Promise<void> {
    const previous = this.gate;
    let release!: () => void;
    const slotGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gate = previous.then(() => slotGate, () => slotGate);
    return previous.then(
      () => {
        try {
          task();
        } finally {
          release();
        }
      },
      // A prior slot's rejection is delivered to its own caller.
      () => {
        try {
          task();
        } finally {
          release();
        }
      },
    );
  }

  /** Run `task` in the serial adjudication chain of one session. */
  private runExclusive<T>(key: string, task: () => T): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slot = previous.then(() => gate, () => gate);
    this.chains.set(key, slot);
    const work = previous.then(
      () => {
        try {
          return task();
        } finally {
          release();
          // Remove the chain only if nobody queued behind us; otherwise the
          // last waiter performs the cleanup.
          if (this.chains.get(key) === slot) this.chains.delete(key);
        }
      },
      () => {
        try {
          return task();
        } finally {
          release();
          if (this.chains.get(key) === slot) this.chains.delete(key);
        }
      },
    );
    return work as Promise<T>;
  }

  get(id: string): Performance {
    const session = this.sessions.get(id);
    if (!session) {
      throw new ApiError(
        'SESSION_NOT_FOUND',
        `No performance session exists with id "${id}".`,
        404,
      );
    }
    return this.snapshot(session);
  }

  dispatch(command: PerformanceCommand): Promise<Performance> {
    // Claiming the id and joining the session chain must be one atomic step
    // in gate order: otherwise two commands on different chains could both
    // observe "unclaimed" and both commit.
    let work: Promise<Performance> | undefined;
    return this.admit(() => {
      const claim = this.claims.get(command.requestId);
      if (claim) throw this.duplicateError(command.requestId, claim);
      this.claims.set(command.requestId, INFLIGHT_CLAIM);

      const key = command.type === 'create' ? CREATE_CHAIN_KEY : command.performanceId;
      work = this.runExclusive(key, () => this.decideGuarded(command));
    }).then(() => work as Promise<Performance>);
  }

  /**
   * Run the decision and finalise the global claim: freeze it to the owning
   * session on commit, or release it on any rejection so the request id can
   * be corrected and replayed.
   */
  private decideGuarded(command: PerformanceCommand): Performance {
    try {
      const result = this.decide(command);
      this.claims.set(command.requestId, { state: 'committed', sessionId: result.id });
      return result;
    } catch (err) {
      this.claims.delete(command.requestId);
      throw err;
    }
  }

  /**
   * Stable duplicate verdict. A committed id always reports its *first*
   * owner, even when replayed against another (or a nonexistent) session;
   * an in-flight id means the caller lost a same-id concurrency race.
   */
  private duplicateError(requestId: string, claim: RequestClaim): ApiError {
    const attribution =
      claim.state === 'committed'
        ? ` It was first committed to performance session "${claim.sessionId}".`
        : ' Another command with the same request id is in flight concurrently.';
    return new ApiError(
      'COMMAND_REJECTED',
      `Request id "${requestId}" has already been used for a successful command;` +
        ` a request id can be committed exactly once for the lifetime of the service.` +
        attribution,
      409,
      'DUPLICATE_REQUEST',
    );
  }

  /**
   * The decision procedure. Runs inside the per-session chain, so the whole
   * read-check-write sequence is one atomic step. All throws leave the store
   * untouched (nothing is mutated before the single commit at the end), and
   * decideGuarded releases the id claim on the way out.
   */
  private decide(command: PerformanceCommand): Performance {
    if (command.type === 'create') {
      const session: Performance = {
        id: randomUUID(),
        name: command.name,
        status: 'pending',
        version: 1,
        requestId: command.requestId,
        cues: [],
      };
      this.sessions.set(session.id, session);
      return this.snapshot(session);
    }

    const session = this.sessions.get(command.performanceId);
    if (!session) {
      throw new ApiError(
        'SESSION_NOT_FOUND',
        `No performance session exists with id "${command.performanceId}".`,
        404,
      );
    }

    if (command.expectedVersion !== session.version) {
      reject(
        'VERSION_CONFLICT',
        `expectedVersion ${command.expectedVersion} does not match current version ${session.version}.`,
      );
    }

    if (command.type === 'transition') {
      if (!LEGAL_TRANSITIONS[session.status].includes(command.status)) {
        reject(
          'ILLEGAL_TRANSITION',
          `Cannot move session from "${session.status}" to "${command.status}".`,
        );
      }
      session.status = command.status;
    } else {
      if (session.status !== 'running') {
        reject(
          'NOT_RUNNING',
          `Cues can only be registered while running; session is "${session.status}".`,
        );
      }
      session.cues.push(command.cue);
    }

    // Single commit point: version bump and last-request-id stamp happen
    // together with the state change. The global id claim is frozen by
    // decideGuarded immediately after this returns.
    session.version += 1;
    session.requestId = command.requestId;
    return this.snapshot(session);
  }

  private snapshot(session: Performance): Performance {
    return { ...session, cues: [...session.cues] };
  }
}
