// A stand-in for the WaafiPay gateway, for STAGING ONLY (docker-compose.staging.yml). It answers
// API_PURCHASE the way the real gateway does, so the in-app payment path is exercised end to
// end without merchant keys. Production refuses to boot with any WAAFIPAY_URL but the real one.
//
// The payer's last four digits choose the answer:
//   ...0000  declined (5206, the customer refused)
//   ...9999  a 502 (an answer we can't read -> 'unknown')
//   anything else: approved after ~1.5 s (the customer "typing their PIN")
import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';

const PORT = Number(process.env.PORT || 8099);
const seen = new Map(); // requestId -> answer, so a retried request gets the same one

createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/asm') { res.writeHead(404).end(); return; }
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 16384) req.destroy(); });
  req.on('end', () => {
    let body;
    try { body = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
    const p = body?.serviceParams || {};
    const account = String(p.payerInfo?.accountNo || '');
    const info = p.transactionInfo || {};
    const reply = (status, json) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (body.serviceName !== 'API_PURCHASE' || !p.merchantUid || !p.apiKey) {
      return reply(200, { responseCode: '5001', responseMsg: 'RCS_INVALID_REQUEST' });
    }
    if (seen.has(body.requestId)) return reply(200, seen.get(body.requestId));
    console.log(`[waafipay-mock] purchase ${info.amount} ${info.currency} from …${account.slice(-4)} ref ${info.referenceId}`);
    if (account.endsWith('9999')) { res.writeHead(502).end('bad gateway'); return; }
    setTimeout(() => {
      const answer = account.endsWith('0000')
        ? { schemaVersion: '1.0', responseCode: '5206', errorCode: 'E10205', responseMsg: 'RCS_USER_REJECTED', params: {} }
        : {
          schemaVersion: '1.0', responseCode: '2001', errorCode: '0', responseMsg: 'RCS_SUCCESS',
          params: {
            accountNo: account, accountType: 'MWALLET', state: 'APPROVED', merchantCharges: '0',
            referenceId: info.referenceId, transactionId: String(randomInt(10_000_000, 99_999_999)),
            issuerTransactionId: `MOCK${randomInt(1e6, 9e6)}`, txAmount: String(info.amount),
          },
        };
      seen.set(body.requestId, answer);
      reply(200, answer);
    }, 1500);
  });
}).listen(PORT, () => console.log(`[waafipay-mock] listening on :${PORT} — STAGING ONLY`));
