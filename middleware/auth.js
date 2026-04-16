const jwt = require('jsonwebtoken');
const User = require('../models/user');

/**
 * JWT Auth Middleware
 * Attaches req.user = { id, name, role, tokenVersion } if the token is valid.
 * Usage: router.post('/protected-route', protect, handler)
 */
module.exports = async function protect(req, res, next) {
    // Prefer httpOnly cookie; fall back to Authorization header for API clients
    const authHeader = req.header('Authorization');
    const token = req.cookies?.token ||
        (authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null);

    if (!token) {
        return res.status(401).json({ msg: 'Access denied. Please log in.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Stateful check to support immediate session revocation (logout)
        const user = await User.findById(decoded.id).select('tokenVersion');
        if (!user || user.tokenVersion !== decoded.tokenVersion) {
            return res.status(401).json({ msg: 'Session expired. Please log in again.' });
        }

        req.user = decoded; // { id, name, role, tokenVersion }
        next();
    } catch (err) {
        return res.status(401).json({ msg: 'Session expired. Please log in again.' });
    }
};
