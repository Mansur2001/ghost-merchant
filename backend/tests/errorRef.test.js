// A failure in production must reach the person as something specific they can report — a
// reason and a reference — without leaking a stack, query or address.
import { jest, describe, test, expect } from '@jest/globals';
import { errorRef, errorHandler, describeFailure } from '../src/middleware/errorHandler.js';

function fakeRes() {
  const res = { statusCode: 200, headersSent: false, sent: null };
  res.status = (s) => { res.statusCode = s; return res; };
  res.json = (b) => { res.sent = b; return res; };
  return res;
}
const req = { id: '1a2b3c4d-0000-4000-8000-000000000000', originalUrl: '/api/x' };

describe('errorRef', () => {
  test('adds the short ref to any error answer', () => {
    const res = fakeRes();
    errorRef(req, res, () => {});
    res.status(409).json({ error: 'this order is already paid' });
    expect(res.sent).toEqual({ error: 'this order is already paid', ref: '1a2b3c4d' });
  });

  test('leaves successful answers alone', () => {
    const res = fakeRes();
    errorRef(req, res, () => {});
    res.json({ ok: true });
    expect(res.sent).toEqual({ ok: true });
  });
});

describe('errorHandler', () => {
  const run = (err) => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = fakeRes();
    errorRef(req, res, () => {});
    errorHandler(err, req, res, () => {});
    return res;
  };

  test('database down: 503 with a plain reason and the ref, no internals', () => {
    const err = Object.assign(new Error("Can't reach database server at `postgres:5432`"), { code: 'P1001' });
    const res = run(err);
    expect(res.statusCode).toBe(503);
    expect(res.sent).toMatchObject({ error: 'database unavailable', cause: 'DB-P1001', ref: '1a2b3c4d' });
    // `detail` is the dev-only raw message (never sent in production); everything else is
    // what production sends, and none of it may name the host.
    const { detail, ...production } = res.sent;
    expect(detail).toBeDefined();
    expect(JSON.stringify(production)).not.toContain('postgres:5432');
  });

  test('photo storage down is named as such', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED minio:9000'), { name: 'NetworkingError', $metadata: {} });
    expect(run(err).sent).toMatchObject({ error: 'photo storage unavailable', cause: 'STORAGE-NetworkingError' });
  });

  test('anything unrecognised is still reportable: internal error + ref', () => {
    const res = run(new Error('boom'));
    expect(res.statusCode).toBe(500);
    expect(res.sent).toMatchObject({ error: 'internal error', ref: '1a2b3c4d' });
  });
});

describe('describeFailure', () => {
  test('a write refused under partition says to try again', () => {
    expect(describeFailure({ code: 'WRITE_UNAVAILABLE' })).toMatchObject({ status: 503, cause: 'DB-WRITE' });
  });
  test('unknown errors are not guessed at', () => {
    expect(describeFailure(new Error('x'))).toBeNull();
  });
});
