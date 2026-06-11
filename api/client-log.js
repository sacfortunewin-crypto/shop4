const {
  hasTrackingValues,
  readJson,
  requireMethod,
  sendJson,
  trackingSummary,
} = require("./_lib/pagou");

function safeUrlInfo(value) {
  if (!value) return { present: false, origin: null, pathname: null, hasSearch: false };

  try {
    const url = new URL(String(value));
    return {
      present: true,
      origin: url.origin || null,
      pathname: url.pathname || null,
      hasSearch: Boolean(url.search),
    };
  } catch {
    return { present: true, origin: null, pathname: null, hasSearch: false };
  }
}

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, "POST")) return;

  let input;
  try {
    input = await readJson(req);
  } catch {
    sendJson(res, 400, { ok: false, message: "JSON invalido." });
    return;
  }

  const tracking = input && input.tracking ? input.tracking : {};
  const storage = input && input.storage ? input.storage : {};

  console.log("[checkout:client-tracking]", {
    stage: input && input.stage ? input.stage : null,
    pathname: input && input.pathname ? input.pathname : null,
    hasSearch: Boolean(input && input.hasSearch),
    trackingFound: hasTrackingValues(tracking),
    tracking: trackingSummary(tracking),
    storage: {
      localFound: Boolean(storage.localFound),
      sessionFound: Boolean(storage.sessionFound),
      cookieFound: Boolean(storage.cookieFound),
    },
    referrer: safeUrlInfo(input.referrer),
  });

  sendJson(res, 200, { ok: true });
};
