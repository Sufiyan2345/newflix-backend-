import mongoose from 'mongoose';

const activityLogSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    adminEmail: { type: String, default: '' },
    action: { type: String, required: true }, // e.g. 'CREATE_TITLE'
    targetTable: { type: String, default: '' },
    targetId: { type: String, default: '' },
    details: { type: String, default: '' },
    ip: { type: String, default: '' },
  },
  { timestamps: true }
);

export default mongoose.model('AdminActivityLog', activityLogSchema);
