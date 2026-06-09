(function () {
  "use strict";

  var STORAGE_KEY = "shop4_pending_payment";
  var APPROVED_STATUSES = new Set(["paid", "captured"]);
  var CLOSED_STATUSES = new Set([
    "canceled", "cancelled", "expired", "failed", "refused", "refunded", "chargedback"
  ]);
  var pollTimer = null;
  var isRedirecting = false;
  var originalFetch = window.fetch.bind(window);

  function transactionData(payload) {
    if (!payload || typeof payload !== "object") return {};
    if (payload.transaction && typeof payload.transaction === "object") return payload.transaction;
    if (payload.data && typeof payload.data === "object") return payload.data;
    return payload;
  }

  function normalizedPayment(payload, requestData) {
    var transaction = transactionData(payload);
    return {
      transactionId: String(payload.transactionId || transaction.id || transaction.transactionId || ""),
      status: String(payload.status || transaction.status || "").toLowerCase(),
      method: String(payload.method || transaction.method || (requestData && requestData.method) || "").toLowerCase(),
      amount: Number(payload.amount || transaction.amount || (requestData && requestData.amountCents) || 0),
      createdAt: Date.now()
    };
  }

  function remember(payment) {
    if (!payment.transactionId) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payment)); } catch (_) {}
  }

  function forget() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }

  function readRemembered() {
    try {
      var payment = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!payment || !payment.transactionId) return null;
      if (Date.now() - Number(payment.createdAt || 0) > 2 * 60 * 60 * 1000) {
        forget();
        return null;
      }
      return payment;
    } catch (_) {
      return null;
    }
  }

  function redirectToThanks(payment) {
    if (isRedirecting) return;
    isRedirecting = true;
    forget();

    var params = new URLSearchParams(window.location.search);
    params.set("pedido", payment.transactionId);
    if (payment.method) params.set("metodo", payment.method);
    if (payment.amount) params.set("valor", String(payment.amount));
    window.location.assign("/obrigado/?" + params.toString());
  }

  async function checkStatus(payment) {
    try {
      var response = await originalFetch(
        "/checkout/api/status.php?transactionId=" + encodeURIComponent(payment.transactionId),
        { headers: { Accept: "application/json" }, cache: "no-store" }
      );
      if (!response.ok) return;

      var current = normalizedPayment(await response.json(), payment);
      current.method = current.method || payment.method;
      current.amount = current.amount || payment.amount;

      if (APPROVED_STATUSES.has(current.status)) {
        redirectToThanks(current);
      } else if (CLOSED_STATUSES.has(current.status)) {
        forget();
        if (pollTimer) window.clearInterval(pollTimer);
      }
    } catch (_) {
      // A temporary reconciliation failure must not block checkout.
    }
  }

  function startPolling(payment) {
    if (!payment || !payment.transactionId || pollTimer) return;
    remember(payment);
    checkStatus(payment);
    pollTimer = window.setInterval(function () { checkStatus(payment); }, 4000);
  }

  function inspectTransactionResponse(response, requestData) {
    if (!response.ok) return;
    response.clone().json().then(function (payload) {
      var payment = normalizedPayment(payload, requestData);
      if (!payment.transactionId) return;

      if (APPROVED_STATUSES.has(payment.status)) {
        redirectToThanks(payment);
      } else if (payment.method === "pix") {
        startPolling(payment);
      }
    }).catch(function () {});
  }

  window.fetch = function (input, init) {
    var requestUrl = typeof input === "string" ? input : input && input.url;
    var responsePromise = originalFetch(input, init);

    if (requestUrl && /(?:^|\/)api\/transaction\.php(?:\?|$)/.test(requestUrl)) {
      var requestData = {};
      try { requestData = JSON.parse((init && init.body) || "{}"); } catch (_) {}
      responsePromise.then(function (response) { inspectTransactionResponse(response, requestData); });
    }

    return responsePromise;
  };

  var remembered = readRemembered();
  if (remembered) startPolling(remembered);
})();
