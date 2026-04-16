const request  = require('supertest');
const mongoose = require('mongoose');
const path     = require('path');
const fs       = require('fs');
const app      = require('./app');
const User     = require('../models/user');

beforeAll(async () => { await mongoose.connect(process.env.MONGO_URI); });
afterAll(async () => { await mongoose.connection.db.dropDatabase(); await mongoose.connection.close(); });
afterEach(async () => { await User.deleteMany({}); });

async function registerAndLogin(name, phone, role) {
    await request(app).post('/api/auth/register').send({ name, phone, password: 'Secure@123', role });
    const res = await request(app).post('/api/auth/login').send({ phone, password: 'Secure@123' });
    return res.headers['set-cookie'][0].split(';')[0];
}

// Create a tiny test image buffer
const TEST_IMAGE = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
);

describe('Verification API', () => {
    test('worker can check their verification status', async () => {
        const cookie = await registerAndLogin('VfyWk', '254700002001', 'worker');
        const res = await request(app).get('/api/verify/status').set('Cookie', cookie);
        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('none');
    });

    test('employer can also check status (returns none)', async () => {
        const cookie = await registerAndLogin('VfyEmp', '254700002002', 'employer');
        const res = await request(app).get('/api/verify/status').set('Cookie', cookie);
        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('none');
    });

    test('only workers can upload (employer gets 403)', async () => {
        const cookie = await registerAndLogin('VfyEmpUp', '254700002005', 'employer');
        const tmpPath = '/tmp/test_emp_id.png';
        require('fs').writeFileSync(tmpPath, TEST_IMAGE);
        const res = await request(app)
            .post('/api/verify/upload')
            .set('Cookie', cookie)
            .attach('document', tmpPath, { filename: 'test_emp_id.png', contentType: 'image/png' });
        expect(res.statusCode).toBe(403);
        require('fs').unlinkSync(tmpPath);
    });

    test('worker can upload a verification document', async () => {
        const cookie = await registerAndLogin('VfyUpload', '254700002003', 'worker');
        const tmpPath = path.join('/tmp', 'test_id.png');
        fs.writeFileSync(tmpPath, TEST_IMAGE);

        const res = await request(app)
            .post('/api/verify/upload')
            .set('Cookie', cookie)
            .attach('document', tmpPath, { filename: 'test_id.png', contentType: 'image/png' });

        expect(res.statusCode).toBe(200);
        expect(res.body.msg).toMatch(/submitted/i);

        // Status should now be pending
        const statusRes = await request(app).get('/api/verify/status').set('Cookie', cookie);
        expect(statusRes.body.status).toBe('pending');

        fs.unlinkSync(tmpPath);
    });

    test('rejects upload without a file', async () => {
        const cookie = await registerAndLogin('VfyNoFile', '254700002004', 'worker');
        const res = await request(app)
            .post('/api/verify/upload')
            .set('Cookie', cookie);
        expect(res.statusCode).toBe(400);
    });

    test('unauthenticated request is rejected', async () => {
        const res = await request(app).get('/api/verify/status');
        expect(res.statusCode).toBe(401);
    });
});
