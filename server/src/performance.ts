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
 * Every command is adjudicated serially *per session* (a CREATE chain plus
 * one chain per session id): validation, precondition checks and the state
 * mutation happen in one synchronous critical section, so each command is
 * either committed exactly once or rejected with the stored data and
 * version untouched.
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

function reject(reason: RejectReason, message: string): never {
  throw new ApiError('COMMAND_REJECTED', message, 409, reason);
}

export class PerformanceStore {
  private readonly sessions = new Map<string, Performance>();
  private readonly chains = new Map<string, Promise<unknown>>();
  // requestId of every *committed* command -> session id (null: create).
  private readonly committedRequests = new Map<string, string | null>();

  /** Run `task` in the serial adjudication chain of one session. */
  private async runExclusive<T>(key: string, task: () => T): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slot = previous.then(() => gate);
    this.chains.set(key, slot);
    try {
      await previous;
    } catch {
      // A prior task's rejection is delivered to its own caller.
    }
    try {
      return task();
    } finally {
      release();
      // Remove the chain only if nobody queued behind us; otherwise the
      // last waiter performs the cleanup.
      if (this.chains.get(key) === slot) this.chains.delete(key);
    }
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
    const key = command.type === 'create' ? CREATE_CHAIN_KEY : command.performanceId;
    return this.runExclusive(key, () => this.decide(command));
  }

  /**
   * The decision procedure. Runs inside the per-session chain, so the whole
   * read-check-write sequence is one atomic step. All throws leave the store
   * untouched (nothing is mutated before the single commit at the end).
   */
  private decide(command: PerformanceCommand): Performance {
    if (command.type === 'create') {
      if (this.committedRequests.has(command.requestId)) {
        reject(
          'DUPLICATE_REQUEST',
          `Request id "${command.requestId}" was already committed.`,
        );
      }
      const session: Performance = {
        id: randomUUID(),
        name: command.name,
        status: 'pending',
        version: 1,
        requestId: command.requestId,
        cues: [],
      };
      this.sessions.set(session.id, session);
      this.committedRequests.set(command.requestId, session.id);
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

    // Only *committed* request ids count as duplicates. A rejected command
    // leaves the store untouched, so its request id is never recorded: the
    // caller may correct the precondition (version/transition/run-state)
    // and replay the very same request id without being falsely reported as
    // a duplicate. Recording happens exclusively at the commit point below.
    if (this.committedRequests.has(command.requestId)) {
      reject(
        'DUPLICATE_REQUEST',
        `Request id "${command.requestId}" was already committed to session "${session.id}".`,
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

    // Single commit point: version bump and request-id recording happen
    // together with the state change.
    session.version += 1;
    session.requestId = command.requestId;
    this.committedRequests.set(command.requestId, session.id);
    return this.snapshot(session);
  }

  private snapshot(session: Performance): Performance {
    return { ...session, cues: [...session.cues] };
  }
}
