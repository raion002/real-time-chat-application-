const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Utility to generate a random 6-char server code
function generateServerCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generateId() {
    return Math.random().toString(36).substring(2, 10);
}

const defaultServerCode = 'GLOBAL';

let db;

async function initDB() {
    db = await open({
        filename: path.join(__dirname, 'database.sqlite'),
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT,
            discriminator INTEGER,
            avatar TEXT
        );
        CREATE TABLE IF NOT EXISTS servers (
            id TEXT PRIMARY KEY,
            name TEXT
        );
        CREATE TABLE IF NOT EXISTS channels (
            id TEXT PRIMARY KEY,
            server_id TEXT,
            name TEXT,
            FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS members (
            server_id TEXT,
            user_id TEXT,
            PRIMARY KEY (server_id, user_id),
            FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            channel_id TEXT,
            user_id TEXT,
            text TEXT,
            timestamp TEXT,
            edited INTEGER DEFAULT 0,
            reply_to TEXT,
            FOREIGN KEY (reply_to) REFERENCES messages(id) ON DELETE SET NULL,
            FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS reactions (
            message_id TEXT,
            user_id TEXT,
            emoji TEXT,
            PRIMARY KEY (message_id, user_id, emoji),
            FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    `);

    // Ensure default server exists
    const serverExists = await db.get('SELECT id FROM servers WHERE id = ?', [defaultServerCode]);
    if (!serverExists) {
        await db.run('INSERT INTO servers (id, name) VALUES (?, ?)', [defaultServerCode, 'Nexus Space']);
        await db.run('INSERT INTO channels (id, server_id, name) VALUES (?, ?, ?)', ['general', defaultServerCode, 'general']);
        console.log('Created default GLOBAL server: Nexus Space');
    }
}

async function sendUserServers(socket) {
    const userServers = await db.all('SELECT s.id, s.name FROM servers s JOIN members m ON s.id = m.server_id WHERE m.user_id = ?', [socket.id]);
    socket.emit('user servers', userServers);
}

async function getOnlineMembersForServer(serverId) {
    return await db.all('SELECT u.id, u.username, u.discriminator, u.avatar FROM users u JOIN members m ON u.id = m.user_id WHERE m.server_id = ?', [serverId]);
}

io.on('connection', async (socket) => {
    try {
        // Generate user profile
        const username = `User_${Math.floor(Math.random() * 10000)}`;
        const avatarColor = Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
        const discriminator = Math.floor(1000 + Math.random() * 9000);
        const avatar = `https://ui-avatars.com/api/?name=${username.charAt(0)}&background=${avatarColor}&color=fff`;

        const userProfile = { id: socket.id, username, discriminator, avatar };
        
        await db.run('INSERT INTO users (id, username, discriminator, avatar) VALUES (?, ?, ?, ?)', 
            [socket.id, username, discriminator, avatar]);

        socket.emit('me', userProfile);

        // Auto-join default server
        await db.run('INSERT OR IGNORE INTO members (server_id, user_id) VALUES (?, ?)', [defaultServerCode, socket.id]);
        socket.join(defaultServerCode);
        
        // Send joined servers list
        await sendUserServers(socket);

        // Listen for create server
        socket.on('create server', async (serverName, callback) => {
            const code = generateServerCode();
            const defaultChannelId = generateId();
            
            await db.run('INSERT INTO servers (id, name) VALUES (?, ?)', [code, serverName || 'New Server']);
            await db.run('INSERT INTO channels (id, server_id, name) VALUES (?, ?, ?)', [defaultChannelId, code, 'general']);
            await db.run('INSERT INTO members (server_id, user_id) VALUES (?, ?)', [code, socket.id]);

            socket.join(code);
            await sendUserServers(socket);
            if (callback) callback({ success: true, serverCode: code });
        });

        // Listen for join server
        socket.on('join server', async (serverCode, callback) => {
            const code = serverCode.toUpperCase();
            const server = await db.get('SELECT id FROM servers WHERE id = ?', [code]);
            if (server) {
                const member = await db.get('SELECT user_id FROM members WHERE server_id = ? AND user_id = ?', [code, socket.id]);
                if (!member) {
                    await db.run('INSERT INTO members (server_id, user_id) VALUES (?, ?)', [code, socket.id]);
                    socket.join(code);
                    await sendUserServers(socket);
                    
                    // Notify others
                    const members = await getOnlineMembersForServer(code);
                    io.to(code).emit('server members update', { serverId: code, members });
                }
                if (callback) callback({ success: true, serverCode: code });
            } else {
                if (callback) callback({ success: false, message: 'Server not found' });
            }
        });

        // Request server details
        socket.on('get server state', async (serverId, callback) => {
            const member = await db.get('SELECT user_id FROM members WHERE server_id = ? AND user_id = ?', [serverId, socket.id]);
            if (member) {
                const server = await db.get('SELECT id, name FROM servers WHERE id = ?', [serverId]);
                const channels = await db.all('SELECT id, name FROM channels WHERE server_id = ?', [serverId]);
                const members = await getOnlineMembersForServer(serverId);
                
                // Fetch messages for each channel
                const messagesByChannel = {};
                for (const ch of channels) {
                    const msgs = await db.all(`
                        SELECT m.id, m.text, m.timestamp, m.edited, m.reply_to,
                               u.id as user_id, u.username, u.discriminator, u.avatar,
                               r.text as reply_text, ru.username as reply_username
                        FROM messages m
                        JOIN users u ON m.user_id = u.id
                        LEFT JOIN messages r ON m.reply_to = r.id
                        LEFT JOIN users ru ON r.user_id = ru.id
                        WHERE m.channel_id = ?
                        ORDER BY m.timestamp ASC
                    `, [ch.id]);

                    const reactions = await db.all(`
                        SELECT message_id, emoji, user_id
                        FROM reactions
                        WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)
                    `, [ch.id]);

                    const reactionsByMsg = {};
                    reactions.forEach(r => {
                        if (!reactionsByMsg[r.message_id]) reactionsByMsg[r.message_id] = {};
                        if (!reactionsByMsg[r.message_id][r.emoji]) reactionsByMsg[r.message_id][r.emoji] = [];
                        reactionsByMsg[r.message_id][r.emoji].push(r.user_id);
                    });
                    
                    messagesByChannel[ch.id] = msgs.map(m => ({
                        id: m.id,
                        text: m.text,
                        timestamp: m.timestamp,
                        edited: m.edited === 1,
                        reply_to: m.reply_to ? {
                            id: m.reply_to,
                            text: m.reply_text,
                            username: m.reply_username
                        } : null,
                        sender: {
                            id: m.user_id,
                            username: m.username,
                            discriminator: m.discriminator,
                            avatar: m.avatar
                        },
                        reactions: reactionsByMsg[m.id] || {}
                    }));
                }

                if (callback) callback({
                    success: true,
                    server: {
                        id: server.id,
                        name: server.name,
                        channels: channels,
                        messages: messagesByChannel,
                        members: members
                    }
                });
            }
        });

        // Create channel
        socket.on('create channel', async ({ serverId, channelName }, callback) => {
            const member = await db.get('SELECT user_id FROM members WHERE server_id = ? AND user_id = ?', [serverId, socket.id]);
            if (member) {
                const newChannelId = generateId();
                const cleanName = channelName.toLowerCase().replace(/\s+/g, '-');
                await db.run('INSERT INTO channels (id, server_id, name) VALUES (?, ?, ?)', [newChannelId, serverId, cleanName]);
                const newChannel = { id: newChannelId, name: cleanName };
                io.to(serverId).emit('channel created', { serverId, channel: newChannel });
                if (callback) callback({ success: true, channel: newChannel });
            }
        });

        // Handle chat messages
        socket.on('chat message', async (data) => {
            const { serverId, channelId, text, replyTo } = data;
            const member = await db.get('SELECT user_id FROM members WHERE server_id = ? AND user_id = ?', [serverId, socket.id]);
            if (member) {
                const msgId = generateId();
                const timestamp = new Date().toISOString();
                
                await db.run('INSERT INTO messages (id, channel_id, user_id, text, timestamp, edited, reply_to) VALUES (?, ?, ?, ?, ?, 0, ?)',
                    [msgId, channelId, socket.id, text, timestamp, replyTo || null]);

                const sender = await db.get('SELECT id, username, discriminator, avatar FROM users WHERE id = ?', [socket.id]);
                
                let replyInfo = null;
                if (replyTo) {
                    const replyMsg = await db.get('SELECT m.text, u.username FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?', [replyTo]);
                    if (replyMsg) {
                        replyInfo = { id: replyTo, text: replyMsg.text, username: replyMsg.username };
                    }
                }

                const messageObj = {
                    id: msgId,
                    text: text,
                    sender: sender,
                    timestamp: timestamp,
                    reply_to: replyInfo,
                    reactions: {}
                };
                
                io.to(serverId).emit('chat message', { serverId, channelId, message: messageObj });
            }
        });

        // Reactions
        socket.on('add reaction', async (data) => {
            const { serverId, channelId, messageId, emoji } = data;
            const member = await db.get('SELECT user_id FROM members WHERE server_id = ? AND user_id = ?', [serverId, socket.id]);
            if (member) {
                await db.run('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)', [messageId, socket.id, emoji]);
                io.to(serverId).emit('reaction updated', { serverId, channelId, messageId, userId: socket.id, emoji, action: 'add' });
            }
        });

        socket.on('remove reaction', async (data) => {
            const { serverId, channelId, messageId, emoji } = data;
            const member = await db.get('SELECT user_id FROM members WHERE server_id = ? AND user_id = ?', [serverId, socket.id]);
            if (member) {
                await db.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [messageId, socket.id, emoji]);
                io.to(serverId).emit('reaction updated', { serverId, channelId, messageId, userId: socket.id, emoji, action: 'remove' });
            }
        });

        // Rename Server
        socket.on('rename server', async (data, callback) => {
            const { serverId, newName } = data;
            const member = await db.get('SELECT user_id FROM members WHERE server_id = ? AND user_id = ?', [serverId, socket.id]);
            if (member) {
                await db.run('UPDATE servers SET name = ? WHERE id = ?', [newName, serverId]);
                io.to(serverId).emit('server renamed', { serverId, newName });
                
                const members = await db.all('SELECT user_id FROM members WHERE server_id = ?', [serverId]);
                for (const m of members) {
                    const memberSocket = io.sockets.sockets.get(m.user_id);
                    if (memberSocket) {
                        await sendUserServers(memberSocket);
                    }
                }
                if (callback) callback({ success: true });
            } else {
                if (callback) callback({ success: false, message: 'Unauthorized' });
            }
        });

        // Edit Message
        socket.on('edit message', async (data, callback) => {
            const { serverId, channelId, messageId, newText } = data;
            const msg = await db.get('SELECT user_id FROM messages WHERE id = ? AND channel_id = ?', [messageId, channelId]);
            if (msg && msg.user_id === socket.id) {
                await db.run('UPDATE messages SET text = ?, edited = 1 WHERE id = ?', [newText, messageId]);
                io.to(serverId).emit('message edited', { serverId, channelId, messageId, newText });
                if (callback) callback({ success: true });
            } else {
                if (callback) callback({ success: false, message: 'Unauthorized' });
            }
        });

        // Delete Message
        socket.on('delete message', async (data, callback) => {
            const { serverId, channelId, messageId } = data;
            const msg = await db.get('SELECT user_id FROM messages WHERE id = ? AND channel_id = ?', [messageId, channelId]);
            if (msg && msg.user_id === socket.id) {
                await db.run('DELETE FROM messages WHERE id = ?', [messageId]);
                io.to(serverId).emit('message deleted', { serverId, channelId, messageId });
                if (callback) callback({ success: true });
            } else {
                if (callback) callback({ success: false, message: 'Unauthorized' });
            }
        });

        // Typing Indicators
        socket.on('typing', async (data) => {
            const { serverId, channelId, isTyping } = data;
            const member = await db.get('SELECT user_id FROM members WHERE server_id = ? AND user_id = ?', [serverId, socket.id]);
            if (member) {
                socket.to(serverId).emit('typing', { 
                    serverId, 
                    channelId, 
                    userId: socket.id, 
                    username: userProfile.username,
                    isTyping 
                });
            }
        });

        socket.on('disconnect', async () => {
            const userServersList = await db.all('SELECT server_id FROM members WHERE user_id = ?', [socket.id]);
            
            await db.run('DELETE FROM members WHERE user_id = ?', [socket.id]);

            for (const srv of userServersList) {
                const members = await getOnlineMembersForServer(srv.server_id);
                io.to(srv.server_id).emit('server members update', { serverId: srv.server_id, members });
            }
        });
    } catch (err) {
        console.error("Socket error on connection:", err);
    }
});

initDB().then(() => {
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`Server is running at http://localhost:${PORT}`);
    });
}).catch(err => {
    console.error("Failed to initialize database:", err);
});
