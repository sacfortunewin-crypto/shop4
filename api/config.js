const {
  CHECKOUT_PRODUCT_ID,
  CHECKOUT_PRODUCT_NAME,
  CHECKOUT_PRODUCT_PRICE_CENTS,
  checkoutEnvironment,
  env,
  requireMethod,
  sendJson,
} = require("./_lib/pagou");

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, "GET")) return;

  sendJson(res, 200, {
    publicKey: env("PAGOU_PUBLIC_KEY"),
    environment: checkoutEnvironment(),
    product: {
      id: CHECKOUT_PRODUCT_ID,
      name: CHECKOUT_PRODUCT_NAME,
      priceCents: CHECKOUT_PRODUCT_PRICE_CENTS,
    },
  });
};
