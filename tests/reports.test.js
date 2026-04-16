const request  = require('supertest');
const mongoose = require('mongoose');
const app      = require('./app');
const User     = require('../models/user');
const Job      = require('../models/job');

beforeAll(async () => { await mongoose.connect(process.env.MONGO_URI); });
afterAll(async () => { await mongoose.connection.db.dropDatabase(); await mongoose.connection.close(); });
afterEach(async () => { await User.deleteMany({}); await Job.deleteMany({}); });

async function registerAndLogin(name, phone, role) {
    await request(app).post('/api/auth/register').send({ name, phone, password: 'Secure@123', role });
    const res = await request(app).post('/api/auth/login').send({ phone, password: 'Secure@123' });
    return res.headers['set-cookie'][0].split(';')[0];
}

describe('Reports API', () => {
    test('worker report returns expected shape', async () => {
        const cookie = await registerAndLogin('WkRpt', '254700001001', 'worker');
        const res = await request(app).get('/api/reports/worker').set('Cookie', cookie);
        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('applied');
        expect(res.body).toHaveProperty('hired');
        expect(res.body).toHaveProperty('completed');
        expect(res.body).toHaveProperty('earned');
        expect(res.body).toHaveProperty('byCategory');
        expect(res.body).toHaveProperty('monthly');
    });

    test('employer cannot access worker report', async () => {
        const cookie = await registerAndLogin('EmpRpt', '254700001002', 'employer');
        const res = await request(app).get('/api/reports/worker').set('Cookie', cookie);
        expect(res.statusCode).toBe(403);
    });

    test('employer report returns expected shape', async () => {
        const cookie = await registerAndLogin('EmpRpt2', '254700001003', 'employer');
        const res = await request(app).get('/api/reports/employer').set('Cookie', cookie);
        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('posted');
        expect(res.body).toHaveProperty('completed');
        expect(res.body).toHaveProperty('spent');
        expect(res.body).toHaveProperty('byCategory');
    });

    test('worker cannot access employer report', async () => {
        const cookie = await registerAndLogin('WkRpt2', '254700001004', 'worker');
        const res = await request(app).get('/api/reports/employer').set('Cookie', cookie);
        expect(res.statusCode).toBe(403);
    });

    test('unauthenticated request is rejected', async () => {
        const res = await request(app).get('/api/reports/worker');
        expect(res.statusCode).toBe(401);
    });
});
