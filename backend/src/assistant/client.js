// Ask the hosted model (any OpenAI-compatible endpoint; Groq by default). Returns the reply
// text, or null on ANY failure — timeout, 429 over the free quota, an outage — and the caller
// falls back to the FAQ and "talk to a person". A model problem costs an answer, never an
// error page.
import { config } from '../config.js';

export async function askModel(messages, { settings = config.assistant, fetchImpl = fetch } = {}) {
  if (!settings.enabled) return null;
  try {
    const res = await fetchImpl(`${settings.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: settings.model, messages, temperature: 0.3, max_tokens: 220, stream: false }),
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
    if (!res.ok) {
      // Say why in the log (never the key): 401 = bad key, 404 = model name, 429 = free quota.
      let why = '';
      try { why = JSON.stringify((await res.json())?.error?.message || '').slice(0, 160); } catch { /* not JSON */ }
      console.warn(`[assistant] ${new URL(settings.url).host} answered ${res.status} ${why}`);
      return null;
    }
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content;
    return typeof text === 'string' ? text : null;
  } catch (err) {
    console.warn(`[assistant] no answer: ${err.name === 'TimeoutError' ? `timed out after ${settings.timeoutMs} ms` : err.message}`);
    return null;
  }
}
