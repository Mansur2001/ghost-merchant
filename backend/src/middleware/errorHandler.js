// Terminal error handling: an unknown API route, and anything a handler threw.
//
// Before this, an unhandled throw fell through to Express's default handler, which in a
// non-production env renders the STACK TRACE into the response body — file paths, library
// versions, sometimes the failing SQL. The client gets a request id instead; the stack goes
// to the log where it belongs.
import { config } from '../config.js';

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
  const status = isBadJson ? 400 : isTooLarge ? 413 : err?.status || err?.statusCode || 500;

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

  const body = { error: status === 400 ? 'invalid request body' : status === 413 ? 'payload too large' : 'internal error' };
  // The request id is the safe half of debuggability: the user can quote it, and we can find
  // the line. The message and stack stay server-side in production.
  if (req.id) body.requestId = req.id;
  if (config.env !== 'production' && status >= 500) body.detail = err?.message;

  res.status(status).json(body);
}
