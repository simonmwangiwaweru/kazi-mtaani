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
        .send({ sessionId: 'test-session', serviceCode: '*123#', phoneNumber: phone, text });
}

describe('USSD API', () => {
    test('main menu shown for unknown phone', async () => {
        const res = await ussd('');
        expect(res.statusCode).toBe(200);
        expect(res.text).toMatch(/CON/);
        expect(res.text).toMatch(/not registered/i);
    });

    test('main menu shown for registered user', async () => {
        await User.create({ name: 'USSD User', phone: '254712000001', password: 'hashed', role: 'worker', tokenVersion: 0 });
        const res = await ussd('', '254712000001');
        expect(res.text).toMatch(/CON/);
        expect(res.text).toMatch(/USSD User|Browse Jobs/i);
    });

    test('browse jobs lists open jobs', async () => {
        await Job.create({ title: 'Painter', description: 'Paint walls', location: 'Nairobi', pay: 800, status: 'Open',
            employer: new mongoose.Types.ObjectId(), employerPhone: '254700000000', category: 'manual' });
        const res = await ussd('1');
        expect(res.text).toMatch(/CON/);
        expect(res.text).toMatch(/Painter|Open Jobs/i);
    });

    test('no open jobs shows appropriate message', async () => {
        const res = await ussd('1');
        expect(res.text).toMatch(/No open jobs/i);
    });

    test('exit returns END', async () => {
        const res = await ussd('0');
        expect(res.text).toMatch(/^END/);
    });

    test('invalid option returns error', async () => {
        const res = await ussd('99');
        expect(res.text).toMatch(/Invalid/i);
    });

    test('my applications returns END for unregistered user', async () => {
        const res = await ussd('2', '254700099999');
        expect(res.text).toMatch(/END/);
        expect(res.text).toMatch(/register/i);
    });

    test('my profile returns END for registered worker', async () => {
        await User.create({ name: 'Profile Wk', phone: '254712000002', password: 'x', role: 'worker',
            rating: 4.5, tokenVersion: 0 });
        const res = await ussd('3', '254712000002');
        expect(res.text).toMatch(/END/);
        expect(res.text).toMatch(/Profile Wk/i);
    });

    test('response content-type is text/plain', async () => {
        const res = await ussd('');
        expect(res.headers['content-type']).toMatch(/text\/plain/);
    });
});
