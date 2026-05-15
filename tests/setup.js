process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-at-least-32-chars-long!!';

// Silence Africa's Talking SDK in tests — no real SMS sent
process.env.AT_API_KEY  = '';
process.env.AT_USERNAME = '';
