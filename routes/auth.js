const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const User = require('../models/user');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const protect = require('../middleware/auth');
const { sendSMS } = require('../services/sms');
const AuditLog = require('../models/AuditLog');

function audit(userId, userName, action, req) {
    const ip = (req?.header('x-forwarded-for') || req?.ip || '').split(',')[0].trim();
    AuditLog.create({ userId, userName, action, entity: 'user', entityId: String(userId), ip }).catch(() => {});
}

// Strip HTML tags and trim. Prevents stored XSS from reaching the database.
function sanitizeText(val, maxLen) {
    if (val === null || val === undefined) return '';
    return String(val).replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim().slice(0, maxLen || 500);
}

// Rate limiter for auth routes — 30 attempts per 15 minutes
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: { msg: 'Too many attempts. Please try again in 15 minutes.' }
});

// Helper: generate a signed JWT
function generateToken(user) {
    return jwt.sign(
        { id: user._id, name: user.name, role: user.role, tokenVersion: user.tokenVersion },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
    );
}

// Helper: set JWT as a secure httpOnly cookie
function setAuthCookie(res, token) {
    res.cookie('token', token, {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
        maxAge:   24 * 60 * 60 * 1000  // 24 h
    });
}

// Helper: clear the auth cookie on logout
function clearAuthCookie(res) {
    res.clearCookie('token', {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
    });
}

// @route   POST /api/auth/register
router.post('/register', authLimiter, async (req, res) => {
    try {
        const { name, phone, password } = req.body;

        // Validate required fields
        if (!name || !phone || !password) {
            return res.status(400).json({ msg: 'Name, phone, and password are required.' });
        }

        // Enforce strong password (same rules as the frontend)
        const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#^_\-])[A-Za-z\d@$!%*?&#^_\-]{8,}$/;
        if (!passwordRegex.test(password)) {
            return res.status(400).json({ msg: 'Password must contain uppercase, lowercase, a number, and a special character (@$!%*?&#^_-).' });
        }

        // Check if user exists
        let user = await User.findOne({ phone });
        if (user) {
            return res.status(400).json({ msg: 'User already exists with this phone number.' });
        }

        // SECURITY: Only allow 'worker' or 'employer' roles from registration
        // The role from req.body is read but forced to a safe value
        let safeRole = 'worker';
        if (req.body.role === 'employer') safeRole = 'employer';
        // 'admin' can NEVER be self-assigned — must be set in the database directly

        user = new User({ name: sanitizeText(name, 60), phone, password, role: safeRole });
        await user.save();

        // Generate JWT so user is logged in immediately after registration
        const token = generateToken(user);
        setAuthCookie(res, token);
        audit(user._id, user.name, 'register', req);

        res.status(201).json({
            msg: 'User registered successfully!',
            token,
            user: {
                id: user._id,
                name: user.name,
                role: user.role,
                phone: user.phone
            }
        });
    } catch (err) {
        console.error('Registration Error:', err.message);
        res.status(500).json({ msg: 'Server error. Please try again.' });
    }
});

// @route   POST /api/auth/login
router.post('/login', authLimiter, async (req, res) => {
    try {
        const { phone, password } = req.body;

        if (!phone || !password) {
            return res.status(400).json({ msg: 'Phone and password are required.' });
        }

        const user = await User.findOne({ phone });
        if (!user) {
            return res.status(400).json({ msg: 'Invalid credentials.' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ msg: 'Invalid credentials.' });
        }

        // Generate JWT
        const token = generateToken(user);
        setAuthCookie(res, token);
        audit(user._id, user.name, 'login', req);

        res.json({
            msg: 'Login successful!',
            token,
            user: {
                id: user._id,
                name: user.name,
                role: user.role,
                phone: user.phone
            }
        });
    } catch (err) {
        console.error('Login Error:', err.message);
        res.status(500).json({ msg: 'Server error during login.' });
    }
});

// @route   POST /api/auth/logout
router.post('/logout', protect, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (user) {
            user.tokenVersion += 1;
            await user.save();
        }
        clearAuthCookie(res);
        res.json({ msg: 'Logged out successfully!' });
    } catch (err) {
        console.error('Logout Error:', err.message);
        res.status(500).json({ msg: 'Server error during logout.' });
    }
});

router.get('/me', protect, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-password -tokenVersion ');
        if (!user) return res.status(404).json({ msg: 'User not found.' });
        res.json(user);
    } catch (err) {
        console.error('Profile fetch error:', err.message);
        res.status(500).json({ msg: 'Server error.' });
    }
});

// @route   PUT /api/auth/profile  — update logged-in user's profile
router.put('/profile', protect, async (req, res) => {
    try {
        const allowed = ['bio', 'skills', 'location', 'phone', 'experienceYears', 'specialization'];
        const updates = {};
        allowed.forEach(field => {
            if (req.body[field] === undefined) return;
            if (field === 'bio')           updates.bio = sanitizeText(req.body.bio, 600);
            else if (field === 'specialization') updates.specialization = sanitizeText(req.body.specialization, 120);
            else if (field === 'skills' && Array.isArray(req.body.skills))
                updates.skills = req.body.skills.map(s => sanitizeText(s, 60)).filter(Boolean).slice(0, 20);
            else if (field === 'location' && req.body.location && typeof req.body.location === 'object')
                updates.location = {
                    county:    sanitizeText(req.body.location.county, 60),
                    subCounty: sanitizeText(req.body.location.subCounty, 60),
                };
            else if (field === 'experienceYears') updates.experienceYears = Math.min(60, Math.max(0, parseInt(req.body.experienceYears) || 0));
            else updates[field] = req.body[field];
        });

        // Validate phone uniqueness if changed
        if (updates.phone) {
            const conflict = await User.findOne({ phone: updates.phone, _id: { $ne: req.user.id } });
            if (conflict) return res.status(400).json({ msg: 'Phone number already in use.' });
        }

        const user = await User.findByIdAndUpdate(
            req.user.id,
            { $set: updates },
            { new: true, runValidators: true }
        ).select('-password -tokenVersion ');

        // Notify employers with open jobs that match this worker's updated skills
        if (user.role === 'worker' && updates.skills && updates.skills.length > 0) {
            const Job = require('../models/job');
            const { createNotification } = require('./notifications');
            const matchingJobs = await Job.find({
                status: 'Open',
                requiredSkills: { $in: updates.skills.map(s => new RegExp(s, 'i')) }
            }).select('employer title').limit(10).lean();

            matchingJobs.forEach(job => {
                if (job.employer) {
                    createNotification(
                        job.employer,
                        'general',
                        `New worker available: ${user.name}`,
                        `${user.name} has skills matching your open job "${job.title}". Check their profile!`,
                        'jobs'
                    );
                }
            });
        }

        res.json({ msg: 'Profile updated!', user });
    } catch (err) {
        console.error('Profile update error:', err.message);
        res.status(500).json({ msg: 'Server error.' });
    }
});

// @route   GET /api/auth/lookup?name=X  — employer looks up a worker's ID by name
// Used by the frontend hire button to get a workerId before calling /api/jobs/hire
router.get('/lookup', protect, async (req, res) => {
    try {
        if (req.user.role !== 'employer') {
            return res.status(403).json({ msg: 'Only employers can look up workers.' });
        }
        const { name } = req.query;
        if (!name || !name.trim()) {
            return res.status(400).json({ msg: 'name query parameter is required.' });
        }
        const user = await User.findOne({ name: name.trim(), role: 'worker' }).select('_id name phone');
        if (!user) return res.status(404).json({ msg: 'Worker not found.' });
        res.json({ id: user._id, name: user.name, phone: user.phone });
    } catch (err) {
        console.error('Lookup error:', err.message);
        res.status(500).json({ msg: 'Server error.' });
    }
});

// @route   GET /api/auth/worker/:name  — public worker profile (no phone/email)
router.get('/worker/:name', async (req, res) => {
    try {
        const user = await User.findOne({ name: req.params.name, role: 'worker' })
            .select('name bio skills experienceYears specialization location rating isVerified dateJoined');
        if (!user) return res.status(404).json({ msg: 'Worker not found.' });
        res.json(user);
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

// @route   POST /api/auth/forgot  — request password reset OTP
router.post('/forgot', authLimiter, async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ msg: 'Phone number is required.' });

        const normalised = phone.startsWith('0') ? '254' + phone.slice(1) : phone;
        const user = await User.findOne({ phone: normalised });
        // Always respond the same way — don't reveal if phone is registered
        if (!user) return res.json({ msg: 'If that number is registered, an OTP has been sent.' });

        // Generate 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.resetOTP        = otp;
        user.resetOTPExpiry  = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
        await user.save();

        await sendSMS(normalised, `Your Kazi Mtaani reset code is: ${otp}. Valid for 10 minutes. Do not share this code.`);

        res.json({ msg: 'If that number is registered, an OTP has been sent.' });
    } catch (err) {
        console.error('Forgot password error:', err.message);
        res.status(500).json({ msg: 'Server error.' });
    }
});

// @route   POST /api/auth/reset  — verify OTP and set new password
router.post('/reset', authLimiter, async (req, res) => {
    try {
        const { phone, otp, newPassword } = req.body;
        if (!phone || !otp || !newPassword) {
            return res.status(400).json({ msg: 'Phone, OTP, and new password are required.' });
        }

        const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#^_\-])[A-Za-z\d@$!%*?&#^_\-]{8,}$/;
        if (!passwordRegex.test(newPassword)) {
            return res.status(400).json({ msg: 'Password must contain uppercase, lowercase, a number, and a special character.' });
        }

        const normalised = phone.startsWith('0') ? '254' + phone.slice(1) : phone;
        const user = await User.findOne({ phone: normalised });

        if (!user || user.resetOTP !== otp || !user.resetOTPExpiry || user.resetOTPExpiry < new Date()) {
            return res.status(400).json({ msg: 'Invalid or expired OTP.' });
        }

        user.password       = newPassword; // pre-save hook will hash it
        user.resetOTP       = undefined;
        user.resetOTPExpiry = undefined;
        user.tokenVersion  += 1;           // invalidate all existing sessions
        await user.save();

        res.json({ msg: 'Password reset successfully! You can now log in.' });
    } catch (err) {
        console.error('Reset password error:', err.message);
        res.status(500).json({ msg: 'Server error.' });
    }
});

// @route   PUT /api/auth/change-password  — change password while logged in
router.put('/change-password', protect, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ msg: 'Current password and new password are required.' });
        }

        const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#^_\-])[A-Za-z\d@$!%*?&#^_\-]{8,}$/;
        if (!passwordRegex.test(newPassword)) {
            return res.status(400).json({ msg: 'Password must contain uppercase, lowercase, a number, and a special character.' });
        }

        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found.' });

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.status(400).json({ msg: 'Current password is incorrect.' });
        }

        if (currentPassword === newPassword) {
            return res.status(400).json({ msg: 'New password must be different from current password.' });
        }

        user.password      = newPassword; // pre-save hook hashes it
        user.tokenVersion += 1;           // invalidate other sessions
        await user.save();

        // Issue a fresh cookie so this session stays valid
        const token = generateToken(user);
        setAuthCookie(res, token);
        audit(user._id, user.name, 'change-password', req);

        res.json({ msg: 'Password changed successfully!' });
    } catch (err) {
        console.error('Change password error:', err.message);
        res.status(500).json({ msg: 'Server error.' });
    }
});

// DELETE /api/auth/account — permanently delete the logged-in user's account
router.delete('/account', protect, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found.' });

        const Job          = require('../models/job');
        const Rating       = require('../models/Rating');
        const Message      = require('../models/Message');
        const Notification = require('../models/Notification');

        if (user.role === 'employer') {
            // Delete all jobs posted by this employer
            await Job.deleteMany({ employer: user._id });
        } else {
            // Remove worker from all applicant lists
            await Job.updateMany(
                { applicants: user._id },
                { $pull: { applicants: user._id } }
            );
            // Clear hiredWorker references on jobs where they were hired
            await Job.updateMany(
                { hiredWorkerId: user._id },
                { $set: { hiredWorker: null, hiredWorkerId: null, status: 'Open' } }
            );
        }

        // Delete ratings, messages, notifications
        await Rating.deleteMany({ $or: [{ subjectId: user._id }, { raterId: user._id }] });
        await Message.deleteMany({ $or: [{ sender: user._id }, { recipient: user._id }] });
        await Notification.deleteMany({ user: user._id });

        await User.findByIdAndDelete(user._id);

        // Clear auth cookie
        res.clearCookie('token', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
        res.json({ msg: 'Account deleted successfully.' });
    } catch (err) {
        console.error('Delete account error:', err.message);
        res.status(500).json({ msg: 'Server error.' });
    }
});

module.exports = router;