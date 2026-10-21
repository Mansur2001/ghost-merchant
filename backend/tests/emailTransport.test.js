// Email codes over Twilio SendGrid, under the same rules as SMS: real mail in production, never
// a code in the log there, and in dev only to addresses someone vouched for.
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const config = {
  env: 'development',
  otp: {
    transport: 'auto',
    sendTimeoutMs: 5000,
    twilio: { accountSid: '', authToken: '', messagingServiceSid: '', from: '' },
    sendgrid: { apiKey: '', from: '' },
    devSmsAllowlist: [],
    devEmailAllowlist: [],
  },
};
jest.unstable_mockModule('../src/config.js', () => ({ config }));

const { sendOtpEmail, sendSetupEmail, emailConfigured } = await import('../src/notify/emailSender.js');

const KEYS = { apiKey: 'SG.key', from: 'codes@gurikaabe.com' };
let warn;

beforeEach(() => {
  config.env = 'development';
  config.otp.transport = 'auto';
  config.otp.sendgrid = { ...KEYS };
  config.otp.devEmailAllowlist = ['me@example.com'];
  global.fetch = jest.fn(async () => ({ ok: true, status: 202 }));
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('sendgrid request', () => {
  test('posts the code as plain text with a bearer key, tracking off', async () => {
    const { transport } = await sendOtpEmail('me@example.com', '424242');
    expect(transport).toBe('twilio');
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(init.headers.Authorization).toBe('Bearer SG.key');
    const body = JSON.parse(init.body);
    expect(body.personalizations[0].to[0].email).toBe('me@example.com');
    expect(body.from.email).toBe('codes@gurikaabe.com');
    expect(body.content[0].value).toContain('424242');
    expect(body.tracking_settings.click_tracking.enable).toBe(false);
  });

  test('anything but 202 is a failure, with SendGrid\'s reason', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false, status: 403,
      json: async () => ({ errors: [{ message: 'The from address does not match a verified Sender Identity' }] }),
    }));
    await expect(sendOtpEmail('me@example.com', '111111')).rejects.toThrow(/verified Sender/);
  });

  test('staff setup codes go out the same way', async () => {
    await sendSetupEmail('me@example.com', 'driver', '12345678');
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).content[0].value).toContain('12345678');
  });
});

describe('the same safety rules as SMS', () => {
  test('dev never emails an address that is not on DEV_EMAIL_ALLOWLIST', async () => {
    expect((await sendOtpEmail('stranger@example.com', '123456')).transport).toBe('log');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('allowlist matching ignores case', async () => {
    expect((await sendOtpEmail('Me@Example.com', '123456')).transport).toBe('twilio');
  });

  test('unconfigured in production fails loudly instead of logging the code', async () => {
    config.env = 'production';
    config.otp.sendgrid = { apiKey: '', from: '' };
    expect(emailConfigured()).toBe(false);
    await expect(sendOtpEmail('me@example.com', '123456')).rejects.toThrow(/SENDGRID_API_KEY/);
  });

  test('the code never leaks into the return value', async () => {
    config.otp.transport = 'log';
    const result = await sendOtpEmail('me@example.com', '987654');
    expect(JSON.stringify(result)).not.toContain('987654');
  });
});
