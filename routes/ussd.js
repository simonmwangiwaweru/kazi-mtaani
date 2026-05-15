/**
 * USSD — Africa's Talking USSD gateway for feature-phone users.
 *
 * Session text format (AT accumulates selections separated by *):
 *   ""              → main menu
 *
 * Unregistered user flow:
 *   ""              → welcome + register option
 *   "1"             → ask full name
 *   "1*{name}"      → ask role (worker / employer)
 *   "1*{name}*1|2"  → create account → END
 *
 * Registered user flow:
 *   "1"             → Browse Jobs
 *   "1*N"           → Job detail
 *   "1*N*1"         → Apply for job
 *   "2"             → My Applications
 *   "3"             → My Profile
 *   "0"             → Exit
 */
const express  = require('express');
const router   = express.Router();
const User     = require('../models/user');
const Job      = require('../models/job');
const { sendSMS }              = require('../services/sms');
const { createNotification }   = require('./notifications');

const MAX_JOBS = 3;

// POST /api/ussd — AT sends a form-urlencoded POST
router.post('/', async (req, res) => {
    const { sessionId, serviceCode, phoneNumber, text = '' } = req.body;

    // Normalise phone: 0712... → 254712...
    const phone = phoneNumber
        ? phoneNumber.replace(/^\+/, '').replace(/^0/, '254')
        : '';

    const parts = text.split('*').map(p => p.trim());
    const level = parts.filter(p => p !== '').length;
    const last  = parts[parts.length - 1];

    let response = '';

    try {
        // Single user lookup reused across all branches
        const user = await User.findOne({ phone });

        // ── Level 0: Main menu ───────────────────────────────────────────────
        if (text === '') {
            if (!user) {
                response = `CON Welcome to KaziMtaani!\nYou are not registered.\n1. Register now\n0. Exit`;
            } else {
                const greeting = user.name.split(' ')[0];
                response = `CON Welcome, ${greeting}!\n1. Browse Jobs\n2. My Applications\n3. My Profile\n0. Exit`;
            }
        }

        // ── 0: Exit ──────────────────────────────────────────────────────────
        else if (text === '0') {
            response = `END Thank you for using KaziMtaani. Kwaheri!`;
        }

        // ════════════════════════════════════════════════════════════════════
        // REGISTRATION FLOW (unregistered users)
        // ════════════════════════════════════════════════════════════════════

        // Step 1 — ask for full name
        else if (parts[0] === '1' && level === 1 && !user) {
            response = `CON Enter your full name:`;
        }

        // Step 2 — ask for role
        else if (parts[0] === '1' && level === 2 && !user) {
            const name = parts[1];
            if (!name || name.length < 2) {
                response = `CON Name is too short. Enter your full name:`;
            } else {
                response = `CON Hi ${name.split(' ')[0]}!\nSelect your role:\n1. Worker (find jobs)\n2. Employer (post jobs)`;
            }
        }

        // Step 3 — create account
        else if (parts[0] === '1' && level === 3 && !user && (parts[2] === '1' || parts[2] === '2')) {
            const name = parts[1];
            const role = parts[2] === '1' ? 'worker' : 'employer';
            const tempPassword = phone.slice(-6); // last 6 digits as temporary password

            await User.create({ name, phone, role, password: tempPassword, tokenVersion: 0 });

            // Notify them of the temp password via SMS
            await sendSMS(
                phone,
                `Welcome to KaziMtaani, ${name.split(' ')[0]}! Your account is ready. ` +
                `Temp password: ${tempPassword}. Login & update it at kazimtaani.co.ke`
            );

            response = `END Welcome ${name.split(' ')[0]}! Registered as a ${role}.\nTemp password: ${tempPassword}\nDial *384*30173# to get started.\nUpdate your profile at kazimtaani.co.ke`;
        }

        // Invalid role selection during registration
        else if (parts[0] === '1' && level === 3 && !user) {
            response = `CON Invalid choice.\nSelect your role:\n1. Worker\n2. Employer`;
        }

        // ════════════════════════════════════════════════════════════════════
        // REGISTERED USER FLOWS
        // ════════════════════════════════════════════════════════════════════

        // ── 1: Browse Jobs ───────────────────────────────────────────────────
        else if (parts[0] === '1' && level === 1 && user) {
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
        else if (parts[0] === '1' && level === 2 && parts[1] !== '0' && user) {
            const idx  = parseInt(parts[1]) - 1;
            const jobs = await Job.find({ status: 'Open' }).sort({ createdAt: -1 }).limit(MAX_JOBS).lean();
            const job  = jobs[idx];

            if (!job) {
                response = `CON Invalid selection.\n0. Back`;
            } else {
                response = `CON ${job.title}\nLocation: ${job.location}\nPay: KES ${Number(job.pay).toLocaleString()}\n${job.duration ? 'Duration: ' + job.duration + '\n' : ''}\n1. Apply\n0. Back`;
            }
        }

        // ── 1*0: Back to main menu ───────────────────────────────────────────
        else if (parts[0] === '1' && level === 2 && parts[1] === '0') {
            const greeting = user ? user.name.split(' ')[0] : 'there';
            response = `CON Welcome, ${greeting}!\n1. Browse Jobs\n2. My Applications\n3. My Profile\n0. Exit`;
        }

        // ── 1*N*1: Apply for job ─────────────────────────────────────────────
        else if (parts[0] === '1' && level === 3 && parts[2] === '1' && user) {
            const idx  = parseInt(parts[1]) - 1;
            const jobs = await Job.find({ status: 'Open' }).sort({ createdAt: -1 }).limit(MAX_JOBS).lean();
            const job  = jobs[idx];

            if (!job) {
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

        // ── 1*N*0: Back to job list ──────────────────────────────────────────
        else if (parts[0] === '1' && level === 3 && parts[2] === '0') {
            response = `CON Open Jobs:\n0. Back`;
        }

        // ── 2: My Applications ───────────────────────────────────────────────
        else if (parts[0] === '2' && level === 1) {
            if (!user) {
                response = `END Register first. Dial again and choose Register.`;
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
            if (!user) {
                response = `END Register first. Dial again and choose Register.`;
            } else {
                const stars = user.rating > 0 ? `${user.rating.toFixed(1)}/5` : 'No ratings yet';
                const badge = user.verificationStatus === 'verified' ? ' ✓' : '';
                response = `END ${user.name}${badge}\nRole: ${user.role}\nRating: ${stars}\nSkills: ${(user.skills || []).slice(0, 3).join(', ') || 'None set'}\n\nUpdate profile at kazimtaani.co.ke`;
            }
        }

        // ── Back from any sub-menu ───────────────────────────────────────────
        else if (last === '0') {
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

    res.set('Content-Type', 'text/plain');
    res.send(response);
});

module.exports = router;
