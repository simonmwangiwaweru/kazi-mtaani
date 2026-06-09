/**
 * ESCROW ROUTES — Kazi Mtaani (Manual Escrow)
 * Payments are made manually by employer to admin's M-PESA/Paybill.
 * Admin confirms receipt, then releases funds to worker manually.
 */
const express          = require('express');
const router           = express.Router();
const Job              = require('../models/job');
const User             = require('../models/user');
const protect          = require('../middleware/auth');
const { createNotification } = require('./notifications');

// ROUTE 1: Employer confirms they have sent payment manually
router.post('/claim/:jobId', protect, async (req, res) => {
    try {
        if (req.user.role !== 'employer') {
            return res.status(403).json({ msg: 'Only employers can do this.' });
        }

        const job = await Job.findById(req.params.jobId);
        if (!job) return res.status(404).json({ msg: 'Job not found.' });

        if (job.employer && job.employer.toString() !== req.user.id) {
            return res.status(403).json({ msg: 'Not authorized for this job.' });
        }

        if (job.paymentStatus !== 'Pending') {
            return res.status(400).json({ msg: `Payment already submitted.` });
        }

        job.paymentStatus = 'Pending Payment';
        job.employerPhone = req.body.employerPhone || '';
        await job.save();

        // Notify admin to confirm receipt (employer pays job.employerTotal = pay + 5%)
        const adminUsers = await User.find({ role: 'admin' }).select('_id');
        adminUsers.forEach(admin => {
            createNotification(
                admin._id,
                'general',
                'Payment Claim Received 💰',
                `Employer claims to have sent KES ${Number(job.employerTotal || job.pay).toLocaleString()} for "${job.title}" (job pay: KES ${Number(job.pay).toLocaleString()} + 5% fee). Check your M-PESA and confirm receipt in the Payouts panel.`,
                'payments'
            );
        });

        res.json({ msg: 'Payment claim submitted! Admin will confirm receipt shortly.' });
    } catch (err) {
        console.error('Claim Error:', err.message);
        res.status(500).json({ msg: 'Server error.' });
    }
});

// ROUTE 2: Release Payment to Worker (employer owner only)
router.post('/release/:jobId', protect, async (req, res) => {
    try {
        if (req.user.role !== 'employer') {
            return res.status(403).json({ msg: 'Only employers can release funds.' });
        }

        const job = await Job.findById(req.params.jobId);
        if (!job) return res.status(404).json({ msg: 'Job not found.' });

        if (job.employer && job.employer.toString() !== req.user.id) {
            return res.status(403).json({ msg: 'Not authorized for this job.' });
        }

        if (job.paymentStatus !== 'In-Escrow') {
            return res.status(400).json({ msg: `Cannot release — status is: ${job.paymentStatus}` });
        }

        if (!job.hiredWorkerId) {
            return res.status(400).json({ msg: 'No worker hired for this job.' });
        }

        const worker = await User.findById(job.hiredWorkerId).select('phone name');
        if (!worker) return res.status(404).json({ msg: 'Hired worker account not found.' });
        if (!worker.phone) return res.status(400).json({ msg: 'Hired worker has no phone on record.' });

        job.paymentStatus = 'Pending Release';
        job.workerPhone   = worker.phone;
        await job.save();

        // Notify admin to manually send the payout (worker receives job.workerPayout = pay - 5%)
        const adminUsers = await User.find({ role: 'admin' }).select('_id');
        adminUsers.forEach(admin => {
            createNotification(
                admin._id,
                'general',
                'Payout Required 💸',
                `Employer requested release for "${job.title}". Send KES ${Number(job.workerPayout || job.pay).toLocaleString()} to ${worker.name} (${worker.phone}). Platform keeps KES ${Number(job.platformFee || 0).toLocaleString()} fee.`,
                'payments'
            );
        });

        res.json({ msg: 'Release requested! Admin will process and send your payment shortly.' });
    } catch (err) {
        console.error('Release Error:', err.response?.data || err.message);
        res.status(500).json({ msg: 'Failed to release payment.' });
    }
});

// ROUTE 4: Refund to Employer (employer owner only)
router.post('/refund/:jobId', protect, async (req, res) => {
    try {
        if (req.user.role !== 'employer') {
            return res.status(403).json({ msg: 'Only employers can request refunds.' });
        }

        const job = await Job.findById(req.params.jobId);
        if (!job) return res.status(404).json({ msg: 'Job not found.' });

        if (job.employer && job.employer.toString() !== req.user.id) {
            return res.status(403).json({ msg: 'Not authorized for this job.' });
        }

        if (job.paymentStatus !== 'In-Escrow') {
            return res.status(400).json({ msg: `Cannot refund — status is: ${job.paymentStatus}` });
        }

        if (!job.employerPhone) {
            return res.status(400).json({ msg: 'Employer phone not found on record.' });
        }

        const employer = await User.findById(job.employer).select('name');

        job.paymentStatus = 'Pending Refund';
        await job.save();

        // Notify admin to manually send the refund
        const adminUsers = await User.find({ role: 'admin' }).select('_id');
        adminUsers.forEach(admin => {
            createNotification(
                admin._id,
                'general',
                'Refund Required ↩️',
                `Employer requested refund of KES ${Number(job.pay).toLocaleString()} for "${job.title}" to ${employer?.name || 'Employer'} (${job.employerPhone}). Send from IntaSend dashboard and confirm.`,
                'payments'
            );
        });

        res.json({ msg: 'Refund requested! Admin will process and return your money shortly.' });
    } catch (err) {
        console.error('Refund Error:', err.response?.data || err.message);
        res.status(500).json({ msg: 'Failed to refund.' });
    }
});

module.exports = router;
