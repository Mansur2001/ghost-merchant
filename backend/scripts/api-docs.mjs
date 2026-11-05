// The API reference, in Swagger UI, on your own machine:   npm run docs   ->  http://localhost:8099
//
// Local only, on purpose: production does not serve it, because a public map of every operator
// and admin endpoint helps nobody but someone probing them. The spec is docs/api/openapi.yaml —
// change it in the same commit as the route. "Try it out" works against staging
// (https://localhost:8444 — accept its certificate in the browser first) with a token you sign in for.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = join(here, '..', '..', 'docs', 'api', 'openapi.yaml');
const UI = dirname(createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'));
const PORT = Number(process.env.DOCS_PORT || 8099);
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.html': 'text/html', '.map': 'application/json' };

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GuriKaabe API</title><link rel="stylesheet" href="/ui/swagger-ui.css">
<style>body{margin:0} .swagger-ui .topbar{display:none}</style></head>
<body><div id="ui"></div><script src="/ui/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: '/openapi.json', dom_id: '#ui', deepLinking: true,
  docExpansion: 'list', defaultModelsExpandDepth: 0, persistAuthorization: true,
  tryItOutEnabled: false, displayRequestDuration: true, filter: true });</script></body></html>`;

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE); }
    // Read on every request, so an edit to the spec shows on reload.
    if (url.pathname === '/openapi.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(YAML.parse(await readFile(SPEC, 'utf8'))));
    }
    if (url.pathname === '/openapi.yaml') { res.writeHead(200, { 'Content-Type': 'text/yaml' }); return res.end(await readFile(SPEC)); }
    if (url.pathname.startsWith('/ui/') && !url.pathname.includes('..')) {
      const file = join(UI, url.pathname.slice(4));
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      return res.end(await readFile(file));
    }
    res.writeHead(404); res.end('not found');
  } catch (err) {
    res.writeHead(500); res.end(String(err.message));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`GuriKaabe API docs: http://localhost:${PORT}`));
