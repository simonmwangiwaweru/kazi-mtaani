const express      = require('express');
const mongoose     = require('mongoose');
const cors         = require('cors');
const dotenv       = require('dotenv');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const cookieParser = require('cookie-parser');

// 1. Load environment variables
dotenv.config();

// Guard: fail fast if critical secrets are missing or weak
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error('❌ FATAL: JWT_SECRET must be set and at least 32 characters long.');
    process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // Trust Render's reverse proxy for real client IPs

// HTTPS redirect in production (assumes a reverse proxy sets x-forwarded-proto)
if (process.env.NODE_ENV === 'production') {
    app.use((req, res, next) => {
        if (req.header('x-forwarded-proto') !== 'https') {
            return res.redirect(301, `https://${req.header('host')}${req.url}`);
        }
        next();
    });
}

// 2. Security Middleware
// Configure Helmet with a CSP that allows inline scripts (required for the
// HTML pages) and Google's Identity Services script, while keeping all other
// security headers (XSS filter, frame-options, HSTS, etc.) enabled.
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc:  ["'self'"],
            scriptSrc:   ["'self'", "'unsafe-inline'", "https://accounts.google.com"],
            'script-src-attr': ["'unsafe-inline'"],
            styleSrc:    ["'self'", "https:", "'unsafe-inline'"],
            imgSrc:      ["'self'", "data:", "https:"],
            connectSrc:  ["'self'"],
            fontSrc:     ["'self'", "https:", "data:"],
            objectSrc:   ["'none'"],
            frameSrc:    ["'none'"],
            frameAncestors: ["'none'"],
            baseUri:     ["'self'"],
            formAction:  ["'self'"],
        }
    }
}));
app.use(express.json({ limit: '10kb' })); // Limit body size to prevent abuse
app.use(cookieParser());

// CORS — restrict to known origins
// ⚠️  Before deploying: add your production domain to allowedOrigins, e.g. 'https://kazimtaani.co.ke'
const allowedOrigins = [
    'http://localhost:5000',
    'http://127.0.0.1:5000',
    'http://localhost:5500',      // VS Code Live Server
    'http://127.0.0.1:5500',     // VS Code Live Server (alternate)
    'https://kazimtaani.co.ke',
    'https://kazi-mtaani.onrender.com'  // Render deployment
];
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (same-origin requests, Postman, mobile apps)
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error(`CORS blocked: origin '${origin}' is not allowed.`));
        }
    },
    credentials: true
}));

// Global rate limiter — max 100 requests per 15 min per IP
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { msg: 'Too many requests. Please try again later.' }
});
app.use('/api/', globalLimiter);

app.use(express.static('public'));

// 3. Database Connection
const mongoURI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/kazi_mtaani';

mongoose.connect(mongoURI)
    .then(() => console.log("✅ Database Connected! Kazi Mtaani memory is active."))
    .catch((err) => console.log("❌ DB Connection Error:", err));

// Serve uploaded verification documents (admin-only path in production)
app.use('/uploads', require('express').static('uploads'));

// 4. Routes
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/jobs',          require('./routes/jobs'));
app.use('/api/escrow',        require('./routes/escrow'));
app.use('/api/ratings',       require('./routes/ratings'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/admin',         require('./routes/admin'));
app.use('/api/messages',      require('./routes/messages'));
app.use('/api/reports',       require('./routes/reports'));
app.use('/api/audit',         require('./routes/audit'));
app.use('/api/verify',        require('./routes/verify'));
app.use('/api/ussd',          require('./routes/ussd'));

// 5. Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});