/**
 * IntaSend Webhook Challenge Guard
 *
 * IntaSend sends the "challenge" value you configured in the dashboard
 * inside every webhook payload as req.body.challenge.
 * We verify it matches our stored INTASEND_CHALLENGE env var.
 *
 * In development the check is skipped so Postman testing still works.
 */

module.exports = function intasendGuard(req, res, next) {
    if (process.env.NODE_ENV !== 'production') return next();

    const challenge = req.body?.challenge;
    if (!challenge || challenge !== process.env.INTASEND_CHALLENGE) {
        console.warn('[SECURITY] IntaSend webhook challenge mismatch:', challenge);
        return res.status(403).json({ msg: 'Forbidden' });
    }

    next();
};
