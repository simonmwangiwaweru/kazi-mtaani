const request  = require('supertest');
const mongoose = require('mongoose');
const app      = require('./app');

const User = require('../models/user');
const Job  = require('../models/job');

beforeAll(async () => { await mongoose.connect(process.env.MONGO_URI); });
afterAll(async () => { await mongoose.connection.db.dropDatabase(); await mongoose.connection.close(); });
afterEach(async () => { await User.deleteMany({}); await Job.deleteMany({}); });

// ── helpers ─────────────────────────────────────────────────────────────────

async function registerAndLogin(phone, role = 'worker') {
    const name = role === 'employer' ? 'EmpUser' : 'WorkerUser';
    await request(app).post('/api/auth/register').send({ name, phone, password: 'Secure@123', role });
    const res = await request(app).post('/api/auth/login').send({ phone, password: 'Secure@123' });
    return { cookie: res.headers['set-cookie'][0].split(';')[0], id: res.body.user.id, name: res.body.user.name };
}

async function createJob(employerCookie) {
    const res = await request(app).post('/api/jobs')
        .set('Cookie', employerCookie)
        .send({ title: 'Test Job', description: 'Test description', location: 'Nairobi', pay: 1000, category: 'general', employerPhone: '254700000001' });
    // POST /api/jobs returns the saved job directly
    return res.body;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('Messages API', () => {
    test('returns 200 conversations list (empty)', async () => {
        const emp = await registerAndLogin('254700000010', 'employer');
        const res = await request(app).get('/api/messages').set('Cookie', emp.cookie);
        expect(res.statusCode).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    test('returns unread count for authenticated user', async () => {
        const emp = await registerAndLogin('254700000011', 'employer');
        const res = await request(app).get('/api/messages/meta/unread-count').set('Cookie', emp.cookie);
        expect(res.statusCode).toBe(200);
        expect(typeof res.body.unreadCount).toBe('number');
    });

    test('employer can send message on their own job', async () => {
        const emp = await registerAndLogin('254700000012', 'employer');
        const job = await createJob(emp.cookie);
        expect(job._id).toBeDefined(); // guard against bad helper
        const res = await request(app).post(`/api/messages/${job._id}`)
            .set('Cookie', emp.cookie)
            .send({ content: 'Hello worker!' });
        expect(res.statusCode).toBe(201);
        expect(res.body.content).toBe('Hello worker!');
        expect(res.body.senderName).toBe('EmpUser');
    });

    test('non-participant cannot send message', async () => {
        const emp      = await registerAndLogin('254700000013', 'employer');
        const outsider = await registerAndLogin('254700000014', 'worker');
        const job = await createJob(emp.cookie);
        const res = await request(app).post(`/api/messages/${job._id}`)
            .set('Cookie', outsider.cookie)
            .send({ content: 'Sneaky message' });
        expect(res.statusCode).toBe(403);
    });

    test('empty message is rejected', async () => {
        const emp = await registerAndLogin('254700000015', 'employer');
        const job = await createJob(emp.cookie);
        const res = await request(app).post(`/api/messages/${job._id}`)
            .set('Cookie', emp.cookie)
            .send({ content: '   ' });
        expect(res.statusCode).toBe(400);
    });

    test('unauthenticated request is rejected', async () => {
        const res = await request(app).get('/api/messages');
        expect(res.statusCode).toBe(401);
    });
});
