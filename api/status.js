const {
  errorMessage,
  hasSeenEvent,
  hasTrackingValues,
  markEventSeen,
  mergeOrderWithSnapshot,
  mergeTracking,
  notifyUtmify,
  orderFromTransaction,
  orderSnapshotFromTransaction,
  pagouApiRequest,
  requireMethod,
  sendJson,
  trackingFromRequest,
  trackingSummary,
} = require("./_lib/pagou");

const FINAL_STATUSES = new Set([
  "paid",
  "captured",
  "authorized",
  "refunded",
  "partially_refunded",
  "chargedback",
  "canceled",
  "cancelled",
  "expired",
  "refused",
]);

function utmifyLogMessage(utmify) {
  if (!utmify || typeof utmify !== "object") return null;
  const body = utmify.body && typeof utmify.body === "object" ? utmify.body : {};
  const firstError = Array.isArray(body.errors) ? body.errors[0] : null;

  return (
    body.message ||
    body.detail ||
    body.error ||
    body.title ||
    (firstError && (firstError.message || firstError.detail || firstError.error || String(firstError))) ||
    utmify.message ||
    null
  );
}

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, "GET")) return;

  const url = new URL(req.url || "/api/status", "https://checkout.local");
  const transactionId = String(url.searchParams.get("transactionId") || "").trim();
  const externalRef = String(url.searchParams.get("externalRef") || "").trim();

  if (!transactionId || transactionId.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(transactionId)) {
    sendJson(res, 400, { message: "Transacao invalida." });
    return;
  }

  if (externalRef && (externalRef.length > 120 || !/^[a-zA-Z0-9_-]+$/.test(externalRef))) {
    sendJson(res, 400, { message: "Pedido invalido." });
    return;
  }

  const response = await pagouApiRequest("GET", `/v2/transactions/${encodeURIComponent(transactionId)}`);
  const body = response.body || {};

  if (response.status < 200 || response.status >= 300) {
    sendJson(res, response.status > 0 ? response.status : 502, {
      message: errorMessage(body),
    });
    return;
  }

  const data = body.data && typeof body.data === "object" ? body.data : body;
  const transaction = {
    ...data,
    id: data.id || transactionId,
    external_ref:
      data.external_ref ||
      data.externalRef ||
      data.correlation_id ||
      data.correlationId ||
      externalRef ||
      "",
  };
  const status = String(transaction.status || "").toLowerCase();
  let utmify = null;

  if (FINAL_STATUSES.has(status)) {
    const eventKey = `status:${transaction.id || transactionId}:${status}`;

    if (!hasSeenEvent(eventKey)) {
      const snapshot = orderSnapshotFromTransaction(transaction);
      const requestTracking = trackingFromRequest(req);
      let order = mergeOrderWithSnapshot(orderFromTransaction(transaction, req), snapshot);
      order = {
        ...order,
        tracking: mergeTracking(order.tracking, requestTracking),
      };

      const trackingFound = hasTrackingValues(order.tracking);
      console.log("[checkout:status-utmify-start]", {
        transactionId: order.transactionId || transactionId,
        orderId: order.externalRef || order.transactionId || null,
        pagouStatus: status,
        method: order.method || transaction.method || null,
        amount: transaction.amount || order.amountCents || null,
        trackingFound,
        requestTrackingFound: hasTrackingValues(requestTracking),
        snapshotFound: Boolean(snapshot),
        externalRefFromQuery: Boolean(externalRef),
        externalRefReturned: Boolean(data.external_ref || data.externalRef || data.correlation_id || data.correlationId),
        metadataReturned: Boolean(data.metadata),
        tracking: trackingSummary(order.tracking),
      });

      if (trackingFound) {
        try {
          utmify = await notifyUtmify(order, transaction);
          console.log("[checkout:status-utmify]", {
            transactionId: order.transactionId || transactionId,
            orderId: order.externalRef || order.transactionId || null,
            pagouStatus: status,
            method: order.method || transaction.method || null,
            amount: transaction.amount || order.amountCents || null,
            trackingFound,
            utmifySent: Boolean(utmify && utmify.sent),
            utmifyStatus: utmify ? utmify.status : null,
            utmifyMessage: utmifyLogMessage(utmify),
          });
          if (utmify && utmify.sent) markEventSeen(eventKey);
        } catch (error) {
          console.log("[checkout:status-utmify-error]", {
            transactionId: order.transactionId || transactionId,
            orderId: order.externalRef || order.transactionId || null,
            pagouStatus: status,
            message: error && error.message ? error.message : "Falha ao notificar UTMify pelo status.",
          });
        }
      } else {
        console.log("[checkout:status-utmify-missing-tracking]", {
          transactionId: order.transactionId || transactionId,
          orderId: order.externalRef || order.transactionId || null,
          pagouStatus: status,
          requestTrackingFound: hasTrackingValues(requestTracking),
          snapshotFound: Boolean(snapshot),
          externalRefFromQuery: Boolean(externalRef),
          metadataReturned: Boolean(data.metadata),
        });
      }
    }
  }

  sendJson(res, 200, {
    transactionId: transaction.id || transactionId,
    externalRef: transaction.external_ref || null,
    status: transaction.status || null,
    method: transaction.method || null,
    amount: transaction.amount || null,
    currency: transaction.currency || "BRL",
    utmify,
  });
};
