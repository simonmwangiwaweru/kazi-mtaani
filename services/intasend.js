/**
 * IntaSend Payment Service — Kazi Mtaani
 *
 * Replaces Daraja (Safaricom direct API) with IntaSend, a payment
 * aggregator that handles M-PESA without needing your own Paybill.
 *
 * Docs: https://developers.intasend.com
 */

const axios = require('axios');

const BASE = process.env.NODE_ENV === 'production'
    ? 'https://api.intasend.com'
    : 'https://sandbox.intasend.com';

function client() {
    return axios.create({
        baseURL: BASE,
        headers: {
            'Authorization': `Bearer ${process.env.INTASEND_SECRET_KEY}`,
            'Content-Type': 'application/json',
        },
        timeout: 30000,
    });
}

// STK Push — sends payment prompt to employer's phone
async function stkPush(phone, amount, jobId) {
    const { data } = await client().post('/api/v1/payment/mpesa-stk-push/', {
        phone_number: phone,
        amount:       Math.round(Number(amount)),
        currency:     'KES',
        api_ref:      `JOB-${jobId}`,
        comment:      'Kazi Mtaani escrow payment',
    });
    // Returns { invoice: { invoice_id, state, ... } }
    return data;
}

// Send money to a phone number (worker payout or employer refund)
async function mpesaPayout(phone, amount, name, narrative) {
    const api = client();

    // Step 1: initiate
    const { data } = await api.post('/api/v1/send-money/mpesa/', {
        currency: 'KES',
        transactions: [{
            name:      name || 'Recipient',
            account:   phone,
            amount:    Math.round(Number(amount)),
            narrative: narrative || 'Kazi Mtaani payment',
        }],
    });

    // Step 2: approve (IntaSend requires explicit approval before sending)
    await api.post('/api/v1/send-money/approve/', {
        tracking_id: data.tracking_id,
        nonce:       data.nonce,
    });

    return data; // { tracking_id, nonce, status, transactions }
}

module.exports = { stkPush, mpesaPayout };
