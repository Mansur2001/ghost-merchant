// Payment sensing over EMAIL.
//
// The point of this path: reading SMS on Android needs an app with the SMS permission,
// installed from the right source, granted by hand — three manual steps on a physical device.
// Every US rail emails the same notification it texts, so the server can read it directly.
//
// These use realistic notification text, including the HTML-stripped shape the sensor
// actually feeds the parser, because that is where a parser written against plain text
// quietly stops matching.
import { describe, test, expect } from '@jest/globals';
import { parseReceipt, identifyProvider } from '../src/domain/receipts.js';

// Mirrors the stripping in emailSensor.js.
const toText = (html) =>
  String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

describe('email notifications are recognised like their SMS twins', () => {
  test('Zelle email from the bank', () => {
    const r = parseReceipt({
      senderId: 'no-reply@zellepay.com',
      body: 'John Smith sent you $25.00 with Zelle. Ref A1B2C3',
    });
    expect(r).not.toBeNull();
    expect(r.provider).toBe('zelle');
    expect(r.amount).toBe(25);
    expect(r.senderName).toBe('John Smith');
  });

  test('Zelle email routed through a bank domain', () => {
    // Chase and BofA send these under their own domains rather than zellepay.com.
    expect(
      identifyProvider('alerts@chase.com', 'John Smith sent you $25.00 with Zelle')
    ).not.toBeNull();
  });

  test('Cash App email', () => {
    const r = parseReceipt({
      senderId: 'cash@square.com',
      body: 'Jane Doe sent you $40.00 on Cash App. #ZZ1234',
    });
    expect(r.provider).toBe('cashapp');
    expect(r.amount).toBe(40);
  });

  test('Venmo email', () => {
    const r = parseReceipt({
      senderId: 'venmo@venmo.com',
      body: 'John Smith paid you $15.50 - Venmo. ID: 9988776655',
    });
    expect(r.provider).toBe('venmo');
    expect(r.amount).toBe(15.5);
  });
});

describe('HTML email bodies', () => {
  test('survive being stripped to text', () => {
    // These arrive as multipart HTML; a parser that only ever saw plain SMS would miss them.
    const html = `
      <html><style>.x{color:red}</style><body>
      <table><tr><td><b>John&nbsp;Smith</b> sent you <span>$25.00</span> with Zelle.</td></tr>
      <tr><td>Ref&nbsp;A1B2C3</td></tr></table></body></html>`;
    const r = parseReceipt({ senderId: 'no-reply@zellepay.com', body: toText(html) });
    expect(r).not.toBeNull();
    expect(r.amount).toBe(25);
  });

  test('a marketing email from the same sender is NOT a payment', () => {
    // Providers email constantly. Recognising the sender is not enough.
    const html = '<p>Send money faster with Zelle! Learn more.</p>';
    expect(parseReceipt({ senderId: 'no-reply@zellepay.com', body: toText(html) })).toBeNull();
  });

  test('a payment REQUEST is not a payment received', () => {
    // Otherwise someone could mark their own order paid by ASKING for money instead of
    // sending it — same sender, same brand, same amount as a real receipt.
    const body = toText('<p>John Smith requests $25.00 from you with Zelle.</p>');
    expect(parseReceipt({ senderId: 'no-reply@zellepay.com', body })).toBeNull();
  });
});

describe('an unrelated email is ignored', () => {
  test('ordinary mail returns null', () => {
    expect(
      parseReceipt({ senderId: 'friend@gmail.com', body: 'lunch tomorrow?' })
    ).toBeNull();
  });

  test('a mail merely mentioning a dollar amount returns null', () => {
    expect(
      parseReceipt({ senderId: 'shop@example.com', body: 'Your receipt total was $25.00' })
    ).toBeNull();
  });
});

describe('the same payment over both transports', () => {
  test('produces the same receipt id, so it cannot be counted twice', () => {
    // If the merchant gets BOTH the SMS and the email for one payment, the second must
    // dedupe against the first — otherwise one payment credits two orders.
    const sms = parseReceipt({
      senderId: 'Zelle',
      body: 'John Smith sent you $25.00 with Zelle. Ref A1B2C3',
    });
    const email = parseReceipt({
      senderId: 'no-reply@zellepay.com',
      body: 'John Smith sent you $25.00 with Zelle. Ref A1B2C3',
    });
    expect(sms.receiptId).toBe(email.receiptId);
  });
});
