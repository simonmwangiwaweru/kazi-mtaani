/**
 * IDENTITY VERIFICATION — workers upload an ID document.
 * Admin approves or rejects via /api/admin routes.
 */
const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const User     = require('../models/user');
const AuditLog = require('../models/AuditLog');
const protect  = require('../middleware/auth');

// Ensure uploads directory exists
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'verification');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename:    (req, file, cb) => {
        const ext  = path.extname(file.originalname).toLowerCase();
        cb(null, `${req.user.id}_${Date.now()}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },  // 5 MB
    fileFilter: (req, file, cb) => {
        const allowed = ['.jpg', '.jpeg', '.png', '.pdf'];
        if (allowed.includes(path.extname(file.originalname).toLowerCase())) {
            cb(null, true);
        } else {
            cb(new Error('Only JPG, PNG, and PDF files are allowed.'));
        }
    }
});

// POST /api/verify/upload — worker submits ID document
router.post('/upload', protect, upload.single('document'), async (req, res) => {
    try {
        if (req.user.role !== 'worker') {
            return res.status(403).json({ msg: 'Only workers can submit verification documents.' });
        }
        if (!req.file) {
            return res.status(400).json({ msg: 'No file uploaded.' });
        }

        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found.' });

        if (user.verificationStatus === 'verified') {
            return res.status(400).json({ msg: 'Your account is already verified.' });
        }

        // Delete old doc if it exists
        if (user.verificationDoc) {
            const old = path.join(UPLOAD_DIR, path.basename(user.verificationDoc));
            if (fs.existsSync(old)) fs.unlinkSync(old);
        }

        user.verificationDoc    = req.file.filename;
        user.verificationStatus = 'pending';
        user.verificationNote   = '';
        await user.save();

        AuditLog.create({
            userId: user._id, userName: user.name,
            action: 'verification_submitted', entity: 'user', entityId: user._id.toString(),
            details: req.file.filename
        }).catch(() => {});

        res.json({ msg: 'Document submitted. Our team will review it within 24 hours.' });
    } catch (err) {
        if (err.message.includes('allowed')) return res.status(400).json({ msg: err.message });
        console.error('Verify upload error:', err.message);
        res.status(500).json({ msg: 'Server error.' });
    }
});

// GET /api/verify/status — worker checks their own verification status
router.get('/status', protect, async (req, res) => {
    try {
        const user = await User.findById(req.user.id)
            .select('verificationStatus verificationNote verificationDoc');
        if (!user) return res.status(404).json({ msg: 'User not found.' });
        res.json({
            status: user.verificationStatus,
            note:   user.verificationNote,
            hasDoc: !!user.verificationDoc
        });
    } catch (err) {
        res.status(500).json({ msg: 'Server error.' });
    }
});

module.exports = router;
