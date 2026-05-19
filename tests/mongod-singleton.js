let _mongod = null;
module.exports = {
    get: () => _mongod,
    set: (m) => { _mongod = m; }
};
