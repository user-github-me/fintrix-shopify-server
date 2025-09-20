require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
// ❌ DO NOT use a global body parser before your webhook routes.

const PORT = process.env.PORT || 3000;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION;
const FINTIRX_USER_TOKEN = process.env.FINTIRX_USER_TOKEN;
const FINTIRX_BASE_URL = process.env.FINTIRX_BASE_URL;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// ✅ In-memory storage for DEV. Replace with a database (e.g., Redis, MongoDB) for production.
const paymentUrls = new Map(); // Stores Shopify Order ID -> Payment URL
const orderIdToRefId = new Map(); // Stores Shopify Order ID -> Fintrix refId

// ✅ FIXED: Correctly verifies Shopify webhook HMAC signature
const verifyShopifyWebhook = (req, res, next) => {
  // We use req.body directly because express.raw() gives us the raw buffer
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');

  const generatedHash = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(req.body) // req.body is the raw buffer now
    .digest('base64');

  if (generatedHash === hmacHeader) {
    console.log('✅ Shopify webhook verified successfully!');
    next();
  } else {
    console.error('🚨 Shopify webhook verification failed!');
    res.status(401).send('Webhook verification failed.');
  }
};

// 🚨 IMPORTANT: You MUST implement verification for Fintrix webhooks.
// Check their documentation for a signature header or secret key.
const verifyFintrixWebhook = (req, res, next) => {
  // const fintrixSignature = req.get('X-Fintrix-Signature'); // Example header
  // const fintrixSecret = process.env.FINTRIX_WEBHOOK_SECRET;
  // const isValid = verifySignature(req.body, fintrixSignature, fintrixSecret);
  // if (isValid) {
  //   next();
  // } else {
  //   res.status(401).send('Fintrix webhook verification failed.');
  // }
  console.warn('⚠️ Fintrix webhook verification is not implemented! This is a security risk.');
  next(); // Placeholder - REMOVE IN PRODUCTION
};


// ✅ FIXED: Shopify order creation webhook with correct middleware usage
app.post(
  '/shopify-order-webhook',
  express.raw({ type: 'application/json' }), // 1. Get the raw body first
  verifyShopifyWebhook, // 2. Verify the webhook
  async (req, res) => { // 3. Run the main logic
    const order = JSON.parse(req.body.toString()); // 4. Now parse the JSON

    if (order.financial_status !== 'pending') {
      return res.status(200).send('Not a pending order');
    }

    const customerMobile = order.billing_address?.phone || order.shipping_address?.phone;
    if (!customerMobile) {
      return res.status(200).send('Missing mobile');
    }
    const amount = order.total_price;
    const orderId = order.id.toString();
    const refId = 'LIK' + orderId + Date.now();
    const redirectUrl = order.order_status_url;
    const remark1 = order.note || 'Shopify order from likone.shop';

    try {
      const response = await axios.post(`${FINTIRX_BASE_URL}/api/create-order`, new URLSearchParams({
        customer_mobile: customerMobile,
        user_token: FINTIRX_USER_TOKEN,
        amount: amount,
        order_id: refId,
        redirect_url: redirectUrl,
        remark1: remark1,
      }), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      if (response.data.status === true) {
        const paymentUrl = response.data.result.payment_url;
        paymentUrls.set(orderId, paymentUrl);
        orderIdToRefId.set(orderId, refId); // ✅ Store the mapping
        console.log(`Order ${orderId} processed. Stored refId ${refId}.`);
        res.status(200).send('Order processed');
      } else {
        res.status(200).send('Provider error');
      }
    } catch (error) {
      console.error('Error creating order:', error.message);
      res.status(500).send('Server error');
    }
  }
);


// Get payment URL for the front-end script
app.get('/get-payment-url', (req, res) => {
  const orderId = req.query.order_id;
  const paymentUrl = paymentUrls.get(orderId);
  if (paymentUrl) {
    paymentUrls.delete(orderId);
    res.json({ payment_url: paymentUrl });
  } else {
    res.json({ payment_url: null });
  }
});


// ✅ FIXED: Fintrix payin webhook with placeholder for verification
app.post(
  '/payin-webhook',
  express.json(), // This webhook can be parsed directly if verification logic handles it
  verifyFintrixWebhook,
  async (req, res) => {
    const { order_id, status, amount, utr, message } = req.body;
    if (!order_id || !status) {
      return res.status(400).send('Invalid payload');
    }

    const orderIdMatch = order_id.match(/LIK(\d+)/);
    const shopifyOrderId = orderIdMatch ? orderIdMatch[1] : null;
    if (!shopifyOrderId) {
      return res.status(400).send('Invalid ref_id format');
    }

    if (status.toUpperCase() !== 'SUCCESS') {
      return res.status(200).send('Payment was not successful');
    }

    try {
      await axios.post(
        `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}/transactions.json`, {
        transaction: {
          kind: 'capture',
          status: 'success',
          amount: amount,
          gateway: 'Fintrix',
          source: 'external',
          message: `UTR: ${utr} - ${message}`,
        },
      }, {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
      }
      );
      console.log(`Order ${shopifyOrderId} marked as paid`);
      res.status(200).send('Success');
    } catch (error) {
      console.error('Error creating Shopify transaction:', error.response?.data || error.message);
      res.status(500).send('Server error');
    }
  }
);


// ✅ FIXED: Check order status with correct refId lookup
app.get('/check-status', express.json(), async (req, res) => {
  const orderId = req.query.order_id;
  const refId = orderIdToRefId.get(orderId); // Look up the correct, unique refId

  if (!refId) {
    return res.status(404).json({ error: 'Order not found or not processed yet' });
  }

  try {
    const response = await axios.post(`${FINTIRX_BASE_URL}/api/check-order-status`, new URLSearchParams({
      user_token: FINTIRX_USER_TOKEN,
      order_id: refId,
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    res.json(response.data);
  } catch (error) {
    console.error('Status check error:', error.message);
    res.status(500).json({ error: 'Failed to check status' });
  }
});


// Other routes can use the JSON parser
app.get('/get-wallet-balance', express.json(), async (req, res) => {
    // ... logic for wallet balance
});


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
