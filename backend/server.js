const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');
const userRoutes = require('./routes/user');
const { sendPushNotification } = require('./utils/pushService');

const app = express();
const server = http.createServer(app);

// ─────────────────────────────────────────────────────
// Socket.IO Configuration (Fixed for AWS ALB)
// ─────────────────────────────────────────────────────
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  //  FIXED: Added transports for AWS ALB WebSocket support
  transports: ['websocket', 'polling'],
  //  FIXED: Ping settings to keep connection alive behind ALB
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
  allowUpgrades: true
});

// ─────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─────────────────────────────────────────────────────
// Health Check Endpoints (BEFORE routes - Fix for ALB)
// ─────────────────────────────────────────────────────
//  FIXED: Added both /health and /api/health
app.get('/health', (req, res) => {
  const dbState = mongoose.connection.readyState;
  // 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
  if (dbState === 1) {
    return res.status(200).json({
      status: 'healthy',
      database: 'connected',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    });
  }
  res.status(503).json({
    status: 'unhealthy',
    database: 'disconnected',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', (req, res) => {
  const dbState = mongoose.connection.readyState;
  if (dbState === 1) {
    return res.status(200).json({
      status: 'healthy',
      database: 'connected',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    });
  }
  res.status(503).json({
    status: 'unhealthy',
    database: 'disconnected',
    timestamp: new Date().toISOString()
  });
});

// ─────────────────────────────────────────────────────
// Database Connection (Fixed for AWS DocumentDB)
// ─────────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI
  || 'mongodb://localhost:27017/talkwithteams';

const isDocumentDB = MONGODB_URI.includes('docdb.amazonaws.com');

const getConnectionOptions = () => {
  // Base options
  const baseOptions = {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 10000,
    maxPoolSize: 10,
    minPoolSize: 2,
  };

  if (isDocumentDB) {
    //  FIXED: DocumentDB requires SSL and retryWrites=false
    console.log(' Connecting to AWS DocumentDB...');

    const certPath = path.join(__dirname, 'rds-combined-ca-bundle.pem');
    const certExists = fs.existsSync(certPath);

    if (!certExists) {
      console.warn(' Certificate file not found, SSL validation disabled');
    }

    return {
      ...baseOptions,
      ssl: true,
      sslValidate: certExists,
      sslCA: certExists ? fs.readFileSync(certPath) : undefined,
      retryWrites: false,        //  DocumentDB does NOT support retryWrites
      directConnection: false,
    };
  }

  console.log(' Connecting to local MongoDB...');
  return baseOptions;
};

//  FIXED: Added retry logic for database connection
const connectWithRetry = (retries = 5, delay = 5000) => {
  console.log(`Attempting database connection... (${retries} retries left)`);

  mongoose.connect(MONGODB_URI, getConnectionOptions())
    .then(() => {
      console.log('✓ Connected to database successfully');
      console.log(`  Type: ${isDocumentDB ? 'AWS DocumentDB' : 'Local MongoDB'}`);
    })
    .catch(err => {
      console.error(`✗ Database connection failed: ${err.message}`);
      if (retries > 0) {
        console.log(`  Retrying in ${delay / 1000}s...`);
        setTimeout(() => connectWithRetry(retries - 1, delay), delay);
      } else {
        console.error('✗ Max retries reached. Could not connect to database.');
      }
    });
};

// Database event listeners
mongoose.connection.on('connected', () => {
  console.log('✓ Mongoose connected to database');
});

mongoose.connection.on('error', (err) => {
  console.error('✗ Mongoose connection error:', err.message);
});

mongoose.connection.on('disconnected', () => {
  console.warn(' Mongoose disconnected. Attempting to reconnect...');
});

// Start database connection
connectWithRetry();

// ─────────────────────────────────────────────────────
// API Routes
// ─────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/user', userRoutes);

// ─────────────────────────────────────────────────────
// Socket.IO Models
// ─────────────────────────────────────────────────────
const Message = require('./models/Message');
const User = require('./models/User');
const Room = require('./models/Room');

// Track online users
const onlineUsers = new Map();

// ─────────────────────────────────────────────────────
// Socket.IO Event Handlers
// ─────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`✓ User connected: ${socket.id}`);

  //  FIXED: Added opening backtick (was syntax error)
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    console.log(`User ${socket.id} joined room ${roomId}`);
  });

  socket.on('user-online', (userId) => {
    onlineUsers.set(userId, socket.id);
    io.emit('online-users', Array.from(onlineUsers.keys()));
  });

  socket.on('send-message', async (data) => {
    try {
      // Validate required fields
      if (!data.sender || !data.content || !data.room) {
        socket.emit('error', { message: 'Missing required fields' });
        return;
      }

      const message = new Message({
        sender: data.sender,
        content: data.content,
        messageType: data.messageType || 'text',
        room: data.room,
        replyTo: data.replyTo || null,
        forwardedFrom: data.forwardedFrom || null,
        fileName: data.fileName || '',
        timestamp: new Date()
      });

      await message.save();
      await message.populate([
        { path: 'sender', select: 'username profilePicture' },
        {
          path: 'replyTo',
          populate: { path: 'sender', select: 'username' }
        },
        {
          path: 'forwardedFrom',
          populate: { path: 'sender', select: 'username' }
        }
      ]);

      io.to(data.room).emit('receive-message', message);

      // Send push notifications
      try {
        const room = await Room.findById(data.room).populate('participants');
        const sender = await User.findById(data.sender);

        if (room && sender) {
          for (const participant of room.participants) {
            if (
              participant._id.toString() !== data.sender &&
              participant.pushSubscription
            ) {
              const payload = {
                title: `New message from ${sender.username}`,
                body: data.messageType === 'text'
                  ? data.content
                  : `Sent a ${data.messageType}`,
                icon: '/icon-192x192.png',
                badge: '/icon-192x192.png'
              };
              await sendPushNotification(participant.pushSubscription, payload);
            }
          }
        }
      } catch (notifError) {
        //  FIXED: Don't crash if push notification fails
        console.error('Push notification error:', notifError.message);
      }

    } catch (error) {
      console.error('Error saving message:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  socket.on('typing', (data) => {
    socket.to(data.room).emit('user-typing', data);
  });

  socket.on('stop-typing', (data) => {
    socket.to(data.room).emit('user-stop-typing', data);
  });

  socket.on('message-read', async (data) => {
    try {
      await Message.findByIdAndUpdate(data.messageId, {
        $addToSet: { readBy: data.userId }
      });
      io.to(data.room).emit('message-read-update', data);
    } catch (error) {
      console.error('Error updating message read status:', error);
    }
  });

  //  FIXED: Added opening backtick (was syntax error)
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);

    // Remove from online users
    for (const [userId, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) {
        onlineUsers.delete(userId);
        io.emit('online-users', Array.from(onlineUsers.keys()));
        break;
      }
    }
  });
});

// ─────────────────────────────────────────────────────
// Global Error Handler
// ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({
    status: 'error',
    message: 'Internal server error'
  });
});

// ─────────────────────────────────────────────────────
// Graceful Shutdown (Important for ECS)
// ─────────────────────────────────────────────────────
//  FIXED: Added graceful shutdown for ECS task draining
const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  server.close(async () => {
    console.log('HTTP server closed');
    try {
      await mongoose.connection.close();
      console.log('Database connection closed');
    } catch (err) {
      console.error('Error closing database:', err);
    }
    process.exit(0);
  });

  // Force close after 30 seconds
  setTimeout(() => {
    console.error('Forcing shutdown after timeout');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

//  FIXED: Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// ─────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────
//  FIXED: Added opening backtick (was syntax error)
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ Prayuj Teams server running on port ${PORT}`);
  console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`  Health check: http://localhost:${PORT}/health`);
});

module.exports = { app, io };
```
