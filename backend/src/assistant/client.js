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
    if (!res.ok) return null;
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content;
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}
