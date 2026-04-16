const mongoose = require('mongoose');

/**
 * AuditLog — records key platform events for compliance and debugging.
 * Lightweight: only high-value actions are written (not reads).
 */
const AuditLogSchema = new mongoose.Schema({
    userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    userName: { type: String, default: 'system' },
    action:   { type: String, required: true },  // e.g. 'login', 'job_posted', 'payment_released'
    entity:   { type: String, default: '' },     // 'job', 'user', 'payment'
    entityId: { type: String, default: '' },
    details:  { type: String, default: '' },
    ip:       { type: String, default: '' },
    createdAt:{ type: Date, default: Date.now }
});

AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ userId: 1,  createdAt: -1 });

module.exports = mongoose.models.AuditLog || mongoose.model('AuditLog', AuditLogSchema);
