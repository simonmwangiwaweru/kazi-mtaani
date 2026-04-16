const fetch = require('node-fetch');

async function testApply() {
    try {
        console.log('Registering employer...');
        const empRes = await fetch('http://localhost:5000/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Employer', phone: '0700000001', password: 'Password1!', role: 'employer' })
        });
        const empData = await empRes.json();
        const empToken = empData.token;

        console.log('Posting job...');
        const jobRes = await fetch('http://localhost:5000/api/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${empToken}` },
            body: JSON.stringify({ title: 'Test Job', description: 'Test', location: 'Nairobi', pay: 1000, category: 'general' })
        });
        const jobData = await jobRes.json();
        const jobId = jobData._id;
        console.log('Job posted:', jobId);

        console.log('Registering worker...');
        const workerRes = await fetch('http://localhost:5000/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Worker', phone: '0700000002', password: 'Password1!', role: 'worker' })
        });
        const workerData = await workerRes.json();
        const workerToken = workerData.token;

        console.log('Applying for job...');
        const applyRes = await fetch(`http://localhost:5000/api/jobs/apply/${jobId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${workerToken}` }
        });
        const applyData = await applyRes.text();
        console.log('Apply status:', applyRes.status);
        console.log('Apply response:', applyData);
    } catch (e) {
        console.error(e);
    }
}

testApply();
