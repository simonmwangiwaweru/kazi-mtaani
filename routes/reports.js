/**
 * REPORTS — aggregated stats for workers and employers.
 */
const express = require('express');
const router  = express.Router();
const Job     = require('../models/job');
const Rating  = require('../models/Rating');
const protect = require('../middleware/auth');

// GET /api/reports/worker — stats for the logged-in worker
router.get('/worker', protect, async (req, res) => {
    try {
        if (req.user.role !== 'worker') {
            return res.status(403).json({ msg: 'Only workers can access worker reports.' });
        }

        const allJobs = await Job.find({
            $or: [
                { hiredWorker: req.user.name },
                { applicants:  req.user.name }
            ]
        }).lean();

        const applied    = allJobs.filter(j => j.applicants?.includes(req.user.name)).length;
        const hired      = allJobs.filter(j => j.hiredWorker === req.user.name).length;
        const completed  = allJobs.filter(j => j.hiredWorker === req.user.name && j.status === 'Completed').length;
        const earned     = allJobs.filter(j => j.hiredWorker === req.user.name && j.paymentStatus === 'Released')
                                  .reduce((s, j) => s + Number(j.pay || 0), 0);
        const pending    = allJobs.filter(j => j.hiredWorker === req.user.name && j.paymentStatus === 'In-Escrow')
                                  .reduce((s, j) => s + Number(j.pay || 0), 0);

        const ratings = await Rating.find({ workerName: req.user.name, ratingType: { $in: ['worker', null] } }).lean();
        const avgRating  = ratings.length > 0
            ? Number((ratings.reduce((s, r) => s + r.stars, 0) / ratings.length).toFixed(1))
            : 0;

        // Jobs by category
        const byCategory = {};
        allJobs.filter(j => j.hiredWorker === req.user.name).forEach(j => {
            byCategory[j.category] = (byCategory[j.category] || 0) + 1;
        });

        // Monthly earnings (last 6 months)
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        const monthly = {};
        allJobs
            .filter(j => j.hiredWorker === req.user.name && j.paymentStatus === 'Released' && new Date(j.createdAt) >= sixMonthsAgo)
            .forEach(j => {
                const key = new Date(j.createdAt).toLocaleDateString('en-KE', { month: 'short', year: 'numeric' });
                monthly[key] = (monthly[key] || 0) + Number(j.pay || 0);
            });

        res.json({ applied, hired, completed, earned, pending, avgRating, totalRatings: ratings.length, byCategory, monthly });
    } catch (err) {
        console.error('Worker report error:', err.message);
        res.status(500).json({ msg: 'Server error.' });
    }
});

// GET /api/reports/employer — stats for the logged-in employer
router.get('/employer', protect, async (req, res) => {
    try {
        if (req.user.role !== 'employer') {
            return res.status(403).json({ msg: 'Only employers can access employer reports.' });
        }

        const allJobs = await Job.find({ employer: req.user.id }).lean();

        const posted    = allJobs.length;
        const active    = allJobs.filter(j => j.status !== 'Completed').length;
        const completed = allJobs.filter(j => j.status === 'Completed').length;
        const spent     = allJobs.filter(j => j.paymentStatus === 'Released')
                                 .reduce((s, j) => s + Number(j.pay || 0), 0);
        const inEscrow  = allJobs.filter(j => j.paymentStatus === 'In-Escrow')
                                 .reduce((s, j) => s + Number(j.pay || 0), 0);

        const ratings = await Rating.find({ employerId: req.user.id, ratingType: 'employer' }).lean();
        const avgRating = ratings.length > 0
            ? Number((ratings.reduce((s, r) => s + r.stars, 0) / ratings.length).toFixed(1))
            : 0;

        const byCategory = {};
        allJobs.forEach(j => {
            byCategory[j.category] = (byCategory[j.category] || 0) + 1;
        });

        res.json({ posted, active, completed, spent, inEscrow, avgRating, totalRatings: ratings.length, byCategory });
    } catch (err) {
        console.error('Employer report error:', err.message);
        res.status(500).json({ msg: 'Server error.' });
    }
});

module.exports = router;
