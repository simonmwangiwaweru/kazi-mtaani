const express = require('express');
const router  = express.Router();
const Notification = require('../models/Notification');
const protect = require('../middleware/auth');

// Helper: create a notification (called from other routes)
async function createNotification(userId, type, title, message, tab = '') {
    try {
        await Notification.create({ userId, type, title, message, tab });
    } catch (err) {
        console.error('Notification create error:', err.message);
    }
}

// GET /api/notifications — fetch user's last 30 notifications
router.get('/', protect, async (req, res) => {
    try {
        const notifications = await Notification.find({ userId: req.user.id })
            .sort({ createdAt: -1 })
            .limit(30);
        const unreadCount = await Notification.countDocuments({ userId: req.user.id, read: false });
        res.json({ notifications, unreadCount });
    } catch (err) {
        console.error('Notifications fetch error:', err.message);
        res.status(500).json({ msg: 'Server error.' });
    }
});

// PUT /api/notifications/read-all — mark all as read
router.put('/read-all', protect, async (req, res) => {
    try {
        await Notification.updateMany({ userId: req.user.id, read: false }, { read: true });
        res.json({ msg: 'All notifications marked as read.' });
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

// PUT /api/notifications/:id/read — mark single notification as read
router.put('/:id/read', protect, async (req, res) => {
    try {
        await Notification.findOneAndUpdate(
            { _id: req.params.id, userId: req.user.id },
            { read: true }
        );
        res.json({ msg: 'Notification marked as read.' });
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

// DELETE /api/notifications/clear — clear all notifications
router.delete('/clear', protect, async (req, res) => {
    try {
        await Notification.deleteMany({ userId: req.user.id });
        res.json({ msg: 'All notifications cleared.' });
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

module.exports = router;
module.exports.createNotification = createNotification;
