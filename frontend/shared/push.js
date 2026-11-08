// Turning push notifications on and off on this device. Classic script; window.GMPush.
//
// Browsers (and installed PWAs): standard Web Push, with the server's public VAPID key, through
// the service worker each app already registers. The Android app (Capacitor): FCM through the
// PushNotifications plugin — only when the build was made with Firebase (GM_FCM) AND the server
// can send it, because registering without Firebase configured crashes the app.
//
// Never asked on page load: the browser's permission prompt appears only after the person taps
// "Turn on" (a prompt out of nowhere is what people deny, and a denial can't be asked again).
(function (global) {
  var cfgPromise = null;
  function cfg() {
    if (!cfgPromise) {
      cfgPromise = fetch(global.GMConfig.api('/push/config')).then(function (r) { return r.json(); })
        .catch(function () { return { webPush: null, fcm: false }; });
    }
    return cfgPromise;
  }
  function nativePlugin() {
    var C = global.Capacitor;
    return C && C.isNativePlatform && C.isNativePlatform() && C.Plugins && C.Plugins.PushNotifications;
  }
  function lang() { return (global.GMI18n && global.GMI18n.lang()) || 'en'; }

  // The registration if there is one, at once. NOT serviceWorker.ready: that never settles when
  // no worker is registered (first visit, the native app), and sign-out awaits this.
  function registration() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    return navigator.serviceWorker.getRegistration().then(function (r) { return r || null; }, function () { return null; });
  }

  function urlBase64ToUint8Array(s) {
    var pad = '='.repeat((4 - (s.length % 4)) % 4);
    var raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  // 'on' | 'off' | 'denied' | 'unsupported' | 'unavailable' (server not set up)
  function state() {
    return cfg().then(function (c) {
      if (nativePlugin()) {
        if (!(c.fcm && global.GM_FCM)) return 'unavailable';
        return nativePlugin().checkPermissions().then(function (p) {
          if (p.receive === 'denied') return 'denied';
          return localStorage.getItem('gm_push_token') ? 'on' : 'off';
        });
      }
      if (!('serviceWorker' in navigator) || !('PushManager' in global) || !('Notification' in global)) return 'unsupported';
      if (!c.webPush) return 'unavailable';
      if (Notification.permission === 'denied') return 'denied';
      return registration().then(function (reg) { return reg ? reg.pushManager.getSubscription() : null; })
        .then(function (s) { return s && Notification.permission === 'granted' ? 'on' : 'off'; });
    });
  }

  // `api(path, opts)` is the app's own authenticated fetch helper.
  function enable(api) {
    return cfg().then(function (c) {
      var plugin = nativePlugin();
      if (plugin) {
        if (!(c.fcm && global.GM_FCM)) throw new Error('unavailable');
        return plugin.requestPermissions().then(function (p) {
          if (p.receive !== 'granted') throw new Error('denied');
          return new Promise(function (resolve, reject) {
            plugin.addListener('registration', function (t) {
              localStorage.setItem('gm_push_token', t.value);
              api('/push/subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t.value, lang: lang() }) })
                .then(function (r) { if (r.error) reject(new Error(r.error)); else resolve('on'); });
            });
            plugin.addListener('registrationError', function () { reject(new Error('unavailable')); });
            plugin.register();
          });
        });
      }
      if (!c.webPush) throw new Error('unavailable');
      return Notification.requestPermission().then(function (perm) {
        if (perm !== 'granted') throw new Error('denied');
        return navigator.serviceWorker.ready;
      }).then(function (reg) {
        return reg.pushManager.getSubscription().then(function (old) {
          return old || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(c.webPush) });
        });
      }).then(function (sub) {
        return api('/push/subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON(), lang: lang() }) });
      }).then(function (r) { if (r.error) throw new Error(r.error); return 'on'; });
    });
  }

  // Turn off on this device (and on sign-out: the next person must not get this one's alerts).
  function disable(api) {
    var plugin = nativePlugin();
    if (plugin) {
      var token = localStorage.getItem('gm_push_token');
      localStorage.removeItem('gm_push_token');
      if (!token) return Promise.resolve('off');
      return api('/push/subscriptions', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: token }) })
        .then(function () { return plugin.unregister ? plugin.unregister() : null; }).then(function () { return 'off'; }, function () { return 'off'; });
    }
    return registration().then(function (reg) { return reg ? reg.pushManager.getSubscription() : null; })
      .then(function (sub) {
        if (!sub) return 'off';
        return api('/push/subscriptions', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) })
          .then(function () { return sub.unsubscribe(); }).then(function () { return 'off'; });
      }).catch(function () { return 'off'; });
  }

  // The app was opened by tapping a notification on Android: go where it points.
  function onNativeTap(handler) {
    var plugin = nativePlugin();
    if (!plugin) return;
    plugin.addListener('pushNotificationActionPerformed', function (a) {
      var url = a && a.notification && a.notification.data && a.notification.data.url;
      if (url) handler(url);
    });
  }

  global.GMPush = { state: state, enable: enable, disable: disable, onNativeTap: onNativeTap };
})(window);
