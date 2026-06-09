const { errorMessage, pagouApiRequest, requireMethod, sendJson } = require("./_lib/pagou");

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, "GET")) return;

  const url = new URL(req.url || "/api/status", "https://checkout.local");
  const transactionId = String(url.searchParams.get("transactionId") || "").trim();

  if (!transactionId || transactionId.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(transactionId)) {
    sendJson(res, 400, { message: "Transacao invalida." });
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
  sendJson(res, 200, {
    transactionId: data.id || transactionId,
    status: data.status || null,
    method: data.method || null,
    amount: data.amount || null,
    currency: data.currency || "BRL",
  });
};
