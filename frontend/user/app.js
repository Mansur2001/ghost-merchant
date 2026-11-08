// User PWA logic. Vanilla JS, no framework (keeps the bundle tiny per the data budget).
// Flow: sign in with a code (SMS or email) -> describe need -> geolocate + landmark -> create order ->
// tel: USSD pay -> subscribe over WebSocket -> live timeline + chat until DELIVERED.

const $ = (id) => document.getElementById(id);
const t = GMI18n.t;

// ── Session ──
// The token is the proof that this handset signed in to the account every order is authorized
// against. localStorage (not sessionStorage) on purpose: re-verifying costs a real SMS, and
// the customer is on one personal device. Cleared on sign-out or on any 401.
// gm_phone holds what they signed in with (phone or email), for "Signed in as".
const TOKEN_KEY = 'gm_token';
const PHONE_KEY = 'gm_phone';
const CONTACT_KEY = 'gm_contact'; // the last number given for the driver, to fill in next time
let token = localStorage.getItem(TOKEN_KEY);
let myPhone = localStorage.getItem(PHONE_KEY);

function setSession(newToken, login) {
  token = newToken;
  myPhone = login;
  localStorage.setItem(TOKEN_KEY, newToken);
  localStorage.setItem(PHONE_KEY, login);
}
function clearSession() {
  // The queue holds this customer's unsent writes; carrying them into another session would
  // replay one person's messages under another identity.
  if (window.GMQueue) GMQueue.clear();
  token = null;
  myPhone = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(PHONE_KEY);
  localStorage.removeItem(CONTACT_KEY);
  localStorage.removeItem('gm_last');
  localStorage.removeItem('gm_cart');
}

// Every request carries the bearer token. A 401 means the session died (expired, or the
// server's SESSION_SECRET was rotated) — drop it and send the user back to sign-in rather
// than leaving the UI in a half-broken state.
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(GMConfig.api(path), { ...opts, headers });
  } catch {
    // No answer at all — offline, DNS, timeout. Categorically different from the server
    // saying no, and the offline queue treats it differently.
    return { error: 'No connection.', offline: true };
  }
  if (res.status === 401 && token) {
    clearSession();
    showView('authView');
    toast(t('session.expired'));
    return { error: 'session expired' };
  }
  return GMConfig.readJson(res);
}

const STATES = [
  'PENDING_PAYMENT',
  'PAID_UNASSIGNED',
  'DISPATCHED',
  'IN_TRANSIT',
  'DELIVERED',
];
// Rides say "Driver on the way", deliveries "Driver getting your items": same states, own words.
const isRide = (o) => o && o.kind === 'RIDE';
const label = (s, o = order) => t(isRide(o) ? `st.ride.${s}` : `st.${s}`);
// Server errors arrive in English; show them in the customer's language.
const errText = (res) => (res.retryAfter
  ? t('auth.retry', { err: GMI18n.err(res.error), s: res.retryAfter })
  : GMI18n.err(res.error));

let order = null;
let pendingOrderId = null; // client-minted UUID, held across retries
let ws = null;
let phoneValid = false;
let phoneE164 = null;

// Live Somali-number validation: as the user types, sync the operator + formatting and
// reject anything that isn't a valid assigned prefix + length.
SomPhone.attach({
  input: $('phone'),
  hint: $('phoneHint'),
  onChange: (r) => { phoneValid = r.valid; phoneE164 = r.e164 || null; },
});

// The number the driver calls, asked at checkout: an email account has none, and a phone
// account may want a different one. Filled with the last one used.
let orderPhoneE164 = null;
$('orderPhone').value = localStorage.getItem(CONTACT_KEY) || '';
const refreshOrderPhone = SomPhone.attach({
  input: $('orderPhone'),
  hint: $('orderPhoneHint'),
  onChange: (r) => { orderPhoneE164 = r.valid ? r.e164 : null; },
});
function prefillOrderPhone(phone) {
  if (!phone || $('orderPhone').value.trim()) return;
  $('orderPhone').value = phone;
  refreshOrderPhone();
}

// ── Home / role selection ──
// The landing is the default first screen; "I'm a customer" reveals sign-in, or jumps
// straight to the order form if this handset is already verified.
$('asCustomer').addEventListener('click', () => { setAuthMode('signup'); goTab('home', { start: true }); });
$('asSignin').addEventListener('click', () => { setAuthMode('signin'); goTab('home', { start: true }); });

// Create account vs Sign in: one email code either way (the first verified code creates the
// account), so this only changes the words — but people look for "sign up", and a screen that
// only ever says "Sign in" reads as "you need an account first".
let authMode = 'signup';
function setAuthMode(mode) {
  authMode = mode;
  $('authMode').querySelectorAll('[data-mode]').forEach((b) =>
    b.setAttribute('aria-pressed', b.dataset.mode === mode ? 'true' : 'false'));
  $('authTitle').dataset.i18n = `auth.title.${mode}`;
  $('authIntro').dataset.i18n = `auth.intro.${mode}`;
  $('authTitle').textContent = t($('authTitle').dataset.i18n);
  $('authIntro').textContent = t($('authIntro').dataset.i18n);
  renderAuthMethod();
}

// ── Email + password (the everyday way in) ──
// A password sign-in needs no email to arrive. The emailed code stays for proving the address
// and for "forgot password": after a code sign-in the account can set a new one (15 minutes).
let authMethod = 'password';
let forgotFlow = false; // signed in by code from "Forgot your password?" -> go set a new one
let promptPasswordReset = false;
function renderAuthMethod() {
  const pw = authMethod === 'password' && emailOffered;
  $('pwBlock').classList.toggle('hidden', !pw);
  $('codeBlock').classList.toggle('hidden', pw);
  $('usePassword').classList.toggle('hidden', !emailOffered);
  $('pwConfirmWrap').classList.toggle('hidden', authMode !== 'signup');
  $('pwPass').autocomplete = authMode === 'signup' ? 'new-password' : 'current-password';
  $('pwBtn').dataset.i18n = authMode === 'signup' ? 'auth.pwCreate' : 'auth.pwSignin';
  $('pwBtn').textContent = t($('pwBtn').dataset.i18n);
  $('useCode').dataset.i18n = `auth.useCode.${authMode}`;
  $('useCode').textContent = t($('useCode').dataset.i18n);
  if (pw) {
    $('consentNote').dataset.i18nHtml = 'auth.consentPw';
    $('consentNote').innerHTML = t('auth.consentPw');
  } else {
    renderChannel();
  }
}
$('pwShow').addEventListener('change', () => {
  const type = $('pwShow').checked ? 'text' : 'password';
  ['pwPass', 'pwPass2'].forEach((id) => { $(id).type = type; });
});
$('useCode').addEventListener('click', () => {
  authMethod = 'code';
  forgotFlow = authMode === 'signin';
  // A forgotten password is an email account's: send the code there. Otherwise keep the
  // server's default channel (phone where SMS works).
  if (emailOffered && (forgotFlow || !smsOffered)) {
    otpChannel = 'email';
    if (!$('signinEmail').value) $('signinEmail').value = $('pwEmail').value;
  }
  renderAuthMethod();
});
$('usePassword').addEventListener('click', () => {
  authMethod = 'password';
  forgotFlow = false;
  if (!$('pwEmail').value) $('pwEmail').value = $('signinEmail').value;
  renderAuthMethod();
});
async function passwordSubmit() {
  const email = $('pwEmail').value.trim();
  const password = $('pwPass').value;
  if (!EMAIL_RE.test(email)) return toast(t('email.bad'));
  if (password.length < 8) return toast(t('err.pwShort'));
  if (authMode === 'signup' && password !== $('pwPass2').value) return toast(t('auth.pwMismatch'));
  $('pwBtn').disabled = true;
  $('pwStatus').textContent = '';
  const res = await api(authMode === 'signup' ? '/auth/signup' : '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  $('pwBtn').disabled = false;
  if (res.error) {
    $('pwStatus').textContent = errText(res);
    // "This email already has an account": the next thing they want is Sign in.
    if (res.status === 409) setAuthMode('signin');
    return;
  }
  setSession(res.token, res.email || res.phone);
  $('pwPass').value = ''; $('pwPass2').value = '';
  showSignedIn();
  goTab(afterSignIn || 'home');
  afterSignIn = null;
  toast(t(authMode === 'signup' ? 'auth.okNew' : 'auth.ok'));
}
$('pwBtn').addEventListener('click', passwordSubmit);
$('pwPass').addEventListener('keydown', (e) => { if (e.key === 'Enter' && authMode === 'signin') passwordSubmit(); });
$('authMode').querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.mode)));
$('authHome').addEventListener('click', () => showView('landingView'));

// ── Sign-in: request a code, then verify it ──
// With a phone (a text) or an email (only offered when the server sends email). Either alone
// is a full sign-in, and a first sign-in creates the account. The switch swaps the box.
let otpChannel = 'sms';
let smsOffered = true;
let emailOffered = false;
let codeFor = null; // what the code was sent for — { phone } or { email } — so verify matches it
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function renderChannel() {
  const email = otpChannel === 'email';
  $('channelPick').querySelectorAll('[data-channel]').forEach((b) =>
    b.setAttribute('aria-pressed', b.dataset.channel === otpChannel ? 'true' : 'false'));
  $('phoneSignin').classList.toggle('hidden', email);
  $('emailSignin').classList.toggle('hidden', !email);
  // Swap the key, not just the text, so a language switch re-renders the right label.
  $('sendCodeBtn').dataset.i18n = email ? 'auth.sendEmail' : 'auth.send';
  $('sendCodeBtn').textContent = t($('sendCodeBtn').dataset.i18n);
  $('consentNote').dataset.i18nHtml = email ? 'auth.consentEmail' : 'auth.consent';
  $('consentNote').innerHTML = t($('consentNote').dataset.i18nHtml);
}
$('channelPick').querySelectorAll('[data-channel]').forEach((b) =>
  b.addEventListener('click', () => {
    if (otpChannel === b.dataset.channel) return;
    otpChannel = b.dataset.channel;
    // A code sent the other way belongs to the other box: start this one fresh.
    codeFor = null;
    $('codeStep').classList.add('hidden');
    $('otpStatus').textContent = '';
    renderChannel();
    (otpChannel === 'email' ? $('signinEmail') : $('phone')).focus();
  }));
(async function loadChannels() {
  const res = await api('/auth/channels');
  emailOffered = Boolean(res.email);
  // A server without texting (no Twilio) signs everyone in by email: no switch, no phone box.
  smsOffered = res.sms !== false;
  $('channelPick').classList.toggle('hidden', !(emailOffered && smsOffered));
  otpChannel = emailOffered && !smsOffered ? 'email' : emailOffered ? otpChannel : 'sms';
  // Passwords are email accounts: with no email on this server, codes are the only way in.
  if (!emailOffered) authMethod = 'code';
  renderChannel();
  renderAuthMethod();
})();

async function requestCode() {
  let target;
  if (otpChannel === 'email') {
    const email = $('signinEmail').value.trim();
    if (!EMAIL_RE.test(email)) return toast(t('email.bad'));
    target = { channel: 'email', email };
  } else {
    if (!phoneValid) return toast(t('err.phone'));
    target = { phone: phoneE164 };
  }
  $('sendCodeBtn').disabled = true;
  $('resendBtn').disabled = true;
  $('otpStatus').textContent = t('auth.sending');
  const res = await api('/auth/otp/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(target),
  });
  $('sendCodeBtn').disabled = false;
  if (res.error) {
    // 429 carries retryAfter — tell them exactly how long, don't just fail.
    $('otpStatus').textContent = errText(res);
    $('resendBtn').disabled = false;
    return;
  }
  codeFor = target.email ? { email: target.email } : { phone: target.phone };
  $('codeStep').classList.remove('hidden');
  $('codeInput').focus();
  // devCode is only ever present with the log transport in a non-production backend.
  const m = Math.round(res.expiresInSeconds / 60);
  $('otpStatus').textContent = res.devCode
    ? t('auth.dev', { code: res.devCode })
    : target.email ? t('auth.sentEmailTo', { email: target.email, m }) : t('auth.sent', { phone: res.phone, m });
  startResendCountdown();
}

// The server enforces a 60s cooldown; mirror it in the UI so the button isn't a lie.
let resendLeft = 0;
let resendTimer = null;
function renderResend() {
  $('resendBtn').textContent = resendLeft > 0 ? t('auth.resendIn', { s: resendLeft }) : t('auth.resend');
}
function startResendCountdown(seconds = 60) {
  resendLeft = seconds;
  $('resendBtn').disabled = true;
  clearInterval(resendTimer);
  const tick = () => {
    renderResend();
    if (resendLeft <= 0) { $('resendBtn').disabled = false; clearInterval(resendTimer); }
    resendLeft -= 1;
  };
  resendTimer = setInterval(tick, 1000);
  tick();
}

async function verifyCode() {
  const code = $('codeInput').value.trim();
  if (!/^\d{6}$/.test(code)) return toast(t('err.code'));
  $('verifyBtn').disabled = true;
  const res = await api('/auth/otp/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(codeFor || { phone: phoneE164 }), code }),
  });
  $('verifyBtn').disabled = false;
  if (res.error || !res.token) {
    $('otpStatus').textContent = res.error ? GMI18n.err(res.error) : t('err.badCode');
    return;
  }
  setSession(res.token, res.phone || res.email);
  prefillOrderPhone(res.phone);
  $('codeInput').value = '';
  $('otpStatus').textContent = '';
  $('codeStep').classList.add('hidden');
  codeFor = null;
  showSignedIn();
  // Where they were headed before sign-in (My orders, Account) — otherwise a new order.
  // Came in through "Forgot your password?": straight to setting a new one.
  if (forgotFlow) { afterSignIn = 'account'; promptPasswordReset = true; forgotFlow = false; }
  goTab(afterSignIn || 'home');
  afterSignIn = null;
  toast(t(authMode === 'signup' ? 'auth.okNew' : 'auth.ok'));
}

// ── Adding an email to a phone account (signed in) ──
// An account that signs in BY email has nothing to add here, and removing it would lock it out.
let myEmail = null;
function renderEmailBox() {
  $('emailCurrent').textContent = myEmail ? t('email.current', { email: myEmail }) : t('email.none');
  $('emailAdd').classList.toggle('hidden', Boolean(myEmail));
  $('emailRemove').classList.toggle('hidden', !myEmail);
}
async function loadEmailBox() {
  if (!emailOffered || !token) return $('emailBox').classList.add('hidden');
  const res = await api('/auth/me');
  if (res.error) return;
  prefillOrderPhone(res.phone);
  if (!res.phone) return $('emailBox').classList.add('hidden');
  myEmail = res.email || null;
  $('emailBox').classList.remove('hidden');
  renderEmailBox();
}
$('emailSend').addEventListener('click', async () => {
  const email = $('emailInput').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return toast(t('email.bad'));
  $('emailSend').disabled = true;
  const res = await api('/auth/email/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  $('emailSend').disabled = false;
  if (res.error) { $('emailStatus').textContent = errText(res); return; }
  $('emailCodeStep').classList.remove('hidden');
  $('emailCode').focus();
  $('emailStatus').textContent = res.devCode ? t('auth.dev', { code: res.devCode }) : t('email.sent', { email: res.email });
});
$('emailVerify').addEventListener('click', async () => {
  const code = $('emailCode').value.trim();
  if (!/^\d{6}$/.test(code)) return toast(t('err.code'));
  $('emailVerify').disabled = true;
  const res = await api('/auth/email/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  $('emailVerify').disabled = false;
  if (res.error) { $('emailStatus').textContent = GMI18n.err(res.error); return; }
  myEmail = res.email;
  $('emailInput').value = $('emailCode').value = '';
  $('emailCodeStep').classList.add('hidden');
  $('emailStatus').textContent = '';
  renderEmailBox();
  toast(t('email.ok'));
});
$('emailRemove').addEventListener('click', async () => {
  const res = await api('/auth/email', { method: 'DELETE' });
  if (res.error) return toast(GMI18n.err(res.error));
  myEmail = null;
  renderEmailBox();
  toast(t('email.removed'));
});

$('sendCodeBtn').addEventListener('click', requestCode);
$('resendBtn').addEventListener('click', requestCode);
$('verifyBtn').addEventListener('click', verifyCode);
$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyCode(); });
$('signOutBtn').addEventListener('click', () => {
  if (ws) { try { ws.close(); } catch { /* already closed */ } ws = null; }
  order = null;
  clearSession();
  goTab('home');
  toast(t('signedOut'));
});

function badgeClass(s) {
  return s === 'FAILED_REFUND' ? 'fail' : s === 'PENDING_PAYMENT' ? 'pending' : 'paid';
}

// ── Places: the fixed list (markets, landmarks, districts) that search runs over ──
// Somali addresses are landmarks, not street numbers, so search is over places people name —
// no geocoder, no vendor. Fetched once per session.
let placesCache = null;
async function loadPlaces() {
  if (placesCache) return placesCache;
  const res = await api('/places');
  placesCache = res.places || [];
  return placesCache;
}
const so = () => GMI18n.lang() === 'so';
const placeName = (p) => (so() ? p.name_so : p.name_en) || p.name_en;
const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function searchPlaces(q) {
  const f = fold(q).trim();
  if (f.length < 2) return [];
  return (placesCache || []).filter((p) => fold(p.name_en).includes(f) || fold(p.name_so).includes(f)).slice(0, 8);
}
// Results as buttons; `onPick(place)` sets the point.
function renderPlaceResults(box, list, onPick) {
  box.replaceChildren(...list.map((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'place-result';
    const name = document.createElement('span');
    name.textContent = placeName(p);
    const sub = document.createElement('span');
    sub.className = 'muted';
    sub.textContent = p.city;
    b.append(name, sub);
    b.addEventListener('click', () => { box.replaceChildren(); onPick(p); });
    return b;
  }));
}
// What the server is told about a point: the place id when one was chosen (so the server uses
// ITS coordinates), otherwise the pin.
const pointBody = (p) => (p.placeId ? { placeId: p.placeId } : { lat: p.lat, lng: p.lng });
const pointText = (p) => (p.placeId ? p.label
  : p.gps ? t('ride.myLocation', { m: p.accuracy }) : t('ride.pinned'));

// A phone indoors in Mogadishu is often 100 m+ out. Above this, ask for the pin to be dragged.
const UNSURE_M = 120;

function vehicleName(v) { return t(`veh.${v}`); }
const VEHICLE_ICON = { bajaj: '🛺', car: '🚗', moto: '🏍️' };

// ── Ride booking ──
const ride = { pickup: null, dropoff: null, picking: 'pickup', vehicle: null, quote: null, map: null, seq: 0 };
let ridePhoneE164 = null;
const refreshRidePhone = SomPhone.attach({
  input: $('ridePhone'),
  hint: $('ridePhoneHint'),
  onChange: (r) => { ridePhoneE164 = r.valid ? r.e164 : null; },
});

function setPicking(which) {
  ride.picking = which;
  $('ridePick').querySelectorAll('[data-point]').forEach((b) =>
    b.setAttribute('aria-pressed', b.dataset.point === which ? 'true' : 'false'));
}
$('ridePick').querySelectorAll('[data-point]').forEach((b) => b.addEventListener('click', () => setPicking(b.dataset.point)));

function setRidePoint(which, p) {
  ride[which] = p;
  ride.map.pin(which, p, {
    kind: which,
    draggable: true,
    onMove: (q) => setRidePoint(which, { lat: q.lat, lng: q.lng }),
  });
  if (which === 'pickup') {
    ride.map.accuracy('acc', p.accuracy ? p : null, p.accuracy);
    $('pickupText').textContent = pointText(p);
  } else {
    $('dropoffText').textContent = pointText(p);
  }
  // The rider is usually standing at the pickup: once it's set, the next tap is the destination.
  if (which === 'pickup' && !ride.dropoff) setPicking('dropoff');
  ride.map.line('route', ride.pickup, ride.dropoff);
  if (ride.pickup && ride.dropoff) ride.map.fit([ride.pickup, ride.dropoff]);
  quoteRide();
}

async function locateForRide() {
  $('pickupText').textContent = t('ride.locating');
  try {
    const fix = await GMLocation.best({ onProgress: (f) => ride.map.pin('pickup', f, { kind: 'pickup' }) });
    setRidePoint('pickup', { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, gps: true });
    ride.map.fit([ride.pickup, ride.dropoff].filter(Boolean));
    $('rideMapHint').textContent = fix.accuracy > UNSURE_M ? t('ride.unsure', { m: fix.accuracy }) : t('ride.tapHint');
  } catch (e) {
    $('pickupText').textContent = t('ride.pickup.none');
    toast(t(e.reason === 'denied' ? 'loc.denied' : 'loc.fail'));
  }
}

function openRide() {
  showView('rideView', 'home');
  if (!ride.map) {
    ride.map = GMMap.create($('rideMap'));
    ride.map.onTap((p) => setRidePoint(ride.picking, p));
    loadPlaces();
  }
  ride.map.refresh();
  if (!$('ridePhone').value) { $('ridePhone').value = localStorage.getItem(CONTACT_KEY) || ''; refreshRidePhone(); }
  if (!ride.pickup) locateForRide();
}
$('goRide').addEventListener('click', openRide);
$('rideBack').addEventListener('click', () => goTab('home'));
$('rideLocate').addEventListener('click', locateForRide);

let searchTimer;
$('placeSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    await loadPlaces();
    renderPlaceResults($('placeResults'), searchPlaces($('placeSearch').value), (p) => {
      $('placeSearch').value = '';
      setRidePoint(ride.picking, { lat: p.lat, lng: p.lng, placeId: p.id, label: placeName(p) });
    });
  }, 150);
});

async function quoteRide() {
  ride.quote = null;
  renderRideOptions();
  if (!ride.pickup || !ride.dropoff) return;
  const seq = ++ride.seq;
  $('rideOptions').innerHTML = `<p class="muted">${t('ride.quoting')}</p>`;
  const res = await api('/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'RIDE', pickup: pointBody(ride.pickup), dropoff: pointBody(ride.dropoff) }),
  });
  if (seq !== ride.seq) return; // the pin moved again meanwhile: a newer quote is on its way
  if (res.error) { $('rideOptions').innerHTML = ''; $('rideOptions').textContent = GMI18n.err(res.error); return; }
  ride.quote = res.quote;
  if (!ride.vehicle || !ride.quote.options.some((o) => o.vehicle === ride.vehicle)) {
    // Default to the cheapest one that has a driver nearby, else the cheapest.
    const withDriver = ride.quote.options.filter((o) => o.available > 0);
    ride.vehicle = (withDriver[0] || ride.quote.options[0]).vehicle;
  }
  renderRideOptions();
}

function renderRideOptions() {
  const q = ride.quote;
  const box = $('rideOptions');
  if (!q) {
    if (!ride.pickup || !ride.dropoff) box.innerHTML = `<p class="muted">${t('ride.setBoth')}</p>`;
    $('rideBook').disabled = true;
    $('rideBook').textContent = t('ride.book');
    return;
  }
  box.replaceChildren(...q.options.map((o) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ride-option';
    b.setAttribute('aria-pressed', o.vehicle === ride.vehicle ? 'true' : 'false');
    b.innerHTML = `<span class="ro-icon">${VEHICLE_ICON[o.vehicle] || '🚗'}</span>
      <span class="ro-body"><strong></strong><span class="muted ro-sub"></span></span>
      <strong class="mono ro-price">$${Number(o.total).toFixed(2)}</strong>`;
    b.querySelector('strong').textContent = vehicleName(o.vehicle);
    b.querySelector('.ro-sub').textContent = [
      t('ride.min', { n: q.minutes }), GMMap.formatDistance(q.distance_m),
      o.available > 0 ? t('ride.nearby', { n: o.available }) : t('ride.noneNearby'),
    ].join(' · ');
    b.addEventListener('click', () => { ride.vehicle = o.vehicle; renderRideOptions(); });
    return b;
  }));
  const chosen = q.options.find((o) => o.vehicle === ride.vehicle);
  if (chosen && chosen.available === 0) {
    const warn = document.createElement('p');
    warn.className = 'callout warn';
    warn.textContent = t('ride.noneWarn', { v: vehicleName(chosen.vehicle) });
    box.appendChild(warn);
  }
  $('rideBook').disabled = !chosen;
  $('rideBook').textContent = chosen ? t('ride.bookFor', { v: vehicleName(chosen.vehicle), p: Number(chosen.total).toFixed(2) }) : t('ride.book');
}

let pendingRideId = null;
$('rideBook').addEventListener('click', async () => {
  if (!token) return showView('authView');
  if (!ride.pickup || !ride.dropoff) return toast(t('ride.err.points'));
  const chosen = ride.quote?.options.find((o) => o.vehicle === ride.vehicle);
  if (!chosen) return toast(t('ride.err.vehicle'));
  if (!ridePhoneE164) return toast(t('err.phone'));
  $('rideBook').disabled = true;
  pendingRideId = pendingRideId || GMIds.newId();
  const res = await api('/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'RIDE',
      id: pendingRideId,
      vehicle: ride.vehicle,
      pickup: pointBody(ride.pickup),
      dropoff: pointBody(ride.dropoff),
      pickupNote: $('pickupNote').value.trim(),
      landmark: ride.dropoff.placeId ? ride.dropoff.label : '',
      phone: ridePhoneE164,
      expectedTotal: chosen.total,
    }),
  });
  $('rideBook').disabled = false;
  if (res.error) {
    // The fare moved under us (tariff edited): show the new one, never book at a price unseen.
    if (res.quote) { ride.quote = res.quote; renderRideOptions(); }
    return toast(GMI18n.err(res.error));
  }
  pendingRideId = null;
  localStorage.setItem(CONTACT_KEY, ridePhoneE164);
  order = res.order;
  localStorage.setItem('gm_last', JSON.stringify({ orderId: order.id }));
  ride.dropoff = null;
  ride.map.remove('dropoff');
  ride.map.remove('route');
  $('dropoffText').textContent = t('ride.dropoff.none');
  $('pickupNote').value = '';
  ride.quote = null;
  enterOrderView(res);
});

// ── Catalog + cart ──
// The cart lives on this handset (gm_cart) as { itemId: qty }; the server prices it at
// checkout from the live catalog, so a stale price here can't be what anyone pays.
const CART_KEY = 'gm_cart';
let catalog = null;
let activeCat = null;
let cart = {};
try { cart = JSON.parse(localStorage.getItem(CART_KEY) || '{}') || {}; } catch { cart = {}; }
function saveCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* private mode */ }
  renderCartBar();
}
const itemById = (id) => {
  for (const c of catalog || []) for (const i of c.items) if (i.id === Number(id)) return i;
  return null;
};
const itemName = (i) => (so() ? i.name_so : i.name_en) || i.name_en;
const itemUnit = (i) => (so() ? i.unit_so : i.unit_en) || i.unit_en || '';

async function loadCatalog(force = false) {
  if (catalog && !force) return catalog;
  const res = await api('/catalog');
  if (res.error) { toast(GMI18n.err(res.error)); return catalog || []; }
  catalog = res.categories || [];
  // Drop lines for items no longer sold.
  let changed = false;
  for (const id of Object.keys(cart)) if (!itemById(id)) { delete cart[id]; changed = true; }
  if (changed) saveCart();
  return catalog;
}

function setQty(id, qty) {
  const n = Math.max(0, Math.min(50, qty));
  if (n === 0) delete cart[id];
  else cart[id] = n;
  saveCart();
}

function stepper(id) {
  const wrap = document.createElement('span');
  wrap.className = 'qty';
  const qty = cart[id] || 0;
  if (!qty) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'step-add';
    add.textContent = t('shop.add');
    add.addEventListener('click', () => { setQty(id, 1); rerenderQty(); });
    wrap.appendChild(add);
    return wrap;
  }
  const minus = document.createElement('button');
  minus.type = 'button';
  minus.textContent = '−';
  minus.setAttribute('aria-label', '−');
  minus.addEventListener('click', () => { setQty(id, qty - 1); rerenderQty(); });
  const n = document.createElement('span');
  n.className = 'step-n';
  n.textContent = qty;
  const plus = document.createElement('button');
  plus.type = 'button';
  plus.textContent = '+';
  plus.setAttribute('aria-label', '+');
  plus.addEventListener('click', () => { setQty(id, qty + 1); rerenderQty(); });
  wrap.append(minus, n, plus);
  return wrap;
}

function rerenderQty() {
  if (!$('shopView').classList.contains('hidden')) renderCatalog();
  if (!$('startView').classList.contains('hidden')) { renderCartLines(); quoteDelivery(); }
}

function renderCatalog() {
  const cats = catalog || [];
  if (!activeCat || !cats.some((c) => c.id === activeCat)) activeCat = cats[0]?.id ?? null;
  $('catChips').replaceChildren(...cats.map((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cat-chip';
    b.setAttribute('aria-pressed', c.id === activeCat ? 'true' : 'false');
    b.textContent = `${c.icon || ''} ${so() ? c.name_so : c.name_en}`.trim();
    b.addEventListener('click', () => { activeCat = c.id; renderCatalog(); });
    return b;
  }));
  const cat = cats.find((c) => c.id === activeCat);
  if (!cat) { $('catItems').innerHTML = `<p class="muted">${t('shop.empty')}</p>`; return; }
  $('catItems').replaceChildren(...cat.items.map((i) => {
    const row = document.createElement('div');
    row.className = 'cat-item';
    const body = document.createElement('span');
    body.className = 'cat-body';
    const name = document.createElement('strong');
    name.textContent = itemName(i);
    const sub = document.createElement('span');
    sub.className = 'muted';
    sub.textContent = [itemUnit(i), `$${Number(i.price).toFixed(2)}`].filter(Boolean).join(' · ');
    body.append(name, sub);
    row.append(body, stepper(i.id));
    return row;
  }));
}

function cartSummary() {
  let count = 0;
  let cents = 0;
  for (const [id, qty] of Object.entries(cart)) {
    const i = itemById(id);
    if (!i) continue;
    count += qty;
    cents += Math.round(Number(i.price) * 100) * qty;
  }
  return { count, cents };
}
function renderCartBar() {
  const { count, cents } = cartSummary();
  $('cartBar').classList.toggle('hidden', count === 0);
  $('cartCount').textContent = t('shop.items', { n: count });
  $('cartSum').textContent = (cents / 100).toFixed(2);
}

async function openShop() {
  showView('shopView', 'home');
  if (!catalog) $('catItems').innerHTML = `<p class="muted">${t('shop.loading')}</p>`;
  await loadCatalog();
  renderCatalog();
  renderCartBar();
}
$('goShop').addEventListener('click', openShop);
$('shopBack').addEventListener('click', () => goTab('home'));
$('cartOpen').addEventListener('click', () => openCheckout());
$('shopCustom').addEventListener('click', () => openCheckout({ custom: true }));
$('checkoutBack').addEventListener('click', openShop);

// ── Checkout ──
const drop = { point: null, map: null, quote: null, seq: 0 };

function renderCartLines() {
  const ids = Object.keys(cart).filter((id) => itemById(id));
  if (!ids.length) {
    $('cartLines').innerHTML = `<p class="muted" style="margin:0;">${t('cart.empty')}</p>`;
    return;
  }
  $('cartLines').replaceChildren(...ids.map((id) => {
    const i = itemById(id);
    const row = document.createElement('div');
    row.className = 'cat-item';
    const body = document.createElement('span');
    body.className = 'cat-body';
    const name = document.createElement('strong');
    name.textContent = itemName(i);
    const sub = document.createElement('span');
    sub.className = 'muted';
    sub.textContent = `${itemUnit(i)} · $${(Number(i.price) * cart[id]).toFixed(2)}`;
    body.append(name, sub);
    row.append(body, stepper(Number(id)));
    return row;
  }));
}

function setDropPoint(p) {
  drop.point = p;
  drop.map.pin('dropoff', p, { kind: 'dropoff', draggable: true, onMove: (q) => setDropPoint({ lat: q.lat, lng: q.lng }) });
  drop.map.accuracy('acc', p.accuracy ? p : null, p.accuracy);
  $('locStatus').textContent = p.placeId ? p.label
    : p.gps && p.accuracy > UNSURE_M ? t('ride.unsure', { m: p.accuracy })
      : p.gps ? t('loc.ok', { m: p.accuracy }) : t('ride.pinned');
  if (p.placeId && !$('landmark').value.trim()) $('landmark').value = p.label;
  quoteDelivery();
}

async function openCheckout({ custom = false } = {}) {
  if (!token) { afterSignIn = 'home'; return showView('authView', 'home'); }
  showView('startView', 'home');
  await loadCatalog();
  renderCartLines();
  if (custom) { $('customBox').open = true; $('request').focus(); }
  if (!drop.map) {
    drop.map = GMMap.create($('dropMap'), { zoom: 13 });
    drop.map.onTap((p) => setDropPoint(p));
    loadPlaces();
  }
  drop.map.refresh();
  if (drop.point) drop.map.fit([drop.point]);
  prefillOrderPhone(localStorage.getItem(CONTACT_KEY));
  quoteDelivery();
}

function deliveryBody() {
  const lines = Object.entries(cart).filter(([id]) => itemById(id)).map(([itemId, qty]) => ({ itemId: Number(itemId), qty }));
  const text = $('request').value.trim();
  const budget = parseFloat($('budget').value);
  const body = { kind: 'DELIVERY', cart: { lines } };
  if (text || budget) body.cart.custom = { text, budget };
  if (drop.point) body.dropoff = pointBody(drop.point);
  return body;
}

let quoteTimer;
function quoteDelivery() {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(runDeliveryQuote, 250);
}
async function runDeliveryQuote() {
  drop.quote = null;
  const body = deliveryBody();
  const empty = !body.cart.lines.length && !body.cart.custom;
  const show = (sub, fee, total, note) => {
    $('qSubtotal').textContent = sub; $('qFee').textContent = fee; $('qTotal').textContent = total;
    $('qNote').textContent = note || '';
  };
  if (empty) return show('—', '—', '—', t('cart.empty'));
  if (!drop.point) return show('—', '—', '—', t('quote.needPlace'));
  const seq = ++drop.seq;
  const res = await api('/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (seq !== drop.seq) return;
  if (res.error) {
    // A half-typed custom line is not worth a red error while typing; say it only on submit.
    if (res.status === 409) { await loadCatalog(true); renderCartLines(); }
    return show('—', '—', '—', GMI18n.err(res.error));
  }
  drop.quote = res.quote;
  const q = res.quote;
  const from = q.pickup ? t('quote.from', { m: q.pickup.label, d: GMMap.formatDistance(q.distance_m) }) : '';
  show(q.subtotal, q.fee, q.total, from);
}
['request', 'budget'].forEach((id) => $(id).addEventListener('input', quoteDelivery));

$('locBtn').addEventListener('click', async () => {
  $('locStatus').textContent = t('loc.finding');
  try {
    const fix = await GMLocation.best({ onProgress: (f) => drop.map.pin('dropoff', f, { kind: 'dropoff' }) });
    setDropPoint({ lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, gps: true });
    drop.map.fit([drop.point]);
  } catch (e) {
    $('locStatus').textContent = t(e.reason === 'denied' ? 'loc.denied' : 'loc.fail');
  }
});

$('dropSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    await loadPlaces();
    renderPlaceResults($('dropResults'), searchPlaces($('dropSearch').value), (p) => {
      $('dropSearch').value = '';
      setDropPoint({ lat: p.lat, lng: p.lng, placeId: p.id, label: placeName(p) });
      drop.map.fit([drop.point]);
    });
  }, 150);
});

// ── Place the delivery order ──
// The owner is never sent: the server takes the account from the verified session. `phone` is
// only the number the driver calls. The price is the server's; expectedTotal is what the
// customer saw, and a mismatch is refused rather than charged.
$('submitBtn').addEventListener('click', async () => {
  const body = deliveryBody();
  const landmark = $('landmark').value.trim();
  if (!token) return showView('authView');
  if (!body.cart.lines.length && !body.cart.custom) return toast(t('err.cartEmpty'));
  if (body.cart.custom && !body.cart.custom.text) return toast(t('start.err.request'));
  if (!drop.point) return toast(t('quote.needPlace'));
  if (!orderPhoneE164) return toast(t('err.phone'));
  if (!landmark) return toast(t('start.err.landmark'));

  $('submitBtn').disabled = true;
  // Mint the id here, once, and reuse it if we retry. A lost response on a bad connection
  // must not create a second order the customer could pay for twice.
  pendingOrderId = pendingOrderId || GMIds.newId();
  try {
    const res = await api('/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...body, id: pendingOrderId, phone: orderPhoneE164, landmark,
        ...(drop.quote ? { expectedTotal: drop.quote.total } : {}),
      }),
    });
    if (res.error) {
      if (res.quote) { drop.quote = res.quote; $('qTotal').textContent = res.quote.total; }
      if (res.status === 409 && !res.quote) { await loadCatalog(true); renderCartLines(); }
      throw new Error(res.error);
    }
    order = res.order;
    pendingOrderId = null; // consumed
    localStorage.setItem(CONTACT_KEY, orderPhoneE164);
    localStorage.setItem('gm_last', JSON.stringify({ orderId: order.id }));
    const file = $('refPhoto').files[0];
    const customText = body.cart.custom?.text;
    // The cart is done with: the next order starts clean.
    cart = {};
    saveCart();
    $('request').value = '';
    $('budget').value = '';
    $('landmark').value = '';
    $('customBox').open = false;
    enterOrderView(res);
    if (customText) {
      await api(`/orders/${order.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: customText }),
      });
    }
    // Optional reference photo → MinIO.
    $('refPhoto').value = '';
    $('refCapture').classList.remove('done');
    if (file) { try { await uploadPhoto(order.id, file); await loadPhotos(order.id); } catch { /* non-fatal */ } }
  } catch (e) {
    toast(GMI18n.err(e.message));
  } finally {
    $('submitBtn').disabled = false;
  }
});

// `payment` is { paymentMethod, ussdUri, paymentNote } from the server. A US test number
// has no mobile-money rail, so there may be no wallet at all — render what we're given rather than
// assuming a pay link exists.
function enterOrderView(payment) {
  showView('orderView', 'orders');
  $('orderId').textContent = GMIds.shortId(order.id);
  $('orderTotal').textContent = Number(order.total_amount).toFixed(2);
  renderOrderDetails();
  renderPayment(payment || {});
  renderTimeline(order.status);
  updateBadge(order.status);
  loadThread();
  loadPhotos(order.id);
  refreshEvidence();
  renderOrderMap();
  loadAttempt();
  if (!ws) connectSocket();
  else if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'subscribe', orderId: order.id }));
}

function renderOrderDetails() {
  if (isRide(order)) {
    $('orderItemsLabel').textContent = t('order.from');
    $('orderItems').textContent = order.pickup_text || t('ride.pinned');
    $('orderLandmarkLabel').textContent = t('order.to');
  } else {
    $('orderItemsLabel').textContent = t('order.items');
    $('orderItems').textContent = (order.items || []).map((it) => it.text || '').filter(Boolean).join(', ') || '—';
    $('orderLandmarkLabel').textContent = t('order.landmark');
  }
  $('orderLandmark').textContent = order.landmark_text || '—';
}

// ── Tracking map: where the job starts, where it ends, and the driver's live dot ──
let orderMap = null;
let driverAt = null;
function renderOrderMap() {
  const start = order.pickup_lat != null ? { lat: order.pickup_lat, lng: order.pickup_lng } : null;
  const end = order.lat != null ? { lat: order.lat, lng: order.lng } : null;
  const card = $('orderMapCard');
  const live = ['DISPATCHED', 'IN_TRANSIT'].includes(order.status);
  if (!start && !end) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  if (!orderMap) orderMap = GMMap.create($('orderMap'));
  orderMap.refresh();
  orderMap.pin('start', start, { kind: isRide(order) ? 'pickup' : 'market' });
  orderMap.pin('end', end, { kind: 'dropoff' });
  orderMap.line('route', start, end);
  if (!live) { driverAt = null; orderMap.remove('driver'); $('driverStrip').classList.add('hidden'); }
  orderMap.fit([start, end, driverAt].filter(Boolean));
  if (live) loadDriverLocation();
}
async function loadDriverLocation() {
  const res = await api(`/orders/${order.id}/driver-location`);
  if (res.location) showDriver(res.location);
}
function showDriver(loc) {
  if (!order || !orderMap || !['DISPATCHED', 'IN_TRANSIT'].includes(order.status)) return;
  const first = !driverAt;
  driverAt = { lat: loc.lat, lng: loc.lng, name: loc.name || driverAt?.name, vehicle: loc.vehicle || driverAt?.vehicle };
  orderMap.pin('driver', driverAt, { kind: 'driver' });
  // Where the driver is headed next: the rider's pickup, else the door.
  const target = isRide(order) && order.status === 'DISPATCHED'
    ? { lat: order.pickup_lat, lng: order.pickup_lng } : { lat: order.lat, lng: order.lng };
  const d = GMMap.distance(driverAt, target);
  const minutes = Math.max(1, Math.ceil(((d * 1.3) / 1000 / 18) * 60));
  $('driverIc').textContent = VEHICLE_ICON[driverAt.vehicle] || '🛵';
  $('driverName').textContent = driverAt.name || '';
  $('driverEta').textContent = ` · ${t('drv.eta', { d: GMMap.formatDistance(d), n: minutes })}`;
  $('driverStrip').classList.remove('hidden');
  if (first) orderMap.fit([driverAt, target]);
}

// ── Cancel (before a driver has it) ──
$('cancelBtn').addEventListener('click', async () => {
  const b = $('cancelBtn');
  if (b.dataset.armed !== '1') {
    b.dataset.armed = '1';
    b.textContent = t('order.cancelConfirm');
    setTimeout(() => { b.dataset.armed = ''; b.textContent = t('order.cancel'); }, 5000);
    return;
  }
  b.dataset.armed = '';
  b.disabled = true;
  const res = await api(`/orders/${order.id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  b.disabled = false;
  b.textContent = t('order.cancel');
  if (res.error) return toast(GMI18n.err(res.error));
  order = { ...order, ...res.order };
  updateBadge(order.status);
  toast(t('order.cancelled'));
});

// ── Pay in the app (WaafiPay: EVC Plus, Zaad, Sahal) ──
// The customer's phone gets a prompt and they approve with their PIN; the gateway's approval
// is what marks the order paid. Answers arrive over the socket as payment_attempt.
let payPhoneE164 = null;
const refreshPayPhone = SomPhone.attach({
  input: $('payPhone'),
  hint: $('payPhoneHint'),
  onChange: (r) => { payPhoneE164 = r.valid && r.country === 'SO' ? r.e164 : null; },
});
let attemptState = null;
function renderAppPay(payment) {
  const wallets = payment.appPay || [];
  const show = wallets.length > 0 && order && order.status === 'PENDING_PAYMENT';
  $('appPay').classList.toggle('hidden', !show);
  if (!show) return;
  if (!$('payPhone').value && /^\+252/.test(order.user_phone || '')) {
    $('payPhone').value = order.user_phone.replace(/^\+252/, '');
    refreshPayPhone();
  }
  const busy = attemptState === 'pending';
  $('appPayButtons').replaceChildren(...wallets.map((w) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.disabled = busy;
    b.textContent = t('apppay.btn', { amt: Number(order.total_amount).toFixed(2), wallet: w.name });
    b.addEventListener('click', () => payInApp(w.id));
    return b;
  }));
  const st = $('appPayStatus');
  st.classList.toggle('hidden', !attemptState);
  st.className = 'callout' + (attemptState === 'declined' || attemptState === 'unknown' ? ' warn' : '') + (attemptState ? '' : ' hidden');
  if (attemptState) st.textContent = t(`apppay.${attemptState}`);
}
async function payInApp(wallet) {
  if (!payPhoneE164) return toast(t('err.payPhone'));
  attemptState = 'pending';
  renderAppPay(lastPayment);
  const res = await api(`/orders/${order.id}/pay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet, phone: payPhoneE164 }),
  });
  if (res.error) { attemptState = null; renderAppPay(lastPayment); return toast(GMI18n.err(res.error)); }
  attemptState = res.attempt?.status || 'pending';
  renderAppPay(lastPayment);
}
async function loadAttempt() {
  attemptState = null;
  if (!order || order.status !== 'PENDING_PAYMENT' || !(lastPayment.appPay || []).length) return;
  const res = await api(`/orders/${order.id}/payment`);
  if (res.attempt && String(res.attempt.orderId) === String(order.id)) attemptState = res.attempt.status;
  renderAppPay(lastPayment);
}

// ── Delivery code + proof ──
// The code is the customer's half of the handoff: the driver can't finish the delivery
// without hearing it, so it only ever shows here, on the customer's own screen.
async function loadHandoff() {
  const card = $('handoffCard');
  if (!order || !['PAID_UNASSIGNED', 'DISPATCHED', 'IN_TRANSIT'].includes(order.status)) {
    card.classList.add('hidden');
    return;
  }
  const res = await api(`/orders/${order.id}/handoff`);
  if (!res.code) { card.classList.add('hidden'); return; }
  card.querySelector('.section-title').textContent = t(isRide(order) ? 'code.title.ride' : 'code.title');
  $('codeHelp').textContent = t(isRide(order) ? 'code.help.ride' : 'code.help');
  $('handoffCode').replaceChildren(...res.code.split('').map((d) => {
    const span = document.createElement('span');
    span.textContent = d;
    return span;
  }));
  card.classList.remove('hidden');
}

const PROOF_TEXT = {
  'pickup:photo': 'proof.pickup',
  'pickup:code': 'proof.ridePickup',
  'pickup:no_code': 'proof.rideNoCode',
  'delivery:dropoff': 'proof.dropoff',
  'delivery:code': 'proof.code',
  'delivery:photo_no_code': 'proof.noCode',
};
async function loadProofs() {
  if (!order) return;
  const res = await api(`/orders/${order.id}/proofs`);
  const proofs = res.proofs || [];
  $('proofCard').classList.toggle('hidden', proofs.length === 0);
  $('proofList').replaceChildren(...proofs.map((p) => {
    const li = document.createElement('li');
    const ic = document.createElement('span');
    const weak = p.method === 'photo_no_code' || p.method === 'no_code';
    ic.className = 'ic' + (weak ? ' warn' : '');
    ic.textContent = weak ? '!' : '✓';
    const body = document.createElement('span');
    const when = new Date(p.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    body.textContent = `${t(PROOF_TEXT[`${p.step}:${p.method}`] || 'proof.pickup')} · ${when}`;
    li.append(ic, body);
    return li;
  }));
  // "I didn't get my order": open for 3 days after delivery, once.
  const delivery = proofs.find((p) => p.step === 'delivery');
  const disputed = Boolean(delivery?.flags?.includes('customer_disputed'));
  const recent = delivery && Date.now() - new Date(delivery.created_at).getTime() < 72 * 3600 * 1000;
  $('disputeBox').classList.toggle('hidden', !delivery || disputed || !recent || isRide(order));
  $('disputeNote').classList.toggle('hidden', !disputed);
}

// Two taps: it puts the delivery in front of an operator, so it shouldn't happen by accident.
$('disputeBtn').addEventListener('click', async () => {
  const b = $('disputeBtn');
  if (b.dataset.armed !== '1') {
    b.dataset.armed = '1';
    b.textContent = t('dispute.confirm');
    setTimeout(() => { b.dataset.armed = ''; b.textContent = t('dispute.btn'); }, 5000);
    return;
  }
  b.dataset.armed = '';
  b.disabled = true;
  const res = await api(`/orders/${order.id}/dispute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  b.disabled = false;
  b.textContent = t('dispute.btn');
  if (res.error) return toast(GMI18n.err(res.error));
  loadProofs();
});

// Timestamps for the progress list come from the audit log, so "Paid 14:02" is the moment it
// really happened, not when this page happened to load.
let lastTimeline = [];
async function loadTimeline() {
  if (!order) return;
  const res = await api(`/orders/${order.id}/timeline`);
  lastTimeline = res.timeline || [];
  renderTimeline(order.status);
}

function refreshEvidence() {
  loadHandoff();
  loadProofs();
  loadTimeline();
}

// One pay button per wallet the server offers. Show none when this order can't be paid that
// way: a dead `tel:*712*...#` link on a +1 number produces a dial string the network rejects —
// worse than no button, because the customer thinks they've paid.
let lastPayment = {};
// The wallet the customer tapped, sent with "I've paid" so the operator checks the right
// merchant phone. Kept per order because opening the dialer can reload the page.
const walletKey = (id) => `gm_wallet_${id}`;
function renderPayment(payment) {
  lastPayment = payment;
  const box = $('payWallets');
  const note = $('payNote');
  const wallets = payment.paymentMethod === 'ussd' ? (payment.wallets || []) : [];
  box.replaceChildren(...wallets.map((w) => {
    // CRITICAL: use the server-built URI verbatim; the trailing # is already %23-encoded.
    const link = document.createElement('a');
    link.setAttribute('href', w.ussdUri);
    link.addEventListener('click', () => {
      try { localStorage.setItem(walletKey(order.id), w.id); } catch { /* best effort */ }
    });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = t('pay.btn', { wallet: w.name });
    link.appendChild(btn);
    return link;
  }));
  box.classList.toggle('hidden', !wallets.length);
  // The server's paymentNote is English; the method alone says which message applies.
  note.textContent = wallets.length ? t(wallets.length > 1 ? 'pay.pick' : 'pay.note') : t('pay.manual');
  renderAppPay(payment);
  renderWalletPay();
}

function chosenWallet() {
  const offered = (lastPayment.wallets || []).map((w) => w.id);
  let id = null;
  try { id = localStorage.getItem(walletKey(order.id)); } catch { /* none */ }
  if (offered.includes(id)) return id;
  // Only one way to pay: that's the one they used.
  return offered.length === 1 ? offered[0] : null;
}

// ── Photos (MinIO-backed; bytes stream through the backend) ──
async function uploadPhoto(orderId, file) {
  await fetch(GMConfig.api(`/orders/${orderId}/photos/order_ref`), {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      Authorization: `Bearer ${token}`,
    },
    body: file,
  });
}
async function loadPhotos(orderId) {
  try {
    const { photos } = await api(`/orders/${orderId}/photos`);
    const el = $('photos');
    if (!photos || !photos.length) { el.innerHTML = `<span class="muted">${t('photos.none')}</span>`; return; }
    // Photo bytes are authorized too, so they can't be loaded with a plain <img src>.
    // Fetch each with the token and render from an object URL.
    el.innerHTML = photos.map((p) => `
      <figure class="photo">
        <img data-src="${p.url}" alt="${p.kind}" loading="lazy" />
        <figcaption class="muted">${p.kind === 'delivery_proof' ? t('photo.proof') : t('photo.ref')}</figcaption>
      </figure>`).join('');
    el.querySelectorAll('img[data-src]').forEach(async (img) => {
      try {
        const r = await fetch(GMConfig.base + img.dataset.src, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return;
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        img.src = url;
        img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
      } catch { /* leave the placeholder */ }
    });
  } catch { /* ignore */ }
}

// ── Offline queue ──
// Replays queued writes when the network returns. Customer-side writes are chat messages and
// order creation, both carrying a client-minted UUID, so a replay of something that already
// landed is a no-op on the server rather than a duplicate.
async function sendQueued(item) {
  const res = await fetch(GMConfig.api(item.path), {
    method: item.method,
    headers: {
      'Content-Type': item.contentType,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: item.body,
  });
  return { status: res.status };
}

function flushQueue() {
  if (!token || !navigator.onLine) return;
  GMQueue.flush(sendQueued).then(({ sent }) => {
    if (sent > 0 && order) loadThread();
  });
}

let lastSyncStats = null;
function renderSyncState(stats) {
  const el = $('syncState');
  if (!el) return;
  lastSyncStats = stats;
  const d = GMSync.describe(stats);
  el.textContent = d.tone === 'error' ? t('sync.failed', { n: stats.failed })
    : d.tone === 'pending' ? t('sync.pending', { n: stats.pending }) : '';
  el.className = 'sync-state ' + d.tone;
  el.classList.toggle('hidden', d.tone === 'ok');
}

window.addEventListener('online', flushQueue);
setInterval(flushQueue, 15000);
GMQueue.onChange(renderSyncState);

// ── Realtime socket: authenticate, then subscribe to THIS order ──
// A browser can't set headers on a WebSocket handshake and a token in the query string ends
// up in every access log, so the token goes in the first frame instead. The server drops
// sockets that haven't authenticated within 10s.
function connectSocket() {
  ws = new WebSocket(GMConfig.wsUrl());
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', token }));
  };
  ws.onclose = () => {
    if (token && order) setTimeout(connectSocket, 2000); // auto-reconnect
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'authenticated') {
      if (order) ws.send(JSON.stringify({ type: 'subscribe', orderId: order.id }));
      flushQueue(); // a live socket is the most reliable signal the network is actually back
    } else if (m.type === 'auth_error') {
      clearSession();
      showView('authView');
    } else if (m.type === 'order_state') {
      if (!order || String(m.orderId) !== String(order.id)) return;
      order.status = m.to;
      renderTimeline(m.to);
      updateBadge(m.to);
      refreshEvidence();
      // Assigned, released or finished: the driver (and who it is) may have changed.
      resumeOrderQuietly();
      if (m.to === 'DELIVERED') loadPhotos(order.id);
    } else if (m.type === 'driver_location') {
      if (!order || String(m.orderId) !== String(order.id)) return;
      showDriver(m);
    } else if (m.type === 'payment_attempt') {
      if (!order || String(m.orderId) !== String(order.id)) return;
      attemptState = m.status;
      renderAppPay(lastPayment);
    } else if (m.type === 'payment_confirmed') {
      if (!order || String(m.orderId) !== String(order.id)) return;
      toast(t('pay.confirmed'));
    } else if (m.type === 'message') {
      if (!order || String(m.orderId) !== String(order.id)) return;
      appendMessage(m.message);
      // A system line accompanies every photo upload → refresh the gallery live.
      if (m.message && m.message.sender === 'system') loadPhotos(order.id);
    }
  };
}

// Re-read the order after a state change (driver id, timestamps) without leaving the screen.
async function resumeOrderQuietly() {
  if (!order) return;
  const res = await api(`/orders/${order.id}`);
  if (!res.order || String(res.order.id) !== String(order.id)) return;
  order = res.order;
  renderOrderMap();
}

// ── Timeline + badge ──
function renderTimeline(status) {
  const isFail = status === 'FAILED_REFUND';
  const idx = STATES.indexOf(status);
  const at = {};
  lastTimeline.forEach((e) => { at[e.to_status] = e.created_at; });
  const when = (s) => (at[s]
    ? `<div class="when">${new Date(at[s]).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}</div>`
    : '');
  const reached = isFail ? STATES.filter((s) => at[s]) : STATES;
  $('timeline').innerHTML = reached.map((s, i) => {
    let cls = '';
    if (isFail || i < idx) cls = 'done';
    else if (i === idx) cls = status === 'DELIVERED' ? 'done' : 'active';
    return `<li class="${cls}"><div class="label">${label(s)}</div>${when(s)}</li>`;
  }).join('') + (isFail ? `<li class="failed"><div class="label">${label('FAILED_REFUND')}</div>${when('FAILED_REFUND')}</li>` : '');
}

// The big status at the top of the tracking screen, and the five-segment progress track.
function renderHero(status) {
  const isFail = status === 'FAILED_REFUND';
  const idx = STATES.indexOf(status);
  $('statusTitle').textContent = label(status);
  $('statusSub').textContent = t(isRide(order) ? `st.ride.sub.${status}` : `st.sub.${status}`);
  const track = $('track');
  track.className = 'track' + (isFail ? ' fail' : '');
  track.innerHTML = STATES.map((s, i) => {
    const cls = isFail ? '' : i < idx || status === 'DELIVERED' ? 'done' : i === idx ? 'now' : '';
    return `<span class="${cls}"></span>`;
  }).join('');
}

function updateBadge(status) {
  const b = $('statusBadge');
  b.textContent = label(status);
  b.className = 'badge ' + (status === 'FAILED_REFUND' ? 'fail' : status === 'PENDING_PAYMENT' ? 'pending' : 'paid');
  renderHero(status);
  // Nothing left to pay once paid (or failed): hide the whole card except while pending.
  $('payCard').classList.toggle('hidden', status !== 'PENDING_PAYMENT');
  // Once paid (or failed), a live "Pay now" button invites paying twice. Runs after
  // renderPayment() and on every socket transition, so it always has the last word.
  if (status !== 'PENDING_PAYMENT') {
    $('payWallets').classList.add('hidden');
    $('payNote').classList.add('hidden');
  } else {
    $('payNote').classList.remove('hidden');
  }
  renderPaidClaim(status);
  $('cancelBtn').classList.toggle('hidden', !['PENDING_PAYMENT', 'PAID_UNASSIGNED'].includes(status));
  if (status !== 'PENDING_PAYMENT') { $('appPay').classList.add('hidden'); $('walletPayBox').classList.add('hidden'); }
}

// ── "I've paid" ──
// Nothing reads the merchant's receipts automatically: an operator checks the merchant phone.
// This tells them which order to check. It is not proof of payment, and the order only turns
// "paid" when the operator confirms — the page then updates on its own over the socket.
function renderPaidClaim(status) {
  const pending = status === 'PENDING_PAYMENT';
  const claimed = Boolean(order && order.payment_claimed_at);
  $('paidBox').classList.toggle('hidden', !pending || claimed);
  $('paidNote').classList.toggle('hidden', !pending || !claimed);
  if (pending && claimed) {
    $('paidNote').textContent = t('paid.waiting') +
      (order.payment_claim_ref ? ` ${t('paid.ref', { ref: order.payment_claim_ref })}` : '');
  }
}

$('paidBtn').addEventListener('click', async () => {
  if (!order) return;
  $('paidBtn').disabled = true;
  const res = await api(`/orders/${order.id}/paid`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference: $('payRef').value.trim(), wallet: chosenWallet() }),
  });
  $('paidBtn').disabled = false;
  if (res.error) return toast(GMI18n.err(res.error));
  order = { ...order, ...res.order };
  $('payRef').value = '';
  renderPaidClaim(order.status);
  toast(t('paid.sent'));
});

// ── Chat ──
async function loadThread() {
  const { messages } = await api(`/orders/${order.id}/messages`);
  $('thread').innerHTML = '';
  (messages || []).forEach(appendMessage);
}
function appendMessage(m) {
  // A message we optimistically rendered comes back over the socket once it lands. Replace
  // the placeholder rather than showing the customer their own message twice.
  if (m.client_id) {
    const existing = $('thread').querySelector(`[data-client-id="${m.client_id}"]`);
    if (existing) {
      existing.classList.remove('queued');
      existing.textContent = m.body;
      return;
    }
  }
  const div = document.createElement('div');
  div.className = `msg ${m.sender}${m.queued ? ' queued' : ''}`;
  if (m.clientId || m.client_id) div.dataset.clientId = m.clientId || m.client_id;
  div.textContent = m.body;
  $('thread').appendChild(div);
  $('thread').scrollTop = $('thread').scrollHeight;
}
$('chatSend').addEventListener('click', sendChat);
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
async function sendChat() {
  const body = $('chatInput').value.trim();
  if (!body || !order) return;
  $('chatInput').value = '';

  // A client-minted id makes the write idempotent: if the response is lost and the queue
  // replays it, the server keeps the original instead of duplicating the message.
  const clientId = GMIds.newId();
  const payload = JSON.stringify({ body, clientId });
  const path = `/orders/${order.id}/messages`;

  // Show it immediately, greyed, so the thread never feels like it swallowed the message.
  appendMessage({ sender: 'user', body, queued: true, clientId });

  if (!navigator.onLine) {
    await GMQueue.enqueue({ method: 'POST', path, body: payload, label: 'Send message', orderId: order.id });
    return;
  }
  // `sender` is derived server-side from the session — a client can't label its own message.
  const res = await api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });
  if (res.offline) {
    await GMQueue.enqueue({ method: 'POST', path, body: payload, label: 'Send message', orderId: order.id });
  }
}

// ── Account: set or change the password ──
let pwState = null;
async function loadPasswordBox() {
  const res = await api('/auth/me');
  if (res.error || !res.email) { $('pwSetBox').classList.add('hidden'); return; }
  pwState = res;
  const needCurrent = res.hasPassword && !res.canResetWithoutCurrent;
  $('pwSetTitle').dataset.i18n = res.hasPassword ? 'acct.pw.title.change' : 'acct.pw.title.set';
  $('pwSetTitle').textContent = t($('pwSetTitle').dataset.i18n);
  $('pwCurrentWrap').classList.toggle('hidden', !needCurrent);
  $('pwResetNote').classList.toggle('hidden', !(promptPasswordReset || (res.canResetWithoutCurrent && res.hasPassword)));
  $('pwSetBox').classList.remove('hidden');
  if (promptPasswordReset) { $('pwNew').focus(); promptPasswordReset = false; }
}
$('pwSetBtn').addEventListener('click', async () => {
  const newPassword = $('pwNew').value;
  if (newPassword.length < 8) return toast(t('err.pwShort'));
  if (newPassword !== $('pwNew2').value) return toast(t('auth.pwMismatch'));
  $('pwSetBtn').disabled = true;
  const res = await api('/auth/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPassword, currentPassword: $('pwCurrent').value || undefined }),
  });
  $('pwSetBtn').disabled = false;
  if (res.error) { $('pwSetStatus').textContent = errText(res); return; }
  $('pwNew').value = ''; $('pwNew2').value = ''; $('pwCurrent').value = '';
  $('pwSetStatus').textContent = '';
  toast(t('acct.pw.saved'));
  loadPasswordBox();
});

// ── Help chat ──
// FAQ first, then the small model on our own server (POST /assistant). It only explains:
// nothing typed here is stored, and "Talk to a person" opens the order chat with an operator.
// The conversation lives in memory on this phone, for this visit.
let helpOrderId = null;
let helpHistory = [];
function helpLine(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role === 'user' ? 'user' : 'operator'}`;
  div.textContent = text;
  $('helpThread').appendChild(div);
  $('helpThread').scrollTop = $('helpThread').scrollHeight;
  return div;
}
function openHelp(orderId = null) {
  if (helpOrderId !== orderId) { helpHistory = []; $('helpThread').replaceChildren(); }
  helpOrderId = orderId;
  $('helpAbout').textContent = orderId ? `${t('order.num')}${GMIds.shortId(orderId)}` : '';
  $('helpChat').classList.toggle('hidden', !token);
  if (!$('helpThread').children.length) helpLine('assistant', t('help.hello'));
  showView('faqView');
}
async function sendHelp() {
  const message = $('helpInput').value.trim();
  if (!message || !token) return;
  $('helpInput').value = '';
  helpLine('user', message);
  const wait = helpLine('assistant', '…');
  $('helpSend').disabled = true;
  const res = await api('/assistant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history: helpHistory, lang: GMI18n.lang(), ...(helpOrderId ? { orderId: helpOrderId } : {}) }),
  });
  $('helpSend').disabled = false;
  if (res.error) { wait.textContent = GMI18n.err(res.error); return; }
  wait.textContent = res.reply;
  helpHistory = [...helpHistory, { role: 'user', content: message }, { role: 'assistant', content: res.reply }].slice(-6);
  if (res.handoff) $('helpHuman').classList.add('pulse');
}
$('helpSend').addEventListener('click', sendHelp);
$('helpInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendHelp(); });
$('orderHelp').addEventListener('click', () => openHelp(order?.id || null));
// A person: on an order, its chat (operators read it live); otherwise the owner's contact.
$('helpHuman').addEventListener('click', async () => {
  $('helpHuman').classList.remove('pulse');
  if (helpOrderId) {
    await resumeOrder(helpOrderId);
    $('chatInput').focus();
    $('chatInput').scrollIntoView({ block: 'center' });
    return;
  }
  const res = await api('/signup/contact');
  const c = res.contact;
  if (!c) return;
  const el = $('helpContact');
  el.replaceChildren();
  const mail = document.createElement('a');
  mail.href = `mailto:${c.email}`;
  mail.textContent = c.email;
  const tel = document.createElement('a');
  tel.href = `tel:${String(c.phone).replace(/[^\d+]/g, '')}`;
  tel.textContent = c.phone;
  el.append(t('help.contact'), ' ', mail, ' · ', tel);
  el.classList.remove('hidden');
});

// ── Wallet (WALLET_ENABLED on the server) ──
// Money comes in only through the gateway prompt, and goes out only to pay an order or as a
// withdrawal an admin sends. The balance shown is the server's; nothing is computed here.
let walletState = null;
let topupPhoneE164 = null;
let wdPhoneE164 = null;
SomPhone.attach({ input: $('topupPhone'), hint: $('topupPhoneHint'), onChange: (r) => { topupPhoneE164 = r.valid && r.country === 'SO' ? r.e164 : null; } });
SomPhone.attach({ input: $('wdPhone'), hint: $('wdPhoneHint'), onChange: (r) => { wdPhoneE164 = r.valid && r.country === 'SO' ? r.e164 : null; } });
const WALLET_KIND = { topup: 'wallet.k.topup', order_payment: 'wallet.k.order', refund: 'wallet.k.refund', withdrawal: 'wallet.k.withdrawal', withdrawal_reversal: 'wallet.k.reversal' };
async function loadWallet() {
  const res = await api('/wallet');
  walletState = res.wallet || null;
  renderWallet();
  return walletState;
}
function renderWallet() {
  const w = walletState;
  $('walletCard').classList.toggle('hidden', !w?.enabled);
  if (!w?.enabled) return;
  $('walletBalance').textContent = w.balance;
  const wallets = lastPayment.appPay?.length ? lastPayment.appPay : [{ id: 'evc', name: 'EVC Plus' }, { id: 'zaad', name: 'Zaad' }, { id: 'sahal', name: 'Sahal' }];
  const busy = w.lastTopup?.status === 'pending';
  $('topupButtons').replaceChildren(...wallets.map((x) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'secondary';
    b.disabled = busy;
    b.textContent = t('wallet.topup.btn', { wallet: x.name });
    b.addEventListener('click', () => topUp(x.id));
    return b;
  }));
  const st = $('topupStatus');
  const s = w.lastTopup && Date.now() - new Date(w.lastTopup.created_at).getTime() < 15 * 60 * 1000 ? w.lastTopup.status : null;
  st.classList.toggle('hidden', !s);
  if (s) {
    st.className = 'callout' + (s === 'declined' || s === 'unknown' ? ' warn' : '');
    st.textContent = t(`wallet.topup.${s}`, { amt: w.lastTopup.amount });
  }
  $('walletHistory').replaceChildren(...(w.entries.length ? w.entries.map((e) => {
    const li = document.createElement('li');
    const what = document.createElement('span');
    what.textContent = `${t(WALLET_KIND[e.kind] || e.kind)} · ${new Date(e.created_at).toLocaleDateString()}`;
    const amt = document.createElement('strong');
    amt.className = 'mono ' + (Number(e.amount) > 0 ? 'plus' : 'minus');
    amt.textContent = `${Number(e.amount) > 0 ? '+' : ''}${e.amount}`;
    li.append(what, amt);
    return li;
  }) : [Object.assign(document.createElement('li'), { className: 'muted', textContent: t('wallet.empty') })]));
}
let topupPoll = null;
async function topUp(walletId) {
  const amount = parseFloat($('topupAmount').value);
  if (!(amount > 0)) return toast(t('wallet.err.amount'));
  if (!topupPhoneE164) return toast(t('err.payPhone'));
  const res = await api('/wallet/topup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount, wallet: walletId, phone: topupPhoneE164 }) });
  if (res.error) return toast(GMI18n.err(res.error));
  $('topupAmount').value = '';
  await loadWallet();
  // The answer comes when the customer approves on the phone: look again for up to two minutes.
  clearInterval(topupPoll);
  const until = Date.now() + 120000;
  topupPoll = setInterval(async () => {
    const w = await loadWallet();
    if (!w || w.lastTopup?.status !== 'pending' || Date.now() > until) clearInterval(topupPoll);
  }, 2500);
}
$('wdBtn').addEventListener('click', async () => {
  const amount = parseFloat($('wdAmount').value);
  if (!(amount >= 1)) return toast(t('wallet.err.amount'));
  if (!wdPhoneE164) return toast(t('err.payPhone'));
  $('wdBtn').disabled = true;
  const res = await api('/wallet/withdrawals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount, phone: wdPhoneE164 }) });
  $('wdBtn').disabled = false;
  if (res.error) return toast(GMI18n.err(res.error));
  $('wdAmount').value = '';
  toast(t('wallet.withdraw.sent'));
  loadWallet();
});
// On an unpaid order: one tap, when the balance covers it.
async function renderWalletPay() {
  const box = $('walletPayBox');
  const show = Boolean(lastPayment.walletPay) && order && order.status === 'PENDING_PAYMENT';
  box.classList.add('hidden');
  if (!show) return;
  const w = walletState || await loadWallet();
  if (!w?.enabled) return;
  const enough = Number(w.balance) >= Number(order.total_amount);
  $('walletPayBtn').disabled = !enough;
  $('walletPayBtn').textContent = enough
    ? t('wallet.pay', { amt: Number(order.total_amount).toFixed(2), bal: w.balance })
    : t('wallet.pay.short', { bal: w.balance });
  box.classList.remove('hidden');
}
$('walletPayBtn').addEventListener('click', async () => {
  $('walletPayBtn').disabled = true;
  const res = await api(`/orders/${order.id}/pay-wallet`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  $('walletPayBtn').disabled = false;
  if (res.error) return toast(GMI18n.err(res.error));
  order = { ...order, ...res.order };
  updateBadge(order.status);
  walletState = null;
  toast(t('pay.confirmed'));
});

// ── Navigation: bottom tabs ──
// Home = the new-order screen when signed in, the landing page when not. Orders and Account
// need a session, so they send a signed-out visitor to sign-in first and come back after.
const VIEWS = ['landingView', 'joinView', 'authView', 'homeView', 'rideView', 'shopView', 'startView', 'orderView', 'resumeView', 'faqView', 'accountView'];
const TAB_OF = {
  landingView: 'home', joinView: 'home', authView: null, homeView: 'home', rideView: 'home', shopView: 'home', startView: 'home',
  orderView: 'orders', resumeView: 'orders', faqView: 'help', accountView: 'account',
};
let afterSignIn = null;
function showView(id, tab) {
  VIEWS.forEach((v) => $(v).classList.add('hidden'));
  $(id).classList.remove('hidden');
  const active = tab || TAB_OF[id];
  document.querySelectorAll('.tabbar [data-tab]').forEach((b) => {
    if (b.dataset.tab === active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
}
function goTab(tab, { start = false } = {}) {
  if (tab === 'help') return openHelp(null);
  if (!token) {
    if (tab === 'home' && !start) return showView('landingView');
    afterSignIn = tab;
    // Orders and Account are what a returning customer taps: open on Sign in for them.
    if (tab === 'orders' || tab === 'account') setAuthMode('signin');
    return showView('authView', tab);
  }
  if (tab === 'home') {
    $('signedInAs').textContent = myPhone || '';
    return showView('homeView');
  }
  if (tab === 'orders') return openOrders();
  if (tab === 'account') {
    showSignedIn();
    loadEmailBox();
    loadPasswordBox();
    loadWallet();
    return showView('accountView');
  }
}
function showSignedIn() {
  $('signedInAs').textContent = myPhone || '';
  $('acctLogin').textContent = myPhone || '';
}
document.querySelectorAll('.tabbar [data-tab]').forEach((b) =>
  b.addEventListener('click', () => goTab(b.dataset.tab)));
$('brandHome').addEventListener('click', (e) => { e.preventDefault(); goTab('home'); });
$('orderBack').addEventListener('click', () => goTab('orders'));

// ── My orders ──
// Scoped to the verified session: the server answers with THIS account's orders. There is no
// longer any way to list orders for a number you merely typed.
async function openOrders() {
  showView('resumeView');
  const res = await api('/orders/mine');
  if (res.error) return toast(GMI18n.err(res.error));
  showResumeList(res.orders || []);
}
const ORDER_ICON = {
  PENDING_PAYMENT: '💳', PAID_UNASSIGNED: '✓', DISPATCHED: '🛍️', IN_TRANSIT: '🛵', DELIVERED: '📦', FAILED_REFUND: '✕',
};
function showResumeList(orders) {
  // Landmarks and item text are the customer's own words: escape before innerHTML.
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  $('resumeList').innerHTML = orders.length
    ? orders.map((o) => `
        <button class="tile" type="button" data-id="${o.id}">
          <span class="tile-icon">${isRide(o) ? (VEHICLE_ICON[o.vehicle] || '🚗') : ORDER_ICON[o.status] || '•'}</span>
          <span class="tile-body">
            <span class="tile-title">$${Number(o.total_amount).toFixed(2)}
              <span class="badge ${badgeClass(o.status)}">${label(o.status, o)}</span></span>
            <span class="tile-sub">${esc(isRide(o) ? `${t('order.ride')} → ${o.landmark_text || ''}` : (o.items || []).map((i) => i.text).filter(Boolean).join(', ') || o.landmark_text || '')}</span>
            <span class="tile-sub">#${GMIds.shortId(o.id)} · ${new Date(o.created_at).toLocaleDateString()}</span>
          </span>
          <span class="chev">›</span>
        </button>`).join('')
    : `<div class="empty"><div class="big">🛒</div><p>${t('resume.none')}</p>
        <button type="button" id="emptyNew" style="max-width:260px;">${t('start.title')}</button></div>`;
  const first = $('emptyNew');
  if (first) first.addEventListener('click', () => goTab('home'));
  $('resumeList').querySelectorAll('[data-id]').forEach((el) =>
    el.addEventListener('click', () => resumeOrder(el.dataset.id))
  );
}
async function resumeOrder(id) {
  const res = await api(`/orders/${id}`);
  if (res.error) return toast(GMI18n.err(res.error));
  order = res.order;
  localStorage.setItem('gm_last', JSON.stringify({ orderId: order.id }));
  enterOrderView(res);
}

// Auto-resume the last active order on load (survives refresh, per the resume requirement).
// Requires a live session — without one there is nothing to resume into.
// A signed-in customer opens on the new-order screen, like any delivery app; the landing page
// is for people who haven't started yet.
if (token) { showSignedIn(); goTab('home'); }

(async function autoResume() {
  try {
    if (!token) return;
    const saved = JSON.parse(localStorage.getItem('gm_last') || 'null');
    if (!saved?.orderId) return;
    const res = await api(`/orders/${saved.orderId}`);
    if (res.order && !['DELIVERED', 'FAILED_REFUND'].includes(res.order.status)) {
      order = res.order;
      showSignedIn();
      enterOrderView(res);
    } else {
      localStorage.removeItem('gm_last');
    }
  } catch { /* ignore */ }
})();

// ── Ask to join the team ──
// This submits a REQUEST. It creates no account: an operator reads it, calls the number, and
// decides. The page says so plainly, because a form that looks like registration and then
// doesn't sign you in reads as broken.
$('joinBtn').addEventListener('click', async () => {
  showView('joinView');
  loadOwnerContact();
});
$('joinHome').addEventListener('click', () => showView('landingView'));

// Show the reference photo they picked, so they know it's attached.
$('refPhoto').addEventListener('change', () => {
  const file = $('refPhoto').files[0];
  const thumb = $('refThumb');
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = document.createElement('img');
  img.className = 'thumb';
  img.alt = '';
  img.src = url;
  img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
  thumb.replaceWith(img);
  img.id = 'refThumb';
  $('refCapture').classList.add('done');
});

// Live validation on the applicant's number — same rules as everywhere else, so we don't take
// a request we can't call back.
let joinPhoneValid = false;
let joinPhoneE164 = null;
SomPhone.attach({
  input: $('joinPhone'),
  hint: $('joinPhoneHint'),
  onChange: (r) => { joinPhoneValid = r.valid; joinPhoneE164 = r.e164 || null; },
});

async function loadOwnerContact() {
  const el = $('ownerContact');
  if (el.dataset.loaded) return;
  const res = await api('/signup/contact');
  const c = res.contact;
  if (!c) return;
  el.innerHTML = `
    <div><a href="mailto:${c.email}">${c.email}</a></div>
    <div><a href="tel:${String(c.phone).replace(/[^\d+]/g, '')}">${c.phone}</a></div>`;
  el.dataset.loaded = '1';
}

$('joinSubmit').addEventListener('click', async () => {
  const name = $('joinName').value.trim();
  const role = $('joinRole').value;
  const message = $('joinMessage').value.trim();

  if (name.length < 2) return toast(t('join.err.name'));
  if (!joinPhoneValid) return toast(t('err.phone'));
  const email = $('joinEmail').value.trim();
  if (!EMAIL_RE.test(email)) return toast(t('join.err.email'));

  $('joinSubmit').disabled = true;
  $('joinStatus').textContent = t('join.sending');
  const res = await api('/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, name, phone: joinPhoneE164, email, message }),
  });
  $('joinSubmit').disabled = false;

  if (res.error) {
    $('joinStatus').textContent = errText(res);
    return;
  }
  // Upload the ID sides second, using the short-lived token scoped to this request. Doing it
  // as a separate step keeps the request id off the wire, and lets the application succeed
  // even if a photo fails — losing a good applicant because an upload timed out would be silly.
  const sides = [
    ['front', $('joinIdFront').files[0]],
    ['back', $('joinIdBack').files[0]],
  ].filter(([, f]) => f);

  if (sides.length && res.uploadToken) {
    const failed = [];
    for (const [side, file] of sides) {
      $('joinStatus').textContent = t('join.sendingId', { side: t(`join.side.${side}`) });
      try {
        const up = await fetch(GMConfig.api(`/signup/id-document/${side}`), {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            Authorization: `Bearer ${res.uploadToken}`,
          },
          body: file,
        });
        if (!up.ok) {
          const b = await up.json().catch(() => ({}));
          failed.push(t(`join.side.${side}`));
        }
      } catch {
        failed.push(t(`join.side.${side}`));
      }
    }
    if (failed.length) {
      $('joinStatus').textContent =
        `${t('join.done')} ${t('join.uploadFailed', { list: failed.join(', ') })}`;
      return;
    }
  }

  $('joinStatus').textContent = t('join.done');
  $('joinName').value = '';
  $('joinEmail').value = '';
  $('joinMessage').value = '';
  $('joinIdFront').value = '';
  $('joinIdBack').value = '';
  $('joinIdHint').textContent = '';
});

// Say which sides are attached, so nobody submits thinking both went in when one didn't.
function updateIdHint() {
  const front = $('joinIdFront').files[0];
  const back = $('joinIdBack').files[0];
  if (!front && !back) { $('joinIdHint').textContent = ''; return; }
  const parts = [];
  for (const [side, file] of [['front', front], ['back', back]]) {
    parts.push(`${t(`join.side.${side}`)} ${file ? '✓' : t('join.missing')}`);
  }
  $('joinIdHint').textContent = t('join.idHint', { parts: parts.join(' · ') });
}
$('joinIdFront').addEventListener('change', updateIdHint);
$('joinIdBack').addEventListener('change', updateIdHint);

// ── Language switch ──
// Static text is redone by GMI18n.apply(); this redraws what the script rendered itself.
document.addEventListener('gm:lang', () => {
  if (!$('emailBox').classList.contains('hidden')) renderEmailBox();
  if (!$('shopView').classList.contains('hidden')) renderCatalog();
  if (!$('startView').classList.contains('hidden')) renderCartLines();
  if (ride.quote) renderRideOptions();
  if (order) {
    renderOrderDetails();
    renderPayment(lastPayment);
    renderTimeline(order.status);
    updateBadge(order.status);
    loadPhotos(order.id);
    loadProofs();
  }
  if (resendLeft > 0 || !$('codeStep').classList.contains('hidden')) renderResend();
  if (lastSyncStats) renderSyncState(lastSyncStats);
  // Re-run the live phone hints in the new language.
  if (walletState) renderWallet();
  ['phone', 'joinPhone', 'orderPhone', 'ridePhone', 'payPhone', 'topupPhone', 'wdPhone'].forEach((id) => $(id).dispatchEvent(new Event('input')));
  if (!$('resumeView').classList.contains('hidden')) openOrders();
  updateIdHint();
  $('otpStatus').textContent = '';
});

// ── Tiny toast ──
let toastTimer;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  clearTimeout(toastTimer);
  // A failure to report stays up long enough to read the reference out.
  toastTimer = setTimeout(() => t.remove(), /ref [0-9a-f]{8}|\[\d{3}/.test(msg) ? 10000 : 3200);
}

// ── Service worker ──
// Registered here rather than in an inline <script> so the page can run under a strict
// Content-Security-Policy (script-src 'self'), which is what blocks injected script.
// Skipped in the native shell: Capacitor bundles the assets into the APK, so a service
// worker would be a second, stale copy of the app competing with the real one.
if ('serviceWorker' in navigator && !GMConfig.isNative()) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
}
