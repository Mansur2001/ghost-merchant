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
  // US number, creating an order under an identity that isn't theirs. The country SWITCH
  // (attach() below) is how a person says "this is a US number" without typing +1.
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

  // Hint text in the page's language when shared/i18n.js is loaded (customer, driver);
  // English otherwise (operator). `parse` keeps its English reasons: they are the contract
  // the parity tests check against the backend.
  function tr(key, fallback, vars) {
    return global.GMI18n ? global.GMI18n.t(key, vars) : fallback;
  }
  function reasonText(r) {
    if (/prefix/.test(r.reason)) return tr('phone.badPrefix', r.reason);
    if (/Too many/.test(r.reason)) return tr('phone.tooLong', r.reason);
    if (/US number/.test(r.reason)) return tr('phone.badUs', r.reason);
    return r.reason;
  }

  // Parse as a number from `country` — the country switch's choice. Within that country,
  // whatever the person typed is understood: "61 234 5678", "0612345678", "252612345678" for
  // Somalia; "206 687 6538", "(206) 687-6538", "1 206 687 6538" for the US. A number typed
  // WITH a "+" or "00" carries its own country code, and that always wins over the switch.
  function parseAs(raw, country) {
    var s = raw == null ? '' : String(raw).trim();
    var d = digits(raw);
    var explicit = s.charAt(0) === '+' || d.indexOf('00') === 0;
    if (!explicit && country === 'US' && d) {
      return parse('+1' + (d.charAt(0) === '1' ? d.slice(1) : d));
    }
    return parse(raw);
  }

  // The canonical number for an attached input ('' while it isn't valid). Send THIS to the
  // server, never the raw text: "206 687 6538" only means +1 because of the switch.
  function e164Of(input) {
    return (input && input.dataset && input.dataset.e164) || '';
  }

  var COUNTRY_KEY = 'gm_phone_country';
  var PLACEHOLDER = { SO: '61 234 5678', US: '(206) 555-1234' };
  function savedCountry() {
    try { return localStorage.getItem(COUNTRY_KEY) === 'US' ? 'US' : 'SO'; } catch (e) { return 'SO'; }
  }

  // Drawn flags rather than 🇸🇴/🇺🇸 emoji: flag emoji don't exist on Windows or in some
  // Android WebViews, which show the bare letters "SO" / "US" instead.
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    var e = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }
  function flag(cc) {
    var svg = svgEl('svg', {
      viewBox: '0 0 30 20', width: '20', height: '14', 'aria-hidden': 'true',
      style: 'vertical-align:-2px;margin-right:5px;border-radius:2px;',
    });
    if (cc === 'SO') {
      svg.appendChild(svgEl('rect', { width: '30', height: '20', fill: '#4189DD' }));
      svg.appendChild(svgEl('polygon', {
        fill: '#fff',
        points: '15,4.8 16.23,8.3 19.95,8.39 17,10.65 18.06,14.21 15,12.1 11.94,14.21 13,10.65 10.05,8.39 13.77,8.3',
      }));
    } else {
      svg.appendChild(svgEl('rect', { width: '30', height: '20', fill: '#fff' }));
      for (var i = 0; i < 13; i += 2) {
        svg.appendChild(svgEl('rect', { y: String(i * 20 / 13), width: '30', height: String(20 / 13), fill: '#B22234' }));
      }
      svg.appendChild(svgEl('rect', { width: '12', height: String(7 * 20 / 13), fill: '#3C3B6E' }));
    }
    return svg;
  }

  // The +252 / +1 switch, placed in front of the input. The input is wrapped so the pair
  // behaves as one field inside existing layouts (rows, cards).
  function buildSwitch(input, country, onPick) {
    var wrap = document.createElement('div');
    wrap.className = 'phone-field';
    var sw = document.createElement('div');
    sw.className = 'cc-switch';
    sw.setAttribute('role', 'group');
    sw.setAttribute('aria-label', tr('phone.country', 'Country'));
    var buttons = {};
    [['SO', '+252'], ['US', '+1']].forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.appendChild(flag(c[0]));
      b.appendChild(document.createTextNode(c[1]));
      b.addEventListener('click', function () { onPick(c[0]); input.focus(); });
      buttons[c[0]] = b;
      sw.appendChild(b);
    });
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(sw);
    wrap.appendChild(input);
    return function show(cc) {
      Object.keys(buttons).forEach(function (k) {
        buttons[k].setAttribute('aria-pressed', k === cc ? 'true' : 'false');
      });
    };
  }

  // Wire a live-validating input. opts: { input, hint, onChange }.
  function attach(opts) {
    var input = opts.input;
    var hint = opts.hint;
    var country = savedCountry();
    var show = buildSwitch(input, country, function (cc) {
      country = cc;
      try { localStorage.setItem(COUNTRY_KEY, cc); } catch (e) { /* private mode */ }
      // Keep what was typed, minus any country code it carried — it's re-read as the new country.
      if (/^\s*(\+|00)/.test(input.value)) input.value = '';
      update();
    });

    function update() {
      var r = parseAs(input.value, country);
      // A typed "+1..." / "+252..." names its own country: move the switch to match.
      if (r.country && r.country !== country && /^\s*(\+|00)/.test(input.value)) country = r.country;
      show(country);
      input.placeholder = PLACEHOLDER[country];
      input.dataset.e164 = r.valid ? r.e164 : '';
      if (hint) {
        if (r.valid) {
          // Say plainly when a number can't use the USSD rail, before they reach the pay step.
          var note = r.canUssd ? '' : ' · ' + tr('phone.payOperator', 'pay via operator');
          hint.textContent = '✓ ' + r.operator + ' · ' + format(r.e164) + note;
          hint.style.color = 'var(--accent)';
        } else if (r.partial) {
          var left = (r.country === 'US' ? US_LENGTH : SO_LENGTH) - r.national.length;
          var more = r.reason === 'typing' ? '' : tr('phone.more', left + ' more digit(s)', { n: left });
          hint.textContent = (r.operator ? r.operator + (more ? ' · ' : '') : '') + more;
          hint.style.color = 'var(--muted)';
        } else if (r.reason === 'empty') {
          hint.textContent = tr('phone.enter', 'Enter your mobile number');
          hint.style.color = 'var(--muted)';
        } else if (country === 'SO' && r.national && r.national.length === US_LENGTH) {
          // Ten digits on the Somali setting: most likely a US number. Point at the switch.
          hint.textContent = '✕ ' + tr('phone.tryUs', 'US number? Tap 🇺🇸 +1');
          hint.style.color = 'var(--danger)';
        } else {
          hint.textContent = '✕ ' + reasonText(r);
          hint.style.color = 'var(--danger)';
        }
      }
      if (opts.onChange) opts.onChange(r);
    }
    input.addEventListener('input', update);
    input.addEventListener('blur', function () {
      var r = parseAs(input.value, country);
      // Tidy to the national format; the switch already shows the country code.
      if (r.valid) input.value = format(r.e164).replace(/^\+(252|1)\s*/, '');
    });
    update();
    return update;
  }

  global.SomPhone = {
    parse: parse, parseAs: parseAs, format: format, attach: attach, e164Of: e164Of,
    PREFIX_TO_OPERATOR: PREFIX_TO_OPERATOR,
  };
})(window);
