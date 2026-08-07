// Somali mobile number pattern matcher — shared by all PWAs. Loaded as a classic script;
// exposes window.SomPhone. Used for LIVE input validation/formatting: as the user types we
// detect the operator from the 2-digit prefix, format the number, and reject anything that
// isn't a valid assigned Somali mobile prefix + correct length.
//
// Format: 2-digit operator prefix + 7 subscriber digits = 9-digit national number
// (matches the SRS's own "61XXXXXXX" / EVC Plus format). Canonical E.164: +252XXXXXXXXX.
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
  var SUBSCRIBER_DIGITS = 7;

  // Reduce any accepted form (+252…, 00252…, 0…, spaced/dashed) to the national digits.
  function toNational(raw) {
    if (raw == null) return '';
    var s = String(raw).replace(/[^\d]/g, '');
    if (s.indexOf('00252') === 0) s = s.slice(5);
    else if (s.indexOf('252') === 0) s = s.slice(3);
    else if (s.indexOf('0') === 0) s = s.slice(1);
    return s;
  }

  // Full validation. Returns { valid, national, prefix, operator, e164, reason, complete }.
  // `complete` is false while the user is still typing a valid-so-far number.
  function parse(raw) {
    var national = toNational(raw);
    if (national === '') return { valid: false, complete: false, reason: 'empty', national: '' };

    var prefix = national.slice(0, 2);

    // Still typing the prefix.
    if (national.length < 2) {
      return { valid: false, complete: false, reason: 'typing', national: national, partial: true };
    }
    var operator = PREFIX_TO_OPERATOR[prefix];
    if (!operator) {
      return { valid: false, complete: false, prefix: prefix, national: national,
               reason: 'Not a recognized Somali mobile prefix' };
    }
    if (national.length < 2 + SUBSCRIBER_DIGITS) {
      // Valid prefix, more digits needed — "valid so far".
      return { valid: false, complete: false, partial: true, prefix: prefix,
               operator: operator, national: national,
               reason: (2 + SUBSCRIBER_DIGITS - national.length) + ' more digit(s) needed' };
    }
    if (national.length > 2 + SUBSCRIBER_DIGITS) {
      return { valid: false, complete: true, prefix: prefix, operator: operator,
               national: national, reason: 'Too many digits' };
    }
    return {
      valid: true, complete: true, prefix: prefix, operator: operator,
      national: national, e164: '+252' + national,
    };
  }

  // Pretty display: "+252 61 234 5678" from national digits.
  function format(raw) {
    var n = toNational(raw);
    var out = '+252';
    if (n.length > 0) out += ' ' + n.slice(0, 2);
    if (n.length > 2) out += ' ' + n.slice(2, 5);
    if (n.length > 5) out += ' ' + n.slice(5, 9);
    return out.trim();
  }

  // Wire a live-validating input. opts: { input, hint, onChange }.
  // Colors the hint, shows the operator, and calls onChange(parseResult) on every keystroke.
  function attach(opts) {
    var input = opts.input;
    var hint = opts.hint;
    function update() {
      var r = parse(input.value);
      if (hint) {
        if (r.valid) {
          hint.textContent = '✓ ' + r.operator + ' · ' + format(r.national);
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
      // On blur, snap a complete valid number to canonical spaced form.
      var r = parse(input.value);
      if (r.valid) input.value = format(r.national);
    });
    update();
    return update;
  }

  global.SomPhone = { parse: parse, format: format, attach: attach, PREFIX_TO_OPERATOR: PREFIX_TO_OPERATOR };
})(window);
