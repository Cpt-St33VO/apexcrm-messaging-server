const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const server = createServer(app);

// CORS configuration for ApexCRM
const corsOptions = {
  origin: [
    'http://localhost:9002',
    'https://apexcrm-foundation.web.app',
    'https://apexcrm-foundation.firebaseapp.com',
    /^https:\/\/.*\.web\.app$/,
    /^https:\/\/.*\.firebaseapp\.com$/
  ],
  credentials: true
};

app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json());

// Socket.io setup
const io = new Server(server, {
  cors: corsOptions,
  transports: ['websocket', 'polling']
});

// Connected users tracking
const connectedUsers = new Map();
const userWorkspaces = new Map();

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ApexCRM Messaging Server Running',
    connectedUsers: connectedUsers.size,
    timestamp: new Date().toISOString()
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('👤 User connected:', socket.id);

  // Handle user authentication
  socket.on('authenticate', ({ userId, workspaceId, userInfo }) => {
    try {
      // Store user info
      connectedUsers.set(socket.id, {
        userId,
        workspaceId,
        userInfo,
        connectedAt: new Date()
      });

      // Add to workspace room
      socket.join(`workspace:${workspaceId}`);
      socket.join(`user:${userId}`);

      // Track workspace membership
      if (!userWorkspaces.has(workspaceId)) {
        userWorkspaces.set(workspaceId, new Set());
      }
      userWorkspaces.get(workspaceId).add(userId);

      console.log(`✅ User ${userId} authenticated for workspace ${workspaceId}`);

      // Emit presence update to workspace
      socket.to(`workspace:${workspaceId}`).emit('user-online', {
        userId,
        userInfo,
        timestamp: new Date()
      });

      // Send current online users
      const workspaceUsers = Array.from(connectedUsers.values())
        .filter(user => user.workspaceId === workspaceId)
        .map(user => ({
          userId: user.userId,
          userInfo: user.userInfo,
          status: 'online'
        }));

      socket.emit('online-users', workspaceUsers);

    } catch (error) {
      console.error('Authentication error:', error);
      socket.emit('auth-error', { message: 'Authentication failed' });
    }
  });

  // Handle sending messages
  socket.on('send-message', async (messageData) => {
    try {
      const user = connectedUsers.get(socket.id);
      if (!user) {
        socket.emit('error', { message: 'User not authenticated' });
        return;
      }

      // Add metadata to message
      const message = {
        ...messageData,
        id: generateMessageId(),
        senderId: user.userId,
        senderInfo: user.userInfo,
        timestamp: new Date(),
        workspaceId: user.workspaceId
      };

      console.log(`💬 Message from ${user.userId} in channel ${message.channelId}`);

      // Determine message recipients based on channel type
      let targetRoom;
      
      if (message.channelType === 'workspace') {
        targetRoom = `workspace:${user.workspaceId}`;
      } else if (message.channelType === 'direct') {
        // For direct messages, send to specific users
        const recipients = message.recipients || [];
        recipients.forEach(recipientId => {
          socket.to(`user:${recipientId}`).emit('new-message', message);
        });
        socket.emit('message-sent', { messageId: message.id, status: 'delivered' });
        return;
      } else {
        targetRoom = `channel:${message.channelId}`;
      }

      // Broadcast message to room
      if (targetRoom) {
        socket.to(targetRoom).emit('new-message', message);
        socket.emit('message-sent', { messageId: message.id, status: 'delivered' });
      }

    } catch (error) {
      console.error('Send message error:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // Handle typing indicators
  socket.on('typing-start', ({ channelId }) => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      socket.to(`channel:${channelId}`).emit('user-typing', {
        userId: user.userId,
        channelId,
        isTyping: true
      });
    }
  });

  socket.on('typing-stop', ({ channelId }) => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      socket.to(`channel:${channelId}`).emit('user-typing', {
        userId: user.userId,
        channelId,
        isTyping: false
      });
    }
  });

  // Handle presence updates
  socket.on('presence-update', ({ status }) => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      user.status = status;
      socket.to(`workspace:${user.workspaceId}`).emit('presence-change', {
        userId: user.userId,
        status,
        timestamp: new Date()
      });
    }
  });

  // Handle video call invitations
  socket.on('video-call-invite', ({ targetUserId, roomUrl, meetingInfo }) => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      socket.to(`user:${targetUserId}`).emit('video-call-invitation', {
        fromUserId: user.userId,
        fromUserInfo: user.userInfo,
        roomUrl,
        meetingInfo,
        timestamp: new Date()
      });
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    const user = connectedUsers.get(socket.id);
    
    if (user) {
      console.log(`👋 User ${user.userId} disconnected`);
      
      // Remove from workspace tracking
      const workspaceUsers = userWorkspaces.get(user.workspaceId);
      if (workspaceUsers) {
        workspaceUsers.delete(user.userId);
      }

      // Notify workspace about user going offline
      socket.to(`workspace:${user.workspaceId}`).emit('user-offline', {
        userId: user.userId,
        timestamp: new Date()
      });

      // Remove from connected users
      connectedUsers.delete(socket.id);
    }

    console.log('📊 Connected users:', connectedUsers.size);
  });

  // Error handling
  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// Utility functions
function generateMessageId() {
  return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Cleanup disconnected users periodically
setInterval(() => {
  const now = Date.now();
  for (const [socketId, user] of connectedUsers.entries()) {
    if (now - user.connectedAt.getTime() > 24 * 60 * 60 * 1000) { // 24 hours
      connectedUsers.delete(socketId);
    }
  }
}, 60 * 60 * 1000); // Clean up every hour

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 ApexCRM Messaging Server running on port ${PORT}`);
  console.log(`📡 Socket.io ready for connections`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Shutting down server...');
  server.close(() => {
    console.log('✅ Server shutdown complete');
    process.exit(0);
  });
});
