/**
 * ============================================================
 *  DARAJA API SERVICE — Kazi Mtaani
 * ============================================================
 * 
 * This file handles ALL communication with Safaricom's Daraja API.
 * It has three main jobs:
 *   1. getAccessToken()  — Get a temporary auth key from Daraja
 *   2. stkPush()         — Ask employer to pay via their phone (STK Push)
 *   3. b2cPayout()       — Send money to worker's M-Pesa (B2C)
 *
 * Daraja Docs: https://developer.safaricom.co.ke/Documentation
 * ============================================================
 */

const axios = require('axios');

// ─── Daraja Base URLs ────────────────────────────────────────
// We switch between sandbox and production using DARAJA_ENV in .env
const BASE_URL = process.env.DARAJA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

// ─── 1. GET ACCESS TOKEN ─────────────────────────────────────
/**
 * Every Daraja API call needs a fresh OAuth token.
 * We get this by encoding our Consumer Key + Secret in Base64
 * and calling Daraja's auth endpoint.
 * 
 * @returns {string} The access token (valid for 1 hour)
 */
async function getAccessToken() {
    const key = process.env.DARAJA_CONSUMER_KEY;
    const secret = process.env.DARAJA_CONSUMER_SECRET;

    // Base64 encode "key:secret"
    const auth = Buffer.from(`${key}:${secret}`).toString('base64');

    const response = await axios.get(
        `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
        {
            headers: { Authorization: `Basic ${auth}` }
        }
    );

    return response.data.access_token;
}

// ─── 2. STK PUSH (Employer Pays into Escrow) ─────────────────
/**
 * Sends a payment prompt (popup) to the employer's phone.
 * The employer sees a PIN entry on their Safaricom phone and pays.
 * 
 * @param {string} phone   - Employer's phone number (format: 254XXXXXXXXX)
 * @param {number} amount  - Amount in KES (whole numbers only)
 * @param {string} jobId   - Job ID (used as reference in callback)
 * @returns {object}       - Daraja API response
 */
async function stkPush(phone, amount, jobId) {
    const token = await getAccessToken();
    const shortcode = process.env.DARAJA_SHORTCODE;
    const passkey = process.env.DARAJA_PASSKEY;

    // Timestamp format: YYYYMMDDHHmmss
    const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);

    // Password = Base64(shortcode + passkey + timestamp)
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    const callbackURL = `${process.env.CALLBACK_BASE_URL}/api/escrow/callback`;

    const payload = {
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.ceil(amount),          // Must be a whole number
        PartyA: phone,                       // Employer's phone
        PartyB: shortcode,                   // Your business shortcode
        PhoneNumber: phone,                  // Phone to receive the prompt
        CallBackURL: callbackURL,
        AccountReference: `KAZI-${jobId}`,  // Shows on employer's receipt as reference
        TransactionDesc: `Kazi Mtaani Escrow`
    };

    const response = await axios.post(
        `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
        payload,
        { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log('✅ STK Push sent:', response.data);
    return response.data;
}

// ─── 3. B2C PAYOUT (Send Money to Worker or Refund Employer) ─
/**
 * Sends money FROM our business account TO a phone number.
 * Used when:
 *   - Employer releases payment → sends to worker's phone
 *   - Employer requests refund  → sends back to employer's phone
 * 
 * @param {string} phone     - Recipient's phone number (254XXXXXXXXX)
 * @param {number} amount    - Amount in KES
 * @param {string} jobId     - Job ID (for tracking)
 * @param {string} remarks   - Short description e.g. "Payment for job"
 * @returns {object}         - Daraja API response
 */
async function b2cPayout(phone, amount, jobId, remarks) {
    const token = await getAccessToken();
    const callbackURL = `${process.env.CALLBACK_BASE_URL}/api/escrow/b2c-callback`;

    const payload = {
        InitiatorName: process.env.DARAJA_B2C_INITIATOR,
        SecurityCredential: process.env.DARAJA_B2C_SECURITY_CREDENTIAL,
        CommandID: 'BusinessPayment',
        Amount: Math.ceil(amount),
        PartyA: process.env.DARAJA_B2C_SHORTCODE,  // Our business shortcode
        PartyB: phone,                               // Worker or employer phone
        Remarks: remarks,
        QueueTimeOutURL: `${process.env.CALLBACK_BASE_URL}/api/escrow/b2c-timeout`,
        ResultURL: callbackURL,
        Occasion: `JOB-${jobId}`
    };

    const response = await axios.post(
        `${BASE_URL}/mpesa/b2c/v3/paymentrequest`,
        payload,
        { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log('✅ B2C Payout initiated:', response.data);
    return response.data;
}

module.exports = { getAccessToken, stkPush, b2cPayout };
