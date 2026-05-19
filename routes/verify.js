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

// ── Certificate upload ─────────────────────────────────────────────────────────
const CERT_DIR = path.join(__dirname, '..', 'uploads', 'certificates');
if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });

const certStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, CERT_DIR),
    filename:    (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${req.user.id}_cert_${Date.now()}${ext}`);
    }
});

const certUpload = multer({
    storage: certStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['.jpg', '.jpeg', '.png', '.pdf'];
        if (allowed.includes(path.extname(file.originalname).toLowerCase())) {
            cb(null, true);
        } else {
            cb(new Error('Only JPG, PNG, and PDF files are allowed.'));
        }
    }
});

// POST /api/verify/certificate — worker uploads a professional certificate
router.post('/certificate', protect, certUpload.single('certificate'), async (req, res) => {
    try {
        if (req.user.role !== 'worker') {
            return res.status(403).json({ msg: 'Only workers can upload certificates.' });
        }
        if (!req.file) return res.status(400).json({ msg: 'No file uploaded.' });

        const user = await User.findByIdAndUpdate(
            req.user.id,
            { $push: { certificates: req.file.filename } },
            { new: true }
        ).select('certificates');

        res.json({ msg: 'Certificate uploaded!', filename: req.file.filename, certificates: user.certificates });
    } catch (err) {
        if (err.message.includes('allowed')) return res.status(400).json({ msg: err.message });
        console.error('Certificate upload error:', err.message);
        res.status(500).json({ msg: 'Server error.' });
    }
});

// DELETE /api/verify/certificate/:filename — worker removes their own certificate
router.delete('/certificate/:filename', protect, async (req, res) => {
    try {
        if (req.user.role !== 'worker') {
            return res.status(403).json({ msg: 'Only workers can delete certificates.' });
        }
        const filename = path.basename(req.params.filename);
        if (!filename.startsWith(req.user.id + '_cert_')) {
            return res.status(403).json({ msg: 'Access denied.' });
        }
        const filePath = path.join(CERT_DIR, filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        await User.findByIdAndUpdate(req.user.id, { $pull: { certificates: filename } });
        res.json({ msg: 'Certificate removed.' });
    } catch (err) {
        console.error('Certificate delete error:', err.message);
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
