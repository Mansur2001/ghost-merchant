// The dev seed's fixed dataset, shared by the seed itself and by the guards that keep it out
// of production (db/seedSafety.js).
//
// EVERY CREDENTIAL HERE IS PUBLIC — it is in the repository. That is fine on a laptop and a
// takeover anywhere real: an operator account reads every customer's phone, address and chat.
// So production refuses to boot while any of these still logs in (see index.js).
//
// The customer and driver numbers are made up, but they are VALID Somali numbers and may
// belong to real people. Dev never texts them: notify/smsSender.js only sends real SMS outside
// production to numbers on DEV_SMS_ALLOWLIST.

export const SEED_OPERATORS = [
  { username: 'admin', displayName: 'Bootstrap operator', password: 'change-me-please-1', isAdmin: true },
  { username: 'hodan', displayName: 'Hodan (dispatch)', password: 'seeded-operator-pw-1', isAdmin: false },
];

export const SEED_DRIVERS = [
  { name: 'Amina', msisdn: '+252619876543', pin: '1234' },
  { name: 'Bashir', msisdn: '+252651112223', pin: '5678' },
];

export const SEED_CUSTOMERS = ['+252612345678', '+252651234567', '+252771234567'];
