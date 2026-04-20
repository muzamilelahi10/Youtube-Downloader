const express = require('express');
const { spawn } = require('child_process');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static('public'));

// Get the yt-dlp command (Render will have it installed via Python)
let YT_DLP = process.env.YT_DLP_PATH || 'python -m yt_dlp';

// Helper function to spawn yt-dlp with correct command/args
function spawnYtDlp(args, options = {}) {
    const [command, ...cmdArgs] = YT_DLP.split(' ');
    return spawn(command, [...cmdArgs, ...args], options);
}

// ─── In-memory cache (5-minute TTL) ────────────────────────────────────────
const infoCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached(url) {
    const entry = infoCache.get(url);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
        infoCache.delete(url);
        return null;
    }
    return entry.data;
}

function setCache(url, data) {
    infoCache.set(url, { data, ts: Date.now() });
}

// ─── URL Validator ──────────────────────────────────────────────────────────
function isValid(url) {
    try {
        const u = new URL(url);
        return u.hostname.includes('youtube.com') || u.hostname.includes('youtu.be');
    } catch {
        return false;
    }
}

// ─── yt-dlp base flags shared everywhere ────────────────────────────────────
const BASE_FLAGS = [
    '--no-playlist',
    '--no-warnings',
    '--no-check-certificates',
];

/////////////////////////////////////////////////////
// INFO — returns title, thumbnail, and all formats
// Optimised: in-memory cache + minimal yt-dlp flags
/////////////////////////////////////////////////////
app.post('/info', async (req, res) => {
    const { url } = req.body;

    if (!url || !isValid(url)) {
        return res.json({ error: 'Invalid URL' });
    }

    // ── Cache hit ─────────────────────────────────
    const cached = getCached(url);
    if (cached) {
        console.log('[info] Cache hit');
        return res.json(cached);
    }

    console.log('[info] Fetching…');

    let responded = false;

    // --flat-playlist prevents resolving playlists, -J is JSON dump
    // We skip extra network calls by requesting only what we need
    const yt = spawnYtDlp([
        ...BASE_FLAGS,
        '-J',            // full JSON (needed for format list)
        url
    ]);

    let data = '';
    let stderr = '';

    yt.stdout.on('data', chunk => { data += chunk; });
    yt.stderr.on('data', chunk => { stderr += chunk; });

    yt.on('close', () => {
        if (responded) return;
        responded = true;
        try {
            const info = JSON.parse(data);

            const seen = new Set();
            const videoFormats = (info.formats || [])
                .filter(f => f.height && f.vcodec !== 'none')
                .map(f => ({
                    formatId: f.format_id,
                    ext: f.ext,
                    height: f.height,
                    fps: f.fps || null,
                    filesize: f.filesize || f.filesize_approx || null,
                    vcodec: f.vcodec,
                    acodec: f.acodec,
                    hasAudio: f.acodec && f.acodec !== 'none',
                    label: `${f.height}p${f.fps && f.fps > 30 ? f.fps : ''}`,
                }))
                .reduce((acc, f) => {
                    if (!seen.has(f.label)) {
                        seen.add(f.label);
                        acc.push(f);
                    }
                    return acc;
                }, [])
                .sort((a, b) => b.height - a.height);

            const payload = {
                title: info.title,
                thumbnail: info.thumbnail,
                duration: info.duration_string || null,
                channel: info.channel || info.uploader || null,
                formats: videoFormats,
            };

            setCache(url, payload);
            res.json(payload);

        } catch (e) {
            console.error('[info] Parse error:', e.message);
            console.error('[info] stderr:', stderr.slice(0, 500));
            res.json({ error: 'Failed to parse video info' });
        }
    });

    yt.on('error', err => {
        if (responded) return;
        responded = true;
        console.error('[info] spawn error:', err.message || err);
        console.error('[info] YT_DLP_PATH:', YT_DLP);
        res.json({ error: `yt-dlp error: ${err.message || 'failed to start'}. Ensure yt-dlp is installed.` });
    });
});

/////////////////////////////////////////////////////
// VIDEO DOWNLOAD — streaming directly to the browser
/////////////////////////////////////////////////////
app.get('/download', (req, res) => {
    const { url, formatId } = req.query;

    if (!url || !isValid(url)) return res.status(400).send('Invalid URL');

    const formatArg = formatId
        ? `${formatId}+bestaudio/best`
        : 'bestvideo+bestaudio/best';

    const cached = getCached(url);
    const safeTitle = cached
        ? cached.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').slice(0, 80)
        : 'video';

    const yt = spawnYtDlp([
        ...BASE_FLAGS,
        '-f', formatArg,
        '--merge-output-format', 'mp4',
        '-o', '-',
        url
    ]);

    let headersSent = false;

    yt.on('error', err => {
        console.error('[download] spawn error:', err.message || err);
        if (!headersSent) {
            res.status(500).send('Download failed: yt-dlp error');
        } else {
            // Headers already sent, can't send error response
            console.error('[download] Headers already sent, cannot send error response');
            res.end();
        }
    });

    yt.on('close', code => {
        if (code !== 0) {
            console.error(`[download] yt-dlp exited with code ${code}`);
            if (!headersSent) {
                res.status(500).send('Download failed: yt-dlp process error');
            }
        }
        if (!res.writableEnded) res.end();
        console.log('[download] stream completed');
    });

    // Set headers only after yt-dlp starts successfully
    yt.stdout.once('data', () => {
        if (!headersSent) {
            res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.mp4"`);
            res.setHeader('Content-Type', 'video/mp4');
            headersSent = true;
        }
    });

    yt.stdout.pipe(res);
    yt.stderr.on('data', chunk => {
        process.stdout.write('[yt-dlp] ' + chunk);
    });

    req.on('close', () => {
        if (!yt.killed) yt.kill();
    });
});

/////////////////////////////////////////////////////
// AUDIO DOWNLOAD — streaming directly to the browser
/////////////////////////////////////////////////////
app.get('/download-audio', (req, res) => {
    const { url } = req.query;

    if (!url || !isValid(url)) return res.status(400).send('Invalid URL');

    const cached = getCached(url);
    const safeTitle = cached
        ? cached.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').slice(0, 80)
        : 'audio';

    console.log('[audio] streaming download');

    const yt = spawnYtDlp([
        ...BASE_FLAGS,
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '0',
        '-o', '-',
        url
    ]);

    let headersSent = false;

    yt.on('error', err => {
        console.error('[audio] spawn error:', err.message || err);
        if (!headersSent) {
            res.status(500).send('Download failed: yt-dlp error');
        } else {
            res.end();
        }
    });

    yt.on('close', code => {
        if (code !== 0) {
            console.error(`[audio] yt-dlp exited with code ${code}`);
            if (!headersSent) {
                res.status(500).send('Download failed: yt-dlp process error');
            }
        }
        if (!res.writableEnded) res.end();
        console.log('[audio] stream completed');
    });

    // Set headers only after yt-dlp starts successfully
    yt.stdout.once('data', () => {
        if (!headersSent) {
            res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.mp3"`);
            res.setHeader('Content-Type', 'audio/mpeg');
            headersSent = true;
        }
    });

    yt.stdout.pipe(res);
    yt.stderr.on('data', chunk => {
        process.stdout.write('[yt-dlp audio] ' + chunk);
    });

    req.on('close', () => {
        if (!yt.killed) yt.kill();
    });
});

/////////////////////////////////////////////////////
app.listen(PORT, () => {
    console.log(`Server running: http://localhost:${PORT}`);
});