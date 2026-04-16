const express    = require('express');
const router     = express.Router();
const path       = require('path');
const fs         = require('fs');
const User       = require('../models/user');
const Job        = require('../models/job');
const AuditLog   = require('../models/AuditLog');
const adminGuard = require('../middleware/admin');
const { createNotification } = require('./notifications');

// GET /api/admin/stats
router.get('/stats', adminGuard, async (req, res) => {
    try {
        const [totalUsers, totalJobs, activeJobs, escrowJobs] = await Promise.all([
            User.countDocuments(),
            Job.countDocuments(),
            Job.countDocuments({ status: { $ne: 'Completed' } }),
            Job.find({ paymentStatus: 'In-Escrow' }).select('pay')
        ]);
        const escrowTotal = escrowJobs.reduce((s, j) => s + Number(j.pay || 0), 0);
        res.json({ totalUsers, totalJobs, activeJobs, escrowTotal });
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

        // Delete the uploaded document
        if (user.verificationDoc) {
            const docPath = path.join(__dirname, '..', 'uploads', 'verification', path.basename(user.verificationDoc));
            if (fs.existsSync(docPath)) fs.unlinkSync(docPath);
        }

        user.verificationStatus = 'rejected';
        user.verificationDoc    = '';
        user.verificationNote   = reason || 'Document could not be verified.';
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

module.exports = router;
