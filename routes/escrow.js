/**
 * ESCROW ROUTES — Kazi Mtaani (IntaSend)
 */
const express          = require('express');
const router           = express.Router();
const Job              = require('../models/job');
const User             = require('../models/user');
const { stkPush, mpesaPayout } = require('../services/intasend');
const protect          = require('../middleware/auth');
const intasendGuard    = require('../middleware/intasend');
const { createNotification } = require('./notifications');

// ─── Phone format validation helper ──────────────────────────────────────────
function isValidPhone(phone) {
    return /^2547\d{8}$|^2541\d{8}$/.test(phone);
}

// ROUTE 1: Trigger STK Push (employer only, must own the job)
router.post('/pay/:jobId', protect, async (req, res) => {
    try {
        if (req.user.role !== 'employer') {
            return res.status(403).json({ msg: 'Only employers can pay.' });
        }

        const { employerPhone } = req.body;
        if (!employerPhone) {
            return res.status(400).json({ msg: 'Employer phone number is required.' });
        }
        if (!isValidPhone(employerPhone)) {
            return res.status(400).json({ msg: 'Phone must be in format 254XXXXXXXXX (e.g. 254712345678).' });
        }

        const job = await Job.findById(req.params.jobId);
        if (!job) return res.status(404).json({ msg: 'Job not found.' });

        if (job.employer && job.employer.toString() !== req.user.id) {
            return res.status(403).json({ msg: 'Not authorized for this job.' });
        }

        if (job.paymentStatus !== 'Pending') {
            return res.status(400).json({ msg: `Job is already: ${job.paymentStatus}` });
        }

        job.employerPhone = employerPhone;
        await job.save();

        const result = await stkPush(employerPhone, job.pay, job._id);

        // Store IntaSend invoice_id for matching the callback
        job.checkoutRequestId = result.invoice?.invoice_id || result.invoice_id || '';
        await job.save();

        res.json({ msg: 'M-Pesa prompt sent! Check your phone.' });
    } catch (err) {
        console.error('STK Push Error:', err.response?.data || err.message);
        const msg = err.response?.data?.detail || err.response?.data?.message || err.message || 'Failed to initiate payment.';
        res.status(500).json({ msg });
    }
});

// ROUTE 2: STK Push Callback (webhook from IntaSend — signature-guarded)
router.post('/callback', intasendGuard, async (req, res) => {
    try {
        console.log('IntaSend STK Callback:', JSON.stringify(req.body, null, 2));

        const { invoice_id, state, api_ref, mpesa_reference } = req.body;

        if (state === 'COMPLETE' && invoice_id) {
            let matchedJob = await Job.findOne({
                checkoutRequestId: invoice_id,
                paymentStatus: 'Pending'
            });

            // Fallback: match by api_ref = "JOB-{jobId}"
            if (!matchedJob && api_ref && api_ref.startsWith('JOB-')) {
                matchedJob = await Job.findOne({ _id: api_ref.slice(4), paymentStatus: 'Pending' });
            }

            if (matchedJob) {
                matchedJob.paymentStatus      = 'In-Escrow';
                matchedJob.mpesaReceiptNumber = mpesa_reference || '';
                await matchedJob.save();
                console.log(`Job ${matchedJob._id} is now In-Escrow. Ref: ${mpesa_reference}`);

                if (matchedJob.hiredWorkerId) {
                    createNotification(
                        matchedJob.hiredWorkerId,
                        'escrow_funded',
                        'Payment Secured in Escrow 🔒',
                        `KES ${Number(matchedJob.pay).toLocaleString()} has been locked in escrow for "${matchedJob.title}". Complete the job to receive your payment.`,
                        'payments'
                    );
                }
            } else {
                console.log('No matching pending job for invoice_id:', invoice_id);
            }
        } else {
            console.log('STK Push not complete:', state, req.body);
        }

        res.json({ status: 'ok' });
    } catch (err) {
        console.error('STK Callback Error:', err.message);
        res.status(500).json({ status: 'error' });
    }
});

// ROUTE 3: Release Payment to Worker (employer owner only)
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

        job.paymentStatus = 'Releasing';
        await job.save();

        const remarks = `Payment for Kazi: ${job.title}`;
        try {
            const result = await mpesaPayout(worker.phone, job.pay, worker.name, remarks);
            job.workerPhone      = worker.phone;
            job.payoutTrackingId = result.tracking_id || '';
            await job.save();
        } catch (err) {
            job.paymentStatus = 'In-Escrow';
            await job.save();
            const errData = err.response?.data;
            console.error('Payout Release Error:', JSON.stringify(errData || err.message));
            const userMsg = errData?.detail || errData?.message || err.message || 'Unknown error';
            return res.status(500).json({ msg: `Release failed: ${userMsg}` });
        }

        res.json({ msg: 'Payment release initiated. Worker will receive M-Pesa confirmation shortly.' });
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
        const remarks  = `Refund for cancelled Kazi: ${job.title}`;

        job.paymentStatus = 'Refunding';
        await job.save();

        try {
            const result = await mpesaPayout(job.employerPhone, job.pay, employer?.name || 'Employer', remarks);
            job.payoutTrackingId = result.tracking_id || '';
            await job.save();
        } catch (err) {
            job.paymentStatus = 'In-Escrow';
            await job.save();
            const errData = err.response?.data;
            console.error('Payout Refund Error:', JSON.stringify(errData || err.message));
            const userMsg = errData?.detail || errData?.message || err.message || 'Unknown error';
            return res.status(500).json({ msg: `Refund failed: ${userMsg}` });
        }

        res.json({ msg: 'Refund initiated. You will receive M-Pesa confirmation shortly.' });
    } catch (err) {
        console.error('Refund Error:', err.response?.data || err.message);
        res.status(500).json({ msg: 'Failed to refund.' });
    }
});

// ROUTE 5: Payout Result Callback (webhook from IntaSend — signature-guarded)
router.post('/payout-callback', intasendGuard, async (req, res) => {
    try {
        console.log('IntaSend Payout Callback:', JSON.stringify(req.body, null, 2));

        const { tracking_id, status } = req.body;
        if (!tracking_id) return res.json({ status: 'ok' });

        const job = await Job.findOne({ payoutTrackingId: tracking_id });
        if (!job) return res.json({ status: 'ok' });

        // IntaSend payout success statuses
        const succeeded = ['TS', 'Complete', 'COMPLETE', 'SUCCESS'].includes(status);

        if (succeeded) {
            if (job.paymentStatus === 'Releasing') {
                job.paymentStatus = 'Released';
                job.status        = 'Completed';
                await job.save();
                console.log(`Job ${job._id} payment Released.`);

                if (job.hiredWorkerId) {
                    createNotification(
                        job.hiredWorkerId,
                        'payment_released',
                        'Payment Released to Your M-Pesa! 💰',
                        `KES ${Number(job.pay).toLocaleString()} for "${job.title}" has been sent to your M-Pesa. Check your phone!`,
                        'payments'
                    );
                }
            } else if (job.paymentStatus === 'Refunding') {
                job.paymentStatus = 'Refunded';
                job.status        = 'Open';
                await job.save();
                console.log(`Job ${job._id} Refunded to employer.`);

                createNotification(
                    job.employer,
                    'refunded',
                    'Refund Processed ↩️',
                    `KES ${Number(job.pay).toLocaleString()} for "${job.title}" has been refunded to your M-Pesa.`,
                    'payments'
                );
            }
        } else {
            if (job.paymentStatus === 'Releasing' || job.paymentStatus === 'Refunding') {
                const wasRefund   = job.paymentStatus === 'Refunding';
                job.paymentStatus = 'In-Escrow';
                await job.save();
                console.error(`Payout failed for job ${job._id}: status=${status}`);

                createNotification(
                    job.employer,
                    'general',
                    wasRefund ? 'Refund Failed ⚠️' : 'Payment Release Failed ⚠️',
                    `${wasRefund ? 'Refund' : 'Payment release'} for "${job.title}" failed. Please try again from your dashboard.`,
                    'payments'
                );
            }
        }

        res.json({ status: 'ok' });
    } catch (err) {
        console.error('Payout Callback Error:', err.message);
        res.status(500).json({ status: 'error' });
    }
});

module.exports = router;
