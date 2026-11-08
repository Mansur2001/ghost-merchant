// Push notifications: who is told what, and in which words. Pure, so every rule is tested.
//
// A notification shows on a LOCK SCREEN, where anyone holding the phone can read it. So the
// text never carries an address, a phone number, a code, an amount owed or a chat message's
// words — only that something happened, and the tap opens the app (which needs the session).
//
// Rules map a domain event (plus the order it concerns) to targets:
//   { to: { role: 'customer'|'driver', id } | { role: 'operator', admins?: true },
//     kind, vars?, url, tag }
// `tag` collapses repeats on the device: the at-least-once event bus can deliver twice, and
// the second notification then REPLACES the first instead of buzzing again.

export const TEXT = {
  en: {
    paid: ['Payment received', 'We are finding a driver for you now.'],
    paid_ride: ['Payment received', 'We are finding the nearest driver.'],
    dispatched: ['Driver assigned', 'Your driver is buying your items.'],
    dispatched_ride: ['Driver on the way', 'Your driver is coming to pick you up.'],
    arriving: ['Your driver is almost there', 'Get ready — have your ride code ready.'],
    in_transit: ['On the way', 'Your driver has your items and is coming to you.'],
    in_transit_ride: ['Trip started', 'Enjoy your ride.'],
    delivered: ['Delivered', 'Your order has arrived. Thank you!'],
    delivered_ride: ['You have arrived', 'Thank you for riding with GuriKaabe!'],
    failed: ['Order stopped', 'Your order was stopped. Open the app for details.'],
    failed_ride: ['Ride cancelled', 'Your ride was cancelled. Open the app for details.'],
    released: ['Finding another driver', 'Your driver could not make it. We are finding another.'],
    pay_declined: ['Payment not approved', 'The payment was not approved. You can try again.'],
    message: ['New message', 'You have a new message about your order.'],
    new_job: ['New job', 'You have a new job. Open the app.'],
    new_ride: ['New ride', 'A rider is waiting. Open the app.'],
    job_removed: ['Job removed', 'A job was taken off your list.'],
    driver_message: ['New message', 'You have a new message about a job.'],
    op_claimed: ['Payment to check', 'A customer says they have paid. Check the merchant phone.'],
    op_disputed: ['Delivery disputed', 'A customer says an order never arrived.'],
    op_pay_unknown: ['Payment unclear', 'A wallet payment could not be confirmed. Check the merchant account.'],
    op_withdrawal: ['Withdrawal requested', 'A customer asked to take money out of their wallet.'],
    op_access: ['New staff request', 'Someone asked to join as a driver or operator.'],
    topup_ok: ['Money added', 'Your wallet top-up went through.'],
    withdrawal_paid: ['Withdrawal sent', 'The money from your wallet was sent to your number.'],
    withdrawal_rejected: ['Withdrawal returned', 'Your withdrawal was not sent; the money is back in your wallet.'],
  },
  so: {
    paid: ['Lacagta waa la helay', 'Darawal ayaan kuu raadinaynaa.'],
    paid_ride: ['Lacagta waa la helay', 'Darawalka kuugu dhow ayaan raadinaynaa.'],
    dispatched: ['Darawal waa laguu diray', 'Darawalku alaabtaada ayuu iibinayaa.'],
    dispatched_ride: ['Darawalku waa soo socdaa', 'Darawalku wuu kuu imanayaa si uu kuu qaado.'],
    arriving: ['Darawalku waa ku dhow yahay', 'Diyaar noqo — koodhka safarka diyaar u hay.'],
    in_transit: ['Waa soo socdaa', 'Darawalku alaabta wuu haystaa, waa kuu imanayaa.'],
    in_transit_ride: ['Safarku wuu bilaabmay', 'Safar wanaagsan.'],
    delivered: ['Waa la keenay', 'Dalabkaagu waa yimid. Mahadsanid!'],
    delivered_ride: ['Waad timid', 'Mahadsanid inaad GuriKaabe raacday!'],
    failed: ['Dalabka waa la joojiyay', 'Dalabkaaga waa la joojiyay. App-ka fur si aad u ogaato.'],
    failed_ride: ['Safarka waa la joojiyay', 'Safarkaaga waa la joojiyay. App-ka fur si aad u ogaato.'],
    released: ['Darawal kale ayaa la raadinayaa', 'Darawalkaagu ma iman karo. Mid kale ayaan raadinaynaa.'],
    pay_declined: ['Lacagta lama oggolaan', 'Lacag bixinta lama oggolaan. Mar kale isku day.'],
    message: ['Fariin cusub', 'Fariin cusub ayaad ka heshay dalabkaaga.'],
    new_job: ['Shaqo cusub', 'Shaqo cusub ayaad haysataa. App-ka fur.'],
    new_ride: ['Safar cusub', 'Macmiil ayaa ku sugaya. App-ka fur.'],
    job_removed: ['Shaqo waa laga saaray', 'Shaqo ayaa liiskaaga laga saaray.'],
    driver_message: ['Fariin cusub', 'Fariin cusub ayaad ka heshay shaqo.'],
    op_claimed: ['Lacag la hubiyo', 'Macmiil ayaa sheegay inuu bixiyay. Hubi taleefanka ganacsiga.'],
    op_disputed: ['Keenis la diiday', 'Macmiil ayaa sheegay in dalab uusan iman.'],
    op_pay_unknown: ['Lacag aan cadayn', 'Lacag bixis lama xaqiijin karin. Hubi akoonka ganacsiga.'],
    op_withdrawal: ['Codsi lacag bixis', 'Macmiil ayaa codsaday inuu boorsada lacag ka bixiyo.'],
    op_access: ['Codsi shaqaale cusub', 'Qof ayaa codsaday inuu darawal ama shaqaale noqdo.'],
    topup_ok: ['Lacag waa lagu daray', 'Lacag-ku-darka boorsadaadu wuu dhacay.'],
    withdrawal_paid: ['Lacagta waa la diray', 'Lacagtii boorsada waxaa loo diray lambarkaaga.'],
    withdrawal_rejected: ['Lacagta waa la celiyay', 'Lacag bixintaada lama dirin; lacagtu boorsada ayay ku jirtaa.'],
  },
};

export function textFor(kind, lang = 'en') {
  const pair = (TEXT[lang] || TEXT.en)[kind] || TEXT.en[kind];
  if (!pair) return null;
  return { title: pair[0], body: pair[1] };
}

const customerUrl = (orderId) => `/?order=${orderId}`;
const driverUrl = (orderId) => `/driver/?job=${orderId}`;
const operatorUrl = (orderId) => `/operator/?order=${orderId}`;

const CUSTOMER_STATE = {
  PAID_UNASSIGNED: 'paid',
  DISPATCHED: 'dispatched',
  IN_TRANSIT: 'in_transit',
  DELIVERED: 'delivered',
  FAILED_REFUND: 'failed',
};
// These words differ for a ride.
const RIDE_VARIANT = new Set(['paid', 'dispatched', 'in_transit', 'delivered', 'failed']);

// event: { name, payload }; order: the order row as it is NOW (user_id, driver_id, kind), or
// null for events not about an order. `previousDriverId` for a release/failure, when known.
export function targetsFor(event, order) {
  const p = event.payload || {};
  const out = [];
  const ride = order?.kind === 'RIDE';
  const forCustomer = (kind, extraTag = '') => {
    if (!order || !Number.isInteger(order.user_id)) return;
    const k = ride && RIDE_VARIANT.has(kind) ? `${kind}_ride` : kind;
    out.push({ to: { role: 'customer', id: order.user_id }, kind: k, url: customerUrl(order.id), tag: `order-${order.id}${extraTag}` });
  };
  const forDriver = (driverId, kind) => {
    if (driverId == null || !order) return;
    out.push({ to: { role: 'driver', id: String(driverId) }, kind, url: driverUrl(order.id), tag: `job-${order.id}` });
  };
  const forOperators = (kind, { admins = false, orderId = null } = {}) => {
    out.push({ to: { role: 'operator', admins }, kind, url: orderId ? operatorUrl(orderId) : '/operator/', tag: `op-${kind}-${orderId || 'x'}` });
  };

  switch (event.name) {
    case 'order.state_changed': {
      if (!order) break;
      if (p.from === 'DISPATCHED' && p.to === 'PAID_UNASSIGNED') {
        forCustomer('released');
        // The driver who let it go did it themselves: nothing to tell them.
        break;
      }
      const kind = CUSTOMER_STATE[p.to];
      if (kind) forCustomer(kind);
      if (p.to === 'DISPATCHED') forDriver(order.driver_id, ride ? 'new_ride' : 'new_job');
      // Stopped by someone else (operator, customer) while a driver had it.
      const byDriver = String(p.actor || '').startsWith('driver:');
      if (p.to === 'FAILED_REFUND' && order.driver_id != null && !byDriver) forDriver(order.driver_id, 'job_removed');
      break;
    }
    case 'message.posted': {
      const sender = p.message?.sender;
      if (!order || sender === 'system') break; // system lines go with a state change, already told
      if (sender === 'driver' || sender === 'operator') forCustomer('message', '-msg');
      if ((sender === 'user' || sender === 'operator') && ['DISPATCHED', 'IN_TRANSIT'].includes(order.status)) {
        forDriver(order.driver_id, 'driver_message');
      }
      break;
    }
    case 'payment.claimed':
      forOperators('op_claimed', { orderId: p.orderId });
      break;
    case 'payment.attempt':
      if (p.status === 'declined' && order) forCustomer('pay_declined', '-pay');
      if (p.status === 'unknown') forOperators('op_pay_unknown', { orderId: p.orderId });
      break;
    case 'delivery.disputed':
      forOperators('op_disputed', { orderId: p.orderId });
      break;
    default:
      break;
  }
  return out;
}

// For the ride "almost there" nudge: how close counts, judged from the driver's position.
export const ARRIVING_M = 300;
