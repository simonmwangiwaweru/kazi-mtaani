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
    let data;
    try {
        const res = await api.post('/api/v1/send-money/mpesa/', {
            currency: 'KES',
            transactions: [{
                name:      name || 'Recipient',
                account:   phone,
                amount:    Math.round(Number(amount)),
                narrative: narrative || 'Kazi Mtaani payment',
            }],
        });
        data = res.data;
        console.log('IntaSend send-money response:', JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('IntaSend send-money error:', JSON.stringify(err.response?.data || err.message, null, 2));
        throw err;
    }

    // Step 2: approve (IntaSend requires explicit approval before sending)
    try {
        const approveRes = await api.post('/api/v1/send-money/approve/', {
            tracking_id: data.tracking_id,
            nonce:       data.nonce,
        });
        console.log('IntaSend approve response:', JSON.stringify(approveRes.data, null, 2));
    } catch (err) {
        console.error('IntaSend approve error:', JSON.stringify(err.response?.data || err.message, null, 2));
        throw err;
    }

    return data;
}

module.exports = { stkPush, mpesaPayout };
