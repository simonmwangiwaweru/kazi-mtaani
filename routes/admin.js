const express    = require('express');
const router     = express.Router();
const path       = require('path');
const fs         = require('fs');
const cloudinary = require('cloudinary').v2;
const User       = require('../models/user');
const Job        = require('../models/job');
const AuditLog   = require('../models/AuditLog');
const adminGuard = require('../middleware/admin');
const { createNotification } = require('./notifications');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// GET /api/admin/stats
router.get('/stats', adminGuard, async (req, res) => {
    try {
        const [totalUsers, totalJobs, activeJobs, escrowJobs, releasedJobs] = await Promise.all([
            User.countDocuments(),
            Job.countDocuments(),
            Job.countDocuments({ status: { $ne: 'Completed' } }),
            Job.find({ paymentStatus: 'In-Escrow' }).select('pay'),
            Job.find({ paymentStatus: 'Released' }).select('platformFee pay')
        ]);
        const escrowTotal    = escrowJobs.reduce((s, j) => s + Number(j.pay || 0), 0);
        // Sum platformFee on released jobs; fall back to 10% of pay for older jobs without the field
        const totalEarnings  = releasedJobs.reduce((s, j) => {
            const fee = j.platformFee > 0 ? j.platformFee : Math.round(Number(j.pay || 0) * 0.10);
            return s + fee;
        }, 0);
        res.json({ totalUsers, totalJobs, activeJobs, escrowTotal, totalEarnings });
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

// GET /api/admin/users
router.get('/users', adminGuard, async (req, res) => {
    try {
        const users = await User.find()
            .select('-password -tokenVersion -googleId -resetOTP -resetOTPExpiry')
            .sort({ dateJoined: -1 })
            .limit(500);
        res.json(users);
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', adminGuard, async (req, res) => {
    try {
        if (req.params.id === req.user.id) {
            return res.status(400).json({ msg: 'Cannot delete your own account.' });
        }
        const user = await User.findByIdAndDelete(req.params.id);
        if (!user) return res.status(404).json({ msg: 'User not found.' });
        res.json({ msg: 'User deleted.' });
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

// GET /api/admin/jobs — all jobs with employer name populated
router.get('/jobs', adminGuard, async (req, res) => {
    try {
        const jobs = await Job.find()
            .populate('employer', 'name phone')
            .sort({ createdAt: -1 })
            .limit(500);
        res.json(jobs);
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

// DELETE /api/admin/jobs/:id — admin override, no ownership check
router.delete('/jobs/:id', adminGuard, async (req, res) => {
    try {
        const job = await Job.findByIdAndDelete(req.params.id);
        if (!job) return res.status(404).json({ msg: 'Job not found.' });
        res.json({ msg: 'Job deleted.' });
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

// GET /api/admin/verifications — list users awaiting verification
router.get('/verifications', adminGuard, async (req, res) => {
    try {
        const users = await User.find({ verificationStatus: 'pending' })
            .select('name phone role verificationDoc verificationStatus dateJoined')
            .sort({ dateJoined: -1 });
        res.json(users);
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

// PUT /api/admin/verify/:userId — approve verification
router.put('/verify/:userId', adminGuard, async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        if (!user) return res.status(404).json({ msg: 'User not found.' });

        user.verificationStatus = 'verified';
        user.isVerified         = true;
        user.verificationNote   = '';
        await user.save();

        createNotification(user._id, 'general', 'Identity Verified ✅',
            'Your ID has been verified. A verified badge is now shown on your profile.', 'profile');

        AuditLog.create({ userId: req.user.id, userName: req.user.name,
            action: 'verification_approved', entity: 'user', entityId: user._id.toString(),
            details: user.name }).catch(() => {});

        res.json({ msg: `${user.name} verified successfully.` });
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

// DELETE /api/admin/verify/:userId — reject verification
router.delete('/verify/:userId', adminGuard, async (req, res) => {
    try {
        const { reason } = req.body;
        const user = await User.findById(req.params.userId);
        if (!user) return res.status(404).json({ msg: 'User not found.' });

        // Delete from Cloudinary
        if (user.verificationDocPublicId) {
            await cloudinary.uploader.destroy(user.verificationDocPublicId, { resource_type: 'image' }).catch(() => {});
        }

        user.verificationStatus      = 'rejected';
        user.verificationDoc         = '';
        user.verificationDocPublicId = '';
        user.verificationNote        = reason || 'Document could not be verified.';
        await user.save();

        createNotification(user._id, 'general', 'Verification Update',
            `Your verification was not approved. Reason: ${user.verificationNote} Please re-upload a clearer document.`,
            'profile');

        AuditLog.create({ userId: req.user.id, userName: req.user.name,
            action: 'verification_rejected', entity: 'user', entityId: user._id.toString(),
            details: reason || '' }).catch(() => {});

        res.json({ msg: `${user.name} verification rejected.` });
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

// GET /api/admin/payouts — list all jobs needing manual admin action
router.get('/payouts', adminGuard, async (req, res) => {
    try {
        const jobs = await Job.find({
            paymentStatus: { $in: ['Pending Payment', 'Pending Release', 'Pending Refund'] }
        }).populate('employer', 'name phone').populate('hiredWorkerId', 'name phone').sort({ createdAt: -1 });
        res.json(jobs);
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

// POST /api/admin/payouts/:jobId/confirm-payment — admin confirms they received payment from employer
router.post('/payouts/:jobId/confirm-payment', adminGuard, async (req, res) => {
    try {
        const job = await Job.findById(req.params.jobId);
        if (!job) return res.status(404).json({ msg: 'Job not found.' });
        if (job.paymentStatus !== 'Pending Payment') {
            return res.status(400).json({ msg: 'Job is not awaiting payment confirmation.' });
        }

        job.paymentStatus = 'In-Escrow';
        await job.save();

        createNotification(
            job.employer,
            'escrow_funded',
            'Payment Confirmed — In Escrow 🔒',
            `Your payment of KES ${Number(job.pay).toLocaleString()} for "${job.title}" has been received and secured in escrow.`,
            'payments'
        );

        if (job.hiredWorkerId) {
            createNotification(
                job.hiredWorkerId,
                'escrow_funded',
                'Payment Secured in Escrow 🔒',
                `KES ${Number(job.pay).toLocaleString()} has been locked in escrow for "${job.title}". Complete the job to receive your payment.`,
                'payments'
            );
        }

        AuditLog.create({ userId: req.user.id, userName: req.user.name,
            action: 'payment_confirmed', entity: 'job', entityId: job._id.toString(),
            details: `Confirmed KES ${job.pay} for "${job.title}"` }).catch(() => {});

        res.json({ msg: 'Payment confirmed. Job is now In-Escrow.' });
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

// POST /api/admin/payouts/:jobId/confirm-release — admin confirms they sent money to worker
router.post('/payouts/:jobId/confirm-release', adminGuard, async (req, res) => {
    try {
        const job = await Job.findById(req.params.jobId);
        if (!job) return res.status(404).json({ msg: 'Job not found.' });
        if (job.paymentStatus !== 'Pending Release') {
            return res.status(400).json({ msg: `Job is not pending release.` });
        }

        job.paymentStatus = 'Released';
        job.status        = 'Completed';
        await job.save();

        if (job.hiredWorkerId) {
            createNotification(
                job.hiredWorkerId,
                'payment_released',
                'Payment Released to Your M-Pesa! 💰',
                `KES ${Number(job.pay).toLocaleString()} for "${job.title}" has been sent to your M-Pesa. Check your phone!`,
                'payments'
            );
        }

        AuditLog.create({ userId: req.user.id, userName: req.user.name,
            action: 'payout_confirmed', entity: 'job', entityId: job._id.toString(),
            details: `Released KES ${job.pay} for "${job.title}"` }).catch(() => {});

        res.json({ msg: 'Release confirmed. Worker has been notified.' });
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

// POST /api/admin/payouts/:jobId/confirm-refund — admin confirms they sent refund to employer
router.post('/payouts/:jobId/confirm-refund', adminGuard, async (req, res) => {
    try {
        const job = await Job.findById(req.params.jobId);
        if (!job) return res.status(404).json({ msg: 'Job not found.' });
        if (job.paymentStatus !== 'Pending Refund') {
            return res.status(400).json({ msg: `Job is not pending refund.` });
        }

        job.paymentStatus = 'Refunded';
        job.status        = 'Open';
        await job.save();

        createNotification(
            job.employer,
            'refunded',
            'Refund Processed ↩️',
            `KES ${Number(job.pay).toLocaleString()} for "${job.title}" has been refunded to your M-Pesa.`,
            'payments'
        );

        AuditLog.create({ userId: req.user.id, userName: req.user.name,
            action: 'refund_confirmed', entity: 'job', entityId: job._id.toString(),
            details: `Refunded KES ${job.pay} for "${job.title}"` }).catch(() => {});

        res.json({ msg: 'Refund confirmed. Employer has been notified.' });
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

module.exports = router;
