// English / Somali strings for the customer and driver PWAs. Classic script; exposes
// window.GMI18n. Loaded just before each app.js, so the page is translated before first paint.
//
// Markup opts in with attributes:
//   data-i18n="key"       -> textContent
//   data-i18n-html="key"  -> innerHTML (ONLY for the static strings below that carry <strong>;
//                            never route user or server text through it)
//   data-i18n-ph="key"    -> placeholder
// Dynamic text calls GMI18n.t(key, vars). Switching language fires a `gm:lang` event so each
// app can re-render what it drew itself.
//
// Keep both languages SHORT: these screens are read on small, old handsets, often in a hurry.
// The Somali is deliberately everyday Somali — common words, short sentences, nothing formal
// or technical. Keep it that way when adding strings. Have a native speaker review before launch. Choice persists in localStorage (`gm_lang`) across the PWAs, like the theme.
(function (global) {
  var KEY = 'gm_lang';

  var STR = {
    en: {
      'nav.home': 'Home',
      'nav.faq': 'FAQ',
      'nav.back': '← Back',
      'lang.switch': 'Af-Soomaali',

      'hero.title': 'Order from the market. Pay from your phone.',
      'hero.sub': 'Pay the merchant with EVC Plus or eDahab. We never hold your money. All you need is a phone number and a nearby landmark.',
      'role.customer': "I'm a customer",
      'role.customer.sub': 'Order and track it live',
      'role.driver': "I'm a driver",
      'role.driver.sub': 'See the deliveries assigned to you',
      'role.operator': "I'm an operator",
      'role.operator.sub': 'Coordinate orders and payments',
      'join.prompt': 'Want to drive or work with us?',
      'join.link': 'Ask to join →',
      'how.1': 'Tell us what you need and your nearest landmark.',
      'how.2': "Tap Pay — your phone's dialer opens with the code filled in.",
      'how.3': 'Follow your order live until it arrives.',

      'join.title': 'Join the GuriKaabe team',
      'join.intro': "Send a request and we'll call you. Accounts are only created after we talk.",
      'join.role': 'What would you like to do?',
      'join.role.driver': 'Deliver orders',
      'join.role.operator': 'Coordinate orders and payments',
      'join.name': 'Your name',
      'join.phone': 'Your phone number',
      'join.phoneHint': "We'll call you on this number",
      'join.msg': 'Anything we should know? (optional)',
      'join.msg.ph': "Your area, whether you have a motorbike, when you're free…",
      'join.id': 'Photo of your ID — both sides',
      'join.id.note': "Any government ID. Only the reviewer sees it, and it's <strong>deleted once they decide</strong>.",
      'join.front': 'Front',
      'join.back': 'Back',
      'join.submit': 'Send request',
      'join.direct': 'Or contact us directly',
      'join.direct.sub': 'Contact the owner:',
      'join.err.name': 'Enter your name.',
      'join.sending': 'Sending…',
      'join.sendingId': 'Sending ID ({side})…',
      'join.done': "Request sent. We'll call you soon.",
      'join.uploadFailed': "Couldn't upload: {list}. We may call you about it.",
      'join.idHint': '{parts} — deleted after review',
      'join.side.front': 'front',
      'join.side.back': 'back',
      'join.missing': 'missing',

      'auth.phone': 'Your phone number',
      'auth.send': 'Text me a code',
      'auth.code': 'Enter the 6-digit code',
      'auth.verify': 'Verify',
      'auth.resend': 'Send a new code',
      'auth.resendIn': 'Send a new code ({s}s)',
      'auth.sending': 'Sending code…',
      'auth.sent': 'Code sent to {phone}. Valid for {m} minutes.',
      'auth.dev': 'Dev mode — your code is {code}',
      'auth.retry': '{err} Try again in {s}s.',
      'auth.ok': 'Phone verified ✓',
      'err.phone': 'Enter a valid phone number.',
      'err.code': 'Enter the 6-digit code.',
      'err.badCode': 'Wrong or expired code.',
      'err.send': "Couldn't send the code. Try again.",
      'err.cooldown': 'A code was just sent. Please wait.',
      'err.tooMany': 'Too many tries. Wait and try again.',
      'err.login': 'Wrong phone number or PIN.',
      'err.generic': 'Something went wrong. Try again.',
      'net.offline': 'No connection.',
      'session.expired': 'Session expired. Please sign in again.',
      'signedOut': 'Signed out.',

      'start.as': 'Signed in as',
      'start.signout': 'Sign out',
      'start.resume': 'My orders',
      'start.request': 'What do you need?',
      'start.request.ph': 'e.g. 2kg rice, cooking oil, 6 eggs',
      'start.amount': 'Agreed total (USD)',
      'start.landmark': 'Nearest landmark (required)',
      'start.landmark.ph': 'Green house next to the yellow pharmacy',
      'start.photo': 'Photo of the item (optional)',
      'start.submit': 'Place order',
      'start.err.request': 'Describe what you need.',
      'start.err.amount': 'Enter a valid amount.',
      'start.err.landmark': 'Add a landmark.',
      'loc.none': 'Location not set.',
      'loc.btn': 'Use my location',
      'loc.finding': 'Finding your location…',
      'loc.ok': 'Location set (±{m}m).',
      'loc.fail': "Couldn't get location. The landmark is enough.",

      'order.num': 'Order #',
      'order.total': 'Total: $',
      'order.progress': 'Progress',
      'order.photos': 'Photos',
      'order.chat': 'Chat',
      'pay.btn': 'Pay now (EVC Plus)',
      'pay.note': 'Opens your dialer with the code filled in. After you pay, tap “I’ve paid” below.',
      'pay.manual': 'EVC Plus / eDahab works with Somali numbers only. Pay the operator directly, then tap “I’ve paid”.',
      'paid.refLabel': 'Transaction number (optional)',
      'paid.refPh': 'From your EVC / eDahab message',
      'paid.btn': 'I’ve paid',
      'paid.sent': 'Thanks — we’re checking it ✓',
      'paid.waiting': 'Thanks. We’re checking your payment — this page updates when it’s confirmed.',
      'paid.ref': 'Number: {ref}.',
      'err.alreadyPaid': 'This order is already paid.',
      'err.badRef': 'That transaction number doesn’t look right.',
      'pay.confirmed': 'Payment confirmed ✓',
      'photos.none': 'No photos yet.',
      'photo.proof': 'Delivery proof',
      'photo.ref': 'Item photo',
      'chat.ph': 'Message the driver or operator…',
      'chat.send': 'Send',
      'resume.title': 'Your orders',
      'resume.none': 'No orders yet.',

      'st.PENDING_PAYMENT': 'Awaiting payment',
      'st.PAID_UNASSIGNED': 'Paid',
      'st.DISPATCHED': 'Driver getting your items',
      'st.IN_TRANSIT': 'On the way to you',
      'st.DELIVERED': 'Delivered',
      'st.FAILED_REFUND': 'Cancelled',

      'faq.title': 'FAQ',

      'faq.what.q': 'What is GuriKaabe?',
      'faq.what.a': 'Order goods from the market and a driver brings them to you. You pay the merchant from your own phone.',
      'faq.pay.q': 'How do I pay?',
      'faq.pay.a': 'After ordering, tap <strong>Pay now</strong>. Your dialer opens with the EVC Plus / eDahab code filled in. After you pay, tap <strong>I’ve paid</strong>. We check the payment and your order updates on its own.',
      'faq.privacy.q': 'Is my number safe?',
      'faq.privacy.a': 'We use it only for your orders and sign-in. We never sell it or share it with advertisers. A texting service delivers your sign-in code.',
      'faq.landmark.q': 'Why a landmark?',
      'faq.landmark.a': 'Street addresses are unreliable, so drivers find you by a landmark. A photo helps too.',
      'faq.track.q': 'How do I track my order?',
      'faq.track.a': "The progress list and chat update live, and you'll see a delivery photo when it arrives.",

      'sync.failed': "{n} not synced",
      'sync.pending': '{n} waiting to send',

      'phone.enter': 'Enter your mobile number',
      'phone.country': 'Country',
      'phone.tryUs': 'US number? Tap 🇺🇸 +1',
      'phone.more': '{n} more digit(s)',
      'phone.badPrefix': 'Unknown prefix (US numbers need +1)',
      'phone.tooLong': 'Too many digits',
      'phone.badUs': 'Not a valid US number',
      'phone.payOperator': 'pay via operator',

      'drv.setup.prompt': 'New driver?',
      'drv.setup.link': 'Set up account →',
      'drv.setup.title': 'Set up your account',
      'drv.setup.intro': 'Enter the 8-digit code we texted you, then choose a 6-digit PIN.',
      'drv.setup.code': 'Setup code',
      'drv.setup.pin': 'New PIN (6 digits)',
      'drv.setup.pin2': 'Repeat PIN',
      'drv.setup.btn': 'Save PIN & log in',
      'drv.setup.ok': 'PIN saved. Welcome ✓',
      'drv.setup.err.code': 'Enter your phone number and the 8-digit code.',
      'drv.setup.err.match': 'The two PINs do not match.',
      'err.setupCode': 'Wrong or expired code. Ask the office for a new one.',
      'err.pinShape': 'The PIN must be 6 digits.',
      'err.pinWeak': 'That PIN is too easy. Choose another.',
      'drv.title': 'Driver',
      'drv.logout': 'Log out',
      'drv.pin': 'PIN',
      'drv.login': 'Log in',
      'drv.orders': 'My deliveries',
      'drv.refresh': 'Refresh',
      'drv.none': 'No deliveries assigned yet.',
      'drv.signedIn': 'Signed in. Pick a delivery.',
      'drv.items': 'Shopping list',
      'drv.noItems': 'No item list.',
      'drv.budget': 'Customer paid: $',
      'drv.delivery': 'Delivery',
      'drv.landmark': 'Landmark:',
      'drv.noLandmark': '(none given)',
      'drv.map': 'Open map',
      'drv.call': 'Call customer',
      'drv.adjust': 'Item or price change',
      'drv.adjust.ph': 'e.g. No sugar, got jaggery instead. Oil +$0.50.',
      'drv.adjust.btn': 'Send to customer',
      'drv.adjust.err': 'Describe the change.',
      'drv.adjust.ok': 'Sent to customer ✓',
      'drv.proof.btn': 'Upload delivery photo',
      'drv.proof.choose': 'Choose a photo first.',
      'drv.proof.ok': 'Delivery photo uploaded ✓',
      'drv.proof.fail': 'Upload failed.',
      'drv.actions': 'Actions',
      'drv.act.secured': 'Got the items — heading to customer',
      'drv.act.delivered': 'Mark delivered',
      'drv.act.failed': 'Report a problem',
      'drv.act.none': 'Nothing to do here.',
      'drv.saved': 'Saved — will send when you have signal.',
      'drv.updated': 'Updated ✓',
      'drv.waiting': '(waiting to send)',
      'drv.st.PAID_UNASSIGNED': 'Paid',
      'drv.st.DISPATCHED': 'Go to market',
      'drv.st.IN_TRANSIT': 'Delivering',
      'drv.st.DELIVERED': 'Delivered',
      'drv.st.FAILED_REFUND': 'Cancelled',
    },

    so: {
      'nav.home': 'Bogga hore',
      'nav.faq': "Su'aalo",
      'nav.back': '← Dib',
      'lang.switch': 'English',

      'hero.title': 'Wax ka dalbo suuqa. Ku bixi taleefankaaga.',
      'hero.sub': 'Lacagta si toos ah ugu dir iibiyaha, EVC Plus ama eDahab. Lacagtaada annagu ma qabanno. Waxaad u baahan tahay lambar taleefan iyo meel kuu dhow oo la yaqaan.',
      'role.customer': 'Waxaan ahay macmiil',
      'role.customer.sub': 'Dalbo oo raac dalabkaaga',
      'role.driver': 'Waxaan ahay darawal',
      'role.driver.sub': 'Arag dalabyada laguu diray',
      'role.operator': 'Waxaan ahay maamule',
      'role.operator.sub': 'Maamul dalabyada iyo lacagta',
      'join.prompt': 'Ma rabtaa inaad nala shaqeyso?',
      'join.link': 'Codso →',
      'how.1': 'Noo sheeg waxaad rabto iyo meel kuu dhow.',
      'how.2': 'Riix Bixi — koodhka lacagta ayaa kuu diyaar ah.',
      'how.3': 'Raac dalabkaaga ilaa uu kuu yimaado.',

      'join.title': 'Nala shaqee',
      'join.intro': 'Codsi soo dir, waan ku soo wacaynaa. Akoonka waxaa la furaa markaan wada hadalno kadib.',
      'join.role': 'Maxaad rabtaa inaad qabato?',
      'join.role.driver': 'Dalabyada gee',
      'join.role.operator': 'Maamul dalabyada iyo lacagta',
      'join.name': 'Magacaaga',
      'join.phone': 'Lambarkaaga',
      'join.phoneHint': 'Lambarkan ayaan kugu soo wacaynaa',
      'join.msg': 'Wax kale? (haddii aad rabto)',
      'join.msg.ph': 'Xaafaddaada, mooto ma leedahay, goorma ayaad bannaan tahay…',
      'join.id': 'Sawirka kaarka aqoonsiga — labada dhinac',
      'join.id.note': 'Kaar kasta oo dawladda ah. Qofka codsiga eegaya oo kaliya ayaa arka, waana <strong>la tirtiraa marka go’aan la gaaro</strong>.',
      'join.front': 'Hore',
      'join.back': 'Gadaal',
      'join.submit': 'Dir codsiga',
      'join.direct': 'Ama si toos ah noola soo xiriir',
      'join.direct.sub': 'La xiriir milkiilaha:',
      'join.err.name': 'Qor magacaaga.',
      'join.sending': 'Waa la dirayaa…',
      'join.sendingId': 'Kaarka waa la dirayaa ({side})…',
      'join.done': 'Codsiga waa la diray. Dhawaan ayaan ku soo wacaynaa.',
      'join.uploadFailed': 'Ma dirmin: {list}. Waan ku soo wici karnaa.',
      'join.idHint': '{parts} — waa la tirtiraa kadib',
      'join.side.front': 'hore',
      'join.side.back': 'gadaal',
      'join.missing': 'ma jiro',

      'auth.phone': 'Lambarkaaga',
      'auth.send': 'Koodh ii soo dir',
      'auth.code': 'Qor koodhka 6-da lambar',
      'auth.verify': 'Gal',
      'auth.resend': 'Koodh cusub ii soo dir',
      'auth.resendIn': 'Koodh cusub ({s}s)',
      'auth.sending': 'Koodhka waa la dirayaa…',
      'auth.sent': 'Koodhka waxaa loo diray {phone}. Wuxuu shaqeynayaa {m} daqiiqo.',
      'auth.dev': 'Tijaabo — koodhkaagu waa {code}',
      'auth.retry': '{err} Sug {s} ilbiriqsi.',
      'auth.ok': 'Waad gashay ✓',
      'err.phone': 'Qor lambar sax ah.',
      'err.code': 'Qor koodhka 6-da lambar.',
      'err.badCode': 'Koodhku waa khalad ama wuu dhacay.',
      'err.send': 'Koodhka lama diri karin. Mar kale isku day.',
      'err.cooldown': 'Koodh hadda ayaa la diray. Wax yar sug.',
      'err.tooMany': 'Isku day badan. Wax yar sug.',
      'err.login': 'Lambarka ama PIN-ka waa khalad.',
      'err.generic': 'Wax baa khaldamay. Mar kale isku day.',
      'net.offline': 'Internet ma jiro.',
      'session.expired': 'Waqtigaagii wuu dhamaaday. Mar kale gal.',
      'signedOut': 'Waad baxday.',

      'start.as': 'Waxaad ku gashay',
      'start.signout': 'Ka bax',
      'start.resume': 'Dalabyadayda',
      'start.request': 'Maxaad rabtaa?',
      'start.request.ph': 'tusaale: 2kg bariis, saliid, 6 ukun',
      'start.amount': 'Lacagta guud (USD)',
      'start.landmark': 'Meel kuu dhow oo la yaqaan (waa muhiim)',
      'start.landmark.ph': 'Guriga cagaaran ee u dhow farmashiyaha jaallaha ah',
      'start.photo': 'Sawirka alaabta (haddii aad rabto)',
      'start.submit': 'Dalbo',
      'start.err.request': 'Qor waxaad rabto.',
      'start.err.amount': 'Qor lacag sax ah.',
      'start.err.landmark': 'Qor meel kuu dhow.',
      'loc.none': 'Goobta lama helin weli.',
      'loc.btn': 'Isticmaal goobtayda',
      'loc.finding': 'Goobtaada waa la raadinayaa…',
      'loc.ok': 'Goobta waa la helay (±{m}m).',
      'loc.fail': 'Goobta lama helin. Meesha aad qortay way ku filan tahay.',

      'order.num': 'Dalab #',
      'order.total': 'Wadarta: $',
      'order.progress': 'Xaaladda',
      'order.photos': 'Sawirro',
      'order.chat': 'Fariimo',
      'pay.btn': 'Hadda bixi (EVC Plus)',
      'pay.note': 'Koodhka lacagta ayaa kuu furmaya. Marka aad bixiso, hoos ka riix “Waan bixiyay”.',
      'pay.manual': 'EVC Plus / eDahab waxay u shaqeysaa lambarrada Soomaaliya oo kaliya. Lacagta si toos ah u sii maamulaha, kadib riix “Waan bixiyay”.',
      'paid.refLabel': 'Lambarka lacag-dirista (haddii aad hayso)',
      'paid.refPh': 'Ka qaado fariinta EVC / eDahab',
      'paid.btn': 'Waan bixiyay',
      'paid.sent': 'Mahadsanid — waan hubinaynaa ✓',
      'paid.waiting': 'Mahadsanid. Lacagtaada waan hubinaynaa — boggan wuu is beddeli doonaa marka la xaqiijiyo.',
      'paid.ref': 'Lambarka: {ref}.',
      'err.alreadyPaid': 'Dalabkan horay ayaa loo bixiyay.',
      'err.badRef': 'Lambarkaas sax uma eka.',
      'pay.confirmed': 'Lacagta waa la helay ✓',
      'photos.none': 'Sawir ma jiro weli.',
      'photo.proof': 'Sawirka keenista',
      'photo.ref': 'Sawirka alaabta',
      'chat.ph': 'U qor darawalka ama maamulaha…',
      'chat.send': 'Dir',
      'resume.title': 'Dalabyadaada',
      'resume.none': 'Dalab ma jiro weli.',

      'st.PENDING_PAYMENT': 'Lacag ayaa la sugayaa',
      'st.PAID_UNASSIGNED': 'Lacagta waa la bixiyay',
      'st.DISPATCHED': 'Darawalku alaabta ayuu soo qaadayaa',
      'st.IN_TRANSIT': 'Waa kuu soo socdaa',
      'st.DELIVERED': 'Waa la keenay',
      'st.FAILED_REFUND': 'Waa la joojiyay',

      'faq.title': "Su'aalo",
      'faq.what.q': 'Waa maxay GuriKaabe?',
      'faq.what.a': 'Wax ka dalbo suuqa, darawal ayaa kuu keenaya. Lacagta waxaad ka bixinaysaa taleefankaaga.',
      'faq.pay.q': 'Sideen u bixiyaa?',
      'faq.pay.a': 'Marka aad dalbato, riix <strong>Hadda bixi</strong>. Koodhka EVC Plus / eDahab ayaa kuu diyaar ah. Marka aad bixiso, riix <strong>Waan bixiyay</strong>. Lacagta waan hubinaynaa, dalabkuna wuu is beddeli doonaa.',
      'faq.privacy.q': 'Lambarkaygu ma ammaan yahay?',
      'faq.privacy.a': 'Waxaan u isticmaalnaa dalabyadaada iyo galitaanka oo kaliya. Ma iibinno, cidna ma siinno. Shirkad fariimaha dirta ayaa kuu soo gudbisa koodhka.',
      'faq.landmark.q': 'Maxaad u rabtaan meel kuu dhow?',
      'faq.landmark.a': 'Darawalku wuxuu kugu helaa meel la yaqaan oo kuu dhow. Sawirna wuu caawiyaa.',
      'faq.track.q': 'Sideen u arkaa dalabkayga?',
      'faq.track.a': 'Xaaladda iyo fariimuhu way is beddelaan markasta. Marka la keeno, sawir ayaad arki doontaa.',

      'sync.failed': '{n} ma dirmin',
      'sync.pending': '{n} ayaa sugaya',

      'phone.enter': 'Qor lambarkaaga',
      'phone.country': 'Dalka',
      'phone.tryUs': 'Lambar Maraykan? Riix 🇺🇸 +1',
      'phone.more': '{n} lambar ayaa haray',
      'phone.badPrefix': 'Lambarku waa khalad (Maraykan: +1)',
      'phone.tooLong': 'Lambarku waa dheer yahay',
      'phone.badUs': 'Lambar Maraykan oo sax ah maaha',
      'phone.payOperator': 'lacagta sii maamulaha',

      'drv.setup.prompt': 'Darawal cusub?',
      'drv.setup.link': 'Samee akoonka →',
      'drv.setup.title': 'Samee akoonkaaga',
      'drv.setup.intro': 'Qor koodhka 8-da lambar ee laguu soo diray, kadib dooro PIN 6 lambar ah.',
      'drv.setup.code': 'Koodhka',
      'drv.setup.pin': 'PIN cusub (6 lambar)',
      'drv.setup.pin2': 'Mar kale qor PIN-ka',
      'drv.setup.btn': 'Kaydi PIN-ka oo gal',
      'drv.setup.ok': 'PIN-ka waa la kaydiyay. Soo dhawoow ✓',
      'drv.setup.err.code': 'Qor lambarkaaga iyo koodhka 8-da lambar.',
      'drv.setup.err.match': 'Labada PIN isku mid maaha.',
      'err.setupCode': 'Koodhku waa khalad ama wuu dhacay. Xafiiska ka codso mid cusub.',
      'err.pinShape': 'PIN-ku waa inuu noqdaa 6 lambar.',
      'err.pinWeak': 'PIN-kaas waa sahlan yahay. Dooro mid kale.',
      'drv.title': 'Darawal',
      'drv.logout': 'Ka bax',
      'drv.pin': 'PIN',
      'drv.login': 'Gal',
      'drv.orders': 'Dalabyadayda',
      'drv.refresh': 'Eeg mar kale',
      'drv.none': 'Dalab laguuma dirin weli.',
      'drv.signedIn': 'Waad gashay. Dooro dalab.',
      'drv.items': 'Waxa la iibinayo',
      'drv.noItems': 'Liis ma jiro.',
      'drv.budget': 'Macmiilku wuxuu bixiyay: $',
      'drv.delivery': 'Keenista',
      'drv.landmark': 'Meesha:',
      'drv.noLandmark': '(lama qorin)',
      'drv.map': 'Fur khariidadda',
      'drv.call': 'Wac macmiilka',
      'drv.adjust': 'Alaab ama qiime is beddelay',
      'drv.adjust.ph': 'tusaale: Sonkor ma jirto, mid kale ayaan qaaday. Saliid +$0.50.',
      'drv.adjust.btn': 'U dir macmiilka',
      'drv.adjust.err': 'Qor waxa is beddelay.',
      'drv.adjust.ok': 'Waa loo diray macmiilka ✓',
      'drv.proof.btn': 'Dir sawirka keenista',
      'drv.proof.choose': 'Marka hore dooro sawir.',
      'drv.proof.ok': 'Sawirka waa la diray ✓',
      'drv.proof.fail': 'Sawirka ma dirmin.',
      'drv.actions': 'Talaabooyin',
      'drv.act.secured': 'Alaabta waan qaaday — macmiilka ayaan u socdaa',
      'drv.act.delivered': 'Waan keenay',
      'drv.act.failed': 'Dhibaato ayaa jirta',
      'drv.act.none': 'Wax la sameeyo ma jiro.',
      'drv.saved': 'Waa la kaydiyay — wuu diri doonaa marka internet yimaado.',
      'drv.updated': 'Waa la beddelay ✓',
      'drv.waiting': '(wuu sugayaa)',
      'drv.st.PAID_UNASSIGNED': 'Lacagta waa la bixiyay',
      'drv.st.DISPATCHED': 'Suuqa aad',
      'drv.st.IN_TRANSIT': 'Keenaya',
      'drv.st.DELIVERED': 'Waa la keenay',
      'drv.st.FAILED_REFUND': 'Waa la joojiyay',
    },
  };

  // The server answers in English. Map the messages a customer or driver can actually see to
  // keys; anything unrecognised falls back to a generic line rather than half-English UI.
  var SERVER_ERRORS = [
    [/^invalid or expired setup code/, 'err.setupCode'],
    [/^PIN must be exactly/, 'err.pinShape'],
    [/^PIN is too easy/, 'err.pinWeak'],
    [/^invalid or expired code/, 'err.badCode'],
    [/^could not send code/, 'err.send'],
    [/^a code was just sent/, 'err.cooldown'],
    [/^too many/, 'err.tooMany'],
    [/^invalid credentials/, 'err.login'],
    [/^Invalid phone number/, 'err.phone'],
    [/^this order is already paid/, 'err.alreadyPaid'],
    [/^that does not look like a transaction reference/, 'err.badRef'],
    [/^No connection/, 'net.offline'],
  ];

  function saved() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  // Saved choice wins; otherwise follow the handset. Many Somali phones run in English, so
  // the toggle sits in the header where anyone can find it.
  var lang = saved() || ((navigator.language || '').toLowerCase().indexOf('so') === 0 ? 'so' : 'en');
  if (!STR[lang]) lang = 'en';

  function t(key, vars) {
    var s = STR[lang][key];
    if (s == null) s = STR.en[key];
    if (s == null) return key;
    if (vars) {
      Object.keys(vars).forEach(function (k) { s = s.split('{' + k + '}').join(String(vars[k])); });
    }
    return s;
  }

  function err(message) {
    var m = String(message || '');
    for (var i = 0; i < SERVER_ERRORS.length; i++) {
      if (SERVER_ERRORS[i][0].test(m)) return t(SERVER_ERRORS[i][1]);
    }
    return lang === 'en' && m ? m : t('err.generic');
  }

  function apply(root) {
    root = root || document;
    document.documentElement.lang = lang;
    root.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
    root.querySelectorAll('[data-i18n-html]').forEach(function (el) { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
    root.querySelectorAll('[data-i18n-ph]').forEach(function (el) { el.placeholder = t(el.getAttribute('data-i18n-ph')); });
    var b = document.getElementById('langToggle');
    if (b) {
      // Show the language you'd switch TO, in that language — someone who can't read the
      // current one can still find their own.
      b.textContent = lang === 'en' ? 'SO' : 'EN';
      b.setAttribute('aria-label', t('lang.switch'));
      b.title = t('lang.switch');
    }
  }

  function set(next) {
    if (!STR[next] || next === lang) return;
    lang = next;
    try { localStorage.setItem(KEY, next); } catch (e) { /* private mode */ }
    apply(document);
    document.dispatchEvent(new CustomEvent('gm:lang', { detail: { lang: lang } }));
  }

  global.GMI18n = { t: t, err: err, apply: apply, set: set, lang: function () { return lang; } };

  apply(document);
  var btn = document.getElementById('langToggle');
  if (btn) btn.addEventListener('click', function () { set(lang === 'en' ? 'so' : 'en'); });
})(window);
