/**
 * Escrow tests — Daraja API is mocked so no real M-Pesa calls are made.
 * The mpesaIpGuard middleware is bypassed automatically in NODE_ENV=test.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');
const request  = require('supertest');
const mongoose = require('mongoose');
const app      = require('./app');
const Job      = require('../models/job');
const User     = require('../models/user');

// ── Mock Daraja so no real Safaricom calls are made ──────────────────────────
jest.mock('../services/daraja', () => ({
    stkPush:   jest.fn().mockResolvedValue({ CheckoutRequestID: 'mock-checkout-id-123' }),
    b2cPayout: jest.fn().mockResolvedValue({ ResponseCode: '0' }),
}));

const { stkPush, b2cPayout } = require('../services/daraja');

let mongod;
let employerCookie, workerCookie;
let employerId, workerId;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());

    // Register employer
    const emp = await request(app).post('/api/auth/register').send({
        name: 'Test Employer', phone: '254711100001', password: 'Emp@Pass123', role: 'employer'
    });
    employerCookie = emp.headers['set-cookie'];
    employerId     = emp.body.user.id;

    // Register worker
    const wrk = await request(app).post('/api/auth/register').send({
        name: 'Test Worker', phone: '254711100002', password: 'Wrk@Pass123', role: 'worker'
    });
    workerCookie = wrk.headers['set-cookie'];
    workerId     = wrk.body.user.id;
});

afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
    await mongod.stop();
});

afterEach(async () => {
    await Job.deleteMany({});
    jest.clearAllMocks();
});

// Helper — create a job owned by the employer
async function createJob(overrides = {}) {
    return Job.create({
        title:         'Paint House',
        description:   'Paint walls',
        location:      'Nairobi',
        pay:           1000,
        status:        'Open',
        category:      'manual',
        employer:      employerId,
        employerPhone: '254711100001',
        paymentStatus: 'Pending',
        ...overrides,
    });
}

// ── POST /api/escrow/pay/:jobId (STK Push) ───────────────────────────────────
describe('POST /api/escrow/pay/:jobId', () => {
    test('employer triggers STK push successfully', async () => {
        const job = await createJob();
        const res = await request(app)
            .post(`/api/escrow/pay/${job._id}`)
            .set('Cookie', employerCookie)
            .send({ employerPhone: '254711100001' });

        expect(res.statusCode).toBe(200);
        expect(res.body.msg).toMatch(/M-Pesa prompt sent/i);
        expect(stkPush).toHaveBeenCalledTimes(1);
        expect(stkPush).toHaveBeenCalledWith('254711100001', 1000, job._id);

        // CheckoutRequestID must be stored on the job
        const updated = await Job.findById(job._id);
        expect(updated.checkoutRequestId).toBe('mock-checkout-id-123');
    });

    test('worker cannot trigger STK push', async () => {
        const job = await createJob();
        const res = await request(app)
            .post(`/api/escrow/pay/${job._id}`)
            .set('Cookie', workerCookie)
            .send({ employerPhone: '254711100002' });

        expect(res.statusCode).toBe(403);
        expect(stkPush).not.toHaveBeenCalled();
    });

    test('rejects missing phone', async () => {
        const job = await createJob();
        const res = await request(app)
            .post(`/api/escrow/pay/${job._id}`)
            .set('Cookie', employerCookie)
            .send({});

        expect(res.statusCode).toBe(400);
        expect(res.body.msg).toMatch(/phone.*required/i);
    });

    test('rejects invalid phone format', async () => {
        const job = await createJob();
        const res = await request(app)
            .post(`/api/escrow/pay/${job._id}`)
            .set('Cookie', employerCookie)
            .send({ employerPhone: '0712345678' }); // missing country code

        expect(res.statusCode).toBe(400);
        expect(res.body.msg).toMatch(/254/);
    });

    test('rejects payment on non-pending job', async () => {
        const job = await createJob({ paymentStatus: 'In-Escrow' });
        const res = await request(app)
            .post(`/api/escrow/pay/${job._id}`)
            .set('Cookie', employerCookie)
            .send({ employerPhone: '254711100001' });

        expect(res.statusCode).toBe(400);
        expect(res.body.msg).toMatch(/In-Escrow/);
    });

    test('returns 404 for unknown job', async () => {
        const fakeId = new mongoose.Types.ObjectId();
        const res = await request(app)
            .post(`/api/escrow/pay/${fakeId}`)
            .set('Cookie', employerCookie)
            .send({ employerPhone: '254711100001' });

        expect(res.statusCode).toBe(404);
    });
});

// ── POST /api/escrow/callback (STK Push webhook) ─────────────────────────────
describe('POST /api/escrow/callback', () => {
    test('successful callback moves job to In-Escrow', async () => {
        const job = await createJob({ checkoutRequestId: 'test-checkout-abc' });

        const res = await request(app)
            .post('/api/escrow/callback')
            .send({
                Body: {
                    stkCallback: {
                        ResultCode: 0,
                        CheckoutRequestID: 'test-checkout-abc',
                        CallbackMetadata: {
                            Item: [
                                { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' },
                                { Name: 'Amount', Value: 1000 },
                            ]
                        }
                    }
                }
            });

        expect(res.statusCode).toBe(200);
        const updated = await Job.findById(job._id);
        expect(updated.paymentStatus).toBe('In-Escrow');
        expect(updated.mpesaReceiptNumber).toBe('NLJ7RT61SV');
    });

    test('failed callback (ResultCode != 0) does not change job status', async () => {
        const job = await createJob({ checkoutRequestId: 'test-checkout-fail' });

        await request(app)
            .post('/api/escrow/callback')
            .send({
                Body: {
                    stkCallback: {
                        ResultCode: 1032,
                        ResultDesc: 'Request cancelled by user',
                        CheckoutRequestID: 'test-checkout-fail',
                    }
                }
            });

        const updated = await Job.findById(job._id);
        expect(updated.paymentStatus).toBe('Pending');
    });

    test('unknown CheckoutRequestID is silently ignored', async () => {
        const res = await request(app)
            .post('/api/escrow/callback')
            .send({
                Body: {
                    stkCallback: {
                        ResultCode: 0,
                        CheckoutRequestID: 'completely-unknown-id',
                        CallbackMetadata: { Item: [] }
                    }
                }
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.ResultCode).toBe(0);
    });
});

// ── POST /api/escrow/release/:jobId ─────────────────────────────────────────
describe('POST /api/escrow/release/:jobId', () => {
    test('employer releases payment to hired worker', async () => {
        const job = await createJob({
            paymentStatus: 'In-Escrow',
            hiredWorkerId: workerId,
            hiredWorker:   'Test Worker',
        });

        const res = await request(app)
            .post(`/api/escrow/release/${job._id}`)
            .set('Cookie', employerCookie);

        expect(res.statusCode).toBe(200);
        expect(res.body.msg).toMatch(/release initiated/i);
        expect(b2cPayout).toHaveBeenCalledTimes(1);

        const updated = await Job.findById(job._id);
        expect(updated.paymentStatus).toBe('Releasing');
    });

    test('worker cannot release payment', async () => {
        const job = await createJob({ paymentStatus: 'In-Escrow' });
        const res = await request(app)
            .post(`/api/escrow/release/${job._id}`)
            .set('Cookie', workerCookie);

        expect(res.statusCode).toBe(403);
    });

    test('cannot release if not In-Escrow', async () => {
        const job = await createJob({ paymentStatus: 'Pending' });
        const res = await request(app)
            .post(`/api/escrow/release/${job._id}`)
            .set('Cookie', employerCookie);

        expect(res.statusCode).toBe(400);
        expect(res.body.msg).toMatch(/Pending/);
    });

    test('cannot release if no worker hired', async () => {
        const job = await createJob({ paymentStatus: 'In-Escrow' });
        const res = await request(app)
            .post(`/api/escrow/release/${job._id}`)
            .set('Cookie', employerCookie);

        expect(res.statusCode).toBe(400);
        expect(res.body.msg).toMatch(/No worker hired/i);
    });
});

// ── POST /api/escrow/refund/:jobId ───────────────────────────────────────────
describe('POST /api/escrow/refund/:jobId', () => {
    test('employer gets refund from escrow', async () => {
        const job = await createJob({ paymentStatus: 'In-Escrow' });

        const res = await request(app)
            .post(`/api/escrow/refund/${job._id}`)
            .set('Cookie', employerCookie);

        expect(res.statusCode).toBe(200);
        expect(res.body.msg).toMatch(/Refund initiated/i);
        expect(b2cPayout).toHaveBeenCalledTimes(1);

        const updated = await Job.findById(job._id);
        expect(updated.paymentStatus).toBe('Refunding');
    });

    test('cannot refund if not In-Escrow', async () => {
        const job = await createJob({ paymentStatus: 'Pending' });
        const res = await request(app)
            .post(`/api/escrow/refund/${job._id}`)
            .set('Cookie', employerCookie);

        expect(res.statusCode).toBe(400);
    });
});

// ── POST /api/escrow/b2c-callback ────────────────────────────────────────────
describe('POST /api/escrow/b2c-callback', () => {
    function b2cCallback(jobId, resultCode = 0, desc = 'Success') {
        return request(app)
            .post('/api/escrow/b2c-callback')
            .send({
                Result: {
                    ResultCode: resultCode,
                    ResultDesc: desc,
                    ReferenceData: {
                        ReferenceItem: { Key: 'Occasion', Value: `JOB-${jobId}` }
                    }
                }
            });
    }

    test('successful release → job status becomes Released', async () => {
        const job = await createJob({ paymentStatus: 'Releasing', hiredWorkerId: workerId });

        const res = await b2cCallback(job._id);
        expect(res.statusCode).toBe(200);

        const updated = await Job.findById(job._id);
        expect(updated.paymentStatus).toBe('Released');
        expect(updated.status).toBe('Completed');
    });

    test('successful refund → job status becomes Refunded', async () => {
        const job = await createJob({ paymentStatus: 'Refunding' });

        const res = await b2cCallback(job._id);
        expect(res.statusCode).toBe(200);

        const updated = await Job.findById(job._id);
        expect(updated.paymentStatus).toBe('Refunded');
    });

    test('failed B2C reverts job to In-Escrow', async () => {
        const job = await createJob({ paymentStatus: 'Releasing', hiredWorkerId: workerId });

        const res = await b2cCallback(job._id, 2001, 'Insufficient funds');
        expect(res.statusCode).toBe(200);

        const updated = await Job.findById(job._id);
        expect(updated.paymentStatus).toBe('In-Escrow');
    });
});

// ── POST /api/escrow/b2c-timeout ─────────────────────────────────────────────
describe('POST /api/escrow/b2c-timeout', () => {
    test('timeout reverts Releasing job to In-Escrow', async () => {
        const job = await createJob({ paymentStatus: 'Releasing' });

        const res = await request(app)
            .post('/api/escrow/b2c-timeout')
            .send({
                Request: {
                    ReferenceData: {
                        ReferenceItem: { Key: 'Occasion', Value: `JOB-${job._id}` }
                    }
                }
            });

        expect(res.statusCode).toBe(200);
        const updated = await Job.findById(job._id);
        expect(updated.paymentStatus).toBe('In-Escrow');
    });
});
