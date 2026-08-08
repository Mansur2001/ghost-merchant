// Phone pattern matcher — shared by all PWAs. Loaded as a classic script; exposes
// window.SomPhone (name kept for compatibility with existing call sites).
//
// Browser MIRROR of backend/src/domain/phone.js. This one exists for live keystroke feedback;
// the backend copy is the enforced source of truth. Keep the two country tables in sync — if
// they drift, the UI accepts a number the API then rejects, which reads as "the app is broken".
//
// Two countries:
//   SO (+252) — 2-digit operator prefix + 7 subscriber digits. Can pay by USSD.
//   US (+1)   — 10-digit NANP, for testing on a North American handset. CANNOT pay by USSD
//               (EVC Plus is a Somali rail); those orders go through the operator instead.
(function (global) {
  // prefix -> operator. Where public sources conflict (62, 68) we take the dominant
  // real-world mobile-money assignment. (NCA Numbering Plan 2021; Wikipedia.)
  var PREFIX_TO_OPERATOR = {
    '61': 'Hormuud',
    '62': 'Hormuud',
    '77': 'Hormuud',
    '65': 'Somtel',
    '66': 'Somtel',
    '68': 'Somtel',
    '63': 'Telesom',
    '64': 'SomLink',
    '67': 'NationLink',
    '69': 'NationLink',
    '71': 'Amtel',
    '90': 'Golis',
  };
  var SO_LENGTH = 9;  // 2 prefix + 7 subscriber
  var US_LENGTH = 10; // NANP
  var US_RE = /^[2-9]\d{2}[2-9]\d{6}$/;

  function digits(raw) {
    return raw == null ? '' : String(raw).replace(/[^\d]/g, '');
  }

  // Decide country + national digits. MUST match backend/src/domain/phone.js:
  // bare digits are always Somali; US requires an explicit +1 / 1 / 001. Accepting a bare
  // 10-digit number as US would let a Somali typo ("6123456789") silently become a valid
  // US number, creating an order under an identity that isn't theirs.
  function split(raw) {
    var d = digits(raw);
    if (d.indexOf('00') === 0) d = d.slice(2);
    if (d.indexOf('252') === 0 && d.length === 3 + SO_LENGTH) {
      return { country: 'SO', national: d.slice(3) };
    }
    // A leading 1 signals US while typing (Somali numbers never start with 1).
    if (d.indexOf('1') === 0 && d.length > 1) {
      return { country: 'US', national: d.slice(1), typing: d.length < 1 + US_LENGTH };
    }
    if (d.indexOf('0') === 0) d = d.slice(1);
    return { country: null, national: d };
  }

  // Full validation. Returns { valid, complete, country, national, prefix, operator, e164,
  // canUssd, reason }. `complete` is false while the user is still typing.
  function parse(raw) {
    var s = split(raw);
    var n = s.national;
    if (n === '') return { valid: false, complete: false, reason: 'empty', national: '' };

    // Explicit US (either +1... or already too long to be Somali).
    if (s.country === 'US') {
      if (n.length < US_LENGTH) {
        return { valid: false, complete: false, partial: true, country: 'US', national: n,
                 reason: (US_LENGTH - n.length) + ' more digit(s) needed' };
      }
      if (n.length > US_LENGTH) {
        return { valid: false, complete: true, country: 'US', national: n, reason: 'Too many digits' };
      }
      if (!US_RE.test(n)) {
        return { valid: false, complete: true, country: 'US', national: n,
                 reason: 'Not a valid US number' };
      }
      return { valid: true, complete: true, country: 'US', national: n, prefix: n.slice(0, 3),
               operator: 'US / Canada', canUssd: false, e164: '+1' + n };
    }

    // Somali — the default for anything without a country code.
    var prefix = n.slice(0, 2);
    if (n.length < 2) {
      return { valid: false, complete: false, reason: 'typing', national: n, partial: true };
    }
    var operator = PREFIX_TO_OPERATOR[prefix];
    if (!operator) {
      return { valid: false, complete: false, prefix: prefix, national: n,
               reason: 'Not a recognized Somali prefix (US numbers need +1)' };
    }
    if (n.length < SO_LENGTH) {
      return { valid: false, complete: false, partial: true, country: 'SO', prefix: prefix,
               operator: operator, national: n,
               reason: (SO_LENGTH - n.length) + ' more digit(s) needed' };
    }
    if (n.length > SO_LENGTH) {
      // Deliberately NOT reinterpreted as US — see split().
      return { valid: false, complete: true, country: 'SO', prefix: prefix, operator: operator,
               national: n, reason: 'Too many digits (US numbers need +1)' };
    }
    return { valid: true, complete: true, country: 'SO', prefix: prefix, operator: operator,
             national: n, canUssd: true, e164: '+252' + n };
  }

  // Pretty display, country-aware.
  function format(raw) {
    var r = parse(raw);
    var n = r.national || '';
    if (r.country === 'US') {
      var us = '+1';
      if (n.length > 0) us += ' (' + n.slice(0, 3) + ')';
      if (n.length > 3) us += ' ' + n.slice(3, 6);
      if (n.length > 6) us += '-' + n.slice(6, 10);
      return us.trim();
    }
    var out = '+252';
    if (n.length > 0) out += ' ' + n.slice(0, 2);
    if (n.length > 2) out += ' ' + n.slice(2, 5);
    if (n.length > 5) out += ' ' + n.slice(5, 9);
    return out.trim();
  }

  // Wire a live-validating input. opts: { input, hint, onChange }.
  function attach(opts) {
    var input = opts.input;
    var hint = opts.hint;
    function update() {
      var r = parse(input.value);
      if (hint) {
        if (r.valid) {
          // Say plainly when a number can't use the USSD rail, before they reach the pay step.
          var note = r.canUssd ? '' : ' · pay via operator';
          hint.textContent = '✓ ' + r.operator + ' · ' + format(r.national) + note;
          hint.style.color = 'var(--accent)';
        } else if (r.partial) {
          hint.textContent = (r.operator ? r.operator + ' · ' : '') + (r.reason || '');
          hint.style.color = 'var(--muted)';
        } else if (r.reason === 'empty') {
          hint.textContent = 'Enter your mobile number';
          hint.style.color = 'var(--muted)';
        } else {
          hint.textContent = '✕ ' + r.reason;
          hint.style.color = 'var(--danger)';
        }
      }
      if (opts.onChange) opts.onChange(r);
    }
    input.addEventListener('input', update);
    input.addEventListener('blur', function () {
      var r = parse(input.value);
      if (r.valid) input.value = format(r.national);
    });
    update();
    return update;
  }

  global.SomPhone = { parse: parse, format: format, attach: attach, PREFIX_TO_OPERATOR: PREFIX_TO_OPERATOR };
})(window);
