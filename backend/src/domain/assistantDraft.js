// AI Caawiye drafts (the mockup's "Raashin iiga dalbo", "Bajaj ii dalbo"). Pure.
//
// The assistant still CANNOT act: it never places, pays for or changes anything. What it can
// do is turn "order me 2 rice and milk" into a DRAFT — cart lines from the real catalog, or a
// ride's vehicle and destination words — that the app opens on the normal screen, where the
// customer checks it, sees the server's price and pays like any order. A wrong guess costs a
// tap, never money.
//
// Matching is deterministic (catalog names in English and Somali, quantities in digits or
// words). A hosted model, when configured, is only asked to pick catalog ids for requests the
// words don't match ("things for tea") — and its answer is checked against the catalog.
import { fold } from './assistant.js';

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1,
  hal: 1, kow: 1, mid: 1, laba: 2, saddex: 3, afar: 4, shan: 5, lix: 6, toddoba: 7, siddeed: 8, sagaal: 9, toban: 10,
};

const RIDE_WORDS = ['bajaj', 'bajaaj', 'bajaajta', 'taxi', 'tagsi', 'taksi', 'car', 'gaari', 'gaadhi', 'ride', 'safar', 'lift'];
const CAR_WORDS = ['taxi', 'tagsi', 'taksi', 'car', 'gaari', 'gaadhi'];
const ORDER_WORDS = ['order me', 'order some', 'buy', 'bring', 'get me', 'i want', 'i need', 'dalbo', 'iiga dalbo', 'ii dalbo', 'ii keen', 'keen', 'iibi', 'iga iibi', 'rabaa', 'u baahanahay'];
const NEARBY_WORDS = ['near', 'nearby', 'nearest', 'close to me', 'u dhow', 'ugu dhow', 'goobaha', 'agtayda', 'meelaha'];
// Words that end a destination: "to Bakaara please", "ilaa Bakaara fadlan".
const TAIL_STOP = /\b(please|now|fadlan|hadda|thanks|mahadsanid)\b.*$/;

const has = (q, words) => words.some((w) => (w.includes(' ') ? q.includes(w) : new RegExp(`(^| )${w}( |$)`).test(q)));

// A question ("how do I pay for an order?", "what does a bajaj cost?") is for the FAQ, not a
// draft. Only a request is drafted.
const QUESTION = /^(how|what|why|where|when|which|who|can|is|are|do|does|sidee|maxay|maxaa|xagee|goorma|immisa|imisa|ma)\b/;
const BOOK_WORDS = ['book', 'call me', 'get me', 'i need', 'i want', 'send', 'dalbo', 'ii dalbo', 'ii soo dir', 'rabaa', 'u baahanahay'];

export function detectIntent(text) {
  const raw = String(text || '');
  const q = fold(raw);
  if (!q) return null;
  if (has(q, NEARBY_WORDS)) return 'nearby';
  if (QUESTION.test(q) || raw.includes('?')) return null;
  const toPlace = /(?:^| )(?:to|ilaa|ila|geey)\s+\S/.test(q);
  if (has(q, RIDE_WORDS) && (has(q, BOOK_WORDS) || toPlace || q.split(' ').length <= 2)) return 'ride';
  if (has(q, ORDER_WORDS) || /^order\b/.test(q)) return 'order';
  return null;
}

// "bajaj ii dalbo ilaa Bakaara" -> { vehicle: 'bajaj', to: 'bakaara' }
export function rideDraft(text) {
  const q = fold(text);
  const vehicle = has(q, CAR_WORDS) ? 'car' : 'bajaj';
  const m = q.match(/(?:^| )(?:to|ilaa|ila|u geey|igu geey|geey)\s+(.+)$/);
  const to = m ? m[1].replace(TAIL_STOP, '').trim().slice(0, 60) : '';
  return { type: 'ride', vehicle, to: to || null };
}

// Catalog items mentioned in the text, with the quantity in front of each ("2 rice", "laba
// bariis", "rice x3"). `items`: [{ id, name_en, name_so }]. Longest names first, so "camel
// milk" wins over "milk", and each part of the text is used once.
export function cartDraft(text, items, { maxLines = 10 } = {}) {
  let q = ` ${fold(text)} `;
  const names = [];
  for (const it of items) {
    for (const n of [it.name_en, it.name_so]) {
      const f = fold(n);
      if (f.length >= 3) names.push({ f, it });
      // "Rice" also matches "rice 5 kg" on the shelf; the plural "tomatoes" its singular.
      const first = f.split(' ')[0];
      if (first.length >= 4 && first !== f) names.push({ f: first, it, weak: true });
    }
  }
  names.sort((a, b) => b.f.length - a.f.length || (a.weak ? 1 : 0) - (b.weak ? 1 : 0));
  const lines = new Map();
  for (const { f, it } of names) {
    if (lines.size >= maxLines) break;
    const re = new RegExp(`( (\\d{1,2}|${Object.keys(NUMBER_WORDS).join('|')})( x| ×)?)? ${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?( x ?(\\d{1,2}))? `);
    const m = q.match(re);
    if (!m) continue;
    if (lines.has(it.id)) continue;
    const before = m[2] ? (Number(m[2]) || NUMBER_WORDS[m[2]] || 1) : null;
    const after = m[5] ? Number(m[5]) : null;
    const qty = Math.max(1, Math.min(50, after || before || 1));
    lines.set(it.id, { itemId: it.id, qty });
    q = q.replace(m[0], ' ');
  }
  return { type: 'cart', lines: [...lines.values()] };
}

// What the model is asked, when the words matched nothing: ids only, as JSON.
export function draftPrompt(items) {
  return [
    'You turn a shopping request into catalog lines. Answer ONLY with JSON like {"lines":[{"id":12,"qty":2}]}.',
    'Use only ids from this list. If nothing fits, answer {"lines":[]}.',
    ...items.slice(0, 150).map((i) => `${i.id}: ${i.name_en}${i.unit_en ? ` (${i.unit_en})` : ''} / ${i.name_so}`),
  ].join('\n');
}

// The model's answer, checked: known ids, sane quantities, at most 10 lines. Anything else = none.
export function parseModelDraft(raw, items) {
  const known = new Set(items.map((i) => i.id));
  try {
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m ? m[0] : '');
    const lines = new Map();
    for (const l of Array.isArray(obj.lines) ? obj.lines : []) {
      const id = Number(l?.id);
      const qty = Math.max(1, Math.min(50, Math.round(Number(l?.qty) || 1)));
      if (known.has(id) && !lines.has(id) && lines.size < 10) lines.set(id, { itemId: id, qty });
    }
    return [...lines.values()];
  } catch {
    return [];
  }
}

export const DRAFT_TEXT = {
  cart: {
    en: (n) => `I put ${n} item${n === 1 ? '' : 's'} in a cart for you. Check it, then order — you see the price before you pay.`,
    so: (n) => `${n} shay ayaan gaarigaaga kuu geliyay. Hubi, kadib dalbo — qiimaha waad aragtaa kahor intaadan bixin.`,
  },
  cartEmpty: {
    en: 'Tell me what to get, like "2 rice and 1 milk". Or open the shop and choose.',
    so: 'Ii sheeg waxa aan kuu keeno, tusaale "laba bariis iyo hal caano". Ama dukaanka fur oo dooro.',
  },
  ride: {
    en: (v, to) => `I set up a ${v === 'car' ? 'taxi' : 'bajaj'}${to ? ` to “${to}”` : ''}. Check the pickup and destination, choose your driver, then book.`,
    so: (v, to) => `${v === 'car' ? 'Tagsi' : 'Bajaaj'} ayaan kuu diyaariyay${to ? ` ilaa “${to}”` : ''}. Hubi meesha laga qaadayo iyo meesha la aadayo, dooro darawalka, kadib dalbo.`,
  },
  nearby: {
    en: 'Here are the places closest to you. Tap one to go there by bajaj or taxi.',
    so: 'Kuwani waa goobaha kuugu dhow. Mid riix si aad bajaaj ama tagsi ugu aaddo.',
  },
};
