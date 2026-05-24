const mongoose = require('mongoose');
const bcrypt = require('bcryptjs'); 

const UserSchema = new mongoose.Schema({
    // AUTHENTICATION
    name: { type: String, required: true },
    phone:    { type: String, required: true, unique: true },
    password: { type: String, required: true },
    tokenVersion: { type: Number, default: 0 },
    
    // ROLES
    role: { 
        type: String, 
        enum: ['worker', 'employer', 'admin'], 
        default: 'worker' 
    },
    
    // WORKER DETAILS
    skills: { type: [String], validate: { validator: v => v.length <= 20, message: 'Max 20 skills.' } },
    experienceYears: { type: Number, default: 0, min: 0, max: 60 },
    specialization: { type: String, maxlength: 100 },
    bio: { type: String, default: '', maxlength: 500 },

    // LOCATION
    location: {
        county:    { type: String, maxlength: 100 },
        subCounty: { type: String, maxlength: 100 },
        ward:      { type: String, maxlength: 100 }
    },

    // RATINGS & TRUST
    rating: { type: Number, default: 0 },
    isVerified: { type: Boolean, default: false },

    // IDENTITY VERIFICATION
    verificationStatus: {
        type: String,
        enum: ['none', 'pending', 'verified', 'rejected'],
        default: 'none'
    },
    verificationDoc:         { type: String, default: '' },  // Cloudinary secure URL
    verificationDocPublicId: { type: String, default: '' },  // Cloudinary public_id for deletion
    verificationNote:        { type: String, default: '' },  // admin rejection reason
    certificates:            { type: [String], default: [] }, // Cloudinary URLs

    // PASSWORD RESET
    resetOTP:       { type: String },
    resetOTPExpiry: { type: Date },

    language: { type: String, enum: ['en', 'sw'], default: 'en' },

    dateJoined: { type: Date, default: Date.now }
});

// 🔥 THE STABLE VERSION: No 'next' parameter = No 'next is not a function' error.
UserSchema.pre('save', async function() {
    // 1. Only hash if the password is new or changed
    if (!this.isModified('password')) {
        return; 
    }

    try {
        // 2. Generate salt
        const salt = await bcrypt.genSalt(10);
        // 3. Hash the password
        this.password = await bcrypt.hash(this.password, salt);
        // 4. Mongoose automatically moves to 'save' when this async function ends
    } catch (err) {
        throw err; // Mongoose catches this and stops the save
    }
});

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);