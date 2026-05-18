/**
 * USSD — Africa's Talking gateway for feature-phone users.
 *
 * ── Worker flow ──────────────────────────────────────────────────────────────
 *  ""                          → main menu
 *  "1"                         → category menu
 *  "1*{cat}"                   → job list for category
 *  "1*{cat}*{idx}"             → job detail
 *  "1*{cat}*{idx}*1"           → apply
 *  "2"                         → my applications
 *  "3"                         → my profile
 *  "4"                         → language select
 *  "4*1|2"                     → set language (en/sw)
 *
 * ── Employer flow ────────────────────────────────────────────────────────────
 *  ""                          → employer main menu
 *  "1"                         → my jobs list
 *  "1*{idx}"                   → job detail (applicant count)
 *  "1*{idx}*1"                 → applicants list
 *  "1*{idx}*1*{appIdx}"        → hire confirmation prompt
 *  "1*{idx}*1*{appIdx}*1"      → confirm hire → END
 *  "2"                         → my profile
 *  "3"                         → language select
 *
 * ── Registration flow (unregistered users only) ──────────────────────────────
 *  ""                          → not-registered menu
 *  "1"                         → ask name
 *  "1*{name}"                  → ask role
 *  "1*{name}*1|2"              → create account → END
 */

const express  = require('express');
const router   = express.Router();
const User     = require('../models/user');
const Job      = require('../models/job');
const { sendSMS }            = require('../services/sms');
const { createNotification } = require('./notifications');

const MAX_JOBS       = 3;
const MAX_APPLICANTS = 3;

// ── Category map: USSD number → DB value ─────────────────────────────────────
const CATEGORIES = {
    '1': { en: 'All Jobs',         sw: 'Kazi Zote',      value: '' },
    '2': { en: 'Manual / Labour',  sw: 'Kazi ya Mikono', value: 'manual' },
    '3': { en: 'Transport',        sw: 'Usafirishaji',   value: 'transport' },
    '4': { en: 'Technical',        sw: 'Kiufundi',       value: 'technical' },
    '5': { en: 'General',          sw: 'Kawaida',        value: 'general' },
};

// ── Translations ──────────────────────────────────────────────────────────────
const STRINGS = {
    en: {
        welcomeUnregistered: `CON Welcome to KaziMtaani!\nYou are not registered.\n1. Register now\n0. Exit`,
        exit:                `END Thank you for using KaziMtaani. Kwaheri!`,
        workerMenu:   (name) => `CON Welcome, ${name}!\n1. Browse Jobs\n2. My Applications\n3. My Profile\n4. Language / Lugha\n0. Exit`,
        employerMenu: (name) => `CON Welcome, ${name}!\n1. My Jobs\n2. My Profile\n3. Language / Lugha\n0. Exit`,

        // Browse jobs
        browseCategories: `CON Browse Jobs:\n1. All Jobs\n2. Manual / Labour\n3. Transport\n4. Technical\n5. General\n0. Back`,
        noJobs:           `CON No open jobs right now.\n0. Back`,
        openJobs:         `CON Open Jobs:`,
        jobDetail:        (j) => `CON ${j.title}\nLocation: ${j.location}\nPay: KES ${Number(j.pay).toLocaleString()}${j.duration ? '\nDuration: ' + j.duration : ''}\n\n1. Apply\n0. Back`,
        alreadyApplied:   `END You already applied for this job.`,
        applySuccess:     `END Applied successfully!\nThe employer will contact you if selected. Good luck!`,
        mustRegister:     `END Register on kazimtaani.co.ke to apply.`,

        // My applications
        noApplications:   `CON You have no applications yet.\n0. Back`,
        myApplications:   `CON Your Applications:`,

        // My profile
        profile: (u) => {
            const stars = u.rating > 0 ? `${u.rating.toFixed(1)}/5` : 'No ratings yet';
            const badge = u.verificationStatus === 'verified' ? ' ✓' : '';
            return `END ${u.name}${badge}\nRole: ${u.role}\nRating: ${stars}\nSkills: ${(u.skills || []).slice(0, 3).join(', ') || 'None set'}\n\nUpdate at kazimtaani.co.ke`;
        },

        // Language
        languageMenu:  `CON Select Language:\n1. English\n2. Kiswahili\n0. Back`,
        langSetEn:     `END Language set to English.\nDial again to continue.`,
        langSetSw:     `END Lugha: Kiswahili.\nPiga tena kuendelea.`,

        // Employer — my jobs
        noMyJobs:      `CON You have no open jobs.\n0. Back`,
        myJobs:        `CON My Open Jobs:`,
        jobApplicants: (title, n) => `CON ${title}\nApplicants: ${n}\n1. View Applicants\n0. Back`,
        noApplicants:  `CON No applicants yet.\n0. Back`,
        applicantList: `CON Applicants:`,
        hirePrompt:    (name, pay) => `CON Hire ${name}?\nPay: KES ${Number(pay).toLocaleString()}\n1. Yes, Hire\n0. Cancel`,
        hireSuccess:   (name, title) => `END ${name} hired for "${title}"!\nThey will be notified by SMS.`,
        hireNoWorker:  `END Worker not found.`,

        // Registration
        regAskName:    `CON Enter your full name:`,
        regNameShort:  `CON Name too short.\nEnter your full name:`,
        regAskRole:    (name) => `CON Hi ${name}!\nSelect your role:\n1. Worker (find jobs)\n2. Employer (post jobs)`,
        regSuccess:    (name, role, pwd) => `END Welcome ${name}! Registered as ${role}.\nTemp password: ${pwd}\nDial again to get started.\nkazimtaani.co.ke`,
        regBadRole:    `CON Invalid choice.\nSelect your role:\n1. Worker\n2. Employer`,

        // Generic
        invalidOption: `CON Invalid option.\n0. Back to Menu`,
        back:          (name) => `CON Welcome, ${name}!\n1. Browse Jobs\n2. My Applications\n3. My Profile\n4. Language / Lugha\n0. Exit`,
        backEmployer:  (name) => `CON Welcome, ${name}!\n1. My Jobs\n2. My Profile\n3. Language / Lugha\n0. Exit`,
    },

    sw: {
        welcomeUnregistered: `CON Karibu KaziMtaani!\nHujasajiliwa.\n1. Jisajili sasa\n0. Toka`,
        exit:                `END Asante kwa kutumia KaziMtaani. Kwaheri!`,
        workerMenu:   (name) => `CON Karibu, ${name}!\n1. Tafuta Kazi\n2. Maombi Yangu\n3. Wasifu Wangu\n4. Lugha / Language\n0. Toka`,
        employerMenu: (name) => `CON Karibu, ${name}!\n1. Kazi Zangu\n2. Wasifu Wangu\n3. Lugha / Language\n0. Toka`,

        browseCategories: `CON Tafuta Kazi:\n1. Kazi Zote\n2. Kazi ya Mikono\n3. Usafirishaji\n4. Kiufundi\n5. Kawaida\n0. Rudi`,
        noJobs:           `CON Hakuna kazi wazi sasa.\n0. Rudi`,
        openJobs:         `CON Kazi Wazi:`,
        jobDetail:        (j) => `CON ${j.title}\nMahali: ${j.location}\nMalipo: KES ${Number(j.pay).toLocaleString()}${j.duration ? '\nMuda: ' + j.duration : ''}\n\n1. Omba\n0. Rudi`,
        alreadyApplied:   `END Umeshaomba kazi hii.`,
        applySuccess:     `END Umefanikiwa kuomba!\nMwajiri atakuwasiliana nawe. Bahati njema!`,
        mustRegister:     `END Sajili kwanza kazimtaani.co.ke.`,

        noApplications:   `CON Huna maombi bado.\n0. Rudi`,
        myApplications:   `CON Maombi Yako:`,

        profile: (u) => {
            const stars = u.rating > 0 ? `${u.rating.toFixed(1)}/5` : 'Hakuna ukadiriaji';
            const badge = u.verificationStatus === 'verified' ? ' ✓' : '';
            return `END ${u.name}${badge}\nJukumu: ${u.role}\nUkadiriaji: ${stars}\nUjuzi: ${(u.skills || []).slice(0, 3).join(', ') || 'Hakuna'}\n\nSasisha: kazimtaani.co.ke`;
        },

        languageMenu:  `CON Chagua Lugha:\n1. English\n2. Kiswahili\n0. Rudi`,
        langSetEn:     `END Language set to English.\nDial again to continue.`,
        langSetSw:     `END Lugha imewekwa: Kiswahili.\nPiga tena kuendelea.`,

        noMyJobs:      `CON Huna kazi wazi.\n0. Rudi`,
        myJobs:        `CON Kazi Zangu:`,
        jobApplicants: (title, n) => `CON ${title}\nWaombaji: ${n}\n1. Tazama Waombaji\n0. Rudi`,
        noApplicants:  `CON Hakuna waombaji bado.\n0. Rudi`,
        applicantList: `CON Waombaji:`,
        hirePrompt:    (name, pay) => `CON Mwajiri ${name}?\nMalipo: KES ${Number(pay).toLocaleString()}\n1. Ndiyo, Mwajiri\n0. Ghairi`,
        hireSuccess:   (name, title) => `END ${name} ameajiriwa kwa "${title}"!\nAtaarifiwa kwa SMS.`,
        hireNoWorker:  `END Mfanyakazi hakupatikana.`,

        regAskName:    `CON Weka jina lako kamili:`,
        regNameShort:  `CON Jina ni fupi sana.\nWeka jina lako kamili:`,
        regAskRole:    (name) => `CON Habari ${name}!\nChagua jukumu lako:\n1. Mfanyakazi (tafuta kazi)\n2. Mwajiri (toa kazi)`,
        regSuccess:    (name, role, pwd) => `END Karibu ${name}! Umesajiliwa kama ${role}.\nNenosiri la muda: ${pwd}\nPiga tena kuanza.\nkazimtaani.co.ke`,
        regBadRole:    `CON Chaguo baya.\nChagua jukumu:\n1. Mfanyakazi\n2. Mwajiri`,

        invalidOption: `CON Chaguo baya.\n0. Rudi`,
        back:          (name) => `CON Karibu, ${name}!\n1. Tafuta Kazi\n2. Maombi Yangu\n3. Wasifu Wangu\n4. Lugha / Language\n0. Toka`,
        backEmployer:  (name) => `CON Karibu, ${name}!\n1. Kazi Zangu\n2. Wasifu Wangu\n3. Lugha / Language\n0. Toka`,
    },
};

function s(lang, key, ...args) {
    const str = STRINGS[lang]?.[key] ?? STRINGS.en[key];
    return typeof str === 'function' ? str(...args) : str;
}

// ── Route ─────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
    const { phoneNumber, text = '' } = req.body;

    const phone = phoneNumber
        ? phoneNumber.replace(/^\+/, '').replace(/^0/, '254')
        : '';

    const parts = text.split('*').map(p => p.trim());
    const level = parts.filter(p => p !== '').length;
    const last  = parts[parts.length - 1];

    let response = '';

    try {
        const user = await User.findOne({ phone });
        const lang = user?.language || 'en';

        // ── Level 0: Main menu ───────────────────────────────────────────────
        if (text === '') {
            if (!user) {
                response = s(lang, 'welcomeUnregistered');
            } else if (user.role === 'employer') {
                response = s(lang, 'employerMenu', user.name.split(' ')[0]);
            } else {
                response = s(lang, 'workerMenu', user.name.split(' ')[0]);
            }
        }

        // ── 0: Exit ──────────────────────────────────────────────────────────
        else if (text === '0') {
            response = s(lang, 'exit');
        }

        // ════════════════════════════════════════════════════════════════════
        // REGISTRATION FLOW (unregistered users)
        // ════════════════════════════════════════════════════════════════════

        else if (parts[0] === '1' && level === 1 && !user) {
            response = s('en', 'regAskName');
        }

        else if (parts[0] === '1' && level === 2 && !user) {
            const name = parts[1];
            if (!name || name.length < 2) {
                response = s('en', 'regNameShort');
            } else {
                response = s('en', 'regAskRole', name.split(' ')[0]);
            }
        }

        else if (parts[0] === '1' && level === 3 && !user && (parts[2] === '1' || parts[2] === '2')) {
            const name = parts[1];
            const role = parts[2] === '1' ? 'worker' : 'employer';
            const tempPassword = phone.slice(-6);
            await User.create({ name, phone, role, password: tempPassword, tokenVersion: 0 });
            await sendSMS(
                phone,
                `Welcome to KaziMtaani, ${name.split(' ')[0]}! Account ready. Temp password: ${tempPassword}. Login & update at kazimtaani.co.ke`
            );
            response = s('en', 'regSuccess', name.split(' ')[0], role, tempPassword);
        }

        else if (parts[0] === '1' && level === 3 && !user) {
            response = s('en', 'regBadRole');
        }

        // ════════════════════════════════════════════════════════════════════
        // LANGUAGE SELECTION (workers: option 4, employers: option 3)
        // ════════════════════════════════════════════════════════════════════

        else if (user && (
            (user.role !== 'employer' && parts[0] === '4' && level === 1) ||
            (user.role === 'employer' && parts[0] === '3' && level === 1)
        )) {
            response = s(lang, 'languageMenu');
        }

        else if (user && (
            (user.role !== 'employer' && parts[0] === '4' && level === 2) ||
            (user.role === 'employer' && parts[0] === '3' && level === 2)
        )) {
            const choice = user.role !== 'employer' ? parts[1] : parts[1];
            if (choice === '1') {
                await User.findByIdAndUpdate(user._id, { language: 'en' });
                response = s('en', 'langSetEn');
            } else if (choice === '2') {
                await User.findByIdAndUpdate(user._id, { language: 'sw' });
                response = s('sw', 'langSetSw');
            } else {
                response = s(lang, 'languageMenu');
            }
        }

        // ════════════════════════════════════════════════════════════════════
        // EMPLOYER FLOWS
        // ════════════════════════════════════════════════════════════════════

        // My Jobs list
        else if (user?.role === 'employer' && parts[0] === '1' && level === 1) {
            const jobs = await Job.find({ employer: user._id, status: { $in: ['Open', 'In Progress'] } })
                .sort({ createdAt: -1 }).limit(MAX_JOBS).select('title applicants').lean();

            if (!jobs.length) {
                response = s(lang, 'noMyJobs');
            } else {
                const list = jobs.map((j, i) =>
                    `${i + 1}. ${j.title.slice(0, 22)} (${(j.applicants || []).length})`
                ).join('\n');
                response = `${s(lang, 'myJobs')}\n${list}\n\n0. Back`;
            }
        }

        // Job detail + applicant count
        else if (user?.role === 'employer' && parts[0] === '1' && level === 2 && parts[1] !== '0') {
            const jobs = await Job.find({ employer: user._id, status: { $in: ['Open', 'In Progress'] } })
                .sort({ createdAt: -1 }).limit(MAX_JOBS).lean();
            const job = jobs[parseInt(parts[1]) - 1];
            if (!job) {
                response = s(lang, 'invalidOption');
            } else {
                response = s(lang, 'jobApplicants', job.title.slice(0, 20), (job.applicants || []).length);
            }
        }

        // Applicants list
        else if (user?.role === 'employer' && parts[0] === '1' && level === 3 && parts[2] === '1') {
            const jobs = await Job.find({ employer: user._id, status: { $in: ['Open', 'In Progress'] } })
                .sort({ createdAt: -1 }).limit(MAX_JOBS).lean();
            const job = jobs[parseInt(parts[1]) - 1];
            if (!job || !(job.applicants || []).length) {
                response = s(lang, 'noApplicants');
            } else {
                const list = job.applicants.slice(0, MAX_APPLICANTS).map((name, i) =>
                    `${i + 1}. ${name.slice(0, 20)}`
                ).join('\n');
                response = `${s(lang, 'applicantList')}\n${list}\n\n0. Back`;
            }
        }

        // Hire confirmation prompt
        else if (user?.role === 'employer' && parts[0] === '1' && level === 4 && parts[2] === '1') {
            const jobs = await Job.find({ employer: user._id, status: { $in: ['Open', 'In Progress'] } })
                .sort({ createdAt: -1 }).limit(MAX_JOBS).lean();
            const job = jobs[parseInt(parts[1]) - 1];
            const appIdx = parseInt(parts[3]) - 1;
            const workerName = job?.applicants?.[appIdx];
            if (!job || !workerName) {
                response = s(lang, 'invalidOption');
            } else {
                response = s(lang, 'hirePrompt', workerName.split(' ')[0], job.pay);
            }
        }

        // Confirm hire
        else if (user?.role === 'employer' && parts[0] === '1' && level === 5 && parts[2] === '1' && parts[4] === '1') {
            const jobs = await Job.find({ employer: user._id, status: { $in: ['Open', 'In Progress'] } })
                .sort({ createdAt: -1 }).limit(MAX_JOBS).lean();
            const job = jobs[parseInt(parts[1]) - 1];
            const appIdx = parseInt(parts[3]) - 1;
            const workerName = job?.applicants?.[appIdx];
            const worker = workerName ? await User.findOne({ name: workerName }).select('_id name phone') : null;

            if (!job || !worker) {
                response = s(lang, 'hireNoWorker');
            } else {
                await Job.findByIdAndUpdate(job._id, {
                    hiredWorker: worker.name, hiredWorkerId: worker._id, status: 'In Progress'
                });
                createNotification(
                    worker._id, 'hired',
                    "You've Been Hired!",
                    `${user.name} hired you for "${job.title}" via USSD.`,
                    'jobs'
                );
                if (worker.phone) {
                    await sendSMS(
                        worker.phone,
                        `Hongera ${worker.name.split(' ')[0]}! Umeajiriwa kwa "${job.title}" na ${user.name}. Tembelea kazimtaani.co.ke.`
                    ).catch(err => console.error('Hire SMS failed:', err.message));
                }
                response = s(lang, 'hireSuccess', worker.name.split(' ')[0], job.title);
            }
        }

        // Employer profile (option 2)
        else if (user?.role === 'employer' && parts[0] === '2' && level === 1) {
            response = s(lang, 'profile', user);
        }

        // ════════════════════════════════════════════════════════════════════
        // WORKER FLOWS
        // ════════════════════════════════════════════════════════════════════

        // Browse categories
        else if (user && parts[0] === '1' && level === 1) {
            response = s(lang, 'browseCategories');
        }

        // Job list for category
        else if (user && parts[0] === '1' && level === 2 && parts[1] !== '0' && CATEGORIES[parts[1]]) {
            const catValue = CATEGORIES[parts[1]].value;
            const query = { status: 'Open', ...(catValue ? { category: catValue } : {}) };
            const jobs = await Job.find(query).sort({ createdAt: -1 }).limit(MAX_JOBS).select('title pay').lean();

            if (!jobs.length) {
                response = s(lang, 'noJobs');
            } else {
                const list = jobs.map((j, i) =>
                    `${i + 1}. ${j.title.slice(0, 22)} KES${Number(j.pay).toLocaleString()}`
                ).join('\n');
                response = `${s(lang, 'openJobs')}\n${list}\n\n0. Back`;
            }
        }

        // Job detail
        else if (user && parts[0] === '1' && level === 3 && parts[2] !== '0' && CATEGORIES[parts[1]]) {
            const catValue = CATEGORIES[parts[1]].value;
            const query = { status: 'Open', ...(catValue ? { category: catValue } : {}) };
            const jobs = await Job.find(query).sort({ createdAt: -1 }).limit(MAX_JOBS).lean();
            const job = jobs[parseInt(parts[2]) - 1];
            if (!job) {
                response = s(lang, 'invalidOption');
            } else {
                response = s(lang, 'jobDetail', job);
            }
        }

        // Apply for job
        else if (user && parts[0] === '1' && level === 4 && parts[3] === '1' && CATEGORIES[parts[1]]) {
            const catValue = CATEGORIES[parts[1]].value;
            const query = { status: 'Open', ...(catValue ? { category: catValue } : {}) };
            const jobs = await Job.find(query).sort({ createdAt: -1 }).limit(MAX_JOBS).lean();
            const job = jobs[parseInt(parts[2]) - 1];

            if (!job) {
                response = s(lang, 'invalidOption');
            } else if (job.applicants?.includes(user.name)) {
                response = s(lang, 'alreadyApplied');
            } else {
                await Job.findByIdAndUpdate(job._id, { $addToSet: { applicants: user.name } });
                if (job.employer) {
                    createNotification(
                        job.employer, 'applied',
                        'New USSD Application',
                        `${user.name} applied for "${job.title}" via USSD.`,
                        'jobs'
                    );
                }
                response = s(lang, 'applySuccess');
            }
        }

        // My Applications
        else if (user && parts[0] === '2' && level === 1) {
            const jobs = await Job.find({ applicants: user.name })
                .sort({ createdAt: -1 }).limit(5).select('title status hiredWorker').lean();

            if (!jobs.length) {
                response = s(lang, 'noApplications');
            } else {
                const list = jobs.map(j => {
                    const st = j.hiredWorker === user.name ? 'HIRED' : j.status;
                    return `• ${j.title.slice(0, 18)} [${st}]`;
                }).join('\n');
                response = `${s(lang, 'myApplications')}\n${list}\n\n0. Back`;
            }
        }

        // My Profile (workers)
        else if (user && parts[0] === '3' && level === 1) {
            response = s(lang, 'profile', user);
        }

        // Back to main menu
        else if (last === '0' && user) {
            const name = user.name.split(' ')[0];
            response = user.role === 'employer'
                ? s(lang, 'backEmployer', name)
                : s(lang, 'back', name);
        }

        // Unrecognised input
        else {
            response = s(lang, 'invalidOption');
        }

    } catch (err) {
        console.error('USSD error:', err.message);
        response = `END Sorry, a system error occurred. Please try again.`;
    }

    res.set('Content-Type', 'text/plain');
    res.send(response);
});

module.exports = router;
