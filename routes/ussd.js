/**
 * USSD — Africa's Talking USSD gateway for feature-phone users.
 *
 * Session text format (AT accumulates selections separated by *):
 *   ""          → main menu
 *   "1"         → View Jobs
 *   "1*1"       → First job detail
 *   "1*1*1"     → Apply for first job
 *   "2"         → My Applications
 *   "3"         → My Profile
 *   "4"         → Register prompt (if unknown phone)
 *
 * Env: AT_USSD_CODE — the shortcode/string registered in AT dashboard (e.g. *384*123#)
 */
const express = require('express');
const router  = express.Router();
const User    = require('../models/user');
const Job     = require('../models/job');
const { createNotification } = require('./notifications');

const MAX_JOBS = 3;  // jobs to list in USSD view

// POST /api/ussd — AT sends a form-urlencoded POST
router.post('/', async (req, res) => {
    const { sessionId, serviceCode, phoneNumber, text = '' } = req.body;

    // Normalise phone: 0712... → 254712...
    const phone = phoneNumber
        ? phoneNumber.replace(/^\+/, '').replace(/^0/, '254')
        : '';

    const parts  = text.split('*').map(p => p.trim());
    const level  = parts.filter(p => p !== '').length;
    const last   = parts[parts.length - 1];

    let response = '';

    try {
        // ── Level 0: Main menu ───────────────────────────────────────────────
        if (text === '') {
            const user = await User.findOne({ phone });
            if (!user) {
                response = `CON Welcome to KaziMtaani!\nYou are not registered.\nVisit kazimtaani.co.ke to create an account.\n\n0. Exit`;
            } else {
                const greeting = user.name.split(' ')[0];
                response = `CON Welcome, ${greeting}!\n1. Browse Jobs\n2. My Applications\n3. My Profile\n0. Exit`;
            }
        }

        // ── 0: Exit ──────────────────────────────────────────────────────────
        else if (text === '0') {
            response = `END Thank you for using KaziMtaani. Kwaheri!`;
        }

        // ── 1: Browse Jobs ───────────────────────────────────────────────────
        else if (parts[0] === '1' && level === 1) {
            const jobs = await Job.find({ status: 'Open' })
                .sort({ createdAt: -1 })
                .limit(MAX_JOBS)
                .select('title location pay')
                .lean();

            if (!jobs.length) {
                response = `CON No open jobs right now.\n\n0. Back`;
            } else {
                const list = jobs.map((j, i) =>
                    `${i + 1}. ${j.title.slice(0, 25)} — KES ${Number(j.pay).toLocaleString()}`
                ).join('\n');
                response = `CON Open Jobs:\n${list}\n\n0. Back`;
            }
        }

        // ── 1*N: Job detail ──────────────────────────────────────────────────
        else if (parts[0] === '1' && level === 2 && parts[1] !== '0') {
            const idx  = parseInt(parts[1]) - 1;
            const jobs = await Job.find({ status: 'Open' }).sort({ createdAt: -1 }).limit(MAX_JOBS).lean();
            const job  = jobs[idx];

            if (!job) {
                response = `CON Invalid selection.\n0. Back`;
            } else {
                response = `CON ${job.title}\nLocation: ${job.location}\nPay: KES ${Number(job.pay).toLocaleString()}\n${job.duration ? 'Duration: ' + job.duration + '\n' : ''}\n1. Apply\n0. Back`;
            }
        }

        // ── 1*N*0: Back from job detail ──────────────────────────────────────
        else if (parts[0] === '1' && level === 2 && parts[1] === '0') {
            response = `CON Welcome to KaziMtaani!\n1. Browse Jobs\n2. My Applications\n3. My Profile\n0. Exit`;
        }

        // ── 1*N*1: Apply for job ─────────────────────────────────────────────
        else if (parts[0] === '1' && level === 3 && parts[2] === '1') {
            const idx  = parseInt(parts[1]) - 1;
            const jobs = await Job.find({ status: 'Open' }).sort({ createdAt: -1 }).limit(MAX_JOBS).lean();
            const job  = jobs[idx];

            const user = await User.findOne({ phone });

            if (!user) {
                response = `END You must register on kazimtaani.co.ke to apply.`;
            } else if (!job) {
                response = `END Invalid job.`;
            } else if (job.applicants?.includes(user.name)) {
                response = `END You already applied for this job.`;
            } else {
                await Job.findByIdAndUpdate(job._id, { $addToSet: { applicants: user.name } });
                if (job.employer) {
                    createNotification(
                        job.employer,
                        'applied',
                        'New USSD Application',
                        `${user.name} applied for "${job.title}" via USSD.`,
                        'jobs'
                    );
                }
                response = `END Applied successfully!\nThe employer will contact you if selected. Good luck!`;
            }
        }

        // ── 1*N*0: Back ──────────────────────────────────────────────────────
        else if (parts[0] === '1' && level === 3 && parts[2] === '0') {
            response = `CON Open Jobs:\n0. Back`;  // simplified — real state would re-list
        }

        // ── 2: My Applications ───────────────────────────────────────────────
        else if (parts[0] === '2' && level === 1) {
            const user = await User.findOne({ phone });
            if (!user) {
                response = `END Register at kazimtaani.co.ke to track applications.`;
            } else {
                const jobs = await Job.find({ applicants: user.name })
                    .sort({ createdAt: -1 })
                    .limit(5)
                    .select('title status hiredWorker')
                    .lean();

                if (!jobs.length) {
                    response = `CON You have no applications yet.\n\n0. Back`;
                } else {
                    const list = jobs.map(j => {
                        const st = j.hiredWorker === user.name ? 'HIRED' : j.status;
                        return `• ${j.title.slice(0, 20)} [${st}]`;
                    }).join('\n');
                    response = `CON Your Applications:\n${list}\n\n0. Back`;
                }
            }
        }

        // ── 3: My Profile ────────────────────────────────────────────────────
        else if (parts[0] === '3' && level === 1) {
            const user = await User.findOne({ phone });
            if (!user) {
                response = `END Register at kazimtaani.co.ke to view your profile.`;
            } else {
                const stars  = user.rating > 0 ? `${user.rating.toFixed(1)}/5` : 'No ratings yet';
                const badge  = user.verificationStatus === 'verified' ? ' ✓' : '';
                response = `END ${user.name}${badge}\nRole: ${user.role}\nRating: ${stars}\nSkills: ${(user.skills || []).slice(0, 3).join(', ') || 'None set'}\n\nUpdate profile at kazimtaani.co.ke`;
            }
        }

        // ── Back from any sub-menu ───────────────────────────────────────────
        else if (last === '0') {
            const user = await User.findOne({ phone });
            const greeting = user ? user.name.split(' ')[0] : 'there';
            response = `CON Welcome, ${greeting}!\n1. Browse Jobs\n2. My Applications\n3. My Profile\n0. Exit`;
        }

        // ── Unrecognised input ───────────────────────────────────────────────
        else {
            response = `CON Invalid option.\n0. Back to Menu`;
        }

    } catch (err) {
        console.error('USSD error:', err.message);
        response = `END Sorry, a system error occurred. Please try again.`;
    }

    // AT expects plain text, no JSON
    res.set('Content-Type', 'text/plain');
    res.send(response);
});

module.exports = router;
