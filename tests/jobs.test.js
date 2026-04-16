const request  = require('supertest');
const mongoose = require('mongoose');
const app      = require('./app');

let employerCookie, workerCookie, employerId;

beforeAll(async () => {
    await mongoose.connect(process.env.MONGO_URI);

    // Register employer
    const emp = await request(app).post('/api/auth/register').send({
        name: 'Big Boss', phone: '254711000001', password: 'Boss@Pass1', role: 'employer'
    });
    employerCookie = emp.headers['set-cookie'];
    employerId = emp.body.user.id;

    // Register worker
    const wrk = await request(app).post('/api/auth/register').send({
        name: 'Hard Worker', phone: '254711000002', password: 'Work@Pass1', role: 'worker'
    });
    workerCookie = wrk.headers['set-cookie'];
});

afterAll(async () => {
    await mongoose.connection.db.dropDatabase();
    await mongoose.connection.close();
});

afterEach(async () => {
    const Job = require('../models/job');
    await Job.deleteMany({});
});

const validJob = {
    title:       'Dig Trenches',
    description: 'Need someone to dig a trench in Nairobi.',
    location:    'Westlands, Nairobi',
    pay:         500,
    category:    'manual'
};

// ── POST /api/jobs ──────────────────────────────────────────────────────────

describe('POST /api/jobs', () => {
    test('employer can post a job', async () => {
        const res = await request(app)
            .post('/api/jobs')
            .set('Cookie', employerCookie)
            .send(validJob);
        expect(res.statusCode).toBe(201);
        expect(res.body.title).toBe('Dig Trenches');
    });

    test('worker cannot post a job', async () => {
        const res = await request(app)
            .post('/api/jobs')
            .set('Cookie', workerCookie)
            .send(validJob);
        expect(res.statusCode).toBe(403);
    });

    test('rejects unauthenticated request', async () => {
        const res = await request(app).post('/api/jobs').send(validJob);
        expect(res.statusCode).toBe(401);
    });

    test('rejects pay outside 50–1,000,000 range', async () => {
        const res = await request(app)
            .post('/api/jobs')
            .set('Cookie', employerCookie)
            .send({ ...validJob, pay: 10 });
        expect(res.statusCode).toBe(400);
        expect(res.body.msg).toMatch(/pay/i);
    });

    test('strips HTML tags from title and description', async () => {
        const res = await request(app)
            .post('/api/jobs')
            .set('Cookie', employerCookie)
            .send({ ...validJob, title: '<b>Bold Title</b>', description: '<script>xss()</script>Normal text' });
        expect(res.statusCode).toBe(201);
        expect(res.body.title).not.toMatch(/<b>/);
        expect(res.body.description).not.toMatch(/<script>/);
    });
});

// ── GET /api/jobs ───────────────────────────────────────────────────────────

describe('GET /api/jobs', () => {
    beforeEach(async () => {
        await request(app)
            .post('/api/jobs')
            .set('Cookie', employerCookie)
            .send(validJob);
    });

    test('returns job list publicly', async () => {
        const res = await request(app).get('/api/jobs');
        expect(res.statusCode).toBe(200);
        expect(res.body.jobs.length).toBeGreaterThan(0);
    });

    test('search filter works', async () => {
        const res = await request(app).get('/api/jobs?search=Trench');
        expect(res.statusCode).toBe(200);
        expect(res.body.jobs[0].title).toMatch(/Trench/i);
    });
});

// ── PUT /api/jobs/apply/:id ─────────────────────────────────────────────────

describe('PUT /api/jobs/apply/:id', () => {
    let jobId;

    beforeEach(async () => {
        const job = await request(app)
            .post('/api/jobs')
            .set('Cookie', employerCookie)
            .send(validJob);
        jobId = job.body._id;
    });

    test('worker can apply', async () => {
        const res = await request(app)
            .put(`/api/jobs/apply/${jobId}`)
            .set('Cookie', workerCookie);
        expect(res.statusCode).toBe(200);
        expect(res.body.job.applicants).toContain('Hard Worker');
    });

    test('employer cannot apply', async () => {
        const res = await request(app)
            .put(`/api/jobs/apply/${jobId}`)
            .set('Cookie', employerCookie);
        expect(res.statusCode).toBe(403);
    });
});

// ── DELETE /api/jobs/:id ────────────────────────────────────────────────────

describe('DELETE /api/jobs/:id', () => {
    let jobId;

    beforeEach(async () => {
        const job = await request(app)
            .post('/api/jobs')
            .set('Cookie', employerCookie)
            .send(validJob);
        jobId = job.body._id;
    });

    test('owner can delete job', async () => {
        const res = await request(app)
            .delete(`/api/jobs/${jobId}`)
            .set('Cookie', employerCookie);
        expect(res.statusCode).toBe(200);
    });

    test('non-owner cannot delete job', async () => {
        const res = await request(app)
            .delete(`/api/jobs/${jobId}`)
            .set('Cookie', workerCookie);
        expect(res.statusCode).toBe(403);
    });
});
