const {
  env,
  hasSeenEvent,
  markEventSeen,
  normalizeTransactionFromWebhook,
  notifyUtmify,
  orderFromTransaction,
  readJson,
  requireMethod,
  sendJson,
} = require("./_lib/pagou");

const NOTIFIABLE_EVENTS = new Set([
  "transaction.paid",
  "transaction.refunded",
  "transaction.partially_refunded",
  "transaction.chargedback",
  "transaction.cancelled",
]);

const NOTIFIABLE_STATUSES = new Set([
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
  if (!requireMethod(req, res, "POST")) return;

  const configuredSecret = env("PAGOU_WEBHOOK_SECRET");
  const url = new URL(req.url || "/api/webhook", "https://checkout.local");
  const providedSecret =
    url.searchParams.get("secret") ||
    req.headers["x-pagou-webhook-secret"] ||
    req.headers["x-webhook-secret"] ||
    "";

  if (configuredSecret && providedSecret !== configuredSecret) {
    console.log("[checkout:webhook-auth-failed]", {
      hasConfiguredSecret: true,
      hasProvidedSecret: Boolean(providedSecret),
      path: req.url || null,
    });
    sendJson(res, 401, { received: false, message: "Webhook nao autorizado." });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { received: false, message: "JSON invalido." });
    return;
  }

  const transaction = normalizeTransactionFromWebhook(body);
  const eventType = transaction.event_type || "";
  const eventId =
    body.id ||
    body.event_id ||
    transaction.event_id ||
    `${eventType}:${transaction.id || transaction.external_ref || ""}:${transaction.status || ""}`;

  console.log("[checkout:webhook-received]", {
    eventId,
    eventType,
    transactionId: transaction.id || null,
    externalRef: transaction.external_ref || transaction.externalRef || transaction.correlation_id || null,
    method: transaction.method || null,
    status: transaction.status || null,
    amount: transaction.amount || null,
  });

  if (hasSeenEvent(eventId)) {
    console.log("[checkout:webhook-duplicate]", { eventId, eventType });
    sendJson(res, 200, { received: true, duplicate: true, eventId });
    return;
  }

  let utmify = null;
  const status = String(transaction.status || "");
  if (NOTIFIABLE_EVENTS.has(eventType) || NOTIFIABLE_STATUSES.has(status)) {
    const order = orderFromTransaction(transaction, req);
    const tracking = order.tracking || {};
    utmify = await notifyUtmify(order, transaction);
    console.log("[checkout:utmify-webhook]", {
      eventId,
      eventType,
      transactionId: order.transactionId || null,
      orderId: order.externalRef || order.transactionId || null,
      method: order.method || null,
      pagouStatus: transaction.status || null,
      amount: transaction.amount || order.amountCents || null,
      tracking: {
        src: tracking.src || null,
        sck: tracking.sck ? "present" : null,
        utm_source: tracking.utm_source || null,
        utm_campaign: tracking.utm_campaign || null,
        utm_medium: tracking.utm_medium || null,
        utm_content: tracking.utm_content || null,
        utm_term: tracking.utm_term || null,
      },
      utmifySent: Boolean(utmify && utmify.sent),
      utmifyStatus: utmify ? utmify.status : null,
      utmifyMessage: utmifyLogMessage(utmify),
    });

    if (!utmify.sent) {
      sendJson(res, 502, {
        received: false,
        message: "Falha ao notificar UTMify.",
        utmify,
      });
      return;
    }
  } else {
    console.log("[checkout:webhook-ignored]", { eventId, eventType, status });
  }

  markEventSeen(eventId);
  sendJson(res, 200, { received: true, eventId, eventType, utmify });
};
