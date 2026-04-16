/**
 * ESCROW ROUTES — Kazi Mtaani (Secured)
 */
const express       = require('express');
const router        = express.Router();
const Job           = require('../models/job');
const User          = require('../models/user');
const { stkPush, b2cPayout }  = require('../services/daraja');
const protect       = require('../middleware/auth');
const mpesaIpGuard  = require('../middleware/mpesa');
const { createNotification }  = require('./notifications');

// ─── Phone format validation helper ──────────────────────────────────────────
// Accepts 254XXXXXXXXX (12 digits, Kenyan mobile prefixes 7xx/1xx)
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

        // Ownership check
        if (job.employer && job.employer.toString() !== req.user.id) {
            return res.status(403).json({ msg: 'Not authorized for this job.' });
        }

        if (job.paymentStatus !== 'Pending') {
            return res.status(400).json({ msg: `Job is already: ${job.paymentStatus}` });
        }

        job.employerPhone = employerPhone;
        await job.save();

        const darajaResponse = await stkPush(employerPhone, job.pay, job._id);

        // Store CheckoutRequestID server-side only — never sent to client
        job.checkoutRequestId = darajaResponse.CheckoutRequestID;
        await job.save();

        res.json({ msg: 'M-Pesa prompt sent! Check your phone.' });
    } catch (err) {
        console.error('STK Push Error:', err.response?.data || err.message);
        res.status(500).json({ msg: 'Failed to initiate payment.' });
    }
});

// ROUTE 2: STK Push Callback (webhook from Daraja — no JWT, IP-guarded)
router.post('/callback', mpesaIpGuard, async (req, res) => {
    try {
        const callbackData = req.body.Body?.stkCallback;
        if (!callbackData) {
            return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
        }

        const resultCode       = callbackData.ResultCode;
        const checkoutRequestID = callbackData.CheckoutRequestID;
        const metadata         = callbackData.CallbackMetadata?.Item || [];
        const receiptNumber    = metadata.find(i => i.Name === 'MpesaReceiptNumber')?.Value;

        console.log('Daraja Callback:', JSON.stringify(callbackData, null, 2));

        if (resultCode === 0 && checkoutRequestID) {
            // SECURE MATCH: Use CheckoutRequestID instead of amount
            const matchedJob = await Job.findOne({
                checkoutRequestId: checkoutRequestID,
                paymentStatus: 'Pending'
            });

            if (matchedJob) {
                matchedJob.paymentStatus     = 'In-Escrow';
                matchedJob.mpesaReceiptNumber = receiptNumber;
                await matchedJob.save();
                console.log(`Job ${matchedJob._id} is now In-Escrow. Receipt: ${receiptNumber}`);

                // Notify the hired worker that escrow is funded
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
                console.log('No matching pending job for CheckoutRequestID:', checkoutRequestID);
            }
        } else {
            console.log('Payment failed or cancelled:', callbackData.ResultDesc);
        }

        res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    } catch (err) {
        console.error('Callback Error:', err.message);
        res.status(500).json({ ResultCode: 1, ResultDesc: 'Error' });
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

        // Ownership check
        if (job.employer && job.employer.toString() !== req.user.id) {
            return res.status(403).json({ msg: 'Not authorized for this job.' });
        }

        if (job.paymentStatus !== 'In-Escrow') {
            return res.status(400).json({ msg: `Cannot release — status is: ${job.paymentStatus}` });
        }

        if (!job.hiredWorkerId) {
            return res.status(400).json({ msg: 'No worker hired for this job.' });
        }

        // Get worker's phone from DB — never trust client input for payment destination
        const worker = await User.findById(job.hiredWorkerId).select('phone name');
        if (!worker) return res.status(404).json({ msg: 'Hired worker account not found.' });
        if (!worker.phone) return res.status(400).json({ msg: 'Hired worker has no phone on record.' });

        // Transition to Releasing — prevents duplicate release attempts
        job.paymentStatus = 'Releasing';
        await job.save();

        const remarks = `Payment for Kazi: ${job.title}`;
        try {
            await b2cPayout(worker.phone, job.pay, job._id, remarks);
            job.workerPhone = worker.phone;
            await job.save();
        } catch (err) {
            // Revert status so employer can retry
            job.paymentStatus = 'In-Escrow';
            await job.save();
            console.error('B2C Release Error:', err.response?.data || err.message);
            return res.status(500).json({ msg: 'Failed to initiate payment release. Please try again.' });
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

        // Ownership check
        if (job.employer && job.employer.toString() !== req.user.id) {
            return res.status(403).json({ msg: 'Not authorized for this job.' });
        }

        if (job.paymentStatus !== 'In-Escrow') {
            return res.status(400).json({ msg: `Cannot refund — status is: ${job.paymentStatus}` });
        }

        if (!job.employerPhone) {
            return res.status(400).json({ msg: 'Employer phone not found on record.' });
        }

        // Transition to Refunding — prevents duplicate refund attempts
        job.paymentStatus = 'Refunding';
        await job.save();

        const remarks = `Refund for cancelled Kazi: ${job.title}`;
        try {
            await b2cPayout(job.employerPhone, job.pay, job._id, remarks);
        } catch (err) {
            job.paymentStatus = 'In-Escrow';
            await job.save();
            console.error('B2C Refund Error:', err.response?.data || err.message);
            return res.status(500).json({ msg: 'Failed to initiate refund. Please try again.' });
        }

        res.json({ msg: 'Refund initiated. You will receive M-Pesa confirmation shortly.' });
    } catch (err) {
        console.error('Refund Error:', err.response?.data || err.message);
        res.status(500).json({ msg: 'Failed to refund.' });
    }
});

// ROUTE 5: B2C Result Callback (webhook — no JWT, IP-guarded)
// Confirms whether a release or refund B2C payout actually succeeded
router.post('/b2c-callback', mpesaIpGuard, async (req, res) => {
    try {
        const result = req.body?.Result;
        if (!result) return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

        console.log('B2C Result:', JSON.stringify(result, null, 2));

        const resultCode = result.ResultCode;

        // Parse jobId from the Occasion field we set: "JOB-{jobId}"
        const refItems = result.ReferenceData?.ReferenceItem;
        const occasion = Array.isArray(refItems)
            ? refItems.find(i => i.Key === 'Occasion')?.Value
            : (refItems?.Key === 'Occasion' ? refItems.Value : null);

        if (!occasion || !occasion.startsWith('JOB-')) {
            return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
        }

        const jobId = occasion.slice(4);
        const job   = await Job.findById(jobId);
        if (!job) return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

        if (resultCode === 0) {
            // Payout succeeded
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
            // Payout failed — revert to In-Escrow so employer can retry
            if (job.paymentStatus === 'Releasing' || job.paymentStatus === 'Refunding') {
                const wasRefund = job.paymentStatus === 'Refunding';
                job.paymentStatus = 'In-Escrow';
                await job.save();
                console.error(`B2C failed for job ${job._id}: ${result.ResultDesc}`);

                // Notify employer that the payout failed
                createNotification(
                    job.employer,
                    'general',
                    wasRefund ? 'Refund Failed ⚠️' : 'Payment Release Failed ⚠️',
                    `${wasRefund ? 'Refund' : 'Payment release'} for "${job.title}" failed: ${result.ResultDesc}. Please try again from your dashboard.`,
                    'payments'
                );
            }
        }

        res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    } catch (err) {
        console.error('B2C Callback Error:', err.message);
        res.status(500).json({ ResultCode: 1, ResultDesc: 'Error' });
    }
});

// ROUTE 6: B2C Timeout Callback — revert to In-Escrow so employer can retry (IP-guarded)
router.post('/b2c-timeout', mpesaIpGuard, async (req, res) => {
    try {
        console.log('B2C Timeout:', JSON.stringify(req.body, null, 2));

        const refItems = req.body?.Request?.ReferenceData?.ReferenceItem;
        const occasion = Array.isArray(refItems)
            ? refItems.find(i => i.Key === 'Occasion')?.Value
            : (refItems?.Key === 'Occasion' ? refItems.Value : null);

        if (occasion && occasion.startsWith('JOB-')) {
            const jobId = occasion.slice(4);
            const job   = await Job.findById(jobId);
            if (job && (job.paymentStatus === 'Releasing' || job.paymentStatus === 'Refunding')) {
                job.paymentStatus = 'In-Escrow';
                await job.save();
                console.log(`Job ${job._id} reverted to In-Escrow after B2C timeout.`);
            }
        }

        res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    } catch (err) {
        console.error('B2C Timeout Error:', err.message);
        res.status(500).json({ ResultCode: 1, ResultDesc: 'Error' });
    }
});

module.exports = router;
