const express = require('express');
const router  = express.Router();
const Rating  = require('../models/Rating');
const Job     = require('../models/job');
const protect = require('../middleware/auth');

// POST /api/ratings — Employer rates a worker (authenticated)
router.post('/', protect, async (req, res) => {
    try {
        if (req.user.role !== 'employer') {
            return res.status(403).json({ msg: 'Only employers can rate workers.' });
        }

        const { jobId, workerName, stars, comment, tags } = req.body;

        if (!jobId || !workerName || !stars) {
            return res.status(400).json({ msg: 'Missing required fields.' });
        }
        if (stars < 1 || stars > 5) {
            return res.status(400).json({ msg: 'Stars must be between 1 and 5.' });
        }

        const job = await Job.findById(jobId);
        if (!job) return res.status(404).json({ msg: 'Job not found.' });

        if (job.employer && job.employer.toString() !== req.user.id) {
            return res.status(403).json({ msg: 'You can only rate workers on your own jobs.' });
        }
        if (job.paymentStatus !== 'Released') {
            return res.status(400).json({ msg: 'Can only rate after payment is released.' });
        }

        const existing = await Rating.findOne({ job: jobId, ratingType: 'worker' });
        if (existing) return res.status(400).json({ msg: 'You have already rated this job.' });

        const User = require('../models/user');
        const worker = await User.findOne({ name: workerName, role: 'worker' }).select('_id');

        const rating = new Rating({
            job:          jobId,
            ratingType:   'worker',
            reviewerName: req.user.name,
            reviewerId:   req.user.id,
            subjectName:  workerName,
            subjectId:    worker?._id,
            workerName,                     // backward compat for leaderboard
            employerName: req.user.name,
            employerId:   req.user.id,
            stars,
            comment: comment || '',
            tags:    tags || []
        });

        await rating.save();
        res.status(201).json({ msg: 'Rating submitted successfully!', rating });
    } catch (err) {
        if (err.code === 11000) return res.status(400).json({ msg: 'You have already rated this job.' });
        console.error('Rating Error:', err.message);
        res.status(500).json({ msg: 'Server error.' });
    }
});

// POST /api/ratings/employer — Worker rates an employer after job completion
router.post('/employer', protect, async (req, res) => {
    try {
        if (req.user.role !== 'worker') {
            return res.status(403).json({ msg: 'Only workers can rate employers.' });
        }

        const { jobId, stars, comment, tags } = req.body;
        if (!jobId || !stars) return res.status(400).json({ msg: 'jobId and stars are required.' });
        if (stars < 1 || stars > 5) return res.status(400).json({ msg: 'Stars must be 1–5.' });

        const job = await Job.findById(jobId).populate('employer', 'name');
        if (!job) return res.status(404).json({ msg: 'Job not found.' });

        // Only the hired worker can rate
        if (!job.hiredWorkerId || job.hiredWorkerId.toString() !== req.user.id) {
            return res.status(403).json({ msg: 'Only the hired worker can rate this job.' });
        }
        if (job.status !== 'Completed') {
            return res.status(400).json({ msg: 'Job must be completed before rating.' });
        }

        const existing = await Rating.findOne({ job: jobId, ratingType: 'employer' });
        if (existing) return res.status(400).json({ msg: 'You have already rated this employer.' });

        const rating = new Rating({
            job:          jobId,
            ratingType:   'employer',
            reviewerName: req.user.name,
            reviewerId:   req.user.id,
            subjectName:  job.employer?.name || '',
            subjectId:    job.employer?._id,
            employerName: job.employer?.name || '',
            employerId:   job.employer?._id,
            workerName:   req.user.name,
            stars,
            comment: comment || '',
            tags:    tags || []
        });

        await rating.save();

        // Notify the employer
        if (job.employer?._id) {
            const { createNotification } = require('./notifications');
            createNotification(
                job.employer._id,
                'general',
                `New review from ${req.user.name}`,
                `${req.user.name} left you a ${stars}-star review for "${job.title}".`,
                'profile'
            );
        }

        res.status(201).json({ msg: 'Employer rated successfully!', rating });
    } catch (err) {
        if (err.code === 11000) return res.status(400).json({ msg: 'You have already rated this employer.' });
        console.error('Employer Rating Error:', err.message);
        res.status(500).json({ msg: 'Server error.' });
    }
});

// GET /api/ratings/worker/:workerName (public)
router.get('/worker/:workerName', async (req, res) => {
    try {
        const ratings = await Rating.find({ workerName: req.params.workerName })
            .sort({ createdAt: -1 });

        const totalRatings = ratings.length;
        const avgRating = totalRatings > 0
            ? (ratings.reduce((sum, r) => sum + r.stars, 0) / totalRatings).toFixed(1)
            : 0;

        const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
        ratings.forEach(r => { if (distribution[r.stars] !== undefined) distribution[r.stars]++; });

        res.json({ ratings, avgRating: Number(avgRating), totalRatings, distribution });
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

// GET /api/ratings/job/:jobId (public)
router.get('/job/:jobId', async (req, res) => {
    try {
        const rating = await Rating.findOne({ job: req.params.jobId });
        res.json({ rated: !!rating, rating });
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

// GET /api/ratings/all — worker leaderboard (public)
router.get('/all', async (req, res) => {
    try {
        const leaderboard = await Rating.aggregate([
            { $match: { ratingType: { $in: ['worker', null] } } },   // worker ratings only
            {
                $group: {
                    _id:          '$workerName',
                    avgRating:    { $avg: '$stars' },
                    totalRatings: { $sum: 1 },
                    recentComment:{ $last: '$comment' }
                }
            },
            { $sort: { avgRating: -1, totalRatings: -1 } },
            { $limit: 20 }
        ]);
        res.json(leaderboard);
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

// GET /api/ratings/employer/:employerName — employer's received ratings (public)
router.get('/employer/:employerName', async (req, res) => {
    try {
        const ratings = await Rating.find({
            ratingType:  'employer',
            subjectName: req.params.employerName
        }).sort({ createdAt: -1 });

        const total = ratings.length;
        const avg   = total > 0
            ? Number((ratings.reduce((s, r) => s + r.stars, 0) / total).toFixed(1))
            : 0;

        res.json({ ratings, avgRating: avg, totalRatings: total });
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

module.exports = router;
