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

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, "POST")) return;

  const configuredSecret = env("PAGOU_WEBHOOK_SECRET", env("UTMIFY_WEBHOOK_SECRET"));
  const url = new URL(req.url || "/api/webhook", "https://checkout.local");
  const providedSecret =
    url.searchParams.get("secret") ||
    req.headers["x-pagou-webhook-secret"] ||
    req.headers["x-webhook-secret"] ||
    "";

  if (configuredSecret && providedSecret !== configuredSecret) {
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

  if (hasSeenEvent(eventId)) {
    sendJson(res, 200, { received: true, duplicate: true, eventId });
    return;
  }

  let utmify = null;
  const status = String(transaction.status || "");
  if (NOTIFIABLE_EVENTS.has(eventType) || NOTIFIABLE_STATUSES.has(status)) {
    const order = orderFromTransaction(transaction, req);
    utmify = await notifyUtmify(order, transaction);

    if (!utmify.sent) {
      sendJson(res, 502, {
        received: false,
        message: "Falha ao notificar UTMify.",
        utmify,
      });
      return;
    }
  }

  markEventSeen(eventId);
  sendJson(res, 200, { received: true, eventId, eventType, utmify });
};
