/**
 * IDENTITY VERIFICATION — workers upload an ID document.
 * Admin approves or rejects via /api/admin routes.
 * Files are stored in Cloudinary (permanent, survives Render redeploys).
 */
const express    = require('express');
const router     = express.Router();
const path       = require('path');
const multer     = require('multer');
const { Readable } = require('stream');
const cloudinary = require('cloudinary').v2;
const User       = require('../models/user');
const AuditLog   = require('../models/AuditLog');
const protect    = require('../middleware/auth');

// Configure Cloudinary from env vars
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Use memory storage — we stream the buffer to Cloudinary
const memStorage = multer.memoryStorage();

function uploadToCloudinary(buffer, options) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
        Readable.from(buffer).pipe(stream);
    });
}

const upload = multer({
    storage: memStorage,
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

        // Delete old Cloudinary document if it exists
        if (user.verificationDocPublicId) {
            await cloudinary.uploader.destroy(user.verificationDocPublicId, { resource_type: 'image' }).catch(() => {});
        }

        // Upload to Cloudinary
        const ext        = path.extname(req.file.originalname).toLowerCase();
        const resourceType = ext === '.pdf' ? 'raw' : 'image';
        const result     = await uploadToCloudinary(req.file.buffer, {
            folder:        'kazi-mtaani/verification',
            public_id:     `${req.user.id}_${Date.now()}`,
            resource_type: resourceType,
        });

        user.verificationDoc         = result.secure_url;
        user.verificationDocPublicId = result.public_id;
        user.verificationStatus      = 'pending';
        user.verificationNote        = '';
        await user.save();

        AuditLog.create({
            userId: user._id, userName: user.name,
            action: 'verification_submitted', entity: 'user', entityId: user._id.toString(),
            details: result.secure_url
        }).catch(() => {});

        res.json({ msg: 'Document submitted. Our team will review it within 24 hours.' });
    } catch (err) {
        if (err.message && err.message.includes('allowed')) return res.status(400).json({ msg: err.message });
        console.error('Verify upload error:', err.message);
        res.status(500).json({ msg: 'Server error.' });
    }
});

// ── Certificate upload ─────────────────────────────────────────────────────────
const certUpload = multer({
    storage: memStorage,
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

        const ext          = path.extname(req.file.originalname).toLowerCase();
        const resourceType = ext === '.pdf' ? 'raw' : 'image';
        const result       = await uploadToCloudinary(req.file.buffer, {
            folder:        'kazi-mtaani/certificates',
            public_id:     `${req.user.id}_cert_${Date.now()}`,
            resource_type: resourceType,
        });

        const user = await User.findByIdAndUpdate(
            req.user.id,
            { $push: { certificates: result.secure_url } },
            { new: true }
        ).select('certificates');

        res.json({ msg: 'Certificate uploaded!', filename: result.secure_url, certificates: user.certificates });
    } catch (err) {
        if (err.message && err.message.includes('allowed')) return res.status(400).json({ msg: err.message });
        console.error('Certificate upload error:', err.message);
        res.status(500).json({ msg: 'Server error.' });
    }
});

// DELETE /api/verify/certificate/:filename — worker removes their own certificate
// filename is now a Cloudinary URL; we match it against the stored list
router.delete('/certificate/:filename', protect, async (req, res) => {
    try {
        if (req.user.role !== 'worker') {
            return res.status(403).json({ msg: 'Only workers can delete certificates.' });
        }
        const user = await User.findById(req.user.id).select('certificates');
        if (!user) return res.status(404).json({ msg: 'User not found.' });

        const target = decodeURIComponent(req.params.filename);
        if (!user.certificates.includes(target)) {
            return res.status(403).json({ msg: 'Access denied.' });
        }

        await User.findByIdAndUpdate(req.user.id, { $pull: { certificates: target } });
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
