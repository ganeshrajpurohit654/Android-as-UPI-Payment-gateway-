require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const rateLimit = require('express-rate-limit');
const qrcode = require('qrcode');
const axios = require('axios');
const winston = require('winston');
const path = require('path');

const app = express();
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Enhanced Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: path.join(__dirname, 'logs', 'combined.log') }),
    new winston.transports.File({ filename: path.join(__dirname, 'logs', 'errors.log'), level: 'error' })
  ]
});

// Rate Limiter (20 requests/min)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', { ip: req.ip });
    res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }
});
app.use(limiter);

// Firebase Init from environment variables
admin.initializeApp({
  credential: admin.credential.cert({
    type: process.env.FIREBASE_TYPE,
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: process.env.FIREBASE_AUTH_URI,
    token_uri: process.env.FIREBASE_TOKEN_URI,
    auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
    client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
  })
});
const db = admin.firestore();

// Payment Configuration
const PAYMENT_TIMEOUT = 300; // 5 minutes in seconds
const LOCK_TIMEOUT = PAYMENT_TIMEOUT * 1000; // Convert to milliseconds

// In-Memory Lock with enhanced tracking
const paymentSessions = {};

// Helper: Discord Log (optional)
const sendDiscordLog = async (msg) => {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  try {
    await axios.post(url, { content: msg });
  } catch (err) {
    logger.error('Discord webhook failed', { error: err.message });
  }
};

// 📦 Route: Generate QR
app.post('/generate-qr', async (req, res) => {
  const { email, amount } = req.body;
  
  // Validate input
  if (!email || !email.includes('@') || !amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid email or amount' });
  }

  const now = Date.now();
  
  // Check if this amount is already being processed
  if (paymentSessions[amount] && paymentSessions[amount].expiresAt > now) {
    return res.status(423).json({ 
      error: 'Payment in progress',
      details: {
        expiresIn: Math.ceil((paymentSessions[amount].expiresAt - now) / 1000),
        message: `Another user is paying ₹${amount}. Please wait.`
      }
    });
  }

  // Generate transaction reference
  const txnRef = `BB-${Date.now()}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
  const upiId = process.env.UPI_ID;
  const businessName = process.env.BUSINESS_NAME || 'Simple Payment Gateway';
  const upiLink = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(businessName)}&am=${amount}&cu=INR&tn=${txnRef}`;

  // Create payment session
  paymentSessions[amount] = {
    email,
    startedAt: now,
    expiresAt: now + LOCK_TIMEOUT,
    txnRef,
    status: 'pending',
    verificationAttempts: 0
  };

  // Auto-cleanup after timeout
  setTimeout(() => {
    if (paymentSessions[amount]?.txnRef === txnRef) {
      delete paymentSessions[amount];
    }
  }, LOCK_TIMEOUT + 1000);

  try {
    // Generate QR code
    const qrImage = await qrcode.toDataURL(upiLink);
    
    logger.info('QR generated', { email, amount, txnRef });
    
    res.json({
      upiLink,
      qrImage,
      txnRef,
      expiresIn: PAYMENT_TIMEOUT,
      apps: {
        gpay: `intent://${upiLink}#Intent;scheme=upi;package=com.google.android.apps.nbu.paisa.user;end`,
        phonepe: `intent://${upiLink}#Intent;scheme=upi;package=com.phonepe.app;end`,
        paytm: `intent://${upiLink}#Intent;scheme=upi;package=net.one97.paytm;end`
      }
    });
  } catch (err) {
    logger.error('QR Generation Failed', { error: err.message, email, amount });
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// 📨 Route: Unified Payment Webhook
app.post('/payment-webhook', async (req, res) => {
  const { sender, message, notification, token } = req.body;
  
  // Validate webhook token
  if (token !== process.env.SECRET_KEY) {
    logger.warn('Unauthorized webhook attempt', { ip: req.ip });
    return res.status(403).json({ error: 'Unauthorized' });
  }

  let amount, identifier, source, paymentDetails;
  
  try {
    // Parse payment details based on source
    if (message) {
      // Process SMS
      source = 'sms';
      const amountMatch = message.match(/(?:\u20B9|INR|Rs\.?)\s*(\d+(?:\.\d{1,2})?)/i);
      const refMatch = message.match(/UPI[\/\s\-]*CREDIT[\/\s\-]*(\w+)/i) || 
                      message.match(/Ref\s*:\s*(\w+)/i);

      if (!amountMatch || !refMatch) {
        return res.status(400).json({ error: 'Missing amount or UPI ref in SMS' });
      }

      amount = parseFloat(amountMatch[1]);
      identifier = refMatch[1];
      paymentDetails = { sender, amount, upiRef: identifier };
    } 
    else if (notification) {
      // Process Google Pay notification
      source = 'gpay';
      const gpayAmountMatch = notification.match(/paid you ₹(\d+(?:\.\d{1,2})?)/i);
      if (!gpayAmountMatch) {
        return res.status(400).json({ error: 'Missing amount in Google Pay notification' });
      }
      
      amount = parseFloat(gpayAmountMatch[1]);
      identifier = notification.split('\n')[1]; // Extract transaction ID from second line
      if (!identifier) {
        return res.status(400).json({ error: 'Missing transaction ID in Google Pay notification' });
      }
      paymentDetails = { amount, gpayTxnId: identifier };
    }
    else {
      return res.status(400).json({ error: 'No valid payment data received' });
    }

    // Find active session for this amount
    const session = paymentSessions[amount];
    if (!session || session.expiresAt < Date.now()) {
      return res.status(404).json({ error: 'No active payment session for this amount' });
    }

    // Track verification attempts
    session.verificationAttempts = (session.verificationAttempts || 0) + 1;
    if (session.verificationAttempts > 10) {
      logger.warn('Excessive verification attempts', { 
        email: session.email,
        amount,
        txnRef: session.txnRef,
        attempts: session.verificationAttempts
      });
      return res.status(429).json({ error: 'Too many verification attempts' });
    }

    // Mark payment as successful in Firebase
    const transactionKey = `${source}_${identifier}`;
    const refDoc = db.collection('processed_transactions').doc(transactionKey);
    
    await refDoc.set({
      source,
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
      email: session.email,
      sender: sender || 'Google Pay',
      amount,
      identifier,
      txnRef: session.txnRef,
      status: 'completed'
    });

    // Mark session as completed
    session.status = 'completed';
    session.completedAt = Date.now();
    
    // Log successful payment
    await sendDiscordLog(`✅ ₹${amount} payment from ${sender || 'Google Pay'} → ${session.email}`);
    logger.info('Payment processed', { 
      email: session.email, 
      amount, 
      identifier,
      source,
      status: 'completed'
    });

    res.json({ 
      success: true, 
      email: session.email,
      txnRef: session.txnRef,
      status: 'completed'
    });
  } catch (err) {
    logger.error('Payment processing failed', { 
      error: err.message, 
      ...paymentDetails,
      email: paymentSessions[amount]?.email 
    });
    res.status(500).json({ error: 'Payment processing failed: ' + err.message });
  }
});

// 📦 Route: Poll Payment Status
app.post('/check-payment-status', async (req, res) => {
  const { email, amount, txnRef } = req.body;
  
  if (!email || !amount || !txnRef) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Check active session
  const session = paymentSessions[amount];
  if (session && session.txnRef === txnRef) {
    if (session.status === 'completed') {
      return res.json({ success: true });
    }
    return res.json({ 
      success: false,
      expiresIn: Math.ceil((session.expiresAt - Date.now()) / 1000)
    });
  }

  // Check Firebase for completed payment
  try {
    const snap = await db.collection('processed_transactions')
      .where('email', '==', email)
      .where('amount', '==', amount)
      .where('txnRef', '==', txnRef)
      .limit(1)
      .get();

    if (!snap.empty) {
      return res.json({ success: true });
    }
    
    return res.json({ 
      success: false,
      message: 'No active payment session found'
    });
  } catch (err) {
    logger.error('Payment status check failed', { 
      error: err.message,
      email,
      amount,
      txnRef
    });
    res.status(500).json({ error: 'Payment status check failed' });
  }
});

// 🧪 Health Check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`🚀 Server running on port ${PORT}`);
});
