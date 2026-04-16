/**
 * SMS Service — Africa's Talking
 *
 * Requires in .env:
 *   AT_USERNAME  — your Africa's Talking username (use 'sandbox' for testing)
 *   AT_API_KEY   — your Africa's Talking API key
 *   AT_SENDER_ID — (optional) your approved shortcode/sender ID
 *
 * In development (NODE_ENV !== 'production') the SDK defaults to the AT sandbox.
 * If AT_API_KEY is not set at all, falls back to console.log so dev works without credentials.
 */

const AfricasTalking = require('africastalking');

let _sms = null;

function getSMS() {
    if (_sms) return _sms;

    const apiKey   = process.env.AT_API_KEY;
    const username = process.env.AT_USERNAME;

    if (!apiKey || !username) {
        return null; // Will use stub below
    }

    const at = AfricasTalking({ apiKey, username });
    _sms = at.SMS;
    return _sms;
}

/**
 * Send an SMS to a single recipient.
 * @param {string} to      - Recipient in E.164 format (e.g. 254712345678)
 * @param {string} message - Message body
 */
async function sendSMS(to, message) {
    const sms = getSMS();

    if (!sms) {
        // No credentials configured — log and continue (dev / CI)
        console.log(`[SMS STUB] To: +${to} | ${message}`);
        return;
    }

    const opts = {
        to:      [`+${to}`],
        message: message,
    };

    if (process.env.AT_SENDER_ID) {
        opts.from = process.env.AT_SENDER_ID;
    }

    const result = await sms.send(opts);
    console.log('SMS dispatched:', JSON.stringify(result.SMSMessageData?.Recipients?.[0] ?? result));
    return result;
}

module.exports = { sendSMS };
