require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION;
const FINTIRX_USER_TOKEN = process.env.FINTIRX_USER_TOKEN;
const FINTIRX_BASE_URL = process.env.FINTIRX_BASE_URL;

// In-memory storage (replace with DB like MongoDB for production)
const paymentUrls = new Map();

// Verify Shopify webhook
function verifyShopifyWebhook(req) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const body = JSON.stringify(req.body);
  const calculatedHmac = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(body)
    .digest('base64');
  return hmacHeader === calculatedHmac;
}

// Shopify order creation webhook
app.post('/shopify-order-webhook', async (req, res) => {
  if (!verifyShopifyWebhook(req)) {
    console.error('Webhook verification failed');
    return res.status(401).send('Webhook verification failed');
  }

  const order = req.body;
  if (order.financial_status !== 'pending') {
    console.log('Not a pending order:', order.id);
    return res.status(200).send('Not a pending order');
  }

  const customerMobile = order.billing_address?.phone || order.shipping_address?.phone;
  if (!customerMobile) {
    console.error('Missing customer mobile for order', order.id);
    return res.status(200).send('Missing mobile');
  }
  const amount = order.total_price; // Supports decimals
  const orderId = order.id.toString();
  const refId = 'LIK' + orderId + Date.now(); // Unique like plugin's 'WC' prefix
  const redirectUrl = order.order_status_url;
  const remark1 = order.note || 'Shopify order from likone.shop';
  const remark2 = '';

  try {
    const response = await axios.post(`${FINTIRX_BASE_URL}/api/create-order`, new URLSearchParams({
      customer_mobile: customerMobile,
      user_token: FINTIRX_USER_TOKEN,
      amount: amount,
      order_id: refId, // Use unique refId
      redirect_url: redirectUrl,
      remark1: remark1,
      remark2: remark2,
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    if (response.data.status === true) {
      const paymentUrl = response.data.result.payment_url;
      paymentUrls.set(orderId, paymentUrl);
      console.log(`Order ${orderId} processed with refId ${refId}. Payment URL: ${paymentUrl}`);
      res.status(200).send('Order processed');
    } else {
      console.error('Fintrix create-order failed:', response.data.message);
      res.status(200).send('Provider error');
    }
  } catch (error) {
    console.error('Error creating order:', error.message);
    res.status(500).send('Server error');
  }
});

// Get payment URL (uses Shopify orderId)
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

// Fintrix payin webhook
app.post('/payin-webhook', async (req, res) => {
  console.log(`Webhook received at ${new Date().toISOString()}: ${JSON.stringify(req.body)}`); // Log like plugin

  const { order_id, status, amount, utr, message } = req.body; // order_id is refId
  if (!order_id || !status) {
    console.error('Invalid payload');
    return res.status(400).send('Invalid payload');
  }

  // In plugin, it looks up by meta; here, assume order_id (refId) contains Shopify orderId (extract if needed)
  // For simplicity, require user to map refId back to orderId (or use DB to store mapping)
  // Placeholder: Extract orderId from refId (assuming 'LIK1234567890timestamp' -> find digits after 'LIK')
  const orderIdMatch = order_id.match(/LIK(\d+)(\d+)/);
  const shopifyOrderId = orderIdMatch ? orderIdMatch[1] : null;
  if (!shopifyOrderId) {
    console.error('Invalid order_id format');
    return res.status(400).send('Invalid order_id');
  }

  const upperStatus = status.toUpperCase();
  if (upperStatus !== 'SUCCESS') {
    console.log(`Payment ${upperStatus} for ${order_id}: ${message}`);
    return res.status(200).send('Failed');
  }

  try {
    const transactionResponse = await axios.post(
      `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}/transactions.json`,
      {
        transaction: {
          kind: 'capture',
          status: 'success',
          amount: amount,
          gateway: 'Fintrix',
          source: 'external',
          message: `UTR: ${utr} - ${message}`,
        },
      },
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );

    if (transactionResponse.data.transaction.status === 'success') {
      console.log(`Order ${shopifyOrderId} marked as paid`);
      res.status(200).send('Success');
    } else {
      console.error('Capture failed:', transactionResponse.data);
      res.status(200).send('Capture failed');
    }
  } catch (error) {
    console.error('Error capturing:', error.message);
    res.status(500).send('Server error');
  }
});

// Check order status (polling fallback, like plugin)
app.get('/check-status', async (req, res) => {
  const orderId = req.query.order_id;
  const refId = 'LIK' + orderId + ''; // Reconstruct refId (adjust if timestamp needed; use DB for exact)
  // Note: For accuracy, store refId mapping in a DB during create-order
  try {
    const response = await axios.post(`${FINTIRX_BASE_URL}/api/check-order-status`, new URLSearchParams({
      user_token: FINTIRX_USER_TOKEN,
      order_id: refId, // Use refId
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    res.json(response.data);
  } catch (error) {
    console.error('Status check error:', error.message);
    res.status(500).json({ error: 'Failed to check status' });
  }
});

// Get wallet balance
app.get('/get-wallet-balance', async (req, res) => {
  try {
    const response = await axios.post(`${FINTIRX_BASE_URL}/payment/get_user_wallet.php`, new URLSearchParams({
      user_token: FINTIRX_USER_TOKEN,
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    res.json(response.data);
  } catch (error) {
    console.error('Balance error:', error.message);
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
