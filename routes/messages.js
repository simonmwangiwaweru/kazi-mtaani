/**
 * MESSAGES — job-scoped chat between employer and hired/applied worker.
 * Both parties on a job (employer + any applicant) can send messages.
 */
const express = require('express');
const router  = express.Router();
const Message = require('../models/Message');
const Job     = require('../models/job');
const protect = require('../middleware/auth');

function sanitize(val, max) {
    if (!val) return '';
    return String(val).replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim().slice(0, max || 1000);
}

// Verify the user is a participant of this job (employer or applicant/hired worker)
async function getJobAndVerify(jobId, userId) {
    const job = await Job.findById(jobId);
    if (!job) return null;
    const isEmployer = job.employer && job.employer.toString() === userId;
    const isWorker   = job.hiredWorkerId?.toString() === userId ||
                       (job.applicants && job.applicants.length > 0); // any applicant
    if (!isEmployer && !isWorker) return null;
    return job;
}

// POST /api/messages/:jobId — send a message
router.post('/:jobId', protect, async (req, res) => {
    try {
        const { content } = req.body;
        if (!content || !content.trim()) {
            return res.status(400).json({ msg: 'Message content is required.' });
        }

        const job = await Job.findById(req.params.jobId);
        if (!job) return res.status(404).json({ msg: 'Job not found.' });

        const isEmployer = job.employer?.toString() === req.user.id;
        const isApplicant = job.applicants?.includes(req.user.name) ||
                            job.hiredWorkerId?.toString() === req.user.id;

        if (!isEmployer && !isApplicant) {
            return res.status(403).json({ msg: 'Not a participant of this job.' });
        }

        const msg = await Message.create({
            jobId:      job._id,
            senderId:   req.user.id,
            senderName: req.user.name,
            senderRole: req.user.role,
            content:    sanitize(content, 1000),
        });

        res.status(201).json(msg);
    } catch (err) {
        console.error('Message send error:', err.message);
        res.status(500).json({ msg: 'Server error.' });
    }
});

// GET /api/messages/:jobId — fetch conversation for a job
router.get('/:jobId', protect, async (req, res) => {
    try {
        const job = await Job.findById(req.params.jobId);
        if (!job) return res.status(404).json({ msg: 'Job not found.' });

        const isEmployer  = job.employer?.toString() === req.user.id;
        const isApplicant = job.applicants?.includes(req.user.name) ||
                            job.hiredWorkerId?.toString() === req.user.id;

        if (!isEmployer && !isApplicant) {
            return res.status(403).json({ msg: 'Not a participant of this job.' });
        }

        const messages = await Message.find({ jobId: req.params.jobId })
            .sort({ createdAt: 1 })
            .limit(200);

        // Mark unread messages from other party as read
        await Message.updateMany(
            { jobId: req.params.jobId, senderId: { $ne: req.user.id }, read: false },
            { read: true }
        );

        res.json({ messages, jobTitle: job.title });
    } catch (err) {
        console.error('Message fetch error:', err.message);
        res.status(500).json({ msg: 'Server error.' });
    }
});

// GET /api/messages/unread-count — total unread messages for the logged-in user
router.get('/meta/unread-count', protect, async (req, res) => {
    try {
        // Find all jobs user is involved in
        const jobs = await Job.find({
            $or: [
                { employer: req.user.id },
                { hiredWorkerId: req.user.id },
                { applicants: req.user.name }
            ]
        }).select('_id');

        const jobIds = jobs.map(j => j._id);
        const count  = await Message.countDocuments({
            jobId:    { $in: jobIds },
            senderId: { $ne: req.user.id },
            read:     false
        });

        res.json({ unreadCount: count });
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

// GET /api/messages — list all conversations (jobs with messages) for the user
router.get('/', protect, async (req, res) => {
    try {
        const jobs = await Job.find({
            $or: [
                { employer: req.user.id },
                { hiredWorkerId: req.user.id },
                { applicants: req.user.name }
            ]
        }).select('_id title employer hiredWorker status').populate('employer', 'name').lean();

        const jobIds = jobs.map(j => j._id);

        // Last message + unread count per job
        const summaries = await Promise.all(jobs.map(async job => {
            const [lastMsg, unread] = await Promise.all([
                Message.findOne({ jobId: job._id }).sort({ createdAt: -1 }).lean(),
                Message.countDocuments({ jobId: job._id, senderId: { $ne: req.user.id }, read: false })
            ]);
            return { job, lastMsg, unread };
        }));

        // Only return jobs that actually have messages
        const active = summaries.filter(s => s.lastMsg);
        active.sort((a, b) => new Date(b.lastMsg.createdAt) - new Date(a.lastMsg.createdAt));

        res.json(active);
    } catch (err) {
        console.error('Conversations error:', err.message);
        res.status(500).json({ msg: 'Server error.' });
    }
});

module.exports = router;
