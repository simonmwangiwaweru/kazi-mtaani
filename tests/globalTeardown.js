const singleton = require('./mongod-singleton');

module.exports = async function () {
    const mongod = singleton.get();
    if (mongod) await mongod.stop();
};
