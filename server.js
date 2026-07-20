const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(compression());
app.use(morgan('combined'));
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'railway-config-panel-secret-' + uuidv4(),
  resave: false,
  saveUninitialized: true,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// In-memory storage (در محیط Railway)
const configStorage = new Map();
const userStorage = new Map();
const statsStorage = {
  totalConfigs: 0,
  activeConfigs: 0,
  totalBandwidth: 0,
  uptime: Date.now()
};

// Default admin user - رمز عبور ساده بدون هش
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';

userStorage.set(ADMIN_USERNAME, {
  username: ADMIN_USERNAME,
  password: ADMIN_PASSWORD, // ذخیره مستقیم رمز
  role: 'admin',
  createdAt: new Date()
});

console.log('✅ ادمین پیش‌فرض:', ADMIN_USERNAME, '/', ADMIN_PASSWORD);

// Helper functions
function generateVmessConfig(config) {
  const { uuid, address, port, remark } = config;
  const base64 = Buffer.from(JSON.stringify({
    v: "2",
    ps: remark || "Railway-Config",
    add: address,
    port: port || "443",
    id: uuid,
    aid: "0",
    scy: "auto",
    net: "ws",
    type: "none",
    host: address,
    path: "/vmess",
    tls: "tls",
    sni: address,
    alpn: "h2,http/1.1"
  })).toString('base64');
  
  return `vmess://${base64}`;
}

function generateVlessConfig(config) {
  const { uuid, address, port, remark } = config;
  const params = new URLSearchParams({
    type: 'ws',
    security: 'tls',
    path: '/vless',
    host: address,
    sni: address,
    fp: 'chrome',
    alpn: 'h2,http/1.1'
  });
  
  return `vless://${uuid}@${address}:${port || 443}?${params.toString()}#${encodeURIComponent(remark || 'VLESS-Config')}`;
}

function generateTrojanConfig(config) {
  const { uuid, address, port, remark } = config;
  const params = new URLSearchParams({
    type: 'ws',
    security: 'tls',
    path: '/trojan',
    host: address,
    sni: address
  });
  
  return `trojan://${uuid}@${address}:${port || 443}?${params.toString()}#${encodeURIComponent(remark || 'Trojan-Config')}`;
}

function generateShadowsocksConfig(config) {
  const { uuid, address, port, remark } = config;
  const method = 'aes-256-gcm';
  const base64 = Buffer.from(`${method}:${uuid}`).toString('base64');
  return `ss://${base64}@${address}:${port || 443}#${encodeURIComponent(remark || 'SS-Config')}`;
}

// Routes
app.get('/', (req, res) => {
  res.render('index', {
    title: 'پنل کانفیگ‌ساز',
    stats: statsStorage,
    configs: Array.from(configStorage.values()),
    username: req.session.username || 'مهمان',
    error: null,
    success: null
  });
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = userStorage.get(username);
  
  // مقایسه مستقیم رمز عبور
  if (user && user.password === password) {
    req.session.username = username;
    req.session.role = user.role;
    res.redirect('/dashboard');
  } else {
    res.render('login', { error: 'نام کاربری یا رمز عبور اشتباه است' });
  }
});

app.get('/dashboard', (req, res) => {
  if (!req.session.username) {
    return res.redirect('/login');
  }
  
  res.render('dashboard', {
    configs: Array.from(configStorage.values()),
    stats: statsStorage,
    username: req.session.username
  });
});

// API Routes
app.post('/api/config/generate', (req, res) => {
  const { protocol, remark, customDomain, customPort } = req.body;
  
  if (!protocol) {
    return res.status(400).json({ error: 'پروتکل انتخاب نشده است' });
  }
  
  const configId = uuidv4();
  const uuid = uuidv4();
  const address = customDomain || process.env.RAILWAY_STATIC_URL || 'localhost';
  const port = customPort || 443;
  
  const config = {
    id: configId,
    uuid: uuid,
    protocol: protocol,
    address: address,
    port: port,
    remark: remark || `Config-${configId.substring(0, 8)}`,
    createdAt: new Date(),
    status: 'active',
    bandwidth: {
      upload: 0,
      download: 0,
      total: 0
    }
  };
  
  // Generate config link based on protocol
  switch(protocol) {
    case 'vmess':
      config.link = generateVmessConfig(config);
      break;
    case 'vless':
      config.link = generateVlessConfig(config);
      break;
    case 'trojan':
      config.link = generateTrojanConfig(config);
      break;
    case 'shadowsocks':
      config.link = generateShadowsocksConfig(config);
      break;
    default:
      return res.status(400).json({ error: 'پروتکل نامعتبر است' });
  }
  
  configStorage.set(configId, config);
  statsStorage.totalConfigs++;
  statsStorage.activeConfigs++;
  
  // Generate QR Code
  QRCode.toDataURL(config.link, (err, qrCode) => {
    if (!err) {
      config.qrCode = qrCode;
    }
    
    res.json({
      success: true,
      config: config
    });
  });
});

app.get('/api/configs', (req, res) => {
  const configs = Array.from(configStorage.values());
  res.json({ configs, stats: statsStorage });
});

app.get('/api/config/:id', (req, res) => {
  const config = configStorage.get(req.params.id);
  if (!config) {
    return res.status(404).json({ error: 'کانفیگ یافت نشد' });
  }
  res.json(config);
});

app.delete('/api/config/:id', (req, res) => {
  if (!req.session.username) {
    return res.status(401).json({ error: 'دسترسی غیرمجاز' });
  }
  
  const deleted = configStorage.delete(req.params.id);
  if (deleted) {
    statsStorage.activeConfigs--;
    res.json({ success: true, message: 'کانفیگ با موفقیت حذف شد' });
  } else {
    res.status(404).json({ error: 'کانفیگ یافت نشد' });
  }
});

app.get('/api/stats', (req, res) => {
  res.json(statsStorage);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    uptime: Date.now() - statsStorage.uptime,
    configs: statsStorage.totalConfigs,
    timestamp: new Date().toISOString()
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error', { error: 'خطای سرور' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).render('404');
});

app.listen(PORT, () => {
  console.log(`🚀 Config Panel running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`🌐 Railway URL: ${process.env.RAILWAY_STATIC_URL || 'Not set'}`);
});
