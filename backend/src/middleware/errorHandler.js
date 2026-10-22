// Terminal error handling: an unknown API route, and anything a handler threw.
//
// Before this, an unhandled throw fell through to Express's default handler, which in a
// non-production env renders the STACK TRACE into the response body — file paths, library
// versions, sometimes the failing SQL. The client gets a request id instead; the stack goes
// to the log where it belongs.
import { config } from '../config.js';

// A short reference on every error answer, so whoever hits a failure has something exact to
// report: "ref 1a2b3c4d" is the start of the request id, and
// `docker compose logs backend | grep 1a2b3c4d` finds the full story. Wraps res.json once, so
// every handler's own `res.status(4xx).json({ error })` gets it without remembering to.
export function errorRef(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400 && req.id && body && typeof body === 'object' && body.error && !body.ref) {
      body = { ...body, ref: req.id.slice(0, 8) };
    }
    return json(body);
  };
  next();
}

// Name the failure when we know what it is, in words safe for anyone to read: which part of
// the system is down, never its address, query or stack. Anything unrecognised stays
// "internal error" — the ref still finds it in the log.
export function describeFailure(err) {
  const code = String(err?.code || '');
  const name = String(err?.name || '');
  if (code === 'WRITE_UNAVAILABLE') return { status: 503, error: 'could not save right now, try again', cause: 'DB-WRITE' };
  // Prisma: P1xxx = can't reach / connect to the database, P2024 = connection pool timed out.
  if (/^P10\d\d$/.test(code) || name === 'PrismaClientInitializationError') {
    return { status: 503, error: 'database unavailable', cause: `DB-${code || 'INIT'}` };
  }
  if (code === 'P2024') return { status: 503, error: 'database busy, try again', cause: 'DB-P2024' };
  // The S3 SDK (MinIO) marks its errors with $metadata.
  if (err?.$metadata || name === 'S3ServiceException') {
    return { status: 503, error: 'photo storage unavailable', cause: `STORAGE-${name || 'ERROR'}` };
  }
  return null;
}

// 404 for unmatched /api routes. Without this an unknown API path falls through to Express's
// HTML 404, so a client parsing JSON sees a confusing parse error instead of a clean 404.
export function apiNotFound(req, res) {
  res.status(404).json({ error: 'not found' });
}

// Express identifies the error handler by its arity — all four params must stay, including
// `next`, even though it is unused.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  // A malformed JSON body is a client mistake, not a server fault: 400, not 500.
  const isBadJson = err?.type === 'entity.parse.failed' || err instanceof SyntaxError;
  // Payload over the express.json / express.raw ceiling.
  const isTooLarge = err?.type === 'entity.too.large';
  const known = isBadJson || isTooLarge ? null : describeFailure(err);
  const status = isBadJson ? 400 : isTooLarge ? 413 : known?.status || err?.status || err?.statusCode || 500;

  console.error(
    JSON.stringify({
      t: new Date().toISOString(),
      level: 'error',
      id: req.id,
      path: req.originalUrl?.split('?')[0],
      status,
      msg: err?.message,
      // Full stack to the log always; never to the client.
      stack: err?.stack,
    })
  );

  if (res.headersSent) return res.destroy(); // response already streaming (e.g. a photo)

  const body = known
    ? { error: known.error, cause: known.cause }
    : { error: status === 400 ? 'invalid request body' : status === 413 ? 'payload too large' : 'internal error' };
  // The request id is the safe half of debuggability: the user can quote it (errorRef adds
  // the short form), and we can find the line. The message and stack stay server-side.
  if (req.id) body.requestId = req.id;
  if (config.env !== 'production' && status >= 500) body.detail = err?.message;

  res.status(status).json(body);
}
