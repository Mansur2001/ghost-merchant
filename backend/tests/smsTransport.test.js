// How a login code goes out. Twilio carries every number. A code that never arrives is
// experienced as "the app is broken", so the fallbacks here are as important as the happy path.
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const config = {
  env: 'development',
  otp: {
    transport: 'auto',
    sendTimeoutMs: 5000,
    twilio: { accountSid: '', authToken: '', messagingServiceSid: '', from: '' },
    devSmsAllowlist: [],
  },
};

jest.unstable_mockModule('../src/config.js', () => ({ config }));


const { transportFor, sendOtpSms } = await import('../src/notify/smsSender.js');

const CREDS = { accountSid: 'AC123', authToken: 'secret-token', messagingServiceSid: 'MG456', from: '' };

const accepted = () => ({
  ok: true,
  status: 201,
  json: async () => ({ sid: 'SM789', status: 'accepted', error_code: null }),
});

const sentForm = () => new URLSearchParams(global.fetch.mock.calls[0][1].body);

beforeEach(() => {
  config.env = 'development';
  config.otp.transport = 'auto';
  config.otp.twilio = { accountSid: '', authToken: '', messagingServiceSid: '', from: '' };
  // The numbers these tests text on purpose. Anything else is a stranger to a dev box.
  config.otp.devSmsAllowlist = ['+12065551234', '+252612345678'];
  global.fetch = jest.fn(async () => accepted());
});

describe('routing', () => {
  test('auto sends EVERY number through Twilio, Somali and US alike', () => {
    expect(transportFor()).toBe('twilio');
  });

  test('an explicit log transport keeps a dev box offline', () => {
    config.otp.transport = 'log';
    expect(transportFor()).toBe('log');
  });

  test('a Somali number goes out over Twilio', async () => {
    config.otp.twilio = { ...CREDS };
    const { transport } = await sendOtpSms('+252612345678', '123456');
    expect(transport).toBe('twilio');
    expect(sentForm().get('To')).toBe('+252612345678');
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

  test('an EXPLICIT twilio transport never falls back to the log', async () => {
    config.otp.transport = 'twilio';
    await expect(sendOtpSms('+12065551234', '123456')).rejects.toThrow(/TWILIO_ACCOUNT_SID/);
  });

  test('a sender is required: SID + token alone is not configured', async () => {
    config.otp.transport = 'twilio';
    config.otp.twilio = { ...CREDS, messagingServiceSid: '' };
    await expect(sendOtpSms('+12065551234', '123456')).rejects.toThrow(/TWILIO_FROM/);
  });
});

describe('twilio request shape', () => {
  beforeEach(() => {
    config.otp.twilio = { ...CREDS };
  });

  test('posts a form with basic auth and the code in the body', async () => {
    const { transport } = await sendOtpSms('+12065551234', '424242');
    expect(transport).toBe('twilio');
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('AC123:secret-token').toString('base64')}`);
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(sentForm().get('To')).toBe('+12065551234');
    expect(sentForm().get('Body')).toContain('424242');
  });

  test('sends through the Messaging Service (where the 10DLC campaign lives)', async () => {
    await sendOtpSms('+12065551234', '424242');
    expect(sentForm().get('MessagingServiceSid')).toBe('MG456');
    expect(sentForm().has('From')).toBe(false);
  });

  test('falls back to a single From number when no service is set', async () => {
    config.otp.twilio = { ...CREDS, messagingServiceSid: '', from: '+12065550100' };
    await sendOtpSms('+12065551234', '424242');
    expect(sentForm().get('From')).toBe('+12065550100');
    expect(sentForm().has('MessagingServiceSid')).toBe(false);
  });

  test("surfaces Twilio's own error code rather than a generic failure", async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ code: 21408, message: 'Permission to send an SMS has not been enabled for the region' }),
    }));
    await expect(sendOtpSms('+252612345678', '111111')).rejects.toThrow(/21408/);
  });

  test('a message created already failed is a FAILURE, not a send', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ sid: 'SM1', status: 'failed', error_code: 30007 }),
    }));
    await expect(sendOtpSms('+12065551234', '111111')).rejects.toThrow(/30007/);
  });

  test('a network failure is reported as a delivery failure, not a crash', async () => {
    global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
    await expect(sendOtpSms('+12065551234', '111111')).rejects.toThrow(/twilio send failed/);
  });
});

describe('dev never texts strangers', () => {
  beforeEach(() => {
    config.otp.twilio = { ...CREDS };
  });

  test('a number NOT on DEV_SMS_ALLOWLIST gets the dev code, not a real text', async () => {
    // e.g. a seeded Somali number that may belong to a real person.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { transport } = await sendOtpSms('+252651234567', '123456');
    expect(transport).toBe('log');
    expect(global.fetch).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('that holds even when twilio is named explicitly', async () => {
    config.otp.transport = 'twilio';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await sendOtpSms('+252651234567', '123456')).transport).toBe('log');
    expect(global.fetch).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('allowlist entries match in any format', async () => {
    config.otp.devSmsAllowlist = ['+1 (206) 555-1234'];
    expect((await sendOtpSms('+12065551234', '123456')).transport).toBe('twilio');
  });

  test('production ignores the allowlist and texts every customer', async () => {
    config.env = 'production';
    config.otp.devSmsAllowlist = [];
    expect((await sendOtpSms('+252651234567', '123456')).transport).toBe('twilio');
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
