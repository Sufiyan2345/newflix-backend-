import mongoose from 'mongoose';

// Checkout payment records (demo gateway — no real charges). Stores only
// masked card data (last 4 + brand); full numbers/CVV are never persisted.
const paymentSchema = new mongoose.Schema(
  {
    recordId: { type: String, required: true, unique: true }, // human-readable e.g. PAY-8F3K2Q
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userEmail: { type: String, default: '' }, // denormalised for fast admin search
    plan: { type: String, enum: ['Mobile', 'Basic', 'Standard', 'Premium'], required: true },
    planQuality: { type: String, default: '' },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'PKR' },
    method: { type: String, default: 'card' }, // card | other
    cardBrand: { type: String, default: '' }, // Visa | Mastercard | Amex | Unknown
    cardLast4: { type: String, default: '' },
    cardExpiry: { type: String, default: '' }, // MM/YY
    cardName: { type: String, default: '' },
    status: { type: String, enum: ['paid', 'pending', 'failed', 'refunded'], default: 'paid' },
    ip: { type: String, default: '' },
  },
  { timestamps: true }
);

paymentSchema.statics.newRecordId = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i += 1) id += chars[Math.floor(Math.random() * chars.length)];
  return `PAY-${id}`;
};

export default mongoose.model('Payment', paymentSchema);
