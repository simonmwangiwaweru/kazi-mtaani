const express    = require('express');
const router     = express.Router();
const Job        = require('../models/job');
const User       = require('../models/user');
const protect    = require('../middleware/auth');
const AuditLog   = require('../models/AuditLog');
const { createNotification } = require('./notifications');
const { sendSMS }            = require('../services/sms');

function audit(userId, userName, action, entity, entityId, details, req) {
    const ip = (req?.header('x-forwarded-for') || req?.ip || '').split(',')[0].trim();
    AuditLog.create({ userId, userName, action, entity, entityId, details, ip }).catch(() => {});
}

// Strip HTML tags and trim. Prevents stored XSS from reaching the database.
function sanitizeText(val, maxLen) {
    if (val === null || val === undefined) return '';
    return String(val).replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim().slice(0, maxLen || 2000);
}

// 1. GET jobs (public) — supports ?search, ?category, ?status, ?page, ?limit
router.get('/', async (req, res) => {
    try {
        const { search, category, status, page = 1, limit = 50 } = req.query;
        const query = {};

        if (search && search.trim()) {
            const re = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            query.$or = [{ title: re }, { description: re }, { location: re }];
        }
        if (category && category !== 'all') {
            query.category = category;
        }
        if (status === 'open') {
            query.status = 'Open';
        }

        const pageNum  = Math.max(1, parseInt(page)  || 1);
        const limitNum = Math.min(100, parseInt(limit) || 50);
        const skip     = (pageNum - 1) * limitNum;

        const [rawJobs, total] = await Promise.all([
            Job.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum)
                .populate('applicants', 'name'),
            Job.countDocuments(query)
        ]);

        // Return applicants as name strings for dashboard backward-compatibility
        const jobs = rawJobs.map(j => {
            const obj = j.toObject();
            obj.applicants = (obj.applicants || []).map(a => a?.name || String(a));
            return obj;
        });

        res.json({ jobs, total, page: pageNum, pages: Math.ceil(total / limitNum) });
    } catch (err) {
        res.status(500).json({ msg: 'Server error fetching jobs.' });
    }
});

// 2. POST a new job (employer only, authenticated)
router.post('/', protect, async (req, res) => {
    try {
        // Only employers can post jobs
        if (req.user.role !== 'employer') {
            return res.status(403).json({ msg: 'Only employers can post jobs.' });
        }

        // Whitelist allowed fields — prevent mass assignment
        const { title, description, location, pay, category, employerPhone, duration } = req.body;
        let   { requiredSkills } = req.body;

        if (!title || !description || !location || !pay || !category) {
            return res.status(400).json({ msg: 'All fields are required.' });
        }

        // Validate pay amount
        const payAmount = Number(pay);
        if (isNaN(payAmount) || payAmount < 1 || payAmount > 1000000) {
            return res.status(400).json({ msg: 'Pay must be between 1 and 1,000,000 KES.' });
        }

        const VALID_CATEGORIES = ['artisan', 'technical', 'transport', 'cleaning', 'casual'];
        const safeCategory = VALID_CATEGORIES.includes(category) ? category : 'casual';

        // Sanitize skills array (max 10)
        if (!Array.isArray(requiredSkills)) requiredSkills = [];
        const safeSkills = requiredSkills
            .map(s => sanitizeText(s, 60))
            .filter(Boolean)
            .slice(0, 10);

        const newJob = new Job({
            title:          sanitizeText(title, 120),
            description:    sanitizeText(description, 2000),
            location:       sanitizeText(location, 120),
            pay:            payAmount,
            category:       safeCategory,
            employer:       req.user.id,
            employerPhone:  sanitizeText(employerPhone, 20),
            requiredSkills: safeSkills,
            duration:       sanitizeText(duration || '', 100),
        });

        const savedJob = await newJob.save();
        audit(req.user.id, req.user.name, 'job_posted', 'job', savedJob._id.toString(), savedJob.title, req);

        // ── Skill + locality matched notifications + SMS ─────────────────────────
        // Find workers whose skills overlap AND whose location matches the job area.
        // Falls back to skill-only match if no location overlap found.
        if (safeSkills.length > 0 || safeCategory) {
            const locationWords = savedJob.location.split(/[\s,]+/).filter(w => w.length > 2);
            const locationRegexes = locationWords.map(w => new RegExp(w, 'i'));

            const skillQuery = safeSkills.length > 0
                ? { role: 'worker', skills: { $in: safeSkills.map(s => new RegExp(s, 'i')) } }
                : { role: 'worker', specialization: new RegExp(safeCategory, 'i') };

            // Prefer workers in the same area; fall back to any skill match (max 20 total)
            let matchingWorkers = await User.find({
                ...skillQuery,
                $or: [
                    { 'location.county':    { $in: locationRegexes } },
                    { 'location.subCounty': { $in: locationRegexes } },
                ]
            }).select('_id phone').limit(20).lean();

            if (matchingWorkers.length === 0) {
                matchingWorkers = await User.find(skillQuery).select('_id phone').limit(20).lean();
            }

            const smsText = `New job in ${savedJob.location}: "${savedJob.title}" — KES ${Number(savedJob.pay).toLocaleString()}. Apply at kazimtaani.co.ke`;

            console.log(`Job alert: found ${matchingWorkers.length} matching worker(s) for "${savedJob.title}"`);
            matchingWorkers.forEach(w => {
                createNotification(
                    w._id,
                    'new_job',
                    `New job matches your skills: ${savedJob.title}`,
                    `${req.user.name} posted a ${safeCategory} job in ${savedJob.location} — KES ${Number(savedJob.pay).toLocaleString()}. Apply now!`,
                    'jobs'
                );
                if (w.phone) {
                    console.log(`Sending job alert SMS to ${w.phone}`);
                    sendSMS(w.phone, smsText)
                        .then(() => console.log(`Job alert SMS sent to ${w.phone}`))
                        .catch(err => console.error(`Job alert SMS failed for ${w.phone}:`, err.message));
                }
            });
        }

        res.status(201).json(savedJob);
    } catch (err) {
        res.status(400).json({ msg: 'Failed to create job.' });
    }
});

// 3. GET single job by ID
router.get('/:id', async (req, res) => {
    try {
        const job = await Job.findById(req.params.id).lean();
        if (!job) return res.status(404).json({ msg: 'Job not found.' });
        res.json(job);
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

// 4. EDIT a job (owner only, Open jobs only)
router.put('/:id/edit', protect, async (req, res) => {
    try {
        const job = await Job.findById(req.params.id);
        if (!job) return res.status(404).json({ msg: 'Job not found.' });
        if (job.employer && job.employer.toString() !== req.user.id)
            return res.status(403).json({ msg: 'Not authorized.' });
        if (job.status !== 'Open')
            return res.status(400).json({ msg: 'Only Open jobs can be edited.' });

        const { title, description, location, pay, category, duration } = req.body;
        let { requiredSkills } = req.body;

        if (!title || !description || !location || !pay || !category)
            return res.status(400).json({ msg: 'All fields are required.' });

        const payAmount = Number(pay);
        if (isNaN(payAmount) || payAmount < 1 || payAmount > 1000000)
            return res.status(400).json({ msg: 'Pay must be between 1 and 1,000,000 KES.' });

        const VALID_CATEGORIES = ['artisan', 'technical', 'transport', 'cleaning', 'casual'];
        if (!Array.isArray(requiredSkills)) requiredSkills = [];
        const safeSkills = requiredSkills.map(s => sanitizeText(s, 60)).filter(Boolean).slice(0, 10);

        job.title       = sanitizeText(title, 120);
        job.description = sanitizeText(description, 2000);
        job.location    = sanitizeText(location, 120);
        job.pay         = payAmount;
        job.category    = VALID_CATEGORIES.includes(category) ? category : 'casual';
        job.duration    = sanitizeText(duration || '', 60);
        job.requiredSkills = safeSkills;
        await job.save();

        res.json(job);
    } catch (err) {
        res.status(500).json({ msg: 'Server error updating job.' });
    }
});

// 4. DELETE a job (owner only, authenticated)
router.delete('/:id', protect, async (req, res) => {
    try {
        const job = await Job.findById(req.params.id);
        if (!job) return res.status(404).json({ msg: 'Job not found.' });

        // Ownership check — only the employer who posted can delete
        if (job.employer && job.employer.toString() !== req.user.id) {
            return res.status(403).json({ msg: 'Not authorized to delete this job.' });
        }

        await Job.findByIdAndDelete(req.params.id);
        res.json({ msg: 'Job deleted successfully.' });
    } catch (err) {
        res.status(500).json({ msg: 'Server error deleting job.' });
    }
});

// 4. APPLY for a job (worker only, authenticated)
router.put('/apply/:id', protect, async (req, res) => {
    try {
        if (req.user.role !== 'worker') {
            return res.status(403).json({ msg: 'Only workers can apply for jobs.' });
        }

        const job = await Job.findByIdAndUpdate(
            req.params.id,
            { $addToSet: { applicants: req.user.id } },
            { new: true }
        ).populate('applicants', 'name');

        if (!job) return res.status(404).json({ msg: 'Job not found.' });

        // Normalize applicants to names for response
        const jobObj = job.toObject();
        jobObj.applicants = (jobObj.applicants || []).map(a => a?.name || String(a));

        // Notify the employer that someone applied
        if (job.employer) {
            createNotification(
                job.employer,
                'applied',
                'New Application Received 📬',
                `${req.user.name} has applied for your job: "${job.title}"`,
                'jobs'
            );
        }

        res.json({ msg: 'Application successful!', job: jobObj });
    } catch (err) {
        res.status(500).json({ msg: 'Server error. Could not apply.' });
    }
});

// 5. HIRE a worker (employer owner only, authenticated)
router.put('/hire/:id', protect, async (req, res) => {
    try {
        if (req.user.role !== 'employer') {
            return res.status(403).json({ msg: 'Only employers can hire.' });
        }

        const { workerId } = req.body;
        if (!workerId) {
            return res.status(400).json({ msg: 'workerId is required.' });
        }

        // Look up worker by ID — avoids ambiguity with duplicate names
        const worker = await User.findById(workerId).select('name role phone');
        if (!worker) return res.status(404).json({ msg: 'Worker not found.' });
        if (worker.role !== 'worker') {
            return res.status(400).json({ msg: 'Selected user is not a worker.' });
        }

        const job = await Job.findById(req.params.id);
        if (!job) return res.status(404).json({ msg: 'Job not found.' });

        // Ownership check
        if (job.employer && job.employer.toString() !== req.user.id) {
            return res.status(403).json({ msg: 'Not authorized to hire for this job.' });
        }

        // Escrow must be funded before a worker can be hired
        if (job.paymentStatus !== 'In-Escrow') {
            return res.status(400).json({
                msg: 'Escrow must be funded before hiring. Go to the Payments tab and deposit the job amount via M-Pesa first.'
            });
        }

        job.status = 'In Progress';
        job.hiredWorker   = worker.name;
        job.hiredWorkerId = worker._id;
        await job.save();

        createNotification(
            worker._id,
            'hired',
            'You\'ve Been Hired! 🎉',
            `${req.user.name} has hired you for: "${job.title}". Check your dashboard for next steps.`,
            'jobs'
        );

        if (worker.phone) {
            sendSMS(
                worker.phone,
                `Congratulations ${worker.name.split(' ')[0]}! You have been hired for "${job.title}" by ${req.user.name}. Login at kazimtaani.co.ke for next steps.`
            ).catch(err => console.error('Hire SMS failed:', err.message));
        }

        res.json(job);
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

// 6. COMPLETE a job (employer only, authenticated)
router.put('/complete/:id', protect, async (req, res) => {
    try {
        if (req.user.role !== 'employer') {
            return res.status(403).json({ msg: 'Only employers can mark jobs as complete.' });
        }

        const job = await Job.findById(req.params.id);
        if (!job) return res.status(404).json({ msg: 'Job not found.' });

        if (job.employer && job.employer.toString() !== req.user.id) {
            return res.status(403).json({ msg: 'Not authorized.' });
        }

        if (job.status !== 'In Progress') {
            return res.status(400).json({ msg: 'Only In Progress jobs can be marked as done.' });
        }

        job.status = 'Completed';
        await job.save();

        // Notify the worker
        if (job.hiredWorkerId) {
            createNotification(
                job.hiredWorkerId,
                'completed',
                'Job Marked Complete ✅',
                `${req.user.name} has marked "${job.title}" as complete. Payment will be released to you soon.`,
                'jobs'
            );
        }

        res.json(job);
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

// 7. GET /api/jobs/workers — employer searches for workers by skill/location/category
// Requires auth (employer only). Public worker profiles only — no phone/email.
router.get('/workers', protect, async (req, res) => {
    try {
        if (req.user.role !== 'employer' && req.user.role !== 'admin') {
            return res.status(403).json({ msg: 'Only employers can search for workers.' });
        }

        const { skill, location, category, page = 1, limit = 20 } = req.query;
        const query = { role: 'worker' };

        if (skill && skill.trim()) {
            query.skills = { $regex: skill.trim(), $options: 'i' };
        }
        if (location && location.trim()) {
            query.$or = [
                { 'location.county':    { $regex: location.trim(), $options: 'i' } },
                { 'location.subCounty': { $regex: location.trim(), $options: 'i' } }
            ];
        }
        if (category && category.trim()) {
            if (!query.$or) {
                query.specialization = { $regex: category.trim(), $options: 'i' };
            }
        }

        const pageNum  = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(50, parseInt(limit) || 20);

        const [workers, total] = await Promise.all([
            User.find(query)
                .select('name bio skills specialization location experienceYears rating isVerified verificationStatus dateJoined')
                .sort({ rating: -1, dateJoined: -1 })
                .skip((pageNum - 1) * limitNum)
                .limit(limitNum),
            User.countDocuments(query)
        ]);

        res.json({ workers, total, page: pageNum, pages: Math.ceil(total / limitNum) });
    } catch (err) {
        console.error('Worker search error:', err.message);
        res.status(500).json({ msg: 'Server error.' });
    }
});

module.exports = router;