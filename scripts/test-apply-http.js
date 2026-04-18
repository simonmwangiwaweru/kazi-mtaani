const http = require('http');

function request(options, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
        });
        req.on('error', reject);
        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

(async () => {
    try {
        console.log('Registering employer...');
        const empRes = await request({
            hostname: 'localhost',
            port: 5000,
            path: '/api/auth/register',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, { name: 'EmployerTest', phone: '0711122233', password: 'Password1!', role: 'employer' });
        const empToken = empRes.data.token;
        console.log('Employer Token:', !!empToken);

        console.log('Posting job...');
        const jobRes = await request({
            hostname: 'localhost',
            port: 5000,
            path: '/api/jobs',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${empToken}` }
        }, { title: 'Test Job', description: 'Test', location: 'Nairobi', pay: 1000, category: 'general' });
        const jobId = jobRes.data._id;
        console.log('Job ID:', jobId);

        console.log('Registering worker...');
        const workerRes = await request({
            hostname: 'localhost',
            port: 5000,
            path: '/api/auth/register',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, { name: 'WorkerTest', phone: '0744455566', password: 'Password1!', role: 'worker' });
        const workerToken = workerRes.data.token;
        console.log('Worker Token:', !!workerToken);

        console.log('Applying for job...');
        const applyRes = await request({
            hostname: 'localhost',
            port: 5000,
            path: `/api/jobs/apply/${jobId}`,
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${workerToken}` }
        }, {});
        console.log('Apply response:', applyRes);
    } catch (e) {
        console.error(e);
    }
})();
