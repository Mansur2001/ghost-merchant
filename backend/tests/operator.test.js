// Operator account rules (P0 #5) + the error handler's status mapping.
// Pure domain and middleware — no DB.
import { jest } from '@jest/globals';
import {
  normalizeUsername,
  validateUsername,
  validatePassword,
  MIN_PASSWORD_LENGTH,
} from '../src/domain/operator.js';
import { errorHandler, apiNotFound } from '../src/middleware/errorHandler.js';
import { securityHeaders } from '../src/middleware/securityHeaders.js';

describe('normalizeUsername', () => {
  test('is case- and whitespace-insensitive', () => {
    // "Amina " and "amina" must be the same account, or an attacker registers a lookalike
    // of a real operator and phishes the desk.
    expect(normalizeUsername('  Amina ')).toBe('amina');
    expect(normalizeUsername('HODAN')).toBe('hodan');
  });

  test('handles nullish input', () => {
    expect(normalizeUsername(null)).toBe('');
    expect(normalizeUsername(undefined)).toBe('');
  });
});

describe('validateUsername', () => {
  test('accepts sane usernames', () => {
    for (const u of ['amina', 'hodan.a', 'op_2', 'a-b-c', 'abc']) {
      expect(validateUsername(u).valid).toBe(true);
    }
  });

  test('rejects empty, too short, and too long', () => {
    expect(validateUsername('').valid).toBe(false);
    expect(validateUsername('ab').valid).toBe(false);
    expect(validateUsername('a'.repeat(33)).valid).toBe(false);
  });

  test('rejects characters that could confuse a lookalike check or a log line', () => {
    for (const u of ['ami na', 'amina!', 'am/ina', 'ami\nna', '-amina', '.amina', 'ami<b>']) {
      expect(validateUsername(u).valid).toBe(false);
    }
  });

  test('normalizes before validating', () => {
    expect(validateUsername(' Amina ')).toEqual({ valid: true, username: 'amina' });
  });
});

describe('validatePassword', () => {
  test('enforces a minimum length', () => {
    expect(validatePassword('x'.repeat(MIN_PASSWORD_LENGTH)).valid).toBe(true);
    expect(validatePassword('x'.repeat(MIN_PASSWORD_LENGTH - 1)).valid).toBe(false);
  });

  test('rejects a password containing the username', () => {
    // "amina-amina-amina" is long but is the first thing anyone would guess for `amina`.
    expect(validatePassword('amina-amina-amina', { username: 'amina' }).valid).toBe(false);
    expect(validatePassword('Amina-is-here-now', { username: 'AMINA' }).valid).toBe(false);
  });

  test('rejects an all-whitespace password that clears the length bar', () => {
    expect(validatePassword('              ').valid).toBe(false);
  });

  test('rejects an absurdly long password (scrypt DoS)', () => {
    expect(validatePassword('x'.repeat(5000)).valid).toBe(false);
  });

  test('handles nullish input without throwing', () => {
    expect(validatePassword(null).valid).toBe(false);
    expect(validatePassword(undefined).valid).toBe(false);
  });
});

// ── Middleware ──
function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    headersSent: false,
    set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    destroy() { this.destroyed = true; return this; },
  };
  return res;
}

describe('errorHandler', () => {
  const req = { id: 'req-1', originalUrl: '/api/orders/1' };
  let errSpy;
  beforeEach(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => errSpy.mockRestore());

  test('never puts a stack trace in the response', () => {
    // Express's default handler renders the stack outside production — file paths, library
    // versions, sometimes the failing SQL.
    const res = mockRes();
    const err = new Error('column "secret_column" does not exist');
    errorHandler(err, req, res, () => {});
    expect(JSON.stringify(res.body)).not.toContain('at ');
    expect(JSON.stringify(res.body)).not.toContain('secret_column does not exist\n');
    expect(res.statusCode).toBe(500);
  });

  test('returns the request id so a user can quote it', () => {
    const res = mockRes();
    errorHandler(new Error('boom'), req, res, () => {});
    expect(res.body.requestId).toBe('req-1');
  });

  test('maps a malformed JSON body to 400, not 500', () => {
    const res = mockRes();
    const err = new SyntaxError('Unexpected token }');
    err.type = 'entity.parse.failed';
    errorHandler(err, req, res, () => {});
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid request body');
  });

  test('maps an oversized payload to 413', () => {
    const res = mockRes();
    const err = new Error('too big');
    err.type = 'entity.too.large';
    errorHandler(err, req, res, () => {});
    expect(res.statusCode).toBe(413);
  });

  test('honours an explicit status on the error', () => {
    const res = mockRes();
    const err = new Error('nope');
    err.status = 409;
    errorHandler(err, req, res, () => {});
    expect(res.statusCode).toBe(409);
  });

  test('destroys instead of double-writing when the response already started', () => {
    // Photo streaming sets headers then pipes; writing a JSON error on top corrupts it.
    const res = mockRes();
    res.headersSent = true;
    errorHandler(new Error('mid-stream'), req, res, () => {});
    expect(res.destroyed).toBe(true);
    expect(res.body).toBeNull();
  });

  test('logs the stack even though it withholds it from the client', () => {
    const res = mockRes();
    errorHandler(new Error('boom'), req, res, () => {});
    expect(errSpy.mock.calls[0][0]).toContain('stack');
  });
});

describe('apiNotFound', () => {
  test('answers unknown API routes with JSON, not HTML', () => {
    const res = mockRes();
    apiNotFound({}, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });
});

describe('securityHeaders', () => {
  test('sets the anti-sniff / anti-frame / no-store set', () => {
    const res = mockRes();
    securityHeaders({ get: () => undefined, secure: false }, res, () => {});
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['X-Frame-Options']).toBe('DENY');
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.headers['Referrer-Policy']).toBe('no-referrer');
  });

  test('does NOT send HSTS in development', () => {
    // Sending it on localhost pins the dev browser to HTTPS for a year.
    const res = mockRes();
    securityHeaders({ get: () => 'https', secure: true }, res, () => {});
    expect(res.headers['Strict-Transport-Security']).toBeUndefined();
  });

  test('calls next', () => {
    const next = jest.fn();
    securityHeaders({ get: () => undefined }, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });
});
