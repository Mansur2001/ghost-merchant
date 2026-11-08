// The customer-service assistant. Pure — FAQ matching, prompt building, reply cleaning — so the
// rules are tested without a model.
//
// Two layers, cheapest first:
//   1. the FAQ: fixed answers in English and plain Somali, matched by keywords. Instant, free,
//      and right — a small model's Somali is not.
//   2. a hosted open model (assistant/client.js; Groq by default, any OpenAI-compatible
//      endpoint works), only for questions the FAQ doesn't cover, and only when ASSISTANT_URL
//      is set. What it receives is the question, the last few turns, and an order STATE —
//      never a name, phone, address or code (orderSnapshot).
//
// The assistant TALKS; it never acts. It has no tools: it cannot cancel, refund, pay, dispatch
// or change anything, so a prompt-injected "refund me" is just words. What it knows about the
// customer is one order's status snapshot — never a phone number, an address or a code.

export const MAX_QUESTION = 500;
export const MAX_HISTORY = 6;
export const MAX_REPLY = 700;

// Every answer the FAQ can give. `words` are matched against the folded question; the entry
// with the most matching words wins, and it needs at least `min` of them.
export const FAQ = [
  {
    id: 'pay',
    words: ['pay', 'paid', 'payment', 'evc', 'zaad', 'sahal', 'edahab', 'wallet', 'money', 'bixi', 'bixiyaa', 'bixiyay', 'lacag', 'lacagta'],
    en: 'After you book, the order screen shows how to pay: tap your wallet (EVC Plus, Zaad, Sahal or eDahab). With "Pay" in the app you approve a prompt on your phone with your PIN. With a code, your dialer opens; after paying, tap "I\'ve paid". The order updates on its own.',
    so: 'Marka aad dalbato, shaashadda dalabka ayaa kuu sheegaysa sida loo bixiyo: riix lacagtaada (EVC Plus, Zaad, Sahal ama eDahab). Haddii aad app-ka ku bixiso, taleefankaaga PIN-ka ku oggolow. Haddii koodh tahay, kadib riix "Waan bixiyay". Dalabku wuu is beddelayaa.',
  },
  {
    id: 'refund',
    words: ['refund', 'money back', 'cancel', 'cancelled', 'celi', 'soo celi', 'jooji', 'joojiyay'],
    en: 'You can cancel on the order screen until a driver is on the way. If you had already paid, we owe you the money and send it back to your wallet; an operator records it. After a driver is coming, message them or us in the order chat.',
    so: 'Dalabka waad joojin kartaa ilaa darawal kuu soo baxo. Haddii aad bixisay, lacagta waa laguu soo celinayaa. Marka darawal soo socdo, fariin u dir isaga ama annaga.',
  },
  {
    id: 'code',
    words: ['code', 'koodh', 'koodhka', 'pin', 'digits'],
    en: 'Each order has a 4-digit code on your order screen. For a delivery, give it to the driver only when you have your items. For a ride, give it when you get in. Never read it out before then.',
    so: 'Dalab kasta wuxuu leeyahay koodh 4 lambar ah. Keenista: darawalka sii marka alaabta aad hesho. Safarka: sii marka aad fuusho. Hore ha u sheegin.',
  },
  {
    id: 'ride_price',
    words: ['fare', 'price', 'cost', 'how much', 'expensive', 'qiimo', 'qiimaha', 'imisa', 'lacagta safarka'],
    en: 'A ride\'s price is fixed before you book: it depends on the distance and the vehicle (bajaj is cheaper than a car). You see it on the "Choose a ride" list and it does not change after booking.',
    so: 'Qiimaha safarka waad ogaanaysaa kahor intaadan dalban: wuxuu ku xiran yahay masaafada iyo gaadiidka (bajaajku wuu ka jaban yahay gaariga). Kadib ma is beddelayo.',
  },
  {
    id: 'driver',
    words: ['driver', 'where is', 'late', 'waiting', 'how long', 'darawal', 'darawalka', 'xagee', 'sugayaa', 'daahay'],
    en: 'Once a driver is assigned, the map on your order shows where they are and about how long until they reach you. You can call or message them from the order screen. If nobody is free yet, we send the nearest one as soon as they are.',
    so: 'Marka darawal laguu diro, khariidadda dalabka ayaa kuu tusaysa meesha uu joogo iyo inta uu ku imanayo. Waad wici kartaa ama fariin u diri kartaa. Haddii aan cidna bannaanayn, kan kuugu dhow ayaan kuu soo dirnaa.',
  },
  {
    id: 'delivery_fee',
    words: ['delivery fee', 'fee', 'shipping', 'keenista', 'kharash'],
    en: 'The delivery fee depends on the distance from the market to your door. You see the items, the fee and the total before you place the order.',
    so: 'Qiimaha keenistu wuxuu ku xiran yahay masaafada suuqa iyo albaabkaaga. Alaabta, keenista iyo wadarta waad aragtaa kahor intaadan dalban.',
  },
  {
    id: 'custom',
    words: ['not in', 'not on the list', 'something else', 'special', 'photo', 'wax kale', 'sawir', 'ma jiro'],
    en: 'If what you want is not in the list, tap "Something else?" in Food & shopping, describe it, set the most the driver may spend, and add a photo.',
    so: 'Haddii waxa aad rabto liiska ku jirin, riix "Wax kale?", qor waxa aad rabto, sheeg inta ugu badan ee la bixin karo, sawirna ku dar.',
  },
  {
    id: 'location',
    words: ['location', 'address', 'map', 'pin', 'gps', 'landmark', 'goob', 'meel', 'khariidad', 'calaamad'],
    en: 'Tap "Use my location", then drag the pin to the exact spot if the phone is not sure. You can also search a known place. Add a landmark (for example "green gate next to the pharmacy") so the driver finds you.',
    so: 'Riix "Isticmaal meesha aan joogo", kadib calaamadda u jiid meesha saxda ah. Waxaad sidoo kale raadin kartaa meel la yaqaan. Ku dar calaamad (tusaale "albaabka cagaaran ee farmashiyaha agtiisa").',
  },
  {
    id: 'not_received',
    words: ['not received', 'never arrived', "didn't get", 'did not get', 'missing', 'wrong item', 'ma helin', 'iima imaan', 'khalad'],
    en: 'On the delivered order, tap "I didn\'t get my order" within 3 days. An operator checks the driver\'s proof and calls you.',
    so: 'Dalabka la keenay, riix "Dalabkayga ma helin" 3 maalmood gudahood. Shaqaale ayaa hubinaya oo ku soo wacaya.',
  },
  {
    id: 'account',
    words: ['password', 'sign in', 'login', 'log in', 'account', 'email', 'furaha', 'gal', 'akoon'],
    en: 'Sign in with your email and password. Forgot it? Tap "Rather get a code by email?", sign in with the code, then set a new password under Account.',
    so: 'Ku gal emailkaaga iyo furahaaga. Haddii aad illowday, riix koodh email ah, ku gal, kadib Akoon ka beddel furaha.',
  },
];

export function fold(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// The best FAQ answer for a question, or null. Multi-word phrases count double: "money back"
// says more than "money".
export function matchFaq(question, lang = 'en', { min = 1 } = {}) {
  const q = ` ${fold(question)} `;
  let best = null;
  let bestScore = 0;
  for (const entry of FAQ) {
    let score = 0;
    for (const w of entry.words) {
      if (q.includes(` ${w} `) || (w.includes(' ') && q.includes(w))) score += w.includes(' ') ? 2 : 1;
    }
    if (score > bestScore) { best = entry; bestScore = score; }
  }
  if (!best || bestScore < min) return null;
  return { id: best.id, answer: lang === 'so' ? best.so : best.en, score: bestScore };
}

// What the model may know about the customer's order: its state, never personal data.
export function orderSnapshot(order) {
  if (!order) return null;
  return {
    kind: order.kind === 'RIDE' ? 'ride' : 'delivery',
    status: order.status,
    total_usd: Number(order.total_amount).toFixed(2),
    vehicle: order.vehicle || null,
    paid: !['PENDING_PAYMENT'].includes(order.status),
    driver_assigned: order.driver_id != null,
    payment_claimed: Boolean(order.payment_claimed_at),
  };
}

const STATUS_WORDS = {
  PENDING_PAYMENT: 'waiting for payment',
  PAID_UNASSIGNED: 'paid, finding a driver',
  DISPATCHED: 'a driver is assigned and on the way',
  IN_TRANSIT: 'picked up and on the way to the destination',
  DELIVERED: 'finished',
  FAILED_REFUND: 'cancelled or stopped; any money paid is owed back',
};

export function systemPrompt({ lang, snapshot }) {
  const faq = FAQ.map((f) => `- ${f.en}`).join('\n');
  const order = snapshot
    ? `The customer is asking about their ${snapshot.kind}. Its state: ${STATUS_WORDS[snapshot.status] || snapshot.status}. Total $${snapshot.total_usd}.`
    : 'The customer has not opened an order.';
  return [
    'You are the GuriKaabe help assistant. GuriKaabe is a ride and delivery app in Somalia.',
    `Reply in ${lang === 'so' ? 'simple, everyday Somali' : 'simple English'}, in at most 3 short sentences.`,
    'You can only explain. You cannot cancel, refund, pay, change an order, or contact anyone, and you must never say that you did.',
    'Never ask for or repeat a PIN, a password, a delivery code or a card number.',
    'If you do not know, or the customer is upset, has a safety problem, or needs money back, say they can tap "Talk to a person".',
    'Only use these facts:',
    faq,
    order,
  ].join('\n');
}

// History from the client is untrusted text: keep only well-formed turns, cap their size.
export function cleanHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_QUESTION) }));
}

// A model can ramble or claim it did something. Trim it, and replace any "I have cancelled /
// refunded" claim with the truth: only a person can do that.
const ACTION_CLAIM = /\b(i|we)('ve| have| am| will)?\s+(cancel(l)?ed|refunded|sent (you )?the money|changed your order|dispatched)\b/i;
export function cleanReply(text, lang = 'en') {
  let s = String(text || '').replace(/<[^>]*>/g, '').replace(/\s+\n/g, '\n').trim();
  if (!s) return null;
  if (ACTION_CLAIM.test(s)) {
    return lang === 'so'
      ? 'Anigu wax ma beddeli karo. Riix "La hadal qof" si shaqaale kuu caawiyo.'
      : 'I can\'t change orders or money myself. Tap "Talk to a person" and an operator will help.';
  }
  if (s.length > MAX_REPLY) s = `${s.slice(0, MAX_REPLY).replace(/\s+\S*$/, '')}…`;
  return s;
}

// Settings: any OpenAI-compatible chat endpoint. The client appends /v1/chat/completions.
//   Groq        ASSISTANT_URL=https://api.groq.com/openai   ASSISTANT_MODEL=openai/gpt-oss-120b
//               (llama-3.3-70b-versatile was retired for free/developer accounts, Aug 2026)
//   OpenRouter  ASSISTANT_URL=https://openrouter.ai/api     ASSISTANT_MODEL=<model id>
export const GROQ_URL = 'https://api.groq.com/openai';
export function parseAssistant(env, { production = false } = {}) {
  const url = (env.ASSISTANT_URL || '').trim().replace(/\/$/, '');
  const model = (env.ASSISTANT_MODEL || 'openai/gpt-oss-120b').trim();
  const apiKey = (env.ASSISTANT_API_KEY || '').trim();
  const errors = [];
  if (url && !/^https?:\/\//.test(url)) errors.push('ASSISTANT_URL must be an http(s) URL');
  // Customers' questions in clear text over the internet: never.
  if (url && production && !url.startsWith('https://')) errors.push('ASSISTANT_URL must be https in production');
  if (url && !apiKey) errors.push('set ASSISTANT_API_KEY with ASSISTANT_URL (hosted models need one)');
  return {
    enabled: Boolean(url) && errors.length === 0,
    url,
    model,
    apiKey,
    // A hosted model answers in 1–3 s; past this the customer is better served by the FAQ.
    timeoutMs: Number(env.ASSISTANT_TIMEOUT_MS || 12000),
    errors,
  };
}
