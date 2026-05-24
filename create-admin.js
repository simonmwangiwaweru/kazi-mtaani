const mongoose = require('mongoose');
const User     = require('./models/user');
require('dotenv').config();

async function run() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to DB…');

    const existing = await User.findOne({ role: 'admin' });
    if (existing) {
        console.log('Admin already exists:', existing.name, '|', existing.phone);
        await mongoose.disconnect();
        return;
    }

    const admin = await User.create({
        name:         'Admin',
        phone:        '254700000001',
        password:     'Admin@Kazi2026',
        role:         'admin',
        tokenVersion: 0,
        language:     'en',
    });
    console.log('✅ Admin created!');
    console.log('   Phone:    254700000001');
    console.log('   Password: Admin@Kazi2026');
    await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
