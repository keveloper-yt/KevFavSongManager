// server.js
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const session = require("express-session");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ===============================
// Config
// ===============================
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:3000/auth/twitch/callback";

// ===============================
// Database
// ===============================
const db = new Database("user_data.db");

// Users table
db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        login TEXT NOT NULL,
        display_name TEXT NOT NULL,
        color_choice TEXT
    )
`).run();

// Favorites table
db.prepare(`
    CREATE TABLE IF NOT EXISTS favorites (
        user_id TEXT NOT NULL,
        song_id TEXT NOT NULL,
        PRIMARY KEY(user_id, song_id),
        FOREIGN KEY(user_id) REFERENCES users(id)
    )
`).run();

// ===============================
// Middleware
// ===============================
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, httpOnly: true, sameSite: "lax" }
}));

// ===============================
// Authentication helper
// ===============================
function requireAuth(req, res, next) {
    if (!req.session.user) return res.status(401).json({ error: "Unauthorized" });
    next();
}

// ===============================
// Load songs from TSV
// ===============================
const SONGS_TSV = path.join(__dirname, "songdata.tsv");

function loadSongsFromTSV() {
    const tsv = fs.readFileSync(SONGS_TSV, "utf-8");
    const lines = tsv.split(/\r?\n/).filter(l => l.trim());
    const header = lines[0].split("\t").map(h => h.trim());

    return lines.slice(1).map(line => {
        const values = line.split("\t");
        const obj = {};
        header.forEach((h, i) => obj[h] = values[i] || "");

        return {
            id: obj["Id"],
            name: obj["Title"],
            artist: obj["Artist"],
            albumArtist: obj["Album Artist"],
            album: obj["Album"],
            year: obj["Year"],
            genre: obj["Genre"],
            vocal: obj["Vocal"],
            url: obj["Display Url"] || obj["Url"] || ""
        };
    });
}

// Cache in memory
let songs = loadSongsFromTSV();

// ===============================
// Routes
// ===============================

// Home
app.get("/", requireAuth, (req, res) => {
    res.render("index", { displayName: req.session.user.display_name });
});

// Login page
app.get("/login", (req, res) => {
    if (req.session.user) return res.redirect("/");
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Twitch OAuth
app.get("/auth/twitch", (req, res) => {
    const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&scope=user:read:email`;
    res.redirect(authUrl);
});

app.get("/auth/twitch/callback", async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect("/login");

    try {
        const tokenResponse = await axios.post("https://id.twitch.tv/oauth2/token", null, {
            params: {
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                code: code,
                grant_type: "authorization_code",
                redirect_uri: REDIRECT_URI
            }
        });

        const accessToken = tokenResponse.data.access_token;
        const userResponse = await axios.get("https://api.twitch.tv/helix/users", {
            headers: { "Client-ID": CLIENT_ID, "Authorization": `Bearer ${accessToken}` }
        });

        const user = userResponse.data.data[0];
        req.session.user = user;

        db.prepare(`
            INSERT OR IGNORE INTO users (id, login, display_name)
            VALUES (?, ?, ?)
        `).run(user.id, user.login, user.display_name);

        req.session.save(() => res.redirect("/"));
    } catch (err) {
        console.error("OAuth error:", err.response?.data || err);
        res.send("Authentication failed.");
    }
});

// Get songs with favorites
app.get("/songs", requireAuth, (req, res) => {
    const favoriteRows = db.prepare("SELECT song_id FROM favorites WHERE user_id = ?")
        .all(req.session.user.id);
    const favoriteIds = new Set(favoriteRows.map(r => r.song_id));

    const result = songs.map(s => ({ ...s, isFavorite: favoriteIds.has(s.id) }));
    res.json({ songs: result });
});

// Toggle favorite
app.post("/favorite", requireAuth, (req, res) => {
    const { songId, favorite } = req.body;
    const songExists = songs.find(s => s.id === songId);
    if (!songExists) return res.status(400).json({ error: "Invalid song ID" });

    try {
        if (favorite) {
            db.prepare(`INSERT OR IGNORE INTO favorites (user_id, song_id) VALUES (?, ?)`)
                .run(req.session.user.id, songId);
            console.log(`User ${req.session.user.id} FAVORITED song ${songId}`);
        } else {
            db.prepare(`DELETE FROM favorites WHERE user_id = ? AND song_id = ?`)
                .run(req.session.user.id, songId);
            console.log(`User ${req.session.user.id} UNFAVORITED song ${songId}`);
        }
        res.json({ success: true, songId, favorite });
    } catch (err) {
        console.error("Favorite DB error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Logout
app.get("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/login"));
});

// Serve static files
app.use(express.static("public"));

// Start server
app.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
});
