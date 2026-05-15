const { MongoMemoryServer } = require('mongodb-memory-server');
const request  = require('supertest');
const mongoose = require('mongoose');
const app      = require('./app');
const User     = require('../models/user');
const Job      = require('../models/job');

let mongod;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
    await mongod.stop();
});

afterEach(async () => { await User.deleteMany({}); await Job.deleteMany({}); });

// Africa's Talking sends form-urlencoded POST
function ussd(text, phone = '254712000000') {
    return request(app).post('/api/ussd')
        .type('form')
        .send({ sessionId: 'test-session', serviceCode: '*384*30173#', phoneNumber: phone, text });
}

// ── Main menu ────────────────────────────────────────────────────────────────
describe('Main menu', () => {
    test('unregistered phone sees register option', async () => {
        const res = await ussd('');
        expect(res.statusCode).toBe(200);
        expect(res.text).toMatch(/CON/);
        expect(res.text).toMatch(/not registered/i);
        expect(res.text).toMatch(/Register/i);
    });

    test('registered user sees personalised menu', async () => {
        await User.create({ name: 'Alice Wanjiku', phone: '254712000001', password: 'pass', role: 'worker', tokenVersion: 0 });
        const res = await ussd('', '254712000001');
        expect(res.text).toMatch(/CON/);
        expect(res.text).toMatch(/Alice/);
        expect(res.text).toMatch(/Browse Jobs/i);
    });

    test('exit returns END', async () => {
        const res = await ussd('0');
        expect(res.text).toMatch(/^END/);
    });

    test('response content-type is text/plain', async () => {
        const res = await ussd('');
        expect(res.headers['content-type']).toMatch(/text\/plain/);
    });
});

// ── Registration flow ────────────────────────────────────────────────────────
describe('Registration flow', () => {
    const NEW_PHONE = '254799000001';

    test('step 1: asks for full name', async () => {
        const res = await ussd('1', NEW_PHONE);
        expect(res.text).toMatch(/CON/);
        expect(res.text).toMatch(/full name/i);
    });

    test('step 2: asks for role after name entered', async () => {
        const res = await ussd('1*John Kamau', NEW_PHONE);
        expect(res.text).toMatch(/CON/);
        expect(res.text).toMatch(/role/i);
        expect(res.text).toMatch(/Worker/i);
        expect(res.text).toMatch(/Employer/i);
    });

    test('step 2: rejects name that is too short', async () => {
        const res = await ussd('1*J', NEW_PHONE);
        expect(res.text).toMatch(/CON/);
        expect(res.text).toMatch(/too short/i);
    });

    test('step 3: creates worker account', async () => {
        const res = await ussd('1*John Kamau*1', NEW_PHONE);
        expect(res.text).toMatch(/^END/);
        expect(res.text).toMatch(/Registered/i);
        const saved = await User.findOne({ phone: NEW_PHONE });
        expect(saved).not.toBeNull();
        expect(saved.role).toBe('worker');
        expect(saved.name).toBe('John Kamau');
    });

    test('step 3: creates employer account', async () => {
        const res = await ussd('1*Jane Otieno*2', NEW_PHONE);
        expect(res.text).toMatch(/^END/);
        const saved = await User.findOne({ phone: NEW_PHONE });
        expect(saved.role).toBe('employer');
    });

    test('step 3: invalid role choice prompts again', async () => {
        const res = await ussd('1*John Kamau*9', NEW_PHONE);
        expect(res.text).toMatch(/CON/);
        expect(res.text).toMatch(/Invalid/i);
    });
});

// ── Browse jobs ───────────────────────────────────────────────────────────────
describe('Browse jobs', () => {
    test('lists open jobs', async () => {
        await Job.create({ title: 'Painter', description: 'Paint walls', location: 'Nairobi', pay: 800, status: 'Open',
            employer: new mongoose.Types.ObjectId(), employerPhone: '254700000000', category: 'manual' });
        const res = await ussd('1', '254712000001');
        // unregistered → registration flow, so create a registered user first
        await User.create({ name: 'Bob', phone: '254712000001', password: 'x', role: 'worker', tokenVersion: 0 });
        const res2 = await ussd('1', '254712000001');
        expect(res2.text).toMatch(/CON/);
        expect(res2.text).toMatch(/Painter|Open Jobs/i);
    });

    test('no open jobs shows appropriate message', async () => {
        await User.create({ name: 'Bob', phone: '254712000002', password: 'x', role: 'worker', tokenVersion: 0 });
        const res = await ussd('1', '254712000002');
        expect(res.text).toMatch(/No open jobs/i);
    });
});

// ── My Applications ──────────────────────────────────────────────────────────
describe('My Applications', () => {
    test('unregistered user gets redirect message', async () => {
        const res = await ussd('2', '254700099999');
        expect(res.text).toMatch(/END/);
        expect(res.text).toMatch(/Register/i);
    });

    test('registered user with no applications', async () => {
        await User.create({ name: 'Carol', phone: '254712000003', password: 'x', role: 'worker', tokenVersion: 0 });
        const res = await ussd('2', '254712000003');
        expect(res.text).toMatch(/no applications/i);
    });
});

// ── My Profile ───────────────────────────────────────────────────────────────
describe('My Profile', () => {
    test('unregistered user gets redirect message', async () => {
        const res = await ussd('3', '254700099998');
        expect(res.text).toMatch(/END/);
    });

    test('registered worker sees profile', async () => {
        await User.create({ name: 'Profile Wk', phone: '254712000004', password: 'x', role: 'worker',
            rating: 4.5, tokenVersion: 0 });
        const res = await ussd('3', '254712000004');
        expect(res.text).toMatch(/^END/);
        expect(res.text).toMatch(/Profile Wk/i);
    });
});

// ── Misc ─────────────────────────────────────────────────────────────────────
describe('Misc', () => {
    test('invalid option returns error', async () => {
        const res = await ussd('99');
        expect(res.text).toMatch(/Invalid/i);
    });
});
