const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const User = require('../models/user');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const protect = require('../middleware/auth');
const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const { sendSMS } = require('../services/sms');
const AuditLog = require('../models/AuditLog');

// ---------------------------------------------------------------------------
// In-memory store for pending Google sign-ups (new users who need phone+role).
// Key  : random 32-byte hex string, valid for 5 minutes.
// Value: { name, email, googleId, expiresAt }
// ---------------------------------------------------------------------------
const pendingGoogleRegs = new Map();
const PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes

function storePendingGoogle(name, email, googleId) {
    const key = crypto.randomBytes(32).toString('hex');
    pendingGoogleRegs.set(key, { name, email, googleId, expiresAt: Date.now() + PENDING_TTL_MS });
    // Lazy cleanup — remove expired entries whenever a new one is added
    for (const [k, v] of pendingGoogleRegs) {
        if (v.expiresAt < Date.now()) pendingGoogleRegs.delete(k);
    }
    return key;
}

function consumePendingGoogle(key) {
    const entry = pendingGoogleRegs.get(key);
    if (!entry) return null;
    pendingGoogleRegs.delete(key);
    if (entry.expiresAt < Date.now()) return null; // expired
    return entry;
}

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

// @route   POST /api/auth/google-complete
// Called by register.html after a new Google user provides their phone & role.
// Accepts a short-lived pendingKey (stored server-side) instead of the raw id_token.
router.post('/google-complete', authLimiter, async (req, res) => {
    try {
        const { pendingKey, phone, role } = req.body;

        if (!pendingKey) return res.status(400).json({ msg: 'Invalid or expired Google session. Please try again.' });

        const pending = consumePendingGoogle(pendingKey);
        if (!pending) return res.status(400).json({ msg: 'Google session expired or already used. Please sign in with Google again.' });

        const { name, email, googleId } = pending;

        if (!phone || !role) {
            return res.status(400).json({ msg: 'Phone number and role are required.' });
        }

        let safeRole = 'worker';
        if (role === 'employer') safeRole = 'employer';

        // Check for existing account
        let user = await User.findOne({ $or: [{ googleId }, { email }] });
        if (user) {
            // Already registered — just log them in
            if (!user.googleId) { user.googleId = googleId; await user.save(); }
            const token = generateToken(user);
            setAuthCookie(res, token);
            audit(user._id, user.name, 'google-login', req);
            return res.json({
                msg: 'Login successful!',
                token,
                user: { id: user._id, name: user.name, role: user.role, phone: user.phone, email: user.email }
            });
        }

        // Normalise phone
        const normPhone = phone.startsWith('0') ? '254' + phone.slice(1) : phone;
        const existingPhone = await User.findOne({ phone: normPhone });
        if (existingPhone) return res.status(400).json({ msg: 'Phone number is already associated with an account.' });

        user = new User({ name, email, phone: normPhone, googleId, role: safeRole });
        await user.save();
        const token = generateToken(user);
        setAuthCookie(res, token);
        audit(user._id, user.name, 'google-register', req);

        return res.status(201).json({
            msg: 'Account created successfully via Google!',
            token,
            user: { id: user._id, name: user.name, role: user.role, phone: user.phone, email: user.email }
        });

    } catch (err) {
        console.error('Google Complete Error:', err.message);
        res.status(500).json({ msg: 'Server error. Please try again.' });
    }
});

// @route   GET /api/auth/google-redirect-init
// Traditional OAuth2 redirect — fallback when GSI button fails to render.
// Sends user to Google's consent page; Google then POSTs back to /google-callback.
router.get('/google-redirect-init', (req, res) => {
    const redirectUri = process.env.NODE_ENV === 'production'
        ? 'https://kazi-mtaani.onrender.com/api/auth/google-callback'
        : `http://localhost:${process.env.PORT || 5000}/api/auth/google-callback`;

    const authUrl = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri)
        .generateAuthUrl({
            access_type: 'offline',
            scope: ['openid', 'email', 'profile'],
            prompt: 'select_account',
        });
    res.redirect(authUrl);
});

// @route   GET /api/auth/google-callback
// Traditional OAuth2 callback — receives 'code' from Google and exchanges it for user info.
router.get('/google-callback', authLimiter, async (req, res) => {
    try {
        const { code, error } = req.query;
        if (error || !code) return res.redirect('/login.html?error=google_failed');

        const redirectUri = process.env.NODE_ENV === 'production'
            ? 'https://kazi-mtaani.onrender.com/api/auth/google-callback'
            : `http://localhost:${process.env.PORT || 5000}/api/auth/google-callback`;

        const oauthClient = new OAuth2Client(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            redirectUri
        );
        const { tokens } = await oauthClient.getToken(code);
        oauthClient.setCredentials(tokens);

        const ticket = await oauthClient.verifyIdToken({
            idToken: tokens.id_token,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        const { sub, email, name } = payload;

        let user = await User.findOne({ $or: [{ googleId: sub }, { email }] });

        if (user) {
            if (!user.googleId) { user.googleId = sub; await user.save(); }
            const token = generateToken(user);
            setAuthCookie(res, token);
            audit(user._id, user.name, 'google-login', req);
            const u = Buffer.from(JSON.stringify({
                name: user.name, role: user.role,
                id: user._id.toString(), phone: user.phone || ''
            })).toString('base64');
            return res.redirect('/session-bridge.html?u=' + u + '&to=dashboard.html');
        }

        // New user — store info server-side, redirect with a short-lived key only
        const pendingKey = storePendingGoogle(name, email, sub);
        return res.redirect('/register.html?via=google&pk=' + pendingKey);

    } catch (err) {
        console.error('Google Callback Error:', err.message);
        return res.redirect('/login.html?error=google_failed');
    }
});

// @route   POST /api/auth/google-redirect
// Called by Google in redirect-mode (ux_mode:'redirect') — credential arrives as form-encoded body.
router.post('/google-redirect', authLimiter, async (req, res) => {
    try {
        const googleToken = req.body.credential;
        if (!googleToken) return res.redirect('/login.html?error=google_failed');

        const ticket = await client.verifyIdToken({
            idToken: googleToken,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        const { sub, email, name } = payload;

        let user = await User.findOne({ $or: [{ googleId: sub }, { email }] });

        if (user) {
            if (!user.googleId) { user.googleId = sub; await user.save(); }
            const token = generateToken(user);
            setAuthCookie(res, token);
            audit(user._id, user.name, 'google-login', req);
            const u = Buffer.from(JSON.stringify({
                name: user.name, role: user.role,
                id: user._id.toString(), phone: user.phone || ''
            })).toString('base64');
            return res.redirect('/session-bridge.html?u=' + u + '&to=dashboard.html');
        }

        // New user — store info server-side, redirect with a short-lived key only
        const pendingKey = storePendingGoogle(name, email, sub);
        return res.redirect('/register.html?via=google&pk=' + pendingKey);

    } catch (err) {
        console.error('Google Redirect Error:', err.message);
        return res.redirect('/login.html?error=google_failed');
    }
});


router.get('/me', protect, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-password -tokenVersion -googleId');
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
        ).select('-password -tokenVersion -googleId');

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

        // Google-only accounts have no password — block this flow
        if (!user.password) {
            return res.status(400).json({ msg: 'This account uses Google sign-in. Password cannot be changed here.' });
        }

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

module.exports = router;