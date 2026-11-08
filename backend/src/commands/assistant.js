// One assistant turn (domain/assistant.js has the rules). Writes nothing: the conversation
// lives on the customer's phone, and nothing they type here is stored — a help chat is not a
// reason to keep a record of what people say. "Talk to a person" uses the order chat, which is.
import { config } from '../config.js';
import {
  matchFaq, systemPrompt, cleanHistory, cleanReply, orderSnapshot, MAX_QUESTION,
} from '../domain/assistant.js';
import { askModel } from '../assistant/client.js';

const FALLBACK = {
  en: 'I am not sure. Tap "Talk to a person" and an operator will answer.',
  so: 'Ma hubo. Riix "La hadal qof" si shaqaale kuu jawaabo.',
};

export async function answer({ message, history, lang, order, settings = config.assistant, ask = askModel }) {
  const q = String(message || '').trim().slice(0, MAX_QUESTION);
  const l = lang === 'so' ? 'so' : 'en';
  if (!q) return { reply: FALLBACK[l], source: 'fallback', handoff: true };

  // A strong FAQ hit is answered directly: right in both languages, and costs nothing.
  const faq = matchFaq(q, l);
  if (faq && faq.score >= 2) return { reply: faq.answer, source: 'faq', handoff: false };

  const raw = settings.enabled
    ? await ask([
      { role: 'system', content: systemPrompt({ lang: l, snapshot: orderSnapshot(order) }) },
      ...cleanHistory(history),
      { role: 'user', content: q },
    ], { settings })
    : null;
  const reply = cleanReply(raw, l);
  if (reply) return { reply, source: 'ai', handoff: false };
  if (faq) return { reply: faq.answer, source: 'faq', handoff: false };
  return { reply: FALLBACK[l], source: 'fallback', handoff: true };
}
