// One assistant turn (domain/assistant.js has the rules). Writes nothing: the conversation
// lives on the customer's phone, and nothing they type here is stored — a help chat is not a
// reason to keep a record of what people say. "Talk to a person" uses the order chat, which is.
import { config } from '../config.js';
import {
  matchFaq, systemPrompt, cleanHistory, cleanReply, orderSnapshot, MAX_QUESTION,
} from '../domain/assistant.js';
import { askModel } from '../assistant/client.js';
import {
  detectIntent, rideDraft, cartDraft, draftPrompt, parseModelDraft, DRAFT_TEXT,
} from '../domain/assistantDraft.js';
import { getCatalog } from '../queries/catalog.js';

// The catalog as the drafter sees it: names and ids, no prices (the server prices at checkout).
let catalogCache = { at: 0, items: [] };
async function catalogItems() {
  if (Date.now() - catalogCache.at < 60_000) return catalogCache.items;
  const cats = await getCatalog();
  const items = cats.flatMap((c) => c.items.map((i) => ({ id: i.id, name_en: i.name_en, name_so: i.name_so, unit_en: i.unit_en })));
  catalogCache = { at: Date.now(), items };
  return items;
}

// A draft the app opens for the customer to check (domain/assistantDraft.js). Never an order.
export async function draftFor(q, l, { settings, ask, items: given } = {}) {
  const intent = detectIntent(q);
  if (!intent) return null;
  if (intent === 'ride') {
    const d = rideDraft(q);
    return { reply: DRAFT_TEXT.ride[l](d.vehicle, d.to), source: 'draft', handoff: false, draft: d };
  }
  if (intent === 'nearby') {
    return { reply: DRAFT_TEXT.nearby[l], source: 'draft', handoff: false, draft: { type: 'nearby' } };
  }
  const items = given || await catalogItems();
  let lines = cartDraft(q, items).lines;
  if (!lines.length && settings?.enabled) {
    const raw = await ask([{ role: 'system', content: draftPrompt(items) }, { role: 'user', content: q }], { settings });
    lines = parseModelDraft(raw, items);
  }
  if (!lines.length) {
    return { reply: DRAFT_TEXT.cartEmpty[l], source: 'draft', handoff: false, draft: { type: 'cart', lines: [] } };
  }
  return { reply: DRAFT_TEXT.cart[l](lines.length), source: 'draft', handoff: false, draft: { type: 'cart', lines } };
}

const FALLBACK = {
  en: 'I am not sure. Tap "Talk to a person" and an operator will answer.',
  so: 'Ma hubo. Riix "La hadal qof" si shaqaale kuu jawaabo.',
};

export async function answer({ message, history, lang, order, settings = config.assistant, ask = askModel }) {
  const q = String(message || '').trim().slice(0, MAX_QUESTION);
  const l = lang === 'so' ? 'so' : 'en';
  if (!q) return { reply: FALLBACK[l], source: 'fallback', handoff: true };

  // "Order me…", "Book a bajaj…", "places near me": a draft for the customer to check.
  const draft = await draftFor(q, l, { settings, ask });
  if (draft) return draft;

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
