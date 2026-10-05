import express from 'express';
import { createPayment, myPayments } from '../controllers/paymentController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();
router.use(protect);

// Checkout — record a payment (demo gateway, masked card data only)
router.post('/payments', createPayment);
router.get('/payments', myPayments);

export default router;
