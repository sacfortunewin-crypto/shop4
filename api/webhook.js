const {
  env,
  hasSeenEvent,
  hasTrackingValues,
  markEventSeen,
  mergeOrderWithSnapshot,
  mergeTracking,
  normalizeTransactionFromWebhook,
  notifyUtmify,
  orderFromTransaction,
  orderSnapshotFromTransaction,
  pagouApiRequest,
  readJson,
  rememberOrderSnapshot,
  requireMethod,
  sendJson,
  trackingFromWebhookUrl,
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

function trackingLog(tracking) {
  return {
    src: tracking.src || null,
    sck: tracking.sck ? "present" : null,
    utm_source: tracking.utm_source || null,
    utm_campaign: tracking.utm_campaign || null,
    utm_medium: tracking.utm_medium || null,
    utm_content: tracking.utm_content || null,
    utm_term: tracking.utm_term || null,
  };
}

function metadataValue(primary, fallback) {
  if (typeof primary === "string" && primary.trim()) return primary;
  if (primary && typeof primary === "object" && Object.keys(primary).length) return primary;
  return fallback;
}

async function enrichedTransaction(transaction) {
  if (!transaction || !transaction.id) return transaction;

  try {
    const response = await pagouApiRequest("GET", `/v2/transactions/${encodeURIComponent(transaction.id)}`);
    const body = response.body || {};
    if (response.status < 200 || response.status >= 300) {
      console.log("[checkout:webhook-enrich-failed]", {
        transactionId: transaction.id || null,
        pagouStatus: response.status,
      });
      return transaction;
    }

    const data = body.data && typeof body.data === "object" ? body.data : body;
    console.log("[checkout:webhook-enrich-success]", {
      transactionId: transaction.id || null,
      pagouHttpStatus: response.status,
      requestId: body.requestId || null,
      returnedStatus: data.status || null,
      returnedMethod: data.method || null,
      returnedAmount: data.amount || null,
      metadataReturned: Boolean(data.metadata),
      externalRefReturned: data.external_ref || data.externalRef || data.correlation_id || null,
      bodyKeys: data && typeof data === "object" ? Object.keys(data).slice(0, 16) : [],
    });

    return {
      ...transaction,
      ...data,
      id: data.id || transaction.id,
      external_ref:
        data.external_ref ||
        data.externalRef ||
        data.correlation_id ||
        transaction.external_ref ||
        transaction.externalRef ||
        transaction.correlation_id ||
        "",
      event_type: transaction.event_type || data.event_type || "",
      status: data.status || transaction.status,
      method: data.method || transaction.method,
      amount: data.amount || transaction.amount,
      metadata: metadataValue(data.metadata, transaction.metadata),
    };
  } catch (error) {
    console.log("[checkout:webhook-enrich-error]", {
      transactionId: transaction.id || null,
      message: error && error.message ? error.message : "Falha ao consultar Pagou.",
    });
    return transaction;
  }
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

  console.log("[checkout:webhook-auth-check]", {
    hasConfiguredSecret: Boolean(configuredSecret),
    hasProvidedSecret: Boolean(providedSecret),
    providedViaQuery: Boolean(url.searchParams.get("secret")),
    providedViaHeader: Boolean(req.headers["x-pagou-webhook-secret"] || req.headers["x-webhook-secret"]),
    path: url.pathname || null,
    trackingTokenPresent: Boolean(url.searchParams.get("t")),
  });

  if (configuredSecret && providedSecret !== configuredSecret) {
    console.log("[checkout:webhook-auth-failed]", {
      hasConfiguredSecret: true,
      hasProvidedSecret: Boolean(providedSecret),
      path: url.pathname || null,
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

  console.log("[checkout:webhook-body]", {
    topLevelKeys: body && typeof body === "object" ? Object.keys(body).slice(0, 16) : [],
    event: body && body.event ? body.event : null,
    eventType: body && body.event_type ? body.event_type : null,
    type: body && body.type ? body.type : null,
    hasData: Boolean(body && body.data),
    hasTransaction: Boolean(body && body.transaction),
    dataKeys:
      body && body.data && typeof body.data === "object"
        ? Object.keys(body.data.object && typeof body.data.object === "object" ? body.data.object : body.data).slice(0, 16)
        : [],
  });

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
    const snapshot = orderSnapshotFromTransaction(transaction);
    const webhookTracking = trackingFromWebhookUrl(req);
    let finalTransaction = transaction;
    let order = mergeOrderWithSnapshot(orderFromTransaction(finalTransaction, req), snapshot);
    order = {
      ...order,
      tracking: mergeTracking(order.tracking, webhookTracking),
    };

    console.log("[checkout:webhook-order-initial]", {
      eventId,
      eventType,
      transactionId: order.transactionId || transaction.id || null,
      orderId: order.externalRef || order.transactionId || null,
      method: order.method || null,
      pagouStatus: finalTransaction.status || transaction.status || null,
      amount: finalTransaction.amount || order.amountCents || null,
      trackingFound: hasTrackingValues(order.tracking),
      snapshotFound: Boolean(snapshot),
      webhookTrackingFound: hasTrackingValues(webhookTracking),
      tracking: trackingLog(order.tracking || {}),
    });

    if (!hasTrackingValues(order.tracking)) {
      finalTransaction = await enrichedTransaction(transaction);
      order = mergeOrderWithSnapshot(orderFromTransaction(finalTransaction, req), snapshot);
      order = {
        ...order,
        tracking: mergeTracking(order.tracking, webhookTracking),
      };

      console.log("[checkout:webhook-order-enriched]", {
        eventId,
        eventType,
        transactionId: order.transactionId || transaction.id || null,
        orderId: order.externalRef || order.transactionId || null,
        method: order.method || null,
        pagouStatus: finalTransaction.status || transaction.status || null,
        amount: finalTransaction.amount || order.amountCents || null,
        trackingFound: hasTrackingValues(order.tracking),
        snapshotFound: Boolean(snapshot),
        webhookTrackingFound: hasTrackingValues(webhookTracking),
        tracking: trackingLog(order.tracking || {}),
      });
    }

    const tracking = order.tracking || {};
    const trackingFound = hasTrackingValues(tracking);
    console.log("[checkout:utmify-webhook-start]", {
      eventId,
      eventType,
      transactionId: order.transactionId || transaction.id || null,
      orderId: order.externalRef || order.transactionId || null,
      method: order.method || null,
      pagouStatus: finalTransaction.status || transaction.status || null,
      amount: finalTransaction.amount || order.amountCents || null,
      trackingFound,
      snapshotFound: Boolean(snapshot),
      webhookTrackingFound: hasTrackingValues(webhookTracking),
      tracking: trackingLog(tracking),
    });

    if (!trackingFound && ["paid", "captured", "authorized"].includes(String(finalTransaction.status || ""))) {
      console.log("[checkout:utmify-webhook-missing-tracking]", {
        eventId,
        eventType,
        transactionId: order.transactionId || transaction.id || null,
        orderId: order.externalRef || order.transactionId || null,
        method: order.method || null,
        pagouStatus: finalTransaction.status || transaction.status || null,
        amount: finalTransaction.amount || order.amountCents || null,
      });
      markEventSeen(eventId);
      sendJson(res, 200, {
        received: true,
        eventId,
        eventType,
        skippedUtmify: true,
        reason: "missing_tracking",
      });
      return;
    }

    try {
      utmify = await notifyUtmify(order, finalTransaction);
    } catch (error) {
      console.log("[checkout:utmify-webhook-error]", {
        eventId,
        transactionId: order.transactionId || transaction.id || null,
        message: error && error.message ? error.message : "Falha ao notificar UTMify.",
      });
      sendJson(res, 502, {
        received: false,
        message: "Falha ao notificar UTMify.",
      });
      return;
    }

    console.log("[checkout:utmify-webhook]", {
      eventId,
      eventType,
      transactionId: order.transactionId || null,
      orderId: order.externalRef || order.transactionId || null,
      method: order.method || null,
      pagouStatus: finalTransaction.status || transaction.status || null,
      amount: finalTransaction.amount || order.amountCents || null,
      trackingFound,
      snapshotFound: Boolean(snapshot),
      tracking: trackingLog(tracking),
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

    rememberOrderSnapshot(order);
  } else {
    console.log("[checkout:webhook-ignored]", {
      eventId,
      eventType,
      status,
      transactionId: transaction.id || null,
      externalRef: transaction.external_ref || transaction.externalRef || transaction.correlation_id || null,
      method: transaction.method || null,
      amount: transaction.amount || null,
      reason: "non_final_status",
    });
  }

  markEventSeen(eventId);
  sendJson(res, 200, { received: true, eventId, eventType, utmify });
};
