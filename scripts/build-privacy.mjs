#!/usr/bin/env node
// Build the public legal pages from their Markdown sources:
//   docs/PRIVACY.md -> frontend/user/privacy.html   (Google Play's privacy-policy link)
//   docs/TERMS.md   -> frontend/user/terms.html     (also what a 10DLC reviewer reads)
//
//   node scripts/build-privacy.mjs
//
// One source of truth: edit the Markdown, re-run this. A hand-maintained second copy would
// drift, and a policy that disagrees with the Data Safety form is grounds for removal.
// Deliberately tiny and dependency-free: it handles exactly what the sources use (headings,
// paragraphs, bold, links, tables, bullet lists) and refuses to publish with placeholders left
// in — in EITHER page, so the two always go out together.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PAGES = [
  { src: 'PRIVACY.md', out: 'privacy.html', title: 'Privacy Policy' },
  { src: 'TERMS.md', out: 'terms.html', title: 'Terms of Service' },
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Links only to our own pages (/privacy.html) or https — nothing else can become an href.
const inline = (s) => esc(s)
  .replace(/\[([^\]]+)\]\((\/[\w./-]*|https:\/\/[^)\s"]+)\)/g, '<a href="$2">$1</a>')
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/\*(.+?)\*/g, '<em>$1</em>');

function render(src) {
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
  return html.join('\n');
}

const page = (title, body, srcName) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GuriKaabe — ${title}</title>
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <style>
    body { font: 16px/1.6 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; color: #1a1a1a; background: #fffdf7; }
    main { max-width: 760px; margin: 0 auto; padding: 24px 18px 60px; }
    h1 { font-size: 28px; } h2 { font-size: 20px; margin-top: 32px; }
    a { color: #8a6500; }
    .tbl { overflow-x: auto; } table { border-collapse: collapse; width: 100%; font-size: 14px; }
    th, td { border: 1px solid #e3d7b5; padding: 8px; vertical-align: top; text-align: left; }
    th { background: #fbf1d4; }
    footer { margin-top: 40px; font-size: 14px; }
  </style>
</head>
<body><main>
<!-- GENERATED from docs/${srcName} by scripts/build-privacy.mjs — edit the Markdown, not this. -->
${body}
<footer><a href="/">GuriKaabe</a> · <a href="/terms.html">Terms of Service</a> · <a href="/privacy.html">Privacy Policy</a></footer>
</main></body>
</html>
`;

const preview = process.argv.includes('--allow-placeholders');
const built = PAGES.map((p) => {
  const body = render(fs.readFileSync(path.join(root, 'docs', p.src), 'utf8'));
  const placeholders = [...new Set(body.match(/\[[A-Z][A-Z][^\]<]*\]/g) || [])];
  return { ...p, body, placeholders };
});

const unfinished = built.filter((p) => p.placeholders.length);
if (unfinished.length && !preview) {
  for (const p of unfinished) console.error(`${p.src} still has placeholders: ${p.placeholders.join(', ')}`);
  console.error('Fill them in before publishing (or pass --allow-placeholders for a local preview).');
  process.exit(1);
}

for (const p of built) {
  const out = path.join(root, 'frontend', 'user', p.out);
  fs.writeFileSync(out, page(p.title, p.body, p.src));
  console.log(`wrote ${path.relative(root, out)}${p.placeholders.length ? ' (WITH PLACEHOLDERS — preview only)' : ''}`);
}
