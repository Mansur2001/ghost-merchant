// Is the help-chat model reachable? Run on the server:
//   docker compose exec backend node scripts/assistant-check.mjs
// Prints the settings (never the key itself), then one real question and the raw answer.
import { config } from '../src/config.js';
import { requestBody } from '../src/assistant/client.js';

const a = config.assistant;
const k = a.apiKey;
console.log(`url:   ${a.url || '(unset)'}`);
console.log(`model: ${a.model}`);
console.log(`key:   ${k ? `${k.slice(0, 4)}… (${k.length} chars)${/^["']|["']$|\s/.test(k) ? '  ⚠ has quotes or spaces — remove them in .env' : ''}` : '(unset)'}`);
if (a.errors.length) console.log(`config errors: ${a.errors.join('; ')}`);
if (!a.enabled) process.exit(1);
const t0 = Date.now();
try {
  const res = await fetch(`${a.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` },
    // The same body the app sends, so a pass here means the chat works.
    body: JSON.stringify(requestBody(a, [{ role: 'user', content: 'Reply with one short sentence: what is a bajaj?' }])),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  console.log(`HTTP ${res.status} in ${Date.now() - t0} ms`);
  console.log(text.slice(0, 400));
  if (res.status === 401) console.log('→ the key is wrong or revoked: make a new one in the Groq console.');
  if (res.status === 404 || (/model/i.test(text) && res.status === 400)) {
    console.log('→ the model name is wrong. Models this key can use:');
    try {
      const list = await fetch(`${a.url}/v1/models`, { headers: { Authorization: `Bearer ${k}` } }).then((r) => r.json());
      for (const m of (list.data || []).map((x) => x.id).sort()) console.log(`   ${m}`);
      console.log('  Put one in ASSISTANT_MODEL (openai/gpt-oss-120b is a good choice if listed).');
    } catch { console.log('  (could not list them — see Groq console → Models)'); }
  }
  if (res.ok) {
    try {
      const answer = JSON.parse(text)?.choices?.[0]?.message?.content;
      console.log(answer && answer.trim() ? `✓ the chat will work. Answer: ${answer.trim().slice(0, 160)}` : '✗ the model answered with no text — try another ASSISTANT_MODEL');
    } catch { /* printed above */ }
  }
  if (res.status === 403) console.log('→ Groq refused this server (region or account): check the Groq console.');
  if (res.status === 429) console.log('→ free-tier limit reached: wait, or add billing in the Groq console.');
} catch (err) {
  console.log(`no answer: ${err.message} → the server can't reach ${new URL(a.url).host} (firewall / DNS?)`);
}
