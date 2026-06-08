const {
  buildTransactionPayload,
  errorMessage,
  notifyUtmify,
  orderFromTransaction,
  pagouApiRequest,
  readJson,
  requireMethod,
  sendJson,
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

  const payload = buildTransactionPayload(input, req, res);
  if (!payload) return;

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
  const utmify = await notifyUtmify(orderFromTransaction(transaction, req), transaction);
  console.log("[checkout:utmify-pending]", {
    transactionId,
    externalRef: transaction.external_ref || null,
    method: transaction.method || null,
    pagouStatus: transaction.status || null,
    amount: transaction.amount || null,
    utmifySent: Boolean(utmify && utmify.sent),
    utmifyStatus: utmify ? utmify.status : null,
    utmifyMessage: utmifyLogMessage(utmify),
  });

  if (payload.method === "pix") {
    const pix = data.pix && typeof data.pix === "object" ? data.pix : {};

    sendJson(res, 200, {
      transactionId,
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
    requestId: body.requestId || null,
    utmify,
    transaction: data,
  });
};
