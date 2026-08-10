// Receipt parsing — the Oracle senses payments from ANY rail that texts the merchant phone.
//
// The security-relevant property under test: a receipt that identifies the payer only by NAME
// (every US rail does this) must NOT be auto-matchable. Matching on amount alone would mark
// the wrong customer's order paid the moment two people owe the same amount — which, with a
// fixed delivery fee, is most of the time.
import { describe, test, expect } from '@jest/globals';
import { parseReceipt, identifyProvider, PROVIDER_IDS } from '../src/domain/receipts.js';

describe('EVC Plus (the real market)', () => {
  const sms = {
    senderId: 'EVCPlus',
    body: 'You have received $7.25 from 612345678. Ref: ABC123XYZ',
    receivedAt: '1700000000',
  };

  test('parses amount, sender number and reference', () => {
    const r = parseReceipt(sms);
    expect(r.provider).toBe('evcplus');
    expect(r.amount).toBe(7.25);
    expect(r.senderMsisdn).toBe('612345678');
    expect(r.receiptId).toContain('ABC123XYZ');
  });

  test('gives a phone number, so it CAN be matched automatically', () => {
    expect(parseReceipt(sms).senderMsisdn).toBeTruthy();
    expect(parseReceipt(sms).senderName).toBeNull();
  });

  test('keeps the raw text for the audit trail', () => {
    expect(parseReceipt(sms).rawSms).toBe(sms.body);
  });
});

describe('US rails identify people by NAME, not number', () => {
  const cases = [
    ['zelle', { senderId: 'Zelle', body: 'John Smith sent you $25.00 with Zelle. Ref 1234ABCD' }],
    ['cashapp', { senderId: 'CashApp', body: 'Jane Doe sent you $25.00 on Cash App. #XY9876' }],
    ['venmo', { senderId: 'Venmo', body: 'John Smith paid you $25.00 - Venmo. ID: 5551234567' }],
  ];

  test.each(cases)('%s is recognised', (provider, sms) => {
    const r = parseReceipt(sms);
    expect(r).not.toBeNull();
    expect(r.provider).toBe(provider);
    expect(r.amount).toBe(25);
  });

  test.each(cases)('%s yields a name and NO phone number', (provider, sms) => {
    // This is what stops it being auto-matched — the whole point.
    const r = parseReceipt(sms);
    expect(r.senderMsisdn).toBeNull();
    expect(r.senderName).toBeTruthy();
  });
});

describe('messages that are not receipts', () => {
  test('an ordinary text from a person returns null', () => {
    // The merchant phone receives normal messages too; this must never throw.
    expect(parseReceipt({ senderId: '+12065551234', body: 'are you open today?' })).toBeNull();
  });

  test('a marketing text from the telecom returns null', () => {
    expect(
      parseReceipt({ senderId: 'EVCPlus', body: 'Top up 10% bonus this week!' })
    ).toBeNull();
  });

  test('a spoofed sender with unrelated text still does not parse', () => {
    // Sender IDs are trivially spoofable, so the body is a second gate.
    expect(parseReceipt({ senderId: 'Zelle', body: 'hello there' })).toBeNull();
  });

  test('a receipt-shaped message with no amount returns null', () => {
    expect(
      parseReceipt({ senderId: 'EVCPlus', body: 'You have received money from 612345678' })
    ).toBeNull();
  });

  test('a zero or negative amount is refused', () => {
    expect(
      parseReceipt({ senderId: 'EVCPlus', body: 'You have received $0.00 from 612345678. Ref: Z1' })
    ).toBeNull();
  });

  test('nullish input does not throw', () => {
    expect(parseReceipt()).toBeNull();
    expect(parseReceipt({})).toBeNull();
    expect(parseReceipt({ senderId: null, body: null })).toBeNull();
  });
});

describe('deduplication', () => {
  test('the receipt id is namespaced by provider', () => {
    // Two rails could plausibly issue the same reference string; namespacing stops one
    // provider's receipt from suppressing another's as a "duplicate".
    const a = parseReceipt({ senderId: 'EVCPlus', body: 'You have received $5.00 from 612345678. Ref: SAME1' });
    const b = parseReceipt({ senderId: 'Venmo', body: 'John Smith paid you $5.00 - Venmo. ID: SAME1' });
    expect(a.receiptId).not.toBe(b.receiptId);
  });

  test('the same message parses to the same id every time', () => {
    // Dedupe depends on this: the Oracle re-reads the inbox every few seconds.
    const sms = { senderId: 'EVCPlus', body: 'You have received $5.00 from 612345678. Ref: STABLE1', receivedAt: '123' };
    expect(parseReceipt(sms).receiptId).toBe(parseReceipt(sms).receiptId);
  });

  test('a provider with no reference still yields a stable id', () => {
    // Falls back to provider + timestamp + amount, which is stable across a redelivery of the
    // SAME message but distinct between two genuine payments.
    const base = { senderId: 'EVCPlus', body: 'You have received $5.00 from 612345678', receivedAt: '111' };
    const other = { ...base, receivedAt: '222' };
    // (no Ref in the body, so both fall back)
    const a = parseReceipt({ ...base, body: 'You have received $5.00 from 612345678.' });
    const b = parseReceipt({ ...other, body: 'You have received $5.00 from 612345678.' });
    expect(a.receiptId).toBe(parseReceipt({ ...base, body: 'You have received $5.00 from 612345678.' }).receiptId);
    expect(a.receiptId).not.toBe(b.receiptId);
  });
});

describe('amount formats', () => {
  test('handles thousands separators', () => {
    const r = parseReceipt({ senderId: 'Zelle', body: 'John Smith sent you $1,250.00 with Zelle. Ref A1B2' });
    expect(r.amount).toBe(1250);
  });

  test('handles a whole-dollar amount', () => {
    const r = parseReceipt({ senderId: 'EVCPlus', body: 'You have received $12 from 612345678. Ref: Q1' });
    expect(r.amount).toBe(12);
  });
});

describe('identifyProvider', () => {
  test('is case-insensitive about the sender', () => {
    expect(identifyProvider('EVCPLUS', 'You have received $1.00')?.id).toBe('evcplus');
    expect(identifyProvider('evcplus', 'You have received $1.00')?.id).toBe('evcplus');
  });

  test('an unknown sender matches nothing', () => {
    expect(identifyProvider('RandomCorp', 'You have received $1.00')).toBeNull();
  });

  test('every registered provider has an id', () => {
    expect(PROVIDER_IDS.length).toBeGreaterThan(0);
    expect(new Set(PROVIDER_IDS).size).toBe(PROVIDER_IDS.length); // no duplicates
  });
});
