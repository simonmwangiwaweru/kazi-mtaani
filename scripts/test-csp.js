const helmet = require('helmet');
const express = require('express');
const app = express();

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc:  ["'self'"],
            scriptSrc:   ["'self'", "'unsafe-inline'", "https://accounts.google.com"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc:    ["'self'", "https:", "'unsafe-inline'"],
            imgSrc:      ["'self'", "data:", "https:"],
            connectSrc:  ["'self'"],
            fontSrc:     ["'self'", "https:", "data:"],
            objectSrc:   ["'none'"],
            frameSrc:    ["'none'"],
            frameAncestors: ["'none'"],
            baseUri:     ["'self'"],
            formAction:  ["'self'"],
        }
    }
}));

app.get('/', (req, res) => res.send('OK'));

const server = app.listen(0, () => {
    const http = require('http');
    http.get(`http://localhost:${server.address().port}/`, (res) => {
        console.log("Helmet CSP:", res.headers['content-security-policy']);
        server.close();
    });
});
