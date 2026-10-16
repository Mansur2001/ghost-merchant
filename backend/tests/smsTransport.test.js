// How a login code goes out. ClickSend carries every number. A code that never arrives is
// experienced as "the app is broken", so the fallbacks here are as important as the happy path.
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const config = {
  env: 'development',
  otp: {
    transport: 'auto',
    sendTimeoutMs: 5000,
    clicksend: { username: '', apiKey: '', from: '' },
    devSmsAllowlist: [],
  },
};

jest.unstable_mockModule('../src/config.js', () => ({ config }));


const { transportFor, sendOtpSms } = await import('../src/notify/smsSender.js');

const CREDS = { username: 'me@example.com', apiKey: 'secret-key', from: '' };

const accepted = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    http_code: 200,
    response_code: 'SUCCESS',
    data: { messages: [{ status: 'SUCCESS', message_id: 'abc' }] },
  }),
});

beforeEach(() => {
  config.env = 'development';
  config.otp.transport = 'auto';
  config.otp.clicksend = { username: '', apiKey: '', from: '' };
  // The numbers these tests text on purpose. Anything else is a stranger to a dev box.
  config.otp.devSmsAllowlist = ['+12065551234', '+252612345678'];
  global.fetch = jest.fn(async () => accepted());
});

describe('routing', () => {
  test('auto sends EVERY number through ClickSend, Somali and US alike', () => {
    expect(transportFor()).toBe('clicksend');
  });

  test('an explicit log transport keeps a dev box offline', () => {
    config.otp.transport = 'log';
    expect(transportFor()).toBe('log');
  });

  test('a Somali number goes out over ClickSend', async () => {
    config.otp.clicksend = { ...CREDS };
    const { transport } = await sendOtpSms('+252612345678', '123456');
    expect(transport).toBe('clicksend');
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).messages[0].to).toBe('+252612345678');
  });
});

describe('unconfigured transports', () => {
  test('fall back to the log in development rather than blocking sign-in', async () => {
    // Otherwise OTP_TRANSPORT=auto — the correct setting for a mixed deployment — would break
    // every local login until ClickSend credentials exist.
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
    await expect(sendOtpSms('+12065551234', '123456')).rejects.toThrow(/clicksend/i);
  });

  test('an EXPLICIT clicksend transport never falls back to the log', async () => {
    config.otp.transport = 'clicksend';
    await expect(sendOtpSms('+12065551234', '123456')).rejects.toThrow(/CLICKSEND_USERNAME/);
  });
});

describe('clicksend request shape', () => {
  beforeEach(() => {
    config.otp.clicksend = { ...CREDS };
  });

  test('posts JSON with basic auth and the code in the body', async () => {
    const { transport } = await sendOtpSms('+12065551234', '424242');
    expect(transport).toBe('clicksend');
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://rest.clicksend.com/v3/sms/send');
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from('me@example.com:secret-key').toString('base64')}`
    );
    const [msg] = JSON.parse(init.body).messages;
    expect(msg.to).toBe('+12065551234');
    expect(msg.body).toContain('424242');
    expect(msg).not.toHaveProperty('from');
  });

  test('sends from the configured number when one is set', async () => {
    config.otp.clicksend.from = '+18885550100';
    await sendOtpSms('+12065551234', '424242');
    const [msg] = JSON.parse(global.fetch.mock.calls[0][1].body).messages;
    expect(msg.from).toBe('+18885550100');
  });

  test('a 200 whose message was refused is a FAILURE, not a send', async () => {
    // ClickSend accepts the batch and rejects the message inside it. Reporting that as sent
    // would leave a customer waiting for a code that never left.
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        response_code: 'SUCCESS',
        data: { messages: [{ status: 'INSUFFICIENT_CREDIT' }] },
      }),
    }));
    await expect(sendOtpSms('+12065551234', '111111')).rejects.toThrow(/INSUFFICIENT_CREDIT/);
  });

  test("surfaces ClickSend's own error code rather than a generic failure", async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ response_code: 'UNAUTHORIZED', response_msg: 'Invalid credentials' }),
    }));
    await expect(sendOtpSms('+12065551234', '111111')).rejects.toThrow(/UNAUTHORIZED/);
  });

  test('a network failure is reported as a delivery failure, not a crash', async () => {
    global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
    await expect(sendOtpSms('+12065551234', '111111')).rejects.toThrow(/clicksend send failed/);
  });
});

describe('dev never texts strangers', () => {
  beforeEach(() => {
    config.otp.clicksend = { ...CREDS };
  });

  test('a number NOT on DEV_SMS_ALLOWLIST gets the dev code, not a real text', async () => {
    // e.g. a seeded Somali number that may belong to a real person.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { transport } = await sendOtpSms('+252651234567', '123456');
    expect(transport).toBe('log');
    expect(global.fetch).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('that holds even when clicksend is named explicitly', async () => {
    config.otp.transport = 'clicksend';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await sendOtpSms('+252651234567', '123456')).transport).toBe('log');
    expect(global.fetch).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('allowlist entries match in any format', async () => {
    config.otp.devSmsAllowlist = ['+1 (206) 555-1234'];
    expect((await sendOtpSms('+12065551234', '123456')).transport).toBe('clicksend');
  });

  test('production ignores the allowlist and texts every customer', async () => {
    config.env = 'production';
    config.otp.devSmsAllowlist = [];
    expect((await sendOtpSms('+252651234567', '123456')).transport).toBe('clicksend');
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
