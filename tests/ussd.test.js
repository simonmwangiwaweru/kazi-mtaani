const request  = require('supertest');
const mongoose = require('mongoose');
const app      = require('./app');
const User     = require('../models/user');
const Job      = require('../models/job');

beforeAll(async () => {
    await mongoose.connect(process.env.TEST_MONGO_URI);
});

afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
});

afterEach(async () => {
    await User.deleteMany({});
    await Job.deleteMany({});
});

function ussd(text, phone = '254712000000') {
    return request(app).post('/api/ussd')
        .type('form')
        .send({ sessionId: 'sess1', serviceCode: '*384*30173#', phoneNumber: phone, text });
}

async function createWorker(phone = '254712000001', lang = 'en') {
    return User.create({ name: 'Alice Wanjiku', phone, password: 'x', role: 'worker', tokenVersion: 0, language: lang });
}

async function createEmployer(phone = '254712000002', lang = 'en') {
    return User.create({ name: 'Bob Mwangi', phone, password: 'x', role: 'employer', tokenVersion: 0, language: lang });
}

async function createJob(employerId, overrides = {}) {
    return Job.create({
        title: 'Paint House', description: 'Paint walls', location: 'Nairobi',
        pay: 1000, status: 'Open', category: 'artisan',
        employer: employerId, employerPhone: '254712000002',
        ...overrides,
    });
}

// ── Registration ──────────────────────────────────────────────────────────────
describe('Registration', () => {
    test('unregistered user sees register option', async () => {
        const res = await ussd('');
        expect(res.text).toMatch(/CON/);
        expect(res.text).toMatch(/Register/i);
    });

    test('step 1: asks for full name', async () => {
        const res = await ussd('1', '254799000001');
        expect(res.text).toMatch(/full name/i);
    });

    test('step 2: asks for role', async () => {
        const res = await ussd('1*John Kamau', '254799000001');
        expect(res.text).toMatch(/Worker/i);
        expect(res.text).toMatch(/Employer/i);
    });

    test('step 2: rejects short name', async () => {
        const res = await ussd('1*J', '254799000001');
        expect(res.text).toMatch(/short/i);
    });

    test('step 3: creates worker account', async () => {
        await ussd('1*Mary Kamau*1', '254799000002');
        const saved = await User.findOne({ phone: '254799000002' });
        expect(saved).not.toBeNull();
        expect(saved.role).toBe('worker');
    });

    test('step 3: creates employer account', async () => {
        const res = await ussd('1*Dan Otieno*2', '254799000003');
        expect(res.text).toMatch(/^END/);
        const saved = await User.findOne({ phone: '254799000003' });
        expect(saved.role).toBe('employer');
    });
});

// ── Worker main menu ──────────────────────────────────────────────────────────
describe('Worker main menu', () => {
    test('shows personalised worker menu (English)', async () => {
        await createWorker();
        const res = await ussd('', '254712000001');
        expect(res.text).toMatch(/Alice/);
        expect(res.text).toMatch(/Browse Jobs/i);
        expect(res.text).toMatch(/Language/i);
    });

    test('shows personalised worker menu (Swahili)', async () => {
        await createWorker('254712000001', 'sw');
        const res = await ussd('', '254712000001');
        expect(res.text).toMatch(/Karibu/);
        expect(res.text).toMatch(/Tafuta Kazi/i);
    });

    test('exit returns END', async () => {
        const res = await ussd('0');
        expect(res.text).toMatch(/^END/);
    });

    test('content-type is text/plain', async () => {
        const res = await ussd('');
        expect(res.headers['content-type']).toMatch(/text\/plain/);
    });
});

// ── Browse jobs by category ───────────────────────────────────────────────────
describe('Browse jobs by category', () => {
    test('option 1 shows category menu', async () => {
        await createWorker();
        const res = await ussd('1', '254712000001');
        expect(res.text).toMatch(/All Jobs/i);
        expect(res.text).toMatch(/Artisan/i);
        expect(res.text).toMatch(/Transport/i);
    });

    test('all jobs lists open jobs', async () => {
        const emp = await createEmployer();
        await createJob(emp._id);
        await createWorker();
        const res = await ussd('1*1', '254712000001'); // All Jobs
        expect(res.text).toMatch(/Paint House/i);
    });

    test('category filter returns matching jobs', async () => {
        const emp = await createEmployer();
        await createJob(emp._id, { category: 'artisan' });
        await createJob(emp._id, { title: 'Drive Truck', category: 'transport' });
        await createWorker();

        const artisanRes = await ussd('1*2', '254712000001');  // artisan
        expect(artisanRes.text).toMatch(/Paint House/i);
        expect(artisanRes.text).not.toMatch(/Drive Truck/i);

        const transportRes = await ussd('1*5', '254712000001'); // transport (now slot 5)
        expect(transportRes.text).toMatch(/Drive Truck/i);
        expect(transportRes.text).not.toMatch(/Paint House/i);
    });

    test('no jobs in category shows appropriate message', async () => {
        await createWorker();
        const res = await ussd('1*4', '254712000001'); // cleaning — none created
        expect(res.text).toMatch(/No open jobs|Hakuna/i);
    });

    test('job detail shows title, location, pay', async () => {
        const emp = await createEmployer();
        await createJob(emp._id);
        await createWorker();
        const res = await ussd('1*2*1', '254712000001'); // first manual job
        expect(res.text).toMatch(/Nairobi/i);
        expect(res.text).toMatch(/1,000|1000/);
        expect(res.text).toMatch(/Apply/i);
    });

    test('worker can apply for a job', async () => {
        const emp = await createEmployer();
        const job = await createJob(emp._id);
        const worker = await createWorker();
        const res = await ussd('1*2*1*1', '254712000001');
        expect(res.text).toMatch(/^END/);
        expect(res.text).toMatch(/Applied|Umefanikiwa/i);

        const updated = await Job.findById(job._id);
        expect(updated.applicants.map(id => id.toString())).toContain(worker._id.toString());
    });

    test('worker cannot apply twice', async () => {
        const emp = await createEmployer();
        const worker = await createWorker();
        await createJob(emp._id, { applicants: [worker._id] });
        const res = await ussd('1*2*1*1', '254712000001');
        expect(res.text).toMatch(/already|Umeshaomba/i);
    });

    test('category menu in Swahili', async () => {
        await createWorker('254712000001', 'sw');
        const res = await ussd('1', '254712000001');
        expect(res.text).toMatch(/Kazi Zote/i);
        expect(res.text).toMatch(/Fundi wa Biashara/i);
    });
});

// ── My Applications ──────────────────────────────────────────────────────────
describe('My Applications', () => {
    test('shows applied jobs', async () => {
        const emp = await createEmployer();
        const worker = await createWorker();
        await createJob(emp._id, { applicants: [worker._id] });
        const res = await ussd('2', '254712000001');
        expect(res.text).toMatch(/Paint House/i);
    });

    test('shows hired status correctly', async () => {
        const emp = await createEmployer();
        const worker = await createWorker();
        await createJob(emp._id, { applicants: [worker._id], hiredWorker: 'Alice Wanjiku', status: 'In Progress' });
        const res = await ussd('2', '254712000001');
        expect(res.text).toMatch(/HIRED/i);
    });

    test('no applications message', async () => {
        await createWorker();
        const res = await ussd('2', '254712000001');
        expect(res.text).toMatch(/no applications|Huna maombi/i);
    });
});

// ── My Profile ────────────────────────────────────────────────────────────────
describe('My Profile', () => {
    test('shows worker profile', async () => {
        await createWorker();
        const res = await ussd('3', '254712000001');
        expect(res.text).toMatch(/^END/);
        expect(res.text).toMatch(/Alice Wanjiku/i);
    });

    test('shows profile in Swahili', async () => {
        await createWorker('254712000001', 'sw');
        const res = await ussd('3', '254712000001');
        expect(res.text).toMatch(/Jukumu|Ukadiriaji/i);
    });
});

// ── Language selection ────────────────────────────────────────────────────────
describe('Language selection', () => {
    test('worker option 4 shows language menu', async () => {
        await createWorker();
        const res = await ussd('4', '254712000001');
        expect(res.text).toMatch(/English/i);
        expect(res.text).toMatch(/Kiswahili/i);
    });

    test('selecting Swahili updates user language', async () => {
        await createWorker();
        const res = await ussd('4*2', '254712000001');
        expect(res.text).toMatch(/^END/);
        const updated = await User.findOne({ phone: '254712000001' });
        expect(updated.language).toBe('sw');
    });

    test('selecting English keeps language as en', async () => {
        await createWorker('254712000001', 'sw');
        await ussd('4*1', '254712000001');
        const updated = await User.findOne({ phone: '254712000001' });
        expect(updated.language).toBe('en');
    });
});

// ── Employer flows ────────────────────────────────────────────────────────────
describe('Employer flows', () => {
    test('employer sees employer menu (not worker menu)', async () => {
        await createEmployer();
        const res = await ussd('', '254712000002');
        expect(res.text).toMatch(/My Jobs/i);
        expect(res.text).not.toMatch(/Browse Jobs/i);
    });

    test('employer sees their jobs list', async () => {
        const emp = await createEmployer();
        await createJob(emp._id);
        const res = await ussd('1', '254712000002');
        expect(res.text).toMatch(/Paint House/i);
        expect(res.text).toMatch(/\(0\)/); // 0 applicants
    });

    test('employer sees no jobs message', async () => {
        await createEmployer();
        const res = await ussd('1', '254712000002');
        expect(res.text).toMatch(/no.*jobs|Huna kazi/i);
    });

    test('employer sees applicant count on job detail', async () => {
        const emp = await createEmployer();
        const worker1 = await createWorker('254712000001');
        const worker2 = await User.create({ name: 'Carol Muthoni', phone: '254712000010', password: 'x', role: 'worker', tokenVersion: 0 });
        await createJob(emp._id, { applicants: [worker1._id, worker2._id] });
        const res = await ussd('1*1', '254712000002');
        expect(res.text).toMatch(/Applicants: 2|Waombaji: 2/i);
    });

    test('employer sees applicants list', async () => {
        const emp = await createEmployer();
        const worker = await createWorker();
        await createJob(emp._id, { applicants: [worker._id] });
        const res = await ussd('1*1*1', '254712000002');
        expect(res.text).toMatch(/Alice Wanjiku/i);
    });

    test('employer sees hire confirmation prompt', async () => {
        const emp = await createEmployer();
        const worker = await createWorker();
        await createJob(emp._id, { applicants: [worker._id], paymentStatus: 'In-Escrow' });
        const res = await ussd('1*1*1*1', '254712000002');
        expect(res.text).toMatch(/Hire Alice|Mwajiri Alice/i);
        expect(res.text).toMatch(/1,000|1000/);
    });

    test('employer can hire a worker via USSD', async () => {
        const emp = await createEmployer();
        const worker = await createWorker();
        const job = await createJob(emp._id, { applicants: [worker._id], paymentStatus: 'In-Escrow' });

        const res = await ussd('1*1*1*1*1', '254712000002');
        expect(res.text).toMatch(/^END/);
        expect(res.text).toMatch(/Alice|hired|ameajiriwa/i);

        const updated = await Job.findById(job._id);
        expect(updated.hiredWorker).toBe('Alice Wanjiku');
        expect(updated.status).toBe('In Progress');
    });

    test('employer language option is option 3', async () => {
        await createEmployer();
        const res = await ussd('3', '254712000002');
        expect(res.text).toMatch(/English/i);
        expect(res.text).toMatch(/Kiswahili/i);
    });

    test('employer menu in Swahili', async () => {
        await createEmployer('254712000002', 'sw');
        const res = await ussd('', '254712000002');
        expect(res.text).toMatch(/Kazi Zangu/i);
    });
});

// ── Misc ──────────────────────────────────────────────────────────────────────
describe('Misc', () => {
    test('invalid option returns error', async () => {
        await createWorker();
        const res = await ussd('99', '254712000001');
        expect(res.text).toMatch(/Invalid|Chaguo baya/i);
    });
});
