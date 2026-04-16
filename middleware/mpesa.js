/**
 * M-Pesa Callback IP Allowlist
 *
 * Safaricom only sends STK Push and B2C callback POST requests from a known
 * set of IP addresses. In production we reject anything that doesn't originate
 * from one of these IPs to prevent fake payment confirmations.
 *
 * In development (NODE_ENV !== 'production') the check is skipped entirely so
 * that local testing via ngrok / Postman continues to work.
 *
 * Source: Safaricom Developer Portal — "Webhook IP Whitelisting"
 */

const SAFARICOM_IPS = new Set([
    '196.201.214.200',
    '196.201.214.206',
    '196.201.213.114',
    '196.201.214.207',
    '196.201.214.208',
    '196.201.213.44',
    '196.201.212.127',
    '196.201.212.128',
    '196.201.212.129',
    '196.201.212.132',
    '196.201.212.136',
    '196.201.212.74',
]);

module.exports = function mpesaIpGuard(req, res, next) {
    // Skip in development — callbacks come from ngrok or Postman
    if (process.env.NODE_ENV !== 'production') return next();

    // When behind a reverse proxy (nginx / Render / Railway), the real IP is
    // in the first value of X-Forwarded-For, not req.ip.
    const forwarded = req.header('x-forwarded-for');
    const ip = forwarded ? forwarded.split(',')[0].trim() : req.ip;

    if (!SAFARICOM_IPS.has(ip)) {
        console.warn(`[SECURITY] M-Pesa callback blocked — unknown IP: ${ip}`);
        // Respond with the Daraja "accepted" envelope so Safaricom doesn't keep retrying
        return res.status(403).json({ ResultCode: 1, ResultDesc: 'Forbidden' });
    }

    next();
};
