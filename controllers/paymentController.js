import Payment from '../models/Payment.js';
import User from '../models/User.js';
import { sendPaymentSuccessEmail, sendRefundEmail } from '../config/mailer.js';
import { logAdminAction } from '../middleware/activityLog.js';

const BRANDS = [
  [/^4/, 'Visa'],
  [/^(5[1-5]|2[2-7])/, 'Mastercard'],
  [/^3[47]/, 'Amex'],
  [/^6/, 'Discover'],
];

// @route POST /api/payments — called at the end of the signup checkout.
// Stores a payment record with ONLY masked card data (never the full number/CVV).
export const createPayment = async (req, res) => {
  try {
    const { plan, planQuality, amount, currency, method = 'card', card = {} } = req.body;
    if (!plan || amount == null) return res.status(400).json({ message: 'Plan and amount are required' });
    const digits = String(card.number || '').replace(/\D/g, '');
    if (method === 'card') {
      if (digits.length < 15) return res.status(400).json({ message: 'Valid card number is required' });
      if (!/^\d{2}\/\d{2}$/.test(card.expiry || '')) return res.status(400).json({ message: 'Valid card expiry is required' });
      if ((card.cvv || '').length < 3) return res.status(400).json({ message: 'Valid card CVV is required' });
    }
    const brand = (BRANDS.find(([re]) => re.test(digits)) || [, 'Unknown'])[1];
    const payment = await Payment.create({
      recordId: Payment.newRecordId(),
      user: req.user._id,
      userEmail: req.user.email,
      plan,
      planQuality: planQuality || '',
      amount: Number(amount),
      currency: currency || 'PKR',
      method,
      cardBrand: method === 'card' ? brand : '',
      cardLast4: method === 'card' ? digits.slice(-4) : '',
      cardExpiry: method === 'card' ? card.expiry : '',
      cardName: method === 'card' ? String(card.name || '').slice(0, 80) : '',
      status: 'paid', // demo gateway: instantly paid
      ip: req.ip || '',
    });
    // Membership is active from this point — "/" opens the post-payment
    // setup screens (verify card → welcome → simpleSetup) instead of the
    // "Finish Sign-Up" page, and /browse stays locked until setup completes.
    await User.findByIdAndUpdate(req.user._id, {
      membershipActive: true,
      onboardingDone: false,
      onboardingStep: 1,
    });
    // Email the user's own registered address — fired async so the checkout
    // response never waits on SMTP. Failures are logged, never thrown.
    sendPaymentSuccessEmail(payment.userEmail, payment)
      .then(() => console.log(`📧 payment success email sent to ${payment.userEmail} (${payment.recordId})`))
      .catch((mailErr) => console.error(`Payment email failed for ${payment.userEmail}:`, mailErr.message));
    res.status(201).json({
      payment: {
        recordId: payment.recordId,
        plan: payment.plan,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        createdAt: payment.createdAt,
      },
    });
  } catch (err) {
    console.error('createPayment:', err);
    res.status(500).json({ message: 'Failed to record payment' });
  }
};

// @route GET /api/user/payments — the signed-in user's own payment history
export const myPayments = async (req, res) => {
  try {
    const items = await Payment.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(50);
    res.json({ items });
  } catch {
    res.status(500).json({ message: 'Failed to load payments' });
  }
};

// @route GET /api/admin/payments?q=&status=&page= — admin payment ledger
export const adminListPayments = async (req, res) => {
  try {
    const { q, status, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status && ['paid', 'pending', 'failed', 'refunded'].includes(status)) filter.status = status;
    if (q) {
      const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ recordId: rx }, { userEmail: rx }, { plan: rx }, { cardLast4: rx }, { cardName: rx }];
    }
    const [items, total, sumAgg] = await Promise.all([
      Payment.find(filter).sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit)).limit(Number(limit)),
      Payment.countDocuments(filter),
      Payment.aggregate([{ $match: { ...filter, status: 'paid' } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    ]);
    res.json({
      items, total, pages: Math.ceil(total / Number(limit)),
      revenue: sumAgg[0]?.total || 0, paidCount: sumAgg[0]?.count || 0,
    });
  } catch (err) {
    console.error('adminListPayments:', err);
    res.status(500).json({ message: 'Failed to list payments' });
  }
};

// @route PUT /api/admin/payments/:id/status { status } (super-admin)
export const adminUpdatePaymentStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!['paid', 'pending', 'failed', 'refunded'].includes(status))
      return res.status(400).json({ message: 'Invalid status' });
    const previous = await Payment.findById(req.params.id);
    if (!previous) return res.status(404).json({ message: 'Payment not found' });
    const payment = await Payment.findByIdAndUpdate(req.params.id, { status }, { new: true });
    // Keep the user's membership flag in sync with the ledger
    if (status === 'paid' && previous.status !== 'paid')
      await User.findByIdAndUpdate(payment.user, { membershipActive: true });
    if (status === 'refunded' && previous.status !== 'refunded')
      await User.findByIdAndUpdate(payment.user, { membershipActive: false });
    // Refund email — only on the transition INTO refunded (no duplicate sends)
    if (status === 'refunded' && previous.status !== 'refunded') {
      sendRefundEmail(payment.userEmail, payment)
        .then(() => console.log(`📧 refund email sent to ${payment.userEmail} (${payment.recordId})`))
        .catch((mailErr) => console.error(`Refund email failed for ${payment.userEmail}:`, mailErr.message));
    }
    // Re-activation email when an admin marks a pending payment as paid
    if (status === 'paid' && previous.status === 'pending') {
      sendPaymentSuccessEmail(payment.userEmail, payment)
        .then(() => console.log(`📧 payment success email sent to ${payment.userEmail} (${payment.recordId})`))
        .catch((mailErr) => console.error(`Payment email failed for ${payment.userEmail}:`, mailErr.message));
    }
    // Governance: a money-touching action must be attributable — log the transition
    // (previous → new state) in the admin audit trail.
    await logAdminAction(req, 'UPDATE_PAYMENT_STATUS', 'payments', payment._id, `${previous.status} -> ${status} (${payment.recordId} ${payment.currency} ${payment.amount})`);
    res.json({ payment });
  } catch {
    res.status(500).json({ message: 'Failed to update payment' });
  }
};
