const mongoose = require('mongoose');

const JobSchema = new mongoose.Schema({
    title:       { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, required: true, maxlength: 2000 },
    location:    { type: String, required: true, trim: true, maxlength: 200 },
    pay:         { type: Number, required: true },
    category:    { type: String, required: true, maxlength: 100 },

    paymentStatus: {
        type: String,
        enum: ['Pending', 'Pending Payment', 'In-Escrow', 'Releasing', 'Refunding', 'Released', 'Refunded', 'Pending Release', 'Pending Refund'],
        default: 'Pending'
    },

    // Skills required and estimated duration
    requiredSkills: { type: [String], default: [] },
    duration:       { type: String, maxlength: 100, default: '' },

    // Tracks IDs of workers who clicked "Apply" (populated to names when read)
    applicants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    status: {
        type: String,
        enum: ['Open', 'In Progress', 'Completed'],
        default: 'Open'
    },

    // Hired worker — name for display, ID for secure lookups
    hiredWorker:   { type: String, default: '' },
    hiredWorkerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    mpesaReceiptNumber: { type: String },
    employer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // PLATFORM COMMISSION (10% total — 5% from employer, 5% from worker)
    platformFee:   { type: Number, default: 0 },  // Total fee kept by platform
    employerTotal: { type: Number, default: 0 },  // What employer pays (pay + 5%)
    workerPayout:  { type: Number, default: 0 },  // What worker receives (pay - 5%)

    // ESCROW FIELDS
    employerPhone:     { type: String, default: '' },   // Phone that paid into escrow (for refunds)
    workerPhone:       { type: String, default: '' },   // Phone that received payout
    checkoutRequestId: { type: String, default: '' },   // STK Push invoice ID
    payoutTrackingId:  { type: String, default: '' },   // Payout tracking ID

    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.Job || mongoose.model('Job', JobSchema);
