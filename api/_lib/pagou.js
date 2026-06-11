const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CHECKOUT_PRODUCT_ID = "auxiliar-partida-compressor-portatil-emergencia-veicular";
const CHECKOUT_PRODUCT_NAME = "Auxiliar de Partida e Compressor Portátil: Solução de Emergência Veicular Completa";
const CHECKOUT_PRODUCT_PRICE_CENTS = 8990;
const CHECKOUT_EXPRESS_SHIPPING_CENTS = 1990;

const localEnv = (() => {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(process.cwd(), ".env.local"),
    path.join(process.cwd(), "checkout", "api", ".env"),
    path.join(process.cwd(), "tela1", "checkout", "api", ".env"),
  ];
  const values = {};

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;

      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (key && values[key] === undefined) values[key] = value;
    }
  }

  return values;
})();

const seenEvents = globalThis.__pagouSeenEvents || new Map();
globalThis.__pagouSeenEvents = seenEvents;
const orderSnapshots = globalThis.__pagouOrderSnapshots || new Map();
globalThis.__pagouOrderSnapshots = orderSnapshots;

function env(key, fallback = "") {
  return process.env[key] || localEnv[key] || fallback;
}

function checkoutEnvironment() {
  return env("PAGOU_ENVIRONMENT", "production").toLowerCase() === "sandbox"
    ? "sandbox"
    : "production";
}

function pagouBaseUrl() {
  const configured = env("PAGOU_BASE_URL").replace(/\/+$/, "");
  if (configured) return configured;
  return checkoutEnvironment() === "sandbox"
    ? "https://api-sandbox.pagou.ai"
    : "https://api.pagou.ai";
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function requireMethod(req, res, method) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return false;
  }

  if (req.method !== method) {
    sendJson(res, 405, { message: "Metodo nao permitido." });
    return false;
  }

  return true;
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.trim()) return JSON.parse(req.body);

  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function digits(value) {
  return String(value || "").replace(/\D+/g, "");
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  const realIp = req.headers["x-real-ip"] || req.headers["cf-connecting-ip"];
  if (typeof realIp === "string" && realIp.trim()) return realIp.trim();
  return null;
}

function hostFromRequest(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || env("VERCEL_URL");
  return Array.isArray(host) ? host[0] : String(host || "");
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function trackingToken(tracking) {
  const normalized = normalizeTracking(tracking || {});
  if (!hasTrackingValues(normalized)) return "";
  return base64UrlEncode(JSON.stringify(normalized));
}

function trackingFromToken(value) {
  if (!value) return normalizeTracking({});
  try {
    return normalizeTracking(JSON.parse(base64UrlDecode(value)));
  } catch {
    return normalizeTracking({});
  }
}

function appendTrackingToWebhookUrl(rawUrl, tracking) {
  const token = trackingToken(tracking);
  if (!rawUrl || !token) return rawUrl || "";

  try {
    const url = new URL(rawUrl);
    url.searchParams.set("t", token);
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function trackingFromWebhookUrl(req) {
  try {
    const url = new URL(req.url || "/api/webhook", "https://checkout.local");
    return trackingFromToken(url.searchParams.get("t"));
  } catch {
    return normalizeTracking({});
  }
}

function webhookUrl(req, tracking) {
  const configured = env("PAGOU_NOTIFY_URL");
  if (configured) return appendTrackingToWebhookUrl(configured, tracking);

  const host = hostFromRequest(req);
  if (!host || /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return "";

  const proto = req.headers["x-forwarded-proto"] || "https";
  const secret = env("PAGOU_WEBHOOK_SECRET");
  const suffix = secret ? `?secret=${encodeURIComponent(secret)}` : "";
  return appendTrackingToWebhookUrl(`${proto}://${host}/checkout/api/webhook.php${suffix}`, tracking);
}

function selectedAmountCents(input) {
  const requested = Number(input.amountCents || CHECKOUT_PRODUCT_PRICE_CENTS);
  const expressTotal = CHECKOUT_PRODUCT_PRICE_CENTS + CHECKOUT_EXPRESS_SHIPPING_CENTS;
  return requested === expressTotal ? expressTotal : CHECKOUT_PRODUCT_PRICE_CENTS;
}

function cleanTrackingText(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const clean = text.split("::")[0].trim();
  return clean || null;
}

function cleanUtmSource(value) {
  const text = cleanTrackingText(value);
  if (!text) return null;
  const clean = text.replace(/jLj[0-9a-z_-]{12,}$/i, "").trim();
  return clean || text;
}

function normalizeTracking(input) {
  const tracking = input && typeof input === "object" ? input : {};
  const sck = cleanTrackingText(tracking.sck || tracking.xcod || tracking.subid || tracking.sub_id);
  return {
    src: cleanTrackingText(tracking.src),
    sck,
    utm_source: cleanUtmSource(tracking.utm_source),
    utm_campaign: cleanTrackingText(tracking.utm_campaign),
    utm_medium: cleanTrackingText(tracking.utm_medium),
    utm_content: cleanTrackingText(tracking.utm_content),
    utm_term: cleanTrackingText(tracking.utm_term),
  };
}

function hasTrackingValues(tracking) {
  return Object.values(normalizeTracking(tracking || {})).some(Boolean);
}

function trackingSummary(tracking) {
  const normalized = normalizeTracking(tracking || {});
  return {
    src: normalized.src || null,
    sck: normalized.sck ? "present" : null,
    utm_source: normalized.utm_source || null,
    utm_campaign: normalized.utm_campaign || null,
    utm_medium: normalized.utm_medium || null,
    utm_content: normalized.utm_content || null,
    utm_term: normalized.utm_term || null,
  };
}

function mergeTracking(primary, fallback) {
  const current = normalizeTracking(primary || {});
  const saved = normalizeTracking(fallback || {});
  return {
    src: current.src || saved.src,
    sck: current.sck || saved.sck,
    utm_source: current.utm_source || saved.utm_source,
    utm_campaign: current.utm_campaign || saved.utm_campaign,
    utm_medium: current.utm_medium || saved.utm_medium,
    utm_content: current.utm_content || saved.utm_content,
    utm_term: current.utm_term || saved.utm_term,
  };
}

function parseCookieHeader(header) {
  const cookies = {};
  String(header || "")
    .split(";")
    .forEach((part) => {
      const index = part.indexOf("=");
      if (index === -1) return;
      const key = part.slice(0, index).trim();
      if (!key) return;
      cookies[key] = part.slice(index + 1).trim();
    });
  return cookies;
}

function trackingFromSearch(searchParams) {
  const input = {};
  for (const key of ["src", "sck", "xcod", "utm_source", "utm_campaign", "utm_medium", "utm_content", "utm_term"]) {
    const value = searchParams.get(key);
    if (value) input[key] = value;
  }
  return normalizeTracking(input);
}

function trackingFromCookie(req) {
  const cookies = parseCookieHeader(req.headers.cookie);
  const raw = cookies.utmify_tracking || cookies.checkout_tracking;
  if (!raw) return normalizeTracking({});

  try {
    return normalizeTracking(JSON.parse(decodeURIComponent(raw)));
  } catch {
    return normalizeTracking({});
  }
}

function trackingFromReferer(req) {
  const referer = req.headers.referer || req.headers.referrer;
  if (!referer) return normalizeTracking({});

  try {
    return trackingFromSearch(new URL(String(referer)).searchParams);
  } catch {
    return normalizeTracking({});
  }
}

function trackingFromRequest(req) {
  return mergeTracking(trackingFromCookie(req), trackingFromReferer(req));
}

function refererInfo(req) {
  const referer = req.headers.referer || req.headers.referrer;
  if (!referer) {
    return {
      present: false,
      origin: null,
      pathname: null,
      hasSearch: false,
      trackingFound: false,
      tracking: trackingSummary({}),
    };
  }

  try {
    const url = new URL(String(referer));
    const tracking = trackingFromSearch(url.searchParams);
    return {
      present: true,
      origin: url.origin || null,
      pathname: url.pathname || null,
      hasSearch: Boolean(url.search),
      trackingFound: hasTrackingValues(tracking),
      tracking: trackingSummary(tracking),
    };
  } catch {
    return {
      present: true,
      origin: null,
      pathname: null,
      hasSearch: false,
      trackingFound: false,
      tracking: trackingSummary({}),
    };
  }
}

function cookieTrackingInfo(req) {
  const cookies = parseCookieHeader(req.headers.cookie);
  const tracking = trackingFromCookie(req);
  return {
    hasCookieHeader: Boolean(req.headers.cookie),
    hasUtmifyCookie: Boolean(cookies.utmify_tracking),
    hasCheckoutCookie: Boolean(cookies.checkout_tracking),
    trackingFound: hasTrackingValues(tracking),
    tracking: trackingSummary(tracking),
  };
}

function trackingDiagnostics(inputTracking, req) {
  const bodyTracking = normalizeTracking(inputTracking || {});
  const cookieInfo = cookieTrackingInfo(req);
  const refInfo = refererInfo(req);
  const requestTracking = trackingFromRequest(req);
  const mergedTracking = mergeTracking(inputTracking, requestTracking);

  return {
    bodyTrackingFound: hasTrackingValues(bodyTracking),
    cookieTrackingFound: cookieInfo.trackingFound,
    refererTrackingFound: refInfo.trackingFound,
    requestTrackingFound: hasTrackingValues(requestTracking),
    mergedTrackingFound: hasTrackingValues(mergedTracking),
    bodyTracking: trackingSummary(bodyTracking),
    cookie: cookieInfo,
    referer: refInfo,
    mergedTracking: trackingSummary(mergedTracking),
  };
}

function cardTokenValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();

  if (typeof value === "object") {
    for (const key of ["token", "id", "value", "card_token", "cardToken"]) {
      const token = cardTokenValue(value[key]);
      if (token) return token;
    }
  }

  return "";
}

function validateCheckoutPayload(input, res) {
  const customer = input.customer;
  const address = input.address;

  if (!customer || typeof customer !== "object" || !address || typeof address !== "object") {
    sendJson(res, 422, { message: "Dados do checkout incompletos." });
    return false;
  }

  for (const field of ["name", "email", "phone", "cpf"]) {
    if (!String(customer[field] || "").trim()) {
      sendJson(res, 422, { message: "Preencha seus dados pessoais." });
      return false;
    }
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(customer.email || ""))) {
    sendJson(res, 422, { message: "E-mail invalido." });
    return false;
  }

  if (digits(customer.cpf).length !== 11) {
    sendJson(res, 422, { message: "CPF invalido." });
    return false;
  }

  for (const field of ["cep", "street", "number", "district", "city", "state"]) {
    if (!String(address[field] || "").trim()) {
      sendJson(res, 422, { message: "Preencha o endereco de entrega." });
      return false;
    }
  }

  return true;
}

function buildTransactionPayload(input, req, res) {
  if (!validateCheckoutPayload(input, res)) return null;

  const method = String(input.method || "pix");
  if (!["pix", "credit_card"].includes(method)) {
    sendJson(res, 422, { message: "Forma de pagamento invalida." });
    return null;
  }

  const customer = input.customer;
  const address = input.address;
  const amountCents = selectedAmountCents(input);
  const shippingCents = Math.max(0, amountCents - CHECKOUT_PRODUCT_PRICE_CENTS);
  const tracking = mergeTracking(input.tracking, trackingFromRequest(req));
  const createdAt = new Date().toISOString();
  const externalRef = `checkout_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}_${crypto
    .randomBytes(4)
    .toString("hex")}`;

  const payload = {
    external_ref: externalRef,
    amount: amountCents,
    currency: "BRL",
    method,
    buyer: {
      name: String(customer.name || "").trim(),
      email: String(customer.email || "").trim(),
      phone: digits(customer.phone),
      document: {
        type: "CPF",
        number: digits(customer.cpf),
      },
      address: {
        street: String(address.street || "").trim(),
        number: String(address.number || "").trim(),
        complement: String(address.complement || "").trim() || null,
        neighborhood: String(address.district || "").trim(),
        city: String(address.city || "").trim(),
        state: String(address.state || "").trim().toUpperCase(),
        zipCode: digits(address.cep),
        country: "BR",
      },
    },
    products: [
      {
        name: CHECKOUT_PRODUCT_NAME,
        price: CHECKOUT_PRODUCT_PRICE_CENTS,
        quantity: 1,
        tangible: true,
        sku: CHECKOUT_PRODUCT_ID,
      },
    ],
    metadata: JSON.stringify({
      productId: CHECKOUT_PRODUCT_ID,
      shippingCents,
      tracking,
      checkoutOrder: {
        transactionId: "",
        externalRef,
        method,
        amountCents,
        createdAt,
      },
      checkoutCustomer: {
        name: String(customer.name || "").trim(),
        email: String(customer.email || "").trim(),
        phone: digits(customer.phone),
        document: digits(customer.cpf),
        ip: clientIp(req),
      },
    }),
    traceable: true,
  };

  const ip = clientIp(req);
  if (ip) payload.ip_address = ip;

  const notifyUrl = webhookUrl(req, tracking);
  if (notifyUrl.startsWith("https://")) payload.notify_url = notifyUrl;

  if (method === "credit_card") {
    const token = [input.cardToken, input.token, input.card].map(cardTokenValue).find(Boolean) || "";
    const installments = Math.max(1, Math.min(3, Number(input.installments || 1)));

    if (!token) {
      sendJson(res, 422, { message: "Token do cartao nao informado." });
      return null;
    }

    if (!/^(pgct_|pgpm_)/.test(token)) {
      sendJson(res, 422, { message: "Token do cartao invalido. Recarregue a pagina e tente novamente." });
      return null;
    }

    payload.token = token;
    payload.installments = installments;
  }

  return payload;
}

async function pagouApiRequest(method, apiPath, payload) {
  const secret = env("PAGOU_SECRET_KEY");
  if (!secret) {
    return {
      status: 500,
      body: { message: "Chave secreta do Pagou nao configurada." },
    };
  }

  let response;
  try {
    response = await fetch(`${pagouBaseUrl()}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${secret}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: payload === undefined || payload === null ? undefined : JSON.stringify(payload),
    });
  } catch (error) {
    return {
      status: 502,
      body: { message: error && error.message ? error.message : "Falha de comunicacao com a Pagou." },
    };
  }

  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { raw };
  }

  return { status: response.status, body };
}

function validationDetails(body) {
  if (!body || typeof body !== "object") return [];

  const details = [];
  if (Array.isArray(body.errors)) {
    for (const error of body.errors) {
      if (!error) continue;
      if (typeof error === "string") {
        details.push(error);
        continue;
      }

      const field = error.field || error.path || error.param || error.property;
      const message = error.message || error.detail || error.error || error.code;
      if (field && message) details.push(`${field}: ${message}`);
      else if (message) details.push(String(message));
    }
  }

  for (const key of ["data", "details"]) {
    const value = body[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;

    for (const [field, message] of Object.entries(value)) {
      if (typeof message === "string" || typeof message === "number") {
        details.push(`${field}: ${message}`);
      }
    }
  }

  return details;
}

function errorMessage(body) {
  if (!body || typeof body !== "object") return "Falha ao processar pagamento.";
  const message = String(
    body.message ||
      body.detail ||
      body.title ||
      body.error ||
      (Array.isArray(body.errors) && body.errors[0] && (body.errors[0].message || body.errors[0])) ||
      "Falha ao processar pagamento."
  );
  const details = validationDetails(body);
  return details.length ? `${message}: ${details.join("; ")}` : message;
}

function parseMetadata(transaction) {
  const raw = transaction && transaction.metadata;
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function normalizeTransactionFromWebhook(body) {
  const data =
    body && typeof body.data === "object" && body.data !== null
      ? body.data.object && typeof body.data.object === "object"
        ? body.data.object
        : body.data
      : body && typeof body.transaction === "object" && body.transaction !== null
        ? body.transaction
        : body || {};

  const transaction = { ...data };
  const topLevelEvent = String(body.event || "");
  transaction.event_type =
    transaction.event_type ||
    body.event_type ||
    body.type ||
    (topLevelEvent.includes(".") ? topLevelEvent : "") ||
    "";
  transaction.external_ref =
    transaction.external_ref ||
    transaction.externalRef ||
    transaction.correlation_id ||
    transaction.correlationId ||
    "";
  return transaction;
}

function orderFromTransaction(transaction, req) {
  const metadata = parseMetadata(transaction);
  const buyer = transaction.buyer || transaction.customer || {};
  const checkoutCustomer = metadata.checkoutCustomer || {};
  const checkoutOrder = metadata.checkoutOrder || {};
  const tracking = normalizeTracking(metadata.tracking || {});

  const buyerDocument =
    (buyer.document && typeof buyer.document === "object" && buyer.document.number) ||
    buyer.document ||
    buyer.cpf ||
    buyer.tax_id ||
    checkoutCustomer.document ||
    null;

  return {
    transactionId: String(transaction.id || checkoutOrder.transactionId || ""),
    externalRef: String(
      transaction.external_ref ||
        transaction.externalRef ||
        transaction.correlation_id ||
        transaction.correlationId ||
        checkoutOrder.externalRef ||
        ""
    ),
    method: transaction.method || checkoutOrder.method || "pix",
    amountCents: Number(transaction.amount || checkoutOrder.amountCents || CHECKOUT_PRODUCT_PRICE_CENTS),
    createdAt: transaction.created_at || checkoutOrder.createdAt || new Date().toISOString(),
    customer: {
      name: String(checkoutCustomer.name || buyer.name || ""),
      email: String(checkoutCustomer.email || buyer.email || ""),
      phone: digits(checkoutCustomer.phone || buyer.phone || ""),
      document: digits(buyerDocument || ""),
      ip: checkoutCustomer.ip || clientIp(req),
    },
    tracking,
  };
}

function formatUtmifyDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 19).replace("T", " ");
  }
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function utmifyStatus(pagouStatus, eventType) {
  if (eventType === "transaction.paid" || ["paid", "captured", "authorized"].includes(pagouStatus)) return "paid";
  if (["refunded", "partially_refunded"].includes(pagouStatus)) return "refunded";
  if (pagouStatus === "chargedback") return "chargedback";
  if (["refused", "canceled", "cancelled", "expired"].includes(pagouStatus)) return "refused";
  return "waiting_payment";
}

function cents(value, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : fallback;
}

function cleanupSeenEvents() {
  const now = Date.now();

  for (const [key, seenAt] of seenEvents.entries()) {
    if (now - seenAt > 1000 * 60 * 60) seenEvents.delete(key);
  }

  for (const [key, snapshot] of orderSnapshots.entries()) {
    if (!snapshot || now - snapshot.seenAt > 1000 * 60 * 60 * 6) orderSnapshots.delete(key);
  }
}

function hasSeenEvent(eventId) {
  if (!eventId) return false;
  cleanupSeenEvents();
  return seenEvents.has(eventId);
}

function markEventSeen(eventId) {
  if (!eventId) return;
  cleanupSeenEvents();
  seenEvents.set(eventId, Date.now());
}

function snapshotKeys(orderOrTransaction) {
  if (!orderOrTransaction || typeof orderOrTransaction !== "object") return [];

  const metadata = parseMetadata(orderOrTransaction);
  const checkoutOrder = metadata.checkoutOrder || {};
  const keys = [
    orderOrTransaction.externalRef,
    orderOrTransaction.external_ref,
    orderOrTransaction.correlation_id,
    orderOrTransaction.correlationId,
    orderOrTransaction.transactionId,
    orderOrTransaction.id,
    checkoutOrder.externalRef,
    checkoutOrder.transactionId,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return [...new Set(keys)];
}

function rememberOrderSnapshot(order) {
  if (!order || typeof order !== "object") return;
  cleanupSeenEvents();

  const snapshot = {
    seenAt: Date.now(),
    order: {
      ...order,
      customer: { ...(order.customer || {}) },
      tracking: normalizeTracking(order.tracking || {}),
    },
  };

  for (const key of snapshotKeys(order)) {
    orderSnapshots.set(key, snapshot);
  }
}

function orderSnapshotFromTransaction(transaction) {
  cleanupSeenEvents();
  for (const key of snapshotKeys(transaction)) {
    const snapshot = orderSnapshots.get(key);
    if (snapshot && snapshot.order) return snapshot.order;
  }

  return null;
}

function mergeOrderWithSnapshot(order, snapshot) {
  if (!snapshot) return order;
  return {
    ...snapshot,
    ...order,
    customer: {
      ...(snapshot.customer || {}),
      ...(order.customer || {}),
    },
    tracking: mergeTracking(order.tracking || {}, snapshot.tracking || {}),
  };
}

function responseMessage(body) {
  if (!body || typeof body !== "object") return null;
  const firstError = Array.isArray(body.errors) ? body.errors[0] : null;
  return (
    body.message ||
    body.detail ||
    body.error ||
    body.title ||
    (firstError && (firstError.message || firstError.detail || firstError.error || String(firstError))) ||
    null
  );
}

async function notifyUtmify(order, transaction) {
  const token = env("UTMIFY_API_TOKEN");
  if (!token) {
    console.log("[checkout:utmify-skip]", {
      reason: "missing_token",
      orderId: order && (order.externalRef || order.transactionId) ? order.externalRef || order.transactionId : null,
    });
    return { sent: false, status: 0, message: "UTMify nao configurado." };
  }

  const pagouStatus = String(transaction.status || "pending");
  const eventType = String(transaction.event_type || "");
  const status = utmifyStatus(pagouStatus, eventType);
  const amountCents = cents(transaction.amount || order.amountCents, CHECKOUT_PRODUCT_PRICE_CENTS);
  const rawFeeCents = cents(
    transaction.fee || transaction.gateway_fee || transaction.gatewayFee || transaction.feeInCents,
    0
  );
  const feeCents = rawFeeCents > 0 ? rawFeeCents : 1;
  const userCommissionCents = Math.max(1, amountCents - feeCents);
  const customer = order.customer || {};
  const tracking = normalizeTracking(order.tracking || {});

  const payload = {
    orderId: String(order.externalRef || order.transactionId || transaction.id || ""),
    platform: "ShopeeCheckout",
    paymentMethod: (transaction.method || order.method || "pix") === "credit_card" ? "credit_card" : "pix",
    status,
    createdAt: formatUtmifyDate(order.createdAt || transaction.created_at),
    approvedDate: status === "paid" ? formatUtmifyDate(transaction.paid_at || transaction.updated_at) : null,
    refundedAt: status === "refunded" ? formatUtmifyDate(transaction.updated_at) : null,
    customer: {
      name: String(customer.name || ""),
      email: String(customer.email || ""),
      phone: customer.phone || null,
      document: customer.document || null,
      country: "BR",
      ip: customer.ip || null,
    },
    products: [
      {
        id: CHECKOUT_PRODUCT_ID,
        name: CHECKOUT_PRODUCT_NAME,
        planId: null,
        planName: null,
        quantity: 1,
        priceInCents: CHECKOUT_PRODUCT_PRICE_CENTS,
      },
    ],
    trackingParameters: tracking,
    commission: {
      totalPriceInCents: amountCents,
      gatewayFeeInCents: feeCents,
      userCommissionInCents: userCommissionCents,
      currency: transaction.currency || "BRL",
    },
    isTest: checkoutEnvironment() === "sandbox",
  };

  console.log("[checkout:utmify-request]", {
    orderId: payload.orderId || null,
    transactionId: transaction.id || order.transactionId || null,
    paymentMethod: payload.paymentMethod,
    pagouStatus,
    eventType: eventType || null,
    utmifyStatus: status,
    amountCents,
    feeCents,
    userCommissionCents,
    trackingFound: hasTrackingValues(tracking),
    tracking: trackingSummary(tracking),
    customer: {
      namePresent: Boolean(customer.name),
      emailPresent: Boolean(customer.email),
      phonePresent: Boolean(customer.phone),
      documentPresent: Boolean(customer.document),
      ipPresent: Boolean(customer.ip),
    },
    dates: {
      createdAt: payload.createdAt || null,
      approvedDate: payload.approvedDate || null,
      refundedAt: payload.refundedAt || null,
    },
    isTest: payload.isTest,
  });

  let response;
  try {
    response = await fetch("https://api.utmify.com.br/api-credentials/orders", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-token": token,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.log("[checkout:utmify-network-error]", {
      orderId: payload.orderId || null,
      transactionId: transaction.id || order.transactionId || null,
      message: error && error.message ? error.message : "Falha de comunicacao com a UTMify.",
    });
    return {
      sent: false,
      status: 0,
      body: { message: error && error.message ? error.message : "Falha de comunicacao com a UTMify." },
    };
  }

  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { raw };
  }

  console.log("[checkout:utmify-response]", {
    orderId: payload.orderId || null,
    transactionId: transaction.id || order.transactionId || null,
    sent: response.status >= 200 && response.status < 300,
    status: response.status,
    message: responseMessage(body),
    bodyKeys: body && typeof body === "object" ? Object.keys(body).slice(0, 12) : [],
  });

  return {
    sent: response.status >= 200 && response.status < 300,
    status: response.status,
    body,
  };
}

module.exports = {
  CHECKOUT_PRODUCT_ID,
  CHECKOUT_PRODUCT_NAME,
  CHECKOUT_PRODUCT_PRICE_CENTS,
  buildTransactionPayload,
  env,
  errorMessage,
  hasTrackingValues,
  hasSeenEvent,
  markEventSeen,
  mergeTracking,
  mergeOrderWithSnapshot,
  normalizeTransactionFromWebhook,
  notifyUtmify,
  orderSnapshotFromTransaction,
  orderFromTransaction,
  pagouApiRequest,
  readJson,
  rememberOrderSnapshot,
  requireMethod,
  sendJson,
  checkoutEnvironment,
  trackingDiagnostics,
  trackingFromRequest,
  trackingFromWebhookUrl,
  trackingSummary,
};
