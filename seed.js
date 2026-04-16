const mongoose = require('mongoose');
const Job = require('./models/job'); // Path to your Job model
const dotenv = require('dotenv');
dotenv.config();

const mongoURI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/kazi_mtaani';

const seedJobs = [
    {
        title: "House Cleaning",
        description: "General cleaning of a 2-bedroom apartment in Ruiru.",
        location: "Ruiru",
        pay: 1500,
        category: "Cleaning",
        paymentStatus: "In-Escrow"
    },
    {
        title: "Garden Weeding",
        description: "Need help weeding a small backyard garden.",
        location: "Thika",
        pay: 800,
        category: "Gardening",
        paymentStatus: "Pending"
    }
];

mongoose.connect(mongoURI)
    .then(async () => {
        console.log("Seed: Connected to DB...");
        await Job.insertMany(seedJobs);
        console.log("✅ 2 Test Jobs Added!");
        process.exit();
    })
    .catch(err => console.log(err));