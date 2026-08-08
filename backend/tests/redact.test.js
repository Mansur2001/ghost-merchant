// Logs are where careful auth work quietly undoes itself: the API stopped handing out phone
// numbers, and one console.log(req.body) would publish them to every shell user and log
// shipper. These tests assert the leak can't happen.
import { maskPhone, actorLabel, redact, isSensitivePath } from '../src/domain/redact.js';
import { maskPathPii } from '../src/middleware/requestLog.js';

describe('maskPhone', () => {
  test('keeps the country code and last 3 digits only', () => {
    expect(maskPhone('+252612345678')).toBe('+252••••••678');
  });

  test('never emits the full number', () => {
    const masked = maskPhone('+252612345678');
    expect(masked).not.toContain('612345');
    expect(masked).not.toContain('2345678');
  });

  test('handles a national-format number', () => {
    const masked = maskPhone('612345678');
    expect(masked).not.toContain('12345');
    expect(masked.endsWith('678')).toBe(true);
  });

  test('hides short strings entirely rather than half-revealing them', () => {
    // A 7-digit string is mostly tail — partial masking would give away nearly all of it.
    expect(maskPhone('1234567')).toBe('•••••••');
    expect(maskPhone('12')).toBe('••');
  });

  test('is safe on empty and non-string input', () => {
    expect(maskPhone('')).toBe('');
    expect(maskPhone(null)).toBe('');
    expect(maskPhone(undefined)).toBe('');
    expect(maskPhone(12345678)).toBe('');
  });
});

describe('actorLabel', () => {
  test('identifies each role', () => {
    expect(actorLabel({ role: 'driver', id: 3 })).toBe('driver:3');
    expect(actorLabel({ role: 'operator', id: 2, username: 'hodan' })).toBe('operator:2:hodan');
    expect(actorLabel({ role: 'operator', id: 2 })).toBe('operator:2');
  });

  test('masks the customer phone it is built from', () => {
    const label = actorLabel({ role: 'customer', phone: '+252612345678' });
    expect(label.startsWith('customer:+252')).toBe(true);
    expect(label).not.toContain('612345678');
  });

  test('degrades safely', () => {
    expect(actorLabel(null)).toBe('anon');
    expect(actorLabel({})).toBe('anon');
    expect(actorLabel({ role: 'wat' })).toBe('unknown');
  });
});

describe('redact', () => {
  test('removes credentials wherever they appear', () => {
    const out = redact({ token: 'abc', password: 'hunter2', code: '123456', pin: '1234' });
    expect(Object.values(out)).toEqual(['[redacted]', '[redacted]', '[redacted]', '[redacted]']);
  });

  test('is case-insensitive about key names', () => {
    expect(redact({ Password: 'x', TOKEN: 'y', devCode: 'z' })).toEqual({
      Password: '[redacted]', TOKEN: '[redacted]', devCode: '[redacted]',
    });
  });

  test('masks phone-shaped fields instead of dropping them', () => {
    // Keep enough to correlate a support call, not enough to dial the customer.
    const out = redact({ phone: '+252612345678', msisdn: '+252619876543' });
    expect(out.phone).toBe('+252••••••678');
    expect(out.msisdn).toBe('+252••••••543');
  });

  test('reaches into nested structures', () => {
    const out = redact({ order: { user_phone: '+252612345678', items: [{ token: 't' }] } });
    expect(out.order.user_phone).not.toContain('612345678');
    expect(out.order.items[0].token).toBe('[redacted]');
  });

  test('stops at a depth limit rather than recursing forever', () => {
    const cyclic = { a: {} };
    cyclic.a.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
  });

  test('truncates long strings so one field cannot flood the log', () => {
    expect(redact({ note: 'x'.repeat(5000) }).note.length).toBeLessThan(210);
  });

  test('caps array length', () => {
    expect(redact({ xs: Array.from({ length: 100 }, (_, i) => i) }).xs.length).toBe(20);
  });
});

describe('maskPathPii', () => {
  test('masks a phone number embedded in the URL', () => {
    // /api/phone/validate/:phone puts PII in the request line itself.
    const masked = maskPathPii('/api/phone/validate/612345678');
    expect(masked).not.toContain('612345678');
    expect(masked.startsWith('/api/phone/validate/')).toBe(true);
  });

  test('leaves ordinary paths and short ids alone', () => {
    expect(maskPathPii('/api/orders/42/messages')).toBe('/api/orders/42/messages');
    expect(maskPathPii('/api/health')).toBe('/api/health');
  });

  test('masks an E.164 number with its + prefix', () => {
    expect(maskPathPii('/api/orders/by-phone/+252612345678')).not.toContain('612345678');
  });
});

describe('isSensitivePath', () => {
  test('flags the endpoints that carry live secrets', () => {
    expect(isSensitivePath('/api/auth/otp/request')).toBe(true);
    expect(isSensitivePath('/api/driver/login')).toBe(true);
    expect(isSensitivePath('/api/operator/me/password')).toBe(true);
    expect(isSensitivePath('/api/orders/1')).toBe(false);
  });
});
