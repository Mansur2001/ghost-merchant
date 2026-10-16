#!/usr/bin/env node
// Build frontend/user/privacy.html from docs/PRIVACY.md — the page Google Play links to.
//
//   node scripts/build-privacy.mjs
//
// One source of truth: edit the Markdown, re-run this. A hand-maintained second copy would
// drift, and a policy that disagrees with the Data Safety form is grounds for removal.
// Deliberately tiny and dependency-free: it handles exactly what PRIVACY.md uses (headings,
// paragraphs, bold, tables, bullet lists) and refuses to publish with placeholders left in.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'docs', 'PRIVACY.md'), 'utf8');
const out = path.join(root, 'frontend', 'user', 'privacy.html');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');

// Drop the maintainer note (the leading > blockquote) — it's for us, not the public.
const lines = src.split('\n').filter((l) => !l.startsWith('>'));
const html = [];
let para = [];
let list = null;
let table = null;
const flush = () => {
  if (para.length) { html.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
  if (list) { html.push(`<ul>${list.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`); list = null; }
  if (table) {
    const [head, , ...rows] = table;
    const cells = (r) => r.split('|').slice(1, -1).map((c) => c.trim());
    html.push('<div class="tbl"><table><thead><tr>' + cells(head).map((c) => `<th>${inline(c)}</th>`).join('') +
      '</tr></thead><tbody>' + rows.map((r) => '<tr>' + cells(r).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
      '</tbody></table></div>');
    table = null;
  }
};
for (const line of lines) {
  if (/^#{1,3} /.test(line)) { flush(); const n = line.match(/^#+/)[0].length; html.push(`<h${n}>${inline(line.slice(n + 1))}</h${n}>`); }
  else if (line.startsWith('|')) { if (!table) { flush(); table = []; } table.push(line); }
  else if (/^- /.test(line)) { if (!list) { flush(); list = []; } list.push(line.slice(2)); }
  else if (/^\s+\S/.test(line) && list) { list[list.length - 1] += ' ' + line.trim(); }
  else if (line.trim() === '') flush();
  else para.push(line.trim());
}
flush();

const body = html.join('\n');
const placeholders = body.match(/\[[A-Z][A-Z][^\]<]*\]/g) || [];
if (placeholders.length && !process.argv.includes('--allow-placeholders')) {
  console.error(`PRIVACY.md still has placeholders: ${[...new Set(placeholders)].join(', ')}`);
  console.error('Fill them in before publishing (or pass --allow-placeholders for a local preview).');
  process.exit(1);
}

fs.writeFileSync(out, `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GuriKaabe — Privacy Policy</title>
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <style>
    body { font: 16px/1.6 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; color: #1a1a1a; background: #fffdf7; }
    main { max-width: 760px; margin: 0 auto; padding: 24px 18px 60px; }
    h1 { font-size: 28px; } h2 { font-size: 20px; margin-top: 32px; }
    .tbl { overflow-x: auto; } table { border-collapse: collapse; width: 100%; font-size: 14px; }
    th, td { border: 1px solid #e3d7b5; padding: 8px; vertical-align: top; text-align: left; }
    th { background: #fbf1d4; }
  </style>
</head>
<body><main>
<!-- GENERATED from docs/PRIVACY.md by scripts/build-privacy.mjs — edit the Markdown, not this. -->
${body}
</main></body>
</html>
`);
console.log(`wrote ${path.relative(root, out)}${placeholders.length ? ' (WITH PLACEHOLDERS — preview only)' : ''}`);
