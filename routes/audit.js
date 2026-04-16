/**
 * AUDIT LOG — admin-only view of platform activity.
 */
const express    = require('express');
const router     = express.Router();
const AuditLog   = require('../models/AuditLog');
const adminGuard = require('../middleware/admin');

// GET /api/audit?page=1&limit=50&action=X&userId=Y
router.get('/', adminGuard, async (req, res) => {
    try {
        const { page = 1, limit = 50, action, userId } = req.query;
        const query = {};
        if (action)  query.action = { $regex: action,  $options: 'i' };
        if (userId)  query.userId = userId;

        const pageNum  = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(200, parseInt(limit) || 50);

        const [logs, total] = await Promise.all([
            AuditLog.find(query).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum),
            AuditLog.countDocuments(query)
        ]);

        res.json({ logs, total, page: pageNum, pages: Math.ceil(total / limitNum) });
    } catch (err) {
        console.error('Audit log error:', err.message);
        res.status(500).json({ msg: 'Server error.' });
    }
});

module.exports = router;
