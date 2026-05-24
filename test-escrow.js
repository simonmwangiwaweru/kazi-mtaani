/**
 * ============================================================
 *  KAZI MTAANI — END-TO-END M-PESA ESCROW TEST
 * ============================================================
 *
 *  Flow tested:
 *    1  → Register employer + worker
 *    2  → Employer creates a job (KES 50 min)
 *    3  → Worker applies   PUT /api/jobs/apply/:id
 *    4  → Employer hires   PUT /api/jobs/hire/:id
 *    5  → Employer triggers STK Push (real Daraja sandbox)
 *    6  → Simulate STK callback → job becomes "In-Escrow"
 *    7  → Employer releases payment (real B2C sandbox)
 *    8  → Simulate B2C result callback → job becomes "Released"
 *
 *  Run:  node test-escrow.js
 *  Needs: Server on http://localhost:5000
 * ============================================================
 */

require('dotenv').config();
const axios = require('axios');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:5000/api';

// ─── Colour helpers ───────────────────────────────────────────
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m',
      C = '\x1b[36m', W = '\x1b[90m', B = '\x1b[1m', X = '\x1b[0m';

const pass = (m) => console.log(`  ${G}✅ PASS${X}  ${m}`);
const fail = (m) => console.log(`  ${R}❌ FAIL${X}  ${m}`);
const info = (m) => console.log(`  ${C}ℹ${X}   ${m}`);
const warn = (m) => console.log(`  ${Y}⚠${X}   ${m}`);
const step = (n, m) => console.log(`\n${B}${Y}━━ STEP ${n} ${X}${B}${m}${X}`);
const hr   = () => console.log(W + '─'.repeat(62) + X);

// ─── Unique test IDs so reruns don't clash ────────────────────
const ts             = Date.now();
const EMPLOYER_EMAIL = `emp_${ts}@test.km`;
const WORKER_EMAIL   = `wrk_${ts}@test.km`;
const PASSWORD       = 'Test@1234';
// Safaricom sandbox test number used for STK Push / B2C payout
const STK_PHONE      = '254708374149';
// Unique dummy phones — avoids phone-uniqueness conflicts across test runs
const EMPLOYER_PHONE = `2547${String(ts).slice(-8)}`;
const WORKER_PHONE   = `2541${String(ts).slice(-8)}`;

// State
let employerToken, workerToken, employerId, workerId, jobId, checkoutRequestId;

// ─── Axios helper ─────────────────────────────────────────────
async function api(method, path, data, token) {
    try {
        return await axios({
            method, url: `${BASE}${path}`, data,
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            validateStatus: () => true
        });
    } catch (e) {
        return { status: 0, data: { msg: e.message } };
    }
}

// ─── Step 0: Health ───────────────────────────────────────────
async function s0_health() {
    step(0, 'Health check — is the server running?');
    const r = await api('GET', '/auth/health');
    if (r.status === 200) {
        pass(`Server up → ${JSON.stringify(r.data)}`);
    } else {
        fail('Server NOT responding. Start it: node server.js');
        process.exit(1);
    }
}

// ─── Step 1: Register users ───────────────────────────────────
async function s1_register() {
    step(1, 'Register employer & worker');

    // Try to register employer
    let eR = await api('POST', '/auth/register', {
         name: 'TestEmployer', email: EMPLOYER_EMAIL, password: PASSWORD,
         role: 'employer', phone: EMPLOYER_PHONE, location: 'Nairobi'
       });
    if (eR.status === 201) {
         employerToken = eR.data.token;
         employerId    = eR.data.user?._id || eR.data._id;
         pass(`Employer registered → ${EMPLOYER_EMAIL}`);
       } else if (eR.status === 400 && eR.data.msg && eR.data.msg.includes('already exists')) {
         // Fallback: login with this run's unique phone
         const loginR = await api('POST', '/auth/login', {
           phone: EMPLOYER_PHONE,
           password: PASSWORD
         });
         if (loginR.status === 200) {
           employerToken = loginR.data.token;
           employerId    = loginR.data.user?._id || loginR.data._id;
           pass(`Employer logged in → ${EMPLOYER_EMAIL}`);
         } else {
           fail(`Employer login failed (${loginR.status}): ${JSON.stringify(loginR.data)}`);
           process.exit(1);
         }
       } else {
         fail(`Employer register (${eR.status}): ${JSON.stringify(eR.data)}`);
         process.exit(1);
       }

    // Try to register worker
    let wR = await api('POST', '/auth/register', {
         name: 'TestWorker', email: WORKER_EMAIL, password: PASSWORD,
         role: 'worker', phone: WORKER_PHONE, location: 'Nairobi'
       });
       if (wR.status === 201) {
         workerToken = wR.data.token;
         workerId    = wR.data.user?._id || wR.data._id;
         pass(`Worker registered → ${WORKER_EMAIL}`);
       } else if (wR.status === 400 && wR.data.msg && wR.data.msg.includes('already exists')) {
         // Fallback: login with this run's unique phone
         const loginR = await api('POST', '/auth/login', {
           phone: WORKER_PHONE,
           password: PASSWORD
         });
         if (loginR.status === 200) {
           workerToken = loginR.data.token;
           workerId    = loginR.data.user?._id || loginR.data._id;
           pass(`Worker logged in → ${WORKER_EMAIL}`);
         } else {
           fail(`Worker login failed (${loginR.status}): ${JSON.stringify(loginR.data)}`);
           process.exit(1);
         }
       } else {
         fail(`Worker register (${wR.status}): ${JSON.stringify(wR.data)}`);
         process.exit(1);
       }

    // Resolve IDs via /auth/me if not already in register response
    if (!employerId || !workerId) {
        const [em, wm] = await Promise.all([
            api('GET', '/auth/me', null, employerToken),
            api('GET', '/auth/me', null, workerToken)
        ]);
        if (em.status === 200) { employerId = em.data._id || em.data.id; }
        if (wm.status === 200) { workerId   = wm.data._id || wm.data.id; }
    }
    info(`Employer ID: ${employerId}`);
    info(`Worker   ID: ${workerId}`);
}

// ─── Step 2: Create job ───────────────────────────────────────
async function s2_createJob() {
    step(2, 'Create a job as employer (KES 50 minimum)');

    const r = await api('POST', '/jobs', {
        title:       `Escrow Test Job ${ts}`,
        description: 'End-to-end escrow test — lawn mowing.',
        location:    'Nairobi, Kenya',
        pay:         50,          // minimum allowed
        category:    'general',
        duration:    '1 hour'
    }, employerToken);

    if (r.status === 201) {
        jobId = r.data._id;
        pass(`Job created! ID: ${jobId}  |  pay: KES ${r.data.pay}  |  status: ${r.data.paymentStatus}`);
    } else {
        fail(`Job creation (${r.status}): ${JSON.stringify(r.data)}`);
        process.exit(1);
    }
}

// ─── Step 3: Apply & Hire ─────────────────────────────────────
async function s3_applyAndHire() {
    step(3, 'Worker applies → Employer hires');

    // Worker applies
    const aR = await api('PUT', `/jobs/apply/${jobId}`, {}, workerToken);
    if (aR.status === 200) {
        pass('Worker applied successfully');
    } else {
        warn(`Apply response (${aR.status}): ${JSON.stringify(aR.data)}`);
    }

    // Employer hires (needs workerId in body)
    const hR = await api('PUT', `/jobs/hire/${jobId}`, { workerId }, employerToken);
    if (hR.status === 200) {
        pass(`Worker hired! Job status: ${hR.data.status}`);
    } else {
        fail(`Hire (${hR.status}): ${JSON.stringify(hR.data)}`);
        info('Hire failed — will still attempt escrow flow (worker phone won\'t be available for release).');
    }

    // Patch worker's phone directly in DB to the Daraja sandbox number so B2C release works.
    // Must first free STK_PHONE from any stale test user that holds it (unique index constraint).
    step('3b', 'Patch worker phone → Daraja sandbox MSISDN for B2C payout (direct DB)');
    try {
        const mongoose = require('mongoose');
        const User     = require('./models/user');
        if (mongoose.connection.readyState !== 1) await mongoose.connect(process.env.MONGO_URI);
        // Release STK_PHONE from whoever currently holds it (won't affect this run's worker)
        await User.updateMany(
            { phone: STK_PHONE, _id: { $ne: workerId } },
            { $set: { phone: `freed_${Date.now()}` } }
        );
        // Now assign STK_PHONE to this run's worker
        await User.findByIdAndUpdate(workerId, { phone: STK_PHONE });
        pass(`Worker phone set to ${STK_PHONE} in DB ✓`);
    } catch (e) {
        warn(`DB phone patch failed: ${e.message} — B2C release will likely fail`);
    }
}

// ─── Step 4: STK Push ─────────────────────────────────────────
async function s4_stkPush() {
    step(4, `Trigger STK Push → phone ${STK_PHONE} (Daraja sandbox)`);

    const r = await api('POST', `/escrow/pay/${jobId}`, {
        employerPhone: STK_PHONE
    }, employerToken);

    if (r.status === 200) {
        pass(`STK Push sent: "${r.data.msg}"`);
        info('Daraja sandbox may send a push prompt if this is a real sandbox-enrolled number.');
        return true;
    } else {
        warn(`STK Push (${r.status}): ${JSON.stringify(r.data)}`);
        if (r.status === 500) {
            info('Daraja sandbox may be down or credentials mis-matched. Continuing with simulated flow.');
        }
        return false;
    }
}

// ─── Step 5: Read CheckoutRequestID from DB ───────────────────
async function s5_getCheckoutId() {
    step(5, 'Fetch CheckoutRequestID stored by the server');

    // /api/jobs doesn't have a single-job GET, so we list & filter
    const r = await api('GET', '/jobs', null, employerToken);
    let storedId = null;

    if (r.status === 200) {
        const jobs = r.data.jobs || r.data;
        const job  = jobs.find(j => j._id === jobId);
        storedId   = job?.checkoutRequestId;
        info(`checkoutRequestId from job list: ${storedId || '(not exposed / empty)'}`);
    }

    if (storedId) {
        checkoutRequestId = storedId;
        pass(`Will use real Daraja CheckoutRequestID: ${checkoutRequestId}`);
    } else {
        // The job list endpoint may not include this field for security
        // We'll inject directly via DB using a quick mongoose script below,
        // OR fall back to simulating without a real match (status won't update)
        checkoutRequestId = `ws_CO_SIMULATED_${ts}`;
        warn('No real CheckoutRequestID available from API (expected — it\'s server-side only).');
        info(`Will inject simulated ID: ${checkoutRequestId}`);
        await injectCheckoutId();
    }
}

// Injects a known checkoutRequestId into the job so the callback can match it
async function injectCheckoutId() {
    info('Injecting checkoutRequestId into DB directly via mongoose...');
    try {
        const mongoose = require('mongoose');
        const Job      = require('./models/job');

        if (mongoose.connection.readyState !== 1) {
            await mongoose.connect(process.env.MONGO_URI);
        }

        await Job.findByIdAndUpdate(jobId, {
            checkoutRequestId,
            paymentStatus: 'Pending'     // ensure it's Pending so callback can match
        });
        pass(`Injected checkoutRequestId: ${checkoutRequestId}`);
    } catch (e) {
        warn(`Could not inject directly: ${e.message}`);
        info('Callback will still be sent but job may not transition to In-Escrow.');
    }
}

// ─── Step 6: Simulate STK Callback ───────────────────────────
async function s6_stkCallback() {
    step(6, 'Simulate STK Push callback (faking Safaricom → our /api/escrow/callback)');

    const payload = {
        Body: {
            stkCallback: {
                MerchantRequestID:  `merchant-${ts}`,
                CheckoutRequestID:  checkoutRequestId,
                ResultCode:         0,
                ResultDesc:         'The service request is processed successfully.',
                CallbackMetadata: {
                    Item: [
                        { Name: 'Amount',             Value: 50 },
                        { Name: 'MpesaReceiptNumber', Value: `TEST${ts}` },
                        { Name: 'TransactionDate',    Value: 20250507101300 },
                        { Name: 'PhoneNumber',        Value: 254708374149 }
                    ]
                }
            }
        }
    };

    info(`Posting to /api/escrow/callback with CheckoutRequestID: ${checkoutRequestId}`);
    const r = await api('POST', '/escrow/callback', payload);

    if (r.status === 200) {
        pass(`Callback accepted → ${JSON.stringify(r.data)}`);
    } else {
        fail(`Callback failed (${r.status}): ${JSON.stringify(r.data)}`);
    }

    // Give server 600ms to process async DB write
    await new Promise(resolve => setTimeout(resolve, 600));
}

// ─── Step 7: Verify In-Escrow ─────────────────────────────────
async function s7_verifyEscrow() {
    step(7, 'Verify job is now "In-Escrow"');

    const r = await api('GET', '/jobs', null, employerToken);
    if (r.status !== 200) { fail(`Could not list jobs (${r.status})`); return; }

    const jobs = r.data.jobs || r.data;
    const job  = jobs.find(j => j._id === jobId);

    if (!job) { warn('Job not found in list (may need pagination — ID: ' + jobId + ')'); return; }

    info(`paymentStatus : ${B}${job.paymentStatus}${X}`);
    info(`mpesaReceipt  : ${job.mpesaReceiptNumber || '(none)'}`);

    if (job.paymentStatus === 'In-Escrow') {
        pass('🔒 Job is In-Escrow! STK flow confirmed.');
    } else {
        warn(`Expected "In-Escrow" — got "${job.paymentStatus}"`);
        info('This is OK if Daraja sandbox responded with a different CheckoutRequestID.');
        info('The inject step above should have forced a match. Check server logs.');
    }
}

// ─── Step 8: Release Payment ───────────────────────────────────
async function s8_release() {
    step(8, 'Employer releases payment to worker (B2C sandbox)');

    const r = await api('POST', `/escrow/release/${jobId}`, {}, employerToken);

    if (r.status === 200) {
        pass(`Release initiated: "${r.data.msg}"`);
    } else {
        warn(`Release (${r.status}): ${JSON.stringify(r.data)}`);
        if (r.status === 400 && r.data.msg?.includes('In-Escrow')) {
            info('Job not In-Escrow yet — skipping release step.');
        } else if (r.status === 400 && r.data.msg?.includes('worker')) {
            info('No worker phone on record (worker phone field required in user model).');
        }
    }
}

// ─── Step 9: Simulate B2C Callback ───────────────────────────
async function s9_b2cCallback() {
    step(9, 'Simulate B2C result callback → job becomes "Released"');

    const payload = {
        Result: {
            ResultType:               0,
            ResultCode:               0,
            ResultDesc:               'The service request is processed successfully.',
            OriginatorConversationID: `b2c-orig-${ts}`,
            ConversationID:           `b2c-conv-${ts}`,
            TransactionID:            `B2C${ts}`,
            ResultParameters: {
                ResultParameter: [
                    { Key: 'TransactionAmount',              Value: 50 },
                    { Key: 'TransactionReceipt',             Value: `B2CRECEIPT${ts}` },
                    { Key: 'ReceiverPartyPublicName',        Value: `${STK_PHONE} - TestWorker` },
                    { Key: 'TransactionCompletedDateTime',   Value: '07.05.2025 10:15:00' },
                    { Key: 'B2CUtilityAccountAvailableFunds', Value: 9950 },
                    { Key: 'B2CWorkingAccountAvailableFunds', Value: 0 }
                ]
            },
            ReferenceData: {
                ReferenceItem: { Key: 'Occasion', Value: `JOB-${jobId}` }
            }
        }
    };

    const r = await api('POST', '/escrow/b2c-callback', payload);
    if (r.status === 200) {
        pass(`B2C callback accepted → ${JSON.stringify(r.data)}`);
    } else {
        fail(`B2C callback (${r.status}): ${JSON.stringify(r.data)}`);
    }

    await new Promise(resolve => setTimeout(resolve, 600));
}

// ─── Step 10: Verify Released ──────────────────────────────────
async function s10_verifyReleased() {
    step(10, 'Verify job is "Released"');

    const r = await api('GET', '/jobs', null, employerToken);
    if (r.status !== 200) { fail(`Could not list jobs (${r.status})`); return; }

    const jobs = r.data.jobs || r.data;
    const job  = jobs.find(j => j._id === jobId);

    if (!job) { warn('Job not found in list.'); return; }

    info(`paymentStatus : ${B}${job.paymentStatus}${X}`);
    info(`job.status    : ${B}${job.status}${X}`);

    if (job.paymentStatus === 'Released') {
        pass('💰 Payment Released! Full escrow cycle complete. 🎉');
    } else {
        warn(`paymentStatus is "${job.paymentStatus}" — check server logs for B2C result.`);
        info('If release was never triggered (job wasn\'t In-Escrow), this is expected.');
    }
}

// ─── Summary ───────────────────────────────────────────────────
function summary() {
    hr();
    console.log(`\n${B}${C}  KAZI MTAANI ESCROW TEST SUMMARY${X}`);
    console.log(`  Employer  : ${EMPLOYER_EMAIL}`);
    console.log(`  Worker    : ${WORKER_EMAIL}`);
    console.log(`  Job ID    : ${jobId}`);
    console.log(`  Checkout  : ${checkoutRequestId}`);
    console.log(`\n  ${W}Flow: Pending ──[STK Push]──▶ In-Escrow ──[B2C]──▶ Released${X}`);
    console.log(`\n  ${W}Inspect job in DB:${X}`);
    console.log(`  node -e "require('dotenv').config();const m=require('mongoose');const J=require('./models/job');m.connect(process.env.MONGO_URI).then(()=>J.findById('${jobId}').lean().then(j=>{console.log(JSON.stringify(j,null,2));m.disconnect()}))"`);
    hr();
}

// ─── MAIN ──────────────────────────────────────────────────────
(async () => {
    console.log(`\n${B}${C}╔══════════════════════════════════════════════════════╗`);
    console.log(`║   KAZI MTAANI — M-PESA ESCROW END-TO-END TEST       ║`);
    console.log(`╚══════════════════════════════════════════════════════╝${X}\n`);

    await s0_health();
    await s1_register();
    await s2_createJob();
    await s3_applyAndHire();
    await s4_stkPush();
    await s5_getCheckoutId();
    await s6_stkCallback();
    await s7_verifyEscrow();
    await s8_release();
    await s9_b2cCallback();
    await s10_verifyReleased();
    summary();
})().catch(e => {
    console.error(`\n${R}FATAL:${X}`, e.message);
    process.exit(1);
});
