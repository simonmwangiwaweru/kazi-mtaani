/**
 * Test app factory — same middleware/routes as server.js but without
 * connecting to MongoDB or starting the HTTP server.
 * Each test suite connects its own mongoose instance.
 */
const express      = require('express');
const helmet       = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit    = require('express-rate-limit');

const app = express();

app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false })); // needed for USSD form posts
app.use(cookieParser());

// Disable rate limiting in tests
app.use('/api/auth',          require('../routes/auth'));
app.use('/api/jobs',          require('../routes/jobs'));
app.use('/api/escrow',        require('../routes/escrow'));
app.use('/api/ratings',       require('../routes/ratings'));
app.use('/api/notifications', require('../routes/notifications'));
app.use('/api/admin',         require('../routes/admin'));
app.use('/api/messages',      require('../routes/messages'));
app.use('/api/reports',       require('../routes/reports'));
app.use('/api/audit',         require('../routes/audit'));
app.use('/api/verify',        require('../routes/verify'));
app.use('/api/ussd',          require('../routes/ussd'));

module.exports = app;
