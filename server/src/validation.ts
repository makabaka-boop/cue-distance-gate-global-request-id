/**
 * Request validation for the distance API.
 *
 * Inputs are plain JSON values (no text formats are interpreted): two
 * arrays of 32-bit signed integers plus an integer threshold k.
 * Every rejection uses a stable error code so clients and the acceptance
 * suite can rely on it.
 */

export const LIMITS = {
  MAX_ARRAY_LENGTH: 50_000,
  MAX_K: 500,
  INT32_MIN: -2_147_483_648,
  INT32_MAX: 2_147_483_647,
} as const;

export type ErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_BODY'
  | 'INVALID_ELEMENT'
  | 'ARRAY_TOO_LONG'
  | 'INVALID_K'
  | 'INVALID_CUE'
  | 'COMMAND_REJECTED'
  | 'SESSION_NOT_FOUND'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  /** Machine-readable rejection reason (present for COMMAND_REJECTED). */
  readonly reason?: string;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode = 400,
    reason?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode;
    this.reason = reason;
  }
}

export interface CompareRequest {
  a: number[];
  b: number[];
  k: number;
}

export function parseCompareBody(body: unknown): CompareRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(
      'INVALID_BODY',
      'Request body must be a JSON object with fields "a", "b" and "k".',
    );
  }

  const { a, b, k } = body as Record<string, unknown>;
  return {
    a: parseInt32Array(a, 'a'),
    b: parseInt32Array(b, 'b'),
    k: parseK(k),
  };
}

function parseInt32Array(value: unknown, field: 'a' | 'b'): number[] {
  if (!Array.isArray(value)) {
    throw new ApiError(
      'INVALID_BODY',
      `Field "${field}" must be an array of 32-bit signed integers.`,
    );
  }
  if (value.length > LIMITS.MAX_ARRAY_LENGTH) {
    throw new ApiError(
      'ARRAY_TOO_LONG',
      `Field "${field}" has ${value.length} elements; the maximum is ${LIMITS.MAX_ARRAY_LENGTH}.`,
    );
  }
  for (let i = 0; i < value.length; i++) {
    const v = value[i];
    if (
      typeof v !== 'number' ||
      !Number.isInteger(v) ||
      v < LIMITS.INT32_MIN ||
      v > LIMITS.INT32_MAX
    ) {
      throw new ApiError(
        'INVALID_ELEMENT',
        `Element "${field}[${i}]" must be a 32-bit signed integer.`,
      );
    }
  }
  return value as number[];
}

function parseK(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > LIMITS.MAX_K
  ) {
    throw new ApiError(
      'INVALID_K',
      `Field "k" must be an integer between 0 and ${LIMITS.MAX_K}.`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Performance command envelope
// ---------------------------------------------------------------------------

import {
  PERFORMANCE_STATUSES,
  type PerformanceCommand,
  type PerformanceStatus,
} from './performance.js';

const NAME_MAX_LENGTH = 200;
const REQUEST_ID_MAX_LENGTH = 200;

function invalidBody(message: string): never {
  throw new ApiError('INVALID_BODY', message);
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidBody('Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalidBody(`Field "${field}" must be a non-empty string.`);
  }
  if (value.length > REQUEST_ID_MAX_LENGTH) {
    invalidBody(
      `Field "${field}" must be at most ${REQUEST_ID_MAX_LENGTH} characters.`,
    );
  }
  return value;
}

function asExpectedVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    invalidBody('Field "expectedVersion" must be a positive integer.');
  }
  return value;
}

function asStatus(value: unknown): PerformanceStatus {
  if (typeof value !== 'string' || !PERFORMANCE_STATUSES.includes(value as PerformanceStatus)) {
    invalidBody(
      `Field "status" must be one of: ${PERFORMANCE_STATUSES.join(', ')}.`,
    );
  }
  return value as PerformanceStatus;
}

function asCue(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < LIMITS.INT32_MIN ||
    value > LIMITS.INT32_MAX
  ) {
    throw new ApiError(
      'INVALID_CUE',
      'Field "cue" must be a 32-bit signed integer.',
    );
  }
  return value;
}

export function parsePerformanceCommand(body: unknown): PerformanceCommand {
  const obj = asObject(body);
  const requestId = asNonEmptyString(obj.requestId, 'requestId');

  switch (obj.command) {
    case 'create': {
      const name = obj.name;
      if (typeof name !== 'string' || name.length === 0) {
        invalidBody('Field "name" must be a non-empty string.');
      }
      if (name.length > NAME_MAX_LENGTH) {
        invalidBody(`Field "name" must be at most ${NAME_MAX_LENGTH} characters.`);
      }
      return { type: 'create', name, requestId };
    }
    case 'transition': {
      const performanceId = asNonEmptyString(obj.performanceId, 'performanceId');
      return {
        type: 'transition',
        performanceId,
        status: asStatus(obj.status),
        expectedVersion: asExpectedVersion(obj.expectedVersion),
        requestId,
      };
    }
    case 'registerCue': {
      const performanceId = asNonEmptyString(obj.performanceId, 'performanceId');
      return {
        type: 'registerCue',
        performanceId,
        cue: asCue(obj.cue),
        expectedVersion: asExpectedVersion(obj.expectedVersion),
        requestId,
      };
    }
    default:
      invalidBody(
        'Field "command" must be one of: create, transition, registerCue.',
      );
  }
}
