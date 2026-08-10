// Which channel carries a login code, per country.
//
// This matters because getting it wrong is expensive in both directions: routing a Somali
// number through a paid provider costs money on every login in the actual market, and routing
// a +1 number through the Oracle phone means a Somali SIM sending internationally — slow,
// costly, and often silently dropped, which the user experiences as "the app is broken".
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const config = {
  env: 'development',
  otp: {
    transport: 'auto',
    sendTimeoutMs: 5000,
    twilio: { accountSid: '', authToken: '', from: '', messagingServiceSid: '' },
  },
  oracleWebhookSecret: 'test-secret',
};

jest.unstable_mockModule('../src/config.js', () => ({ config }));

// The Oracle transport is only usable when a phone is actually polling — a config value
// can't tell us that, so the sender asks the heartbeat monitor.
let oracleState = 'not_configured';
jest.unstable_mockModule('../src/realtime/oracleMonitor.js', () => ({
  oracleStatus: () => ({ state: oracleState }),
}));
jest.unstable_mockModule('../src/notify/smsQueue.js', () => ({
  queueSms: jest.fn(async () => 1n),
}));

const { transportFor, sendOtpSms } = await import('../src/notify/smsSender.js');

beforeEach(() => {
  oracleState = 'not_configured';
  config.env = 'development';
  config.otp.transport = 'auto';
  config.otp.twilio = { accountSid: '', authToken: '', from: '', messagingServiceSid: '' };
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) }));
});

describe('auto routing', () => {
  test('Somali numbers go through the Oracle phone', () => {
    // The real market. No vendor, no per-message cost — the sovereignty requirement.
    expect(transportFor('+252612345678')).toBe('oracle');
    expect(transportFor('612345678')).toBe('oracle');
  });

  test('US numbers go through the paid provider', () => {
    // A Somali SIM sending to +1 is unreliable; the code just never arrives.
    expect(transportFor('+12065551234')).toBe('twilio');
  });

  test('an unparseable number still picks a transport rather than throwing', () => {
    // The caller has already validated, but a crash here would turn a bad input into a 500.
    expect(['oracle', 'twilio']).toContain(transportFor('nonsense'));
  });
});

describe('explicit transport overrides routing', () => {
  test('a pure-Oracle deployment never reaches for the provider', () => {
    config.otp.transport = 'oracle';
    expect(transportFor('+12065551234')).toBe('oracle');
  });

  test('a dev box can force the log transport for every number', () => {
    config.otp.transport = 'log';
    expect(transportFor('+252612345678')).toBe('log');
  });
});

describe('the Oracle phone', () => {
  test('with NO phone ever polling, a Somali number falls back to the log in dev', async () => {
    // Otherwise every local login silently queues a message nobody will ever send, and
    // sign-in just stops working with no error.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { transport } = await sendOtpSms('+252612345678', '123456');
    expect(transport).toBe('log');
    warn.mockRestore();
  });

  test('once a phone is polling, the code is QUEUED for it', async () => {
    oracleState = 'healthy';
    const { transport } = await sendOtpSms('+252612345678', '123456');
    expect(transport).toBe('oracle');
  });

  test('a phone that WAS polling and went quiet still gets the message queued', async () => {
    // A locked screen or a dropped tunnel is temporary; the message should wait for it
    // rather than failing the login outright.
    oracleState = 'down';
    const { transport } = await sendOtpSms('+252612345678', '123456');
    expect(transport).toBe('oracle');
  });
});

describe('unconfigured transports', () => {
  test('fall back to the log in development rather than blocking sign-in', async () => {
    // Otherwise OTP_TRANSPORT=auto — the correct setting for a mixed deployment — would break
    // every local login until Twilio credentials exist.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { transport } = await sendOtpSms('+12065551234', '123456');
    expect(transport).toBe('log');
    expect(warn.mock.calls.flat().join(' ')).toMatch(/not configured/);
    warn.mockRestore();
  });

  test('FAIL LOUDLY in production instead of printing the code to the log', async () => {
    // Silently logging a customer's login code in production would let anyone with log access
    // sign in as them. An error the operator can see is strictly better.
    config.env = 'production';
    await expect(sendOtpSms('+12065551234', '123456')).rejects.toThrow(/twilio/i);
  });
});

describe('twilio request shape', () => {
  beforeEach(() => {
    config.otp.twilio = {
      accountSid: 'AC123',
      authToken: 'secret-token',
      from: '+15005550006',
      messagingServiceSid: '',
    };
  });

  test('posts to the right account with basic auth and the code in the body', async () => {
    await sendOtpSms('+12065551234', '424242');
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toContain('/Accounts/AC123/Messages.json');
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from('AC123:secret-token').toString('base64')}`
    );
    const body = init.body.toString();
    expect(body).toContain('To=%2B12065551234');
    expect(body).toContain('424242');
  });

  test('prefers a Messaging Service over a bare from-number when both are set', async () => {
    config.otp.twilio.messagingServiceSid = 'MG999';
    await sendOtpSms('+12065551234', '424242');
    const body = global.fetch.mock.calls[0][1].body.toString();
    expect(body).toContain('MessagingServiceSid=MG999');
    expect(body).not.toContain('From=');
  });

  test("surfaces Twilio's own error code rather than a generic failure", async () => {
    // 21608 = "number not verified on a trial account", which is the single most likely
    // first-run failure. Hiding it would send someone hunting through logs for something the
    // API already explained.
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ message: 'The number is unverified', code: 21608 }),
    }));
    await expect(sendOtpSms('+12065551234', '111111')).rejects.toThrow(/21608/);
  });

  test('a network failure is reported as a delivery failure, not a crash', async () => {
    global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
    await expect(sendOtpSms('+12065551234', '111111')).rejects.toThrow(/twilio send failed/);
  });
});

describe('the code never leaks into the return value', () => {
  test('sendOtpSms resolves with the transport only', async () => {
    config.otp.transport = 'log';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await sendOtpSms('+252612345678', '987654');
    expect(result).toEqual({ transport: 'log' });
    expect(JSON.stringify(result)).not.toContain('987654');
    warn.mockRestore();
  });
});
