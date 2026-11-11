const mongoose = require("mongoose");

// Log of similarity-matrix builds: when, how long, how much data. Used by the status API
// and the performance report.
const recoBuildSchema = new mongoose.Schema({
    startedAt:   { type: Date, required: true },
    durationMs:  { type: Number, required: true },
    users:       Number,      // users with at least one interaction
    items:       Number,      // items with at least one interaction
    pairs:       Number,      // co-occurring item pairs considered
    neighbors:   Number,      // neighbor entries stored
    trigger:     String       // startup | schedule | manual | script | benchmark
}, { collection: "reco_builds", versionKey: false });

recoBuildSchema.index({ startedAt: -1 });

module.exports = mongoose.models.RecoBuild || mongoose.model("RecoBuild", recoBuildSchema);
