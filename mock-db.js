const readline = require('readline');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const DB_FILE = path.join(__dirname, 'database.sqlite');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'mock-db> '
});

let db;

async function initDB() {
    try {
        db = await open({
            filename: DB_FILE,
            driver: sqlite3.Database
        });
        
        console.log("=====================================");
        console.log("    Interactive Mock Database CLI    ");
        console.log("=====================================");
        console.log("Available Commands:");
        console.log("  list servers          - Shows all servers");
        console.log("  list users            - Shows all connected users");
        console.log("  view server <code>    - Shows details for a particular server");
        console.log("  exit / quit           - Close the database terminal");
        console.log("");
        rl.prompt();
    } catch (e) {
        console.error("Failed to open database.\nError:", e.message);
        process.exit(1);
    }
}

rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
        rl.prompt();
        return;
    }

    const args = input.split(' ');
    const cmd = args[0].toLowerCase();
    
    if (cmd === 'exit' || cmd === 'quit') {
        process.exit(0);
    }
    
    try {
        if (input === 'list servers') {
            const servers = await db.all('SELECT * FROM servers');
            console.log(`\nFound ${servers.length} server(s):`);
            for (const srv of servers) {
                const members = await db.get('SELECT COUNT(*) as count FROM members WHERE server_id = ?', [srv.id]);
                const channels = await db.get('SELECT COUNT(*) as count FROM channels WHERE server_id = ?', [srv.id]);
                console.log(`- [${srv.id}] ${srv.name}`);
                console.log(`    Members: ${members.count} | Channels: ${channels.count}`);
            }
        } else if (input === 'list users') {
            const users = await db.all('SELECT * FROM users');
            console.log(`\nFound ${users.length} user(s):`);
            users.forEach((user) => {
                console.log(`- ${user.username}#${user.discriminator} (ID: ${user.id})`);
            });
        } else if (cmd === 'view' && args[1] === 'server' && args[2]) {
            const code = args[2].toUpperCase();
            const server = await db.get('SELECT * FROM servers WHERE id = ?', [code]);
            if (server) {
                const channels = await db.all('SELECT id, name FROM channels WHERE server_id = ?', [code]);
                const members = await db.all('SELECT user_id FROM members WHERE server_id = ?', [code]);
                
                const serverDetails = {
                    id: server.id,
                    name: server.name,
                    channels: channels,
                    members: members.map(m => m.user_id),
                };

                console.log(`\n--- Server Details [${code}] ---`);
                console.log(JSON.stringify(serverDetails, null, 2));
            } else {
                console.log(`Server '${code}' not found.`);
            }
        } else {
            console.log("Unknown command.");
        }
    } catch (err) {
        console.error("Database error:", err.message);
    }

    console.log("");
    rl.prompt();
}).on('close', () => {
    process.exit(0);
});

initDB();
