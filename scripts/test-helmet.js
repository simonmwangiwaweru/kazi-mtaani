const helmet = require('helmet');
const express = require('express');

const runTest = (config, name) => {
    return new Promise((resolve) => {
        const app = express();
        app.use(helmet(config));
        app.get('/', (req, res) => res.send('ok'));
        const server = app.listen(0, () => {
            require('http').get(`http://localhost:${server.address().port}/`, (res) => {
                const csp = res.headers['content-security-policy'];
                console.log(`-- ${name} --`);
                console.log(csp.includes("script-src-attr 'unsafe-inline'") ? 'SUCCESS: unsafe-inline present' : 
                            csp.includes("script-src-attr 'none'") ? 'FAIL: none is present' : 
                            !csp.includes("script-src-attr") ? 'SUCCESS: disabled, fallback used' : 'UNKNOWN');
                server.close();
                resolve();
            });
        });
    });
};

(async () => {
    await runTest({ contentSecurityPolicy: { directives: { scriptSrcAttr: ["'unsafe-inline'"] } } }, "scriptSrcAttr");
    await runTest({ contentSecurityPolicy: { directives: { 'script-src-attr': ["'unsafe-inline'"] } } }, "dash-case");
    await runTest({ contentSecurityPolicy: { directives: { scriptSrcAttr: null, 'script-src-attr': null } } }, "null");
})();
