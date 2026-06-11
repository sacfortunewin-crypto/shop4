const {
  buildTransactionPayload,
  errorMessage,
  hasTrackingValues,
  notifyUtmify,
  orderFromTransaction,
  pagouApiRequest,
  readJson,
  rememberOrderSnapshot,
  requireMethod,
  sendJson,
  trackingDiagnostics,
  trackingSummary,
} = require("./_lib/pagou");

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

function pagouErrorDetails(body) {
  if (!body || typeof body !== "object") return null;
  return body.errors || body.data || body.details || null;
}

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, "POST")) return;

  let input;
  try {
    input = await readJson(req);
  } catch {
    sendJson(res, 400, { message: "JSON invalido." });
    return;
  }

  console.log("[checkout:transaction-received]", {
    method: input && input.method ? input.method : "pix",
    requestedAmountCents: input && input.amountCents ? Number(input.amountCents) : null,
    productId: input && input.productId ? String(input.productId) : null,
    shippingSelected: input && input.amountCents ? Number(input.amountCents) > 8990 : null,
    hasCustomer: Boolean(input && input.customer),
    hasAddress: Boolean(input && input.address),
    customerPresence: {
      name: Boolean(input && input.customer && input.customer.name),
      email: Boolean(input && input.customer && input.customer.email),
      phone: Boolean(input && input.customer && input.customer.phone),
      cpf: Boolean(input && input.customer && input.customer.cpf),
    },
    addressPresence: {
      cep: Boolean(input && input.address && input.address.cep),
      city: Boolean(input && input.address && input.address.city),
      state: Boolean(input && input.address && input.address.state),
    },
    trackingDiagnostics: trackingDiagnostics(input && input.tracking, req),
  });

  const payload = buildTransactionPayload(input, req, res);
  if (!payload) return;

  console.log("[checkout:pagou-request]", {
    method: payload.method || null,
    externalRef: payload.external_ref || null,
    amount: payload.amount || null,
    currency: payload.currency || null,
    notifyUrlConfigured: Boolean(payload.notify_url),
    notifyTrackingTokenConfigured: Boolean(payload.notify_url && /[?&]t=/.test(payload.notify_url)),
    tokenPresent: Boolean(payload.token),
    installments: payload.installments || null,
    metadataPresent: Boolean(payload.metadata),
  });

  const response = await pagouApiRequest("POST", "/v2/transactions", payload);
  const body = response.body || {};

  if (response.status < 200 || response.status >= 300) {
    const message = errorMessage(body);
    console.log("[checkout:pagou-error]", {
      method: payload.method || null,
      pagouStatus: response.status,
      requestId: body.requestId || null,
      message,
      details: pagouErrorDetails(body),
    });

    sendJson(res, response.status > 0 ? response.status : 502, {
      message,
      pagouStatus: response.status,
      requestId: body.requestId || null,
      pagouError: pagouErrorDetails(body),
    });
    return;
  }

  const data = body.data && typeof body.data === "object" ? body.data : body;
  const transactionId = data.id || body.transactionId || null;
  console.log("[checkout:pagou-response]", {
    pagouHttpStatus: response.status,
    requestId: body.requestId || null,
    transactionId,
    externalRef: data.external_ref || payload.external_ref || null,
    method: data.method || payload.method || null,
    pagouStatus: data.status || null,
    amount: data.amount || payload.amount || null,
    metadataReturned: Boolean(data.metadata),
    pixReturned: Boolean(data.pix),
    nextActionReturned: Boolean(data.next_action),
  });

  const transaction = {
    ...data,
    id: transactionId || data.id,
    external_ref: data.external_ref || payload.external_ref,
    method: data.method || payload.method,
    amount: data.amount || payload.amount,
    currency: data.currency || payload.currency || "BRL",
    status: data.status || "pending",
    metadata: data.metadata || payload.metadata,
  };
  const order = orderFromTransaction(transaction, req);
  rememberOrderSnapshot(order);
  const tracking = order.tracking || {};
  console.log("[checkout:order-built]", {
    transactionId,
    externalRef: order.externalRef || null,
    method: order.method || null,
    amountCents: order.amountCents || null,
    trackingFound: hasTrackingValues(tracking),
    tracking: trackingSummary(tracking),
    customerPresence: {
      name: Boolean(order.customer && order.customer.name),
      email: Boolean(order.customer && order.customer.email),
      phone: Boolean(order.customer && order.customer.phone),
      document: Boolean(order.customer && order.customer.document),
      ip: Boolean(order.customer && order.customer.ip),
    },
  });

  const utmify = await notifyUtmify(order, transaction);
  console.log("[checkout:utmify-pending]", {
    transactionId,
    externalRef: transaction.external_ref || null,
    method: transaction.method || null,
    pagouStatus: transaction.status || null,
    amount: transaction.amount || null,
    trackingFound: hasTrackingValues(tracking),
    tracking: trackingSummary(tracking),
    utmifySent: Boolean(utmify && utmify.sent),
    utmifyStatus: utmify ? utmify.status : null,
    utmifyMessage: utmifyLogMessage(utmify),
  });

  if (payload.method === "pix") {
    const pix = data.pix && typeof data.pix === "object" ? data.pix : {};

    sendJson(res, 200, {
      transactionId,
      externalRef: transaction.external_ref || null,
      status: data.status || null,
      method: data.method || "pix",
      amount: data.amount || payload.amount,
      currency: data.currency || "BRL",
      requestId: body.requestId || null,
      utmify,
      pix: {
        qrCode: pix.qr_code || body.pixQrCode || null,
        qrCodeImage: pix.qr_code_image || body.pixQrCodeImage || null,
        expirationDate: pix.expiration_date || null,
        receiptUrl: pix.receipt_url || null,
      },
    });
    return;
  }

  sendJson(res, 200, {
    success: true,
    data,
    ...data,
    transactionId,
    externalRef: transaction.external_ref || null,
    requestId: body.requestId || null,
    utmify,
    transaction: data,
  });
};
