/**
 * Jest global setup — loads .env and sets test environment variables.
 * Uses an in-memory MongoDB (mongodb-memory-server) or a dedicated test DB.
 */
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-at-least-32-chars-long!!';
process.env.MONGO_URI  = process.env.MONGO_URI_TEST || 'mongodb://127.0.0.1:27017/kazi_mtaani_test';

// Silence Africa's Talking SDK in tests — no real SMS sent
process.env.AT_API_KEY   = '';
process.env.AT_USERNAME  = '';
