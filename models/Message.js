const mongoose = require('mongoose');

/**
 * Message — job-scoped chat between the employer and the hired worker.
 * Anyone who applied to or owns the job can send messages.
 */
const MessageSchema = new mongoose.Schema({
    jobId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Job',  required: true },
    senderId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    senderName: { type: String, required: true },
    senderRole: { type: String, enum: ['worker', 'employer', 'admin'], required: true },
    content:    { type: String, required: true, maxlength: 1000, trim: true },
    read:       { type: Boolean, default: false },
    createdAt:  { type: Date,   default: Date.now }
});

MessageSchema.index({ jobId: 1, createdAt: 1 });
MessageSchema.index({ jobId: 1, senderId: 1 });

module.exports = mongoose.models.Message || mongoose.model('Message', MessageSchema);
