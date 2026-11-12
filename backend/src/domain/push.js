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
    op_bug: ['New bug report', 'Someone reported a problem with the app.'],
    topup_ok: ['Money added', 'Your wallet top-up went through.'],
    withdrawal_paid: ['Withdrawal sent', 'The money from your wallet was sent to your number.'],
    withdrawal_rejected: ['Withdrawal returned', 'Your withdrawal was not sent; the money is back in your wallet.'],
    paid_parcel: ['Payment received', 'We are finding a driver to collect your parcel.'],
    dispatched_parcel: ['Driver on the way', 'A driver is coming to collect your parcel.'],
    in_transit_parcel: ['Parcel collected', 'Your parcel is on the way.'],
    delivered_parcel: ['Parcel delivered', 'Your parcel has arrived.'],
    failed_parcel: ['Parcel stopped', 'Your parcel was stopped. Open the app for details.'],
    paid_service: ['Payment received', 'We are finding a technician for you.'],
    dispatched_service: ['Technician on the way', 'Your technician is coming to you.'],
    in_transit_service: ['Work started', 'Your technician has started.'],
    delivered_service: ['Job done', 'Thank you for using GuriKaabe!'],
    failed_service: ['Visit stopped', 'Your visit was stopped. Open the app for details.'],
    offer: ['A rider chose you', 'Accept the ride quickly, or it goes to someone else.'],
    new_visit: ['New visit', 'A customer needs your help. Open the app.'],
    extra_quote: ['Extra work quote', 'Your technician sent a price for more work. Open the app.'],
    submission_live: ['Your suggestion is live', 'The item you suggested can now be ordered.'],
    submission_rejected: ['Suggestion not added', 'We could not add the item you suggested. Open the app.'],
    topup_rejected: ['Top-up not added', 'We could not confirm your top-up. Open the app.'],
    op_submission: ['New item suggestion', 'A customer suggested an item for the catalog.'],
    op_topup: ['Top-up to check', 'A customer says they topped up. Check the merchant phone.'],
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
    op_bug: ['Cillad cusub', 'Qof ayaa soo sheegay dhibaato app-ka ku jirta.'],
    topup_ok: ['Lacag waa lagu daray', 'Lacag-ku-darka boorsadaadu wuu dhacay.'],
    withdrawal_paid: ['Lacagta waa la diray', 'Lacagtii boorsada waxaa loo diray lambarkaaga.'],
    withdrawal_rejected: ['Lacagta waa la celiyay', 'Lacag bixintaada lama dirin; lacagtu boorsada ayay ku jirtaa.'],
    paid_parcel: ['Lacagta waa la helay', 'Darawal ayaan u raadinaynaa xirmadaada.'],
    dispatched_parcel: ['Darawalku waa soo socdaa', 'Darawal ayaa u imanaya inuu xirmada qaado.'],
    in_transit_parcel: ['Xirmada waa la qaaday', 'Xirmadaadu waa socotaa.'],
    delivered_parcel: ['Xirmada waa la gaarsiiyay', 'Xirmadaadu way gaartay.'],
    failed_parcel: ['Xirmada waa la joojiyay', 'Xirmadaada waa la joojiyay. App-ka fur.'],
    paid_service: ['Lacagta waa la helay', 'Farsamoyaqaan ayaan kuu raadinaynaa.'],
    dispatched_service: ['Farsamoyaqaanku waa soo socdaa', 'Farsamoyaqaankaagu waa kuu imanayaa.'],
    in_transit_service: ['Shaqadu way bilaabatay', 'Farsamoyaqaanku wuu bilaabay.'],
    delivered_service: ['Shaqadu way dhammaatay', 'Mahadsanid inaad GuriKaabe isticmaashay!'],
    failed_service: ['Booqashada waa la joojiyay', 'Booqashadaada waa la joojiyay. App-ka fur.'],
    offer: ['Macmiil ayaa ku doortay', 'Dhaqso u aqbal safarka, haddii kale mid kale ayaa qaadanaya.'],
    new_visit: ['Booqasho cusub', 'Macmiil ayaa caawimaad u baahan. App-ka fur.'],
    extra_quote: ['Qiimo shaqo dheeraad ah', 'Farsamoyaqaankaagu qiimo ayuu kuu soo diray. App-ka fur.'],
    submission_live: ['Alaabtii aad soo jeedisay waa diyaar', 'Hadda waad dalban kartaa.'],
    submission_rejected: ['Alaabta lama darin', 'Ma darin karin alaabtii aad soo jeedisay. App-ka fur.'],
    topup_rejected: ['Lacagta lama darin', 'Ma xaqiijin karin lacag-ku-darkaaga. App-ka fur.'],
    op_submission: ['Alaab la soo jeediyay', 'Macmiil ayaa alaab cusub soo jeediyay.'],
    op_topup: ['Lacag-ku-dar la hubiyo', 'Macmiil ayaa sheegay inuu lacag ku shubay. Hubi taleefanka ganacsiga.'],
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
// These words differ for a ride, a parcel and a technician's visit.
const KIND_VARIANT = new Set(['paid', 'dispatched', 'in_transit', 'delivered', 'failed']);
const KIND_SUFFIX = { RIDE: '_ride', PARCEL: '_parcel', SERVICE: '_service' };

// event: { name, payload }; order: the order row as it is NOW (user_id, driver_id, kind), or
// null for events not about an order. `previousDriverId` for a release/failure, when known.
export function targetsFor(event, order) {
  const p = event.payload || {};
  const out = [];
  const ride = order?.kind === 'RIDE';
  const suffix = KIND_SUFFIX[order?.kind] || '';
  const forCustomer = (kind, extraTag = '') => {
    if (!order || !Number.isInteger(order.user_id)) return;
    const k = suffix && KIND_VARIANT.has(kind) ? `${kind}${suffix}` : kind;
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
      if (p.to === 'DISPATCHED') forDriver(order.driver_id, ride ? 'new_ride' : order.kind === 'SERVICE' ? 'new_visit' : 'new_job');
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
    case 'driver.offered':
      // A new offer buzzes the chosen driver. A closed one needs nobody told: the customer's
      // screen updates and the next driver gets 'new_ride' from the dispatch.
      if (!p.closed && order) {
        out.push({ to: { role: 'driver', id: String(p.driverId) }, kind: 'offer', url: '/driver/', tag: `offer-${order.id}` });
      }
      break;
    case 'order.extra_quoted':
      forCustomer('extra_quote', '-extra');
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
