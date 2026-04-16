const request  = require('supertest');
const mongoose = require('mongoose');
const app      = require('./app');

beforeAll(async () => {
    await mongoose.connect(process.env.MONGO_URI);
});

afterAll(async () => {
    // Drop test DB and close connection
    await mongoose.connection.db.dropDatabase();
    await mongoose.connection.close();
});

afterEach(async () => {
    // Clean users between tests
    const User = require('../models/user');
    await User.deleteMany({});
});

// ── Registration ────────────────────────────────────────────────────────────

describe('POST /api/auth/register', () => {
    const valid = {
        name: 'Jane Doe',
        phone: '254712345678',
        password: 'Secure@123',
        role: 'worker'
    };

    test('creates a new worker and returns a token cookie', async () => {
        const res = await request(app).post('/api/auth/register').send(valid);
        expect(res.statusCode).toBe(201);
        expect(res.body.user.role).toBe('worker');
        // httpOnly cookie should be set
        expect(res.headers['set-cookie']).toBeDefined();
        expect(res.headers['set-cookie'][0]).toMatch(/^token=/);
    });

    test('rejects duplicate phone', async () => {
        await request(app).post('/api/auth/register').send(valid);
        const res = await request(app).post('/api/auth/register').send(valid);
        expect(res.statusCode).toBe(400);
        expect(res.body.msg).toMatch(/already exists/i);
    });

    test('rejects weak password', async () => {
        const res = await request(app).post('/api/auth/register').send({ ...valid, password: 'weak' });
        expect(res.statusCode).toBe(400);
        expect(res.body.msg).toMatch(/password/i);
    });

    test('silently forces role to worker when admin is requested', async () => {
        const res = await request(app).post('/api/auth/register').send({ ...valid, role: 'admin' });
        expect(res.statusCode).toBe(201);
        expect(res.body.user.role).toBe('worker');
    });

    test('rejects missing fields', async () => {
        const res = await request(app).post('/api/auth/register').send({ name: 'X' });
        expect(res.statusCode).toBe(400);
    });
});

// ── Login ────────────────────────────────────────────────────────────────────

describe('POST /api/auth/login', () => {
    beforeEach(async () => {
        await request(app).post('/api/auth/register').send({
            name: 'Jane Doe', phone: '254712345678', password: 'Secure@123'
        });
    });

    test('returns token cookie on valid credentials', async () => {
        const res = await request(app).post('/api/auth/login').send({
            phone: '254712345678', password: 'Secure@123'
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers['set-cookie']).toBeDefined();
    });

    test('rejects wrong password', async () => {
        const res = await request(app).post('/api/auth/login').send({
            phone: '254712345678', password: 'WrongPass@1'
        });
        expect(res.statusCode).toBe(400);
        expect(res.body.msg).toMatch(/invalid credentials/i);
    });

    test('rejects unknown phone', async () => {
        const res = await request(app).post('/api/auth/login').send({
            phone: '254799999999', password: 'Secure@123'
        });
        expect(res.statusCode).toBe(400);
    });
});

// ── Protected route ──────────────────────────────────────────────────────────

describe('GET /api/auth/me', () => {
    let cookie;

    beforeEach(async () => {
        const reg = await request(app).post('/api/auth/register').send({
            name: 'Jane Doe', phone: '254712345678', password: 'Secure@123'
        });
        cookie = reg.headers['set-cookie'];
    });

    test('returns profile when authenticated via cookie', async () => {
        const res = await request(app)
            .get('/api/auth/me')
            .set('Cookie', cookie);
        expect(res.statusCode).toBe(200);
        expect(res.body.name).toBe('Jane Doe');
        expect(res.body.password).toBeUndefined(); // never exposed
    });

    test('returns 401 without a cookie', async () => {
        const res = await request(app).get('/api/auth/me');
        expect(res.statusCode).toBe(401);
    });
});

// ── Forgot / Reset password ──────────────────────────────────────────────────

describe('POST /api/auth/forgot', () => {
    test('always returns the same vague message (no phone enumeration)', async () => {
        const res = await request(app).post('/api/auth/forgot').send({ phone: '254799999999' });
        expect(res.statusCode).toBe(200);
        expect(res.body.msg).toMatch(/if that number is registered/i);
    });
});

describe('POST /api/auth/reset', () => {
    let otp;

    beforeEach(async () => {
        await request(app).post('/api/auth/register').send({
            name: 'Jane Doe', phone: '254712345678', password: 'Secure@123'
        });
        await request(app).post('/api/auth/forgot').send({ phone: '254712345678' });
        // Read OTP directly from DB
        const User = require('../models/user');
        const user = await User.findOne({ phone: '254712345678' });
        otp = user.resetOTP;
    });

    test('sets new password with valid OTP', async () => {
        const res = await request(app).post('/api/auth/reset').send({
            phone: '254712345678', otp, newPassword: 'NewPass@456'
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.msg).toMatch(/reset successfully/i);
    });

    test('rejects invalid OTP', async () => {
        const res = await request(app).post('/api/auth/reset').send({
            phone: '254712345678', otp: '000000', newPassword: 'NewPass@456'
        });
        expect(res.statusCode).toBe(400);
        expect(res.body.msg).toMatch(/invalid or expired/i);
    });

    test('rejects weak new password', async () => {
        const res = await request(app).post('/api/auth/reset').send({
            phone: '254712345678', otp, newPassword: 'weak'
        });
        expect(res.statusCode).toBe(400);
    });
});

// ── Change password (authenticated) ─────────────────────────────────────────

describe('PUT /api/auth/change-password', () => {
    let cookie;

    beforeEach(async () => {
        const reg = await request(app).post('/api/auth/register').send({
            name: 'Changer', phone: '254712340000', password: 'OldPass@123', role: 'worker'
        });
        cookie = reg.headers['set-cookie'][0].split(';')[0];
    });

    test('changes password with correct current password', async () => {
        const res = await request(app)
            .put('/api/auth/change-password')
            .set('Cookie', cookie)
            .send({ currentPassword: 'OldPass@123', newPassword: 'NewPass@456' });
        expect(res.statusCode).toBe(200);
        expect(res.body.msg).toMatch(/changed successfully/i);
        // New cookie issued
        expect(res.headers['set-cookie']).toBeDefined();
    });

    test('rejects wrong current password', async () => {
        const res = await request(app)
            .put('/api/auth/change-password')
            .set('Cookie', cookie)
            .send({ currentPassword: 'Wrong@Pass1', newPassword: 'NewPass@456' });
        expect(res.statusCode).toBe(400);
        expect(res.body.msg).toMatch(/incorrect/i);
    });

    test('rejects weak new password', async () => {
        const res = await request(app)
            .put('/api/auth/change-password')
            .set('Cookie', cookie)
            .send({ currentPassword: 'OldPass@123', newPassword: 'weak' });
        expect(res.statusCode).toBe(400);
        expect(res.body.msg).toMatch(/password/i);
    });

    test('rejects same new password as current', async () => {
        const res = await request(app)
            .put('/api/auth/change-password')
            .set('Cookie', cookie)
            .send({ currentPassword: 'OldPass@123', newPassword: 'OldPass@123' });
        expect(res.statusCode).toBe(400);
        expect(res.body.msg).toMatch(/different/i);
    });

    test('rejects unauthenticated request', async () => {
        const res = await request(app)
            .put('/api/auth/change-password')
            .send({ currentPassword: 'OldPass@123', newPassword: 'NewPass@456' });
        expect(res.statusCode).toBe(401);
    });
});
