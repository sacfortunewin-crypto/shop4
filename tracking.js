(function () {
  "use strict";

  var STORAGE_KEY = "utmify_tracking";
  var TRACKING_KEYS = [
    "src", "sck", "xcod", "utm_source", "utm_campaign", "utm_medium",
    "utm_content", "utm_term"
  ];

  function readStored(storage) {
    try { return JSON.parse(storage.getItem(STORAGE_KEY) || "{}"); } catch (_) { return {}; }
  }

  function store(data) {
    try { window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (_) {}
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (_) {}
    try {
      var secure = window.location.protocol === "https:" ? "; Secure" : "";
      document.cookie = STORAGE_KEY + "=" + encodeURIComponent(JSON.stringify(data)) + "; Max-Age=2592000; Path=/; SameSite=Lax" + secure;
    } catch (_) {}
  }

  function clean(key, value) {
    if (!value) return "";
    var result = String(value).split("::")[0].trim();
    if (key === "utm_source") result = result.replace(/jLj[0-9a-z_-]{12,}$/i, "").trim();
    return result;
  }

  function collect() {
    var params = new URLSearchParams(window.location.search);
    var data = Object.assign({}, readStored(window.localStorage), readStored(window.sessionStorage));

    TRACKING_KEYS.forEach(function (key) {
      var value = clean(key, params.get(key));
      if (value) data[key] = value;
    });

    if (!data.sck && data.xcod) data.sck = data.xcod;

    store(data);
    return data;
  }

  function hasTracking(data) {
    return TRACKING_KEYS.some(function (key) { return !!data[key]; });
  }

  function sendClientLog(stage, tracking) {
    try {
      var storedLocal = readStored(window.localStorage);
      var storedSession = readStored(window.sessionStorage);
      var payload = {
        stage: stage,
        pathname: window.location.pathname,
        hasSearch: !!window.location.search,
        tracking: tracking || {},
        storage: {
          localFound: hasTracking(storedLocal),
          sessionFound: hasTracking(storedSession),
          cookieFound: document.cookie.indexOf(STORAGE_KEY + "=") !== -1
        },
        referrer: document.referrer || null
      };
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/checkout/api/client-log.php", new Blob([body], { type: "application/json" }));
        return;
      }
      fetch("/checkout/api/client-log.php", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: body,
        keepalive: true
      }).catch(function () {});
    } catch (_) {}
  }

  function decorateLinks() {
    var tracking = collect();
    document.querySelectorAll('a[href]').forEach(function (link) {
      var raw = link.getAttribute("href");
      if (!raw || raw.charAt(0) === "#" || /^(mailto:|tel:|javascript:)/i.test(raw)) return;

      var url;
      try { url = new URL(raw, window.location.href); } catch (_) { return; }
      if (url.origin !== window.location.origin) return;
      if (!/(?:^|\/)(?:checkout|obrigado)(?:\/|$)/.test(url.pathname)) return;

      TRACKING_KEYS.forEach(function (key) {
        if (tracking[key] && !url.searchParams.has(key)) url.searchParams.set(key, tracking[key]);
      });
      link.href = url.pathname + url.search + url.hash;
    });
  }

  window.collectCheckoutTracking = collect;
  window.shop2CollectTracking = collect;
  sendClientLog("initial", collect());
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", decorateLinks);
  else decorateLinks();
  window.setTimeout(function () { sendClientLog("delayed", collect()); }, 1500);
})();
