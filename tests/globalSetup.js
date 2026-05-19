const { MongoMemoryServer } = require('mongodb-memory-server');
const singleton = require('./mongod-singleton');

module.exports = async function () {
    const mongod = await MongoMemoryServer.create();
    singleton.set(mongod);
    process.env.TEST_MONGO_URI = mongod.getUri();
};
