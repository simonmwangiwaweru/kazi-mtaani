const mongoose = require('mongoose');

const RatingSchema = new mongoose.Schema({
    // The job this rating belongs to
    job:         { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true },

    // 'worker' = employer rates worker  |  'employer' = worker rates employer
    ratingType:  { type: String, enum: ['worker', 'employer'], default: 'worker' },

    // Reviewer (who gave the rating)
    reviewerName:{ type: String, required: true },
    reviewerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Subject (who was rated)
    subjectName: { type: String, required: true },
    subjectId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Keep old field names as aliases for backward compatibility with leaderboard queries
    workerName:  { type: String },   // = subjectName when ratingType='worker'
    employerName:{ type: String },   // = subjectName when ratingType='employer'
    employerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // The actual rating
    stars:       { type: Number, required: true, min: 1, max: 5 },
    comment:     { type: String, default: '', trim: true, maxlength: 500 },

    // Tags for quick feedback
    tags:        [{ type: String }],

    createdAt:   { type: Date, default: Date.now }
});

// One rating per direction per job (employer→worker AND worker→employer both allowed)
RatingSchema.index({ job: 1, ratingType: 1 }, { unique: true });

module.exports = mongoose.models.Rating || mongoose.model('Rating', RatingSchema);
