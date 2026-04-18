const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    type: {
        type: String,
        enum: ['applied', 'hired', 'escrow_funded', 'payment_released', 'refunded', 'general'],
        default: 'general'
    },
    title:   { type: String, required: true },
    message: { type: String, required: true },
    read:    { type: Boolean, default: false },
    // Tab to navigate to when notification is clicked
    tab:     { type: String, default: '' },
    createdAt: { type: Date, default: Date.now }
});

// Auto-delete notifications older than 30 days
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

module.exports = mongoose.models.Notification || mongoose.model('Notification', NotificationSchema);
