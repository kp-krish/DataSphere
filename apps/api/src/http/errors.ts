/**
 * Error translation for the HTTP layer.
 *
 * Everything the API can fail with lands here and becomes one JSON shape:
 *
 *   { "error": { "code": "...", "message": "...", "details": ... } }
 *
 * One shape means the client needs one error parser. The `code` is the stable
 * part - messages get reworded, codes do not - so the query builder can react
 * to `unknown_column` specifically without matching on prose.
 *
 * The other job here is deciding what *not* to say. A compile error is the
 * client's fault and describing it precisely helps them fix it. A Postgres
 * error is ours, and its message can carry schema details, so it is logged in
 * full and answered with a generic message.
 */

import { isQueryCompileError } from '@datasphere/core';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { CatalogUnavailableError } from '../catalog/service.js';

/** An error raised deliberately by application code, with a chosen status. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  static notFound(resource: string, id?: string): ApiError {
    return new ApiError(
      404,
      'not_found',
      id ? `No ${resource} with id "${id}"` : `${resource} not found`,
    );
  }

  static badRequest(code: string, message: string, details?: unknown): ApiError {
    return new ApiError(400, code, message, details);
  }

  static serviceUnavailable(code: string, message: string): ApiError {
    return new ApiError(503, code, message);
  }
}

/* -------------------------------------------------------------------------- */
/* Postgres error codes worth translating                                     */
/* -------------------------------------------------------------------------- */

/**
 * https://www.postgresql.org/docs/current/errcodes-appendix.html
 *
 * Only the ones a *user action* can plausibly cause are mapped. Everything
 * else is a bug or an outage and becomes a 500.
 */
const PG_ERROR_MAP: Record<string, { status: number; code: string; message: string }> = {
  // statement_timeout fired. The query was legal, just too expensive - so this
  // is a 504 rather than a 400, and the client is told to narrow it.
  '57014': {
    status: 504,
    code: 'query_timeout',
    message:
      'The query exceeded the configured time limit. Add a filter, reduce the date range, or lower the row limit.',
  },
  // Out of connections.
  '53300': {
    status: 503,
    code: 'too_many_connections',
    message: 'The database is at its connection limit. Please retry shortly.',
  },
  // Out of memory for a sort/hash.
  '53200': {
    status: 503,
    code: 'out_of_memory',
    message: 'The query needed more memory than is available. Try a coarser grouping.',
  },
  // Numeric overflow, division by zero - reachable through an AVG or SUM.
  '22003': {
    status: 400,
    code: 'numeric_overflow',
    message: 'The aggregate produced a value too large to represent.',
  },
  '22012': {
    status: 400,
    code: 'division_by_zero',
    message: 'The query attempted a division by zero.',
  },
};

/**
 * body-parser rejections, which arrive before any route runs.
 *
 * These carry a `type` such as `entity.parse.failed` (malformed JSON) or
 * `entity.too.large` (body over the configured limit), plus an intended
 * status. Without translating them a client typo in a JSON body comes back as
 * a 500, which says "the server is broken" when the truth is "your request
 * was". That is a bad answer to give, and a worse one to debug.
 */
interface BodyParserError {
  type: string;
  status?: number;
  statusCode?: number;
  message: string;
}

const BODY_PARSER_MAP: Record<string, { status: number; code: string; message: string }> = {
  'entity.parse.failed': {
    status: 400,
    code: 'invalid_json',
    message: 'The request body is not valid JSON.',
  },
  'entity.too.large': {
    status: 413,
    code: 'payload_too_large',
    message: 'The request body exceeds the maximum accepted size.',
  },
  'entity.verification.failed': {
    status: 403,
    code: 'body_verification_failed',
    message: 'The request body failed verification.',
  },
  'encoding.unsupported': {
    status: 415,
    code: 'unsupported_encoding',
    message: 'The request body uses an unsupported content encoding.',
  },
  'request.aborted': {
    status: 400,
    code: 'request_aborted',
    message: 'The request was aborted before the body was fully received.',
  },
};

function isBodyParserError(error: unknown): error is BodyParserError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    typeof (error as { type: unknown }).type === 'string' &&
    ((error as { type: string }).type.startsWith('entity.') ||
      (error as { type: string }).type.startsWith('encoding.') ||
      (error as { type: string }).type === 'request.aborted')
  );
}

function isPgError(error: unknown): error is { code: string; message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  );
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                    */
/* -------------------------------------------------------------------------- */

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Express 5 forwards rejected promises from handlers here automatically, so
 * route code can be plain `async` with no try/catch or wrapper.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // The response has already begun - most likely a streaming endpoint. Nothing
  // useful can be sent, so record it and let the socket close.
  if (res.headersSent) {
    req.log?.error({ err: error }, 'Error after response headers were sent');
    return;
  }

  const body = toErrorBody(error, req);
  res.status(body.status).json(body.payload);
}

function toErrorBody(error: unknown, req: Request): { status: number; payload: ErrorBody } {
  /* ---- malformed request shape ------------------------------------------ */
  if (error instanceof ZodError) {
    return {
      status: 400,
      payload: {
        error: {
          code: 'invalid_request',
          message: 'The request body did not match the expected shape.',
          // Field-level issues, so the UI can mark the offending control.
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            code: issue.code,
            message: issue.message,
          })),
        },
      },
    };
  }

  /* ---- the body never parsed ------------------------------------------- */
  if (isBodyParserError(error)) {
    const mapped = BODY_PARSER_MAP[error.type];
    const status = mapped?.status ?? error.status ?? error.statusCode ?? 400;
    return {
      status,
      payload: {
        error: {
          code: mapped?.code ?? 'invalid_body',
          message: mapped?.message ?? 'The request body could not be read.',
        },
      },
    };
  }

  /* ---- the query spec was well-formed but not permitted ------------------ */
  if (isQueryCompileError(error)) {
    // Safe to surface verbatim. These messages describe the caller's own spec
    // against a catalog they can already read via GET /api/catalog, so they
    // disclose nothing the client is not entitled to.
    return {
      status: 400,
      payload: {
        error: { code: error.code, message: error.message, details: error.detail },
      },
    };
  }

  /* ---- deliberate application errors ------------------------------------- */
  if (error instanceof ApiError) {
    return {
      status: error.status,
      payload: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
    };
  }

  /* ---- the query engine has no catalog to validate against --------------- */
  if (error instanceof CatalogUnavailableError) {
    req.log?.error({ err: error }, 'Schema catalog unavailable');
    return {
      status: 503,
      payload: {
        error: {
          code: 'catalog_unavailable',
          message:
            'The schema catalog could not be read. The database may be starting up or unreachable.',
        },
      },
    };
  }

  /* ---- database ---------------------------------------------------------- */
  if (isPgError(error)) {
    const mapped = PG_ERROR_MAP[error.code];
    if (mapped) {
      // A timeout is worth a warning, not an error page in the logs: it is a
      // user asking for too much, which is expected traffic.
      req.log?.warn({ err: error, pgCode: error.code }, 'Query rejected by PostgreSQL');
      return {
        status: mapped.status,
        payload: { error: { code: mapped.code, message: mapped.message } },
      };
    }
  }

  /* ---- everything else --------------------------------------------------- */
  req.log?.error({ err: error }, 'Unhandled request error');

  return {
    status: 500,
    payload: {
      error: {
        code: 'internal_error',
        // A Postgres message can name columns and constraints. In production
        // the log keeps the detail and the client gets nothing.
        message: env.isProduction
          ? 'An unexpected error occurred.'
          : error instanceof Error
            ? error.message
            : String(error),
      },
    },
  };
}

/** 404 for unmatched routes, in the same envelope as every other error. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` },
  } satisfies ErrorBody);
}
