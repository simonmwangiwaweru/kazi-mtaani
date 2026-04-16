const protect = require('./auth');

/**
 * Admin guard — chain after protect.
 * Usage: router.get('/route', adminGuard, handler)
 * Rejects any authenticated user whose role is not 'admin'.
 */
const adminOnly = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ msg: 'Admin access required.' });
    }
    next();
};

module.exports = [protect, adminOnly];
