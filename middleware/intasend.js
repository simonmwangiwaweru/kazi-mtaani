/**
 * IntaSend Webhook Signature Guard
 *
 * IntaSend signs every webhook POST with HMAC-SHA256 of the raw body
 * using your secret key, sent in the X-IntaSend-Signature header.
 * We verify this instead of IP filtering.
 *
 * In development the check is skipped so Postman testing still works.
 */

const crypto = require('crypto');

module.exports = function intasendGuard(req, res, next) {
    if (process.env.NODE_ENV !== 'production') return next();

    const signature = req.headers['x-intasend-signature'];
    if (!signature) {
        console.warn('[SECURITY] IntaSend webhook missing signature header');
        return res.status(403).json({ msg: 'Forbidden' });
    }

    const rawBody = JSON.stringify(req.body);
    const expected = crypto
        .createHmac('sha256', process.env.INTASEND_SECRET_KEY)
        .update(rawBody)
        .digest('hex');

    if (signature !== expected) {
        console.warn('[SECURITY] IntaSend webhook signature mismatch');
        return res.status(403).json({ msg: 'Forbidden' });
    }

    next();
};
