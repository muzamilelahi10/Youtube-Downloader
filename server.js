import express from 'express';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { Innertube, UniversalCache } from 'youtubei.js';

const app = express();
const port = process.env.PORT || 3000;
const playlistLimit = Number.parseInt(process.env.PLAYLIST_LIMIT || '100', 10);

app.use(express.json({ limit: '64kb' }));
app.use(express.static('public'));

let youtubeClient;

function getCookieString() {
  if (process.env.YOUTUBE_COOKIE) {
    return process.env.YOUTUBE_COOKIE.trim();
  }

  if (fs.existsSync('cookies.txt')) {
    try {
      const content = fs.readFileSync('cookies.txt', 'utf8').trim();
      if (content) return content;
    } catch {
      // Ignore file read error
    }
  }

  if (fs.existsSync('cookies.json')) {
    try {
      const jsonContent = JSON.parse(fs.readFileSync('cookies.json', 'utf8'));
      if (Array.isArray(jsonContent)) {
        return jsonContent
          .filter((c) => c.name && c.value)
          .map((c) => `${c.name}=${c.value}`)
          .join('; ');
      }
    } catch {
      // Ignore JSON parse error
    }
  }

  return undefined;
}

async function getYoutube() {
  if (!youtubeClient) {
    const cookie = getCookieString();
    if (cookie) {
      console.log('Loading authenticated YouTube session from cookie.');
    }
    youtubeClient = await Innertube.create({
      cache: new UniversalCache(false),
      cookie
    });
  }
  return youtubeClient;
}

function textValue(value) {
  if (!value) return '';
  if (typeof value === 'string') return value === '[object Object]' ? '' : value;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  if (typeof value.name === 'string') return value.name;
  if (Array.isArray(value?.runs)) return value.runs.map((r) => r.text || '').join('');
  if (Array.isArray(value?.contents)) return value.contents.map((c) => textValue(c)).filter(Boolean).join(' ');
  if (typeof value.toString === 'function') {
    const str = value.toString();
    if (str && str !== '[object Object]') return str;
  }
  return '';
}

function pickThumbnail(thumbnails = []) {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return '';
  const sorted = [...thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0]?.url || '';
}

function sanitizeFilename(value) {
  return (value || 'download')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140) || 'download';
}

function parseYoutubeInput(input) {
  if (!input || typeof input !== 'string') {
    throw new Error('Please enter a YouTube video or playlist link.');
  }

  const trimmed = input.trim();
  let url;

  try {
    url = new URL(trimmed);
  } catch {
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
      return { type: 'video', videoId: trimmed };
    }
    throw new Error('That does not look like a valid YouTube link.');
  }

  const host = url.hostname.replace(/^www\./, '');
  const list = url.searchParams.get('list');
  const videoId = host === 'youtu.be'
    ? url.pathname.split('/').filter(Boolean)[0]
    : url.searchParams.get('v') || url.pathname.match(/\/shorts\/([^/?]+)/)?.[1] || url.pathname.match(/\/embed\/([^/?]+)/)?.[1];

  if (list && !videoId) return { type: 'playlist', playlistId: list };
  if (list && videoId) return { type: 'video', videoId, playlistId: list };
  if (videoId) return { type: 'video', videoId };

  throw new Error('Could not find a YouTube video or playlist id in that link.');
}

function normalizeFormat(format) {
  const mime = format.mime_type || format.mimeType || '';
  const hasVideo = Boolean(format.has_video ?? format.hasVideo ?? mime.startsWith('video/'));
  const hasAudio = Boolean(format.has_audio ?? format.hasAudio ?? (mime.startsWith('audio/') || mime.includes('audio')));
  const quality = format.quality_label || format.qualityLabel || format.quality || (hasAudio && !hasVideo ? 'Audio' : 'Unknown');
  const bitrate = format.bitrate || format.average_bitrate || format.averageBitrate || 0;
  const container = mime.split(';')[0]?.split('/')[1] || format.container || 'media';

  return {
    itag: format.itag,
    quality,
    type: hasVideo && hasAudio ? 'video+audio' : hasVideo ? 'video' : 'audio',
    mime,
    container,
    bitrate
  };
}

function hasValidStreamUrl(format) {
  return Boolean(format && (format.url || format.signature_cipher || format.cipher || typeof format.decipher === 'function'));
}

function uniqueFormats(formats) {
  const byKey = new Map();

  formats
    .filter(hasValidStreamUrl)
    .map(normalizeFormat)
    .filter((format) => format.itag && format.quality !== 'Unknown')
    .forEach((format) => {
      const key = `${format.type}-${format.quality}-${format.container}`;
      const current = byKey.get(key);
      if (!current || format.bitrate > current.bitrate) byKey.set(key, format);
    });

  return [...byKey.values()].sort((a, b) => {
    const ap = Number.parseInt(a.quality, 10) || 0;
    const bp = Number.parseInt(b.quality, 10) || 0;
    if (a.type === 'audio' && b.type !== 'audio') return 1;
    if (a.type !== 'audio' && b.type === 'audio') return -1;
    return bp - ap;
  });
}

const CLIENT_USER_AGENTS = {
  ANDROID: 'com.google.android.youtube/19.29.37 (Linux; U; Android 14; en_US; Pixel 8 Pro)',
  TV_EMBEDDED: 'Mozilla/5.0 (SmartHub; SMART-TV; U; Linux/SmartTV) AppleWebKit/537.42 (KHTML, like Gecko) SmartTV Safari/537.42',
  YTMUSIC: 'com.google.android.apps.youtube.music/7.02.52 (Linux; U; Android 14; en_US; Pixel 8 Pro)',
  IOS: 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)',
  WEB: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
};

async function getInfoWithFallback(youtube, videoId) {
  const clients = ['ANDROID', 'TV_EMBEDDED', 'YTMUSIC', 'IOS', 'WEB'];
  let lastError;

  for (const client of clients) {
    try {
      const info = await youtube.getInfo(videoId, { client });
      if (info && info.basic_info && (info.streaming_data?.formats?.length || info.streaming_data?.adaptive_formats?.length)) {
        return { info, clientUsed: client };
      }
    } catch (err) {
      lastError = err;
    }
  }

  try {
    const info = await youtube.getInfo(videoId);
    return { info, clientUsed: 'ANDROID' };
  } catch (err) {
    throw lastError || err;
  }
}

async function getVideoPayload(videoId) {
  const youtube = await getYoutube();
  const { info } = await getInfoWithFallback(youtube, videoId);
  const basic = info.basic_info || {};
  const rawFormats = [
    ...(info.streaming_data?.formats || []),
    ...(info.streaming_data?.adaptive_formats || [])
  ];

  return {
    id: videoId,
    title: basic.title || 'Untitled video',
    author: textValue(basic.author) || basic.channel?.name || '',
    duration: basic.duration || 0,
    thumbnail: pickThumbnail(basic.thumbnail || basic.thumbnails),
    url: `https://www.youtube.com/watch?v=${videoId}`,
    formats: uniqueFormats(rawFormats)
  };
}

function extractVideoId(video) {
  if (!video) return '';
  if (typeof video.content_id === 'string' && video.content_id) return video.content_id;
  if (typeof video.id === 'string' && video.id) return video.id;
  if (typeof video.video_id === 'string' && video.video_id) return video.video_id;
  if (typeof video.videoId === 'string' && video.videoId) return video.videoId;
  if (video.endpoint?.payload?.videoId) return video.endpoint.payload.videoId;
  if (video.navigation_endpoint?.payload?.videoId) return video.navigation_endpoint.payload.videoId;
  return '';
}

function extractTitle(video) {
  if (!video) return '';
  const titleObj = video.title || video.metadata?.title || video.headline;
  if (titleObj) {
    const text = textValue(titleObj);
    if (text) return text;
  }
  return '';
}

function extractAuthor(video) {
  if (!video) return '';
  const authorObj = video.author || video.short_byline || video.owner || video.byline;
  if (authorObj) {
    const name = textValue(authorObj?.name || authorObj);
    if (name) return name;
  }
  if (video.metadata?.metadata?.metadata_rows) {
    const rows = video.metadata.metadata.metadata_rows;
    for (const row of rows) {
      const text = textValue(row);
      if (text) return text;
    }
  }
  return '';
}

function extractThumbnail(video, id) {
  let raw = video.thumbnails || video.thumbnail || video.content_image?.image || video.content_image?.thumbnails;
  if (raw && !Array.isArray(raw)) raw = [raw];
  const picked = pickThumbnail(raw || []);
  if (picked) return picked;
  if (id) return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  return '';
}

function normalizePlaylistVideo(video) {
  const id = extractVideoId(video);
  const title = extractTitle(video) || (id ? `Video ${id}` : 'Untitled video');
  const author = extractAuthor(video);
  const duration = typeof video.duration === 'object' ? (video.duration?.text || video.duration?.seconds || '') : textValue(video.duration || video.length_text);
  const thumbnail = extractThumbnail(video, id);

  return {
    id,
    title,
    author,
    duration,
    thumbnail,
    url: id ? `https://www.youtube.com/watch?v=${id}` : ''
  };
}

async function getPlaylistWithFallback(youtube, playlistId) {
  try {
    return await youtube.getPlaylist(playlistId);
  } catch (err) {
    console.warn('getPlaylist standard fetch warning:', err.message);
    return await youtube.getPlaylist(playlistId);
  }
}

async function collectPlaylistVideos(playlist) {
  let feed = playlist;
  const videos = [];

  while (feed && videos.length < playlistLimit) {
    const rawItems = [
      ...(feed.items || []),
      ...(feed.videos || []),
      ...(feed.contents || []),
      ...(feed.memo?.getType?.('PlaylistVideo') || []),
      ...(feed.memo?.getType?.('LockupView') || []),
      ...(feed.memo?.getType?.('Video') || []),
      ...(feed.memo?.getType?.('GridVideo') || []),
      ...(feed.memo?.getType?.('PlaylistPanelVideo') || [])
    ];

    for (const item of rawItems) {
      const video = normalizePlaylistVideo(item);
      if (video.id && !videos.some((existing) => existing.id === video.id)) {
        videos.push(video);
      }
      if (videos.length >= playlistLimit) break;
    }

    if (!feed.has_continuation || typeof feed.getContinuation !== 'function') break;
    try {
      feed = await feed.getContinuation();
    } catch {
      break;
    }
  }

  return videos;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/resolve', async (req, res) => {
  try {
    const parsed = parseYoutubeInput(req.body?.url);
    const youtube = await getYoutube();

    if (parsed.type === 'playlist') {
      const playlist = await getPlaylistWithFallback(youtube, parsed.playlistId);
      const videos = await collectPlaylistVideos(playlist);
      res.json({
        type: 'playlist',
        playlist: {
          id: parsed.playlistId,
          title: textValue(playlist.info?.title) || textValue(playlist.metadata?.title) || 'Playlist',
          videoCount: videos.length,
          limit: playlistLimit,
          videos
        }
      });
      return;
    }

    res.json({
      type: 'video',
      video: await getVideoPayload(parsed.videoId)
    });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to read that YouTube link.' });
  }
});

app.get('/api/video/:id', async (req, res) => {
  try {
    res.json({ video: await getVideoPayload(req.params.id) });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to fetch video details.' });
  }
});

app.get('/api/download/:id', async (req, res) => {
  try {
    const youtube = await getYoutube();
    const videoId = req.params.id;
    const { info, clientUsed } = await getInfoWithFallback(youtube, videoId);
    const basic = info.basic_info || {};
    const rawFormats = [
      ...(info.streaming_data?.formats || []),
      ...(info.streaming_data?.adaptive_formats || [])
    ];
    const formats = uniqueFormats(rawFormats);
    const requestedMode = ['audio', 'video', 'video+audio'].includes(req.query.mode) ? req.query.mode : 'video+audio';
    const itag = Number.parseInt(req.query.itag, 10);
    const selectedFormat = Number.isFinite(itag)
      ? formats.find((format) => Number(format.itag) === itag)
      : null;
    let rawFormat = Number.isFinite(itag)
      ? rawFormats.find((format) => Number(format.itag) === itag)
      : null;

    if (!rawFormat) {
      try {
        rawFormat = info.chooseFormat(
          requestedMode === 'audio'
            ? { type: 'audio', quality: 'best', format: 'mp4', codec: 'mp4a' }
            : { type: requestedMode, quality: req.query.quality || 'best', format: 'any' }
        );
      } catch {
        try {
          rawFormat = info.chooseFormat(
            requestedMode === 'audio'
              ? { type: 'audio', quality: 'best' }
              : { type: requestedMode, quality: 'best' }
          );
        } catch {
          rawFormat = rawFormats[0];
        }
      }
    }

    if (!rawFormat) {
      res.status(404).json({ error: 'Selected quality is not available for this video.' });
      return;
    }

    const outputMode = selectedFormat?.type || requestedMode;
    const container = selectedFormat?.container || rawFormat.mime_type?.split(';')[0]?.split('/')[1] || 'mp4';
    const extension = outputMode === 'audio' && container === 'mp4' ? 'm4a' : container;
    const label = outputMode === 'audio' ? 'audio' : selectedFormat?.quality || rawFormat.quality_label || 'video';
    const contentType = selectedFormat?.mime?.split(';')[0] || rawFormat.mime_type?.split(';')[0] || (outputMode === 'audio' ? 'audio/mp4' : `video/${container}`);
    const filename = `${sanitizeFilename(basic.title || 'video')}-${label}.${extension}`;

    let webStream;
    let streamUrl;

    if (rawFormat.url) {
      streamUrl = rawFormat.url;
    } else if (typeof rawFormat.decipher === 'function') {
      try {
        streamUrl = await rawFormat.decipher(youtube.session.player);
      } catch {
        // Silent fallback
      }
    }

    if (!streamUrl) {
      const fallbackFormat = rawFormats.find((f) => f.url || (typeof f.decipher === 'function'));
      if (fallbackFormat) {
        streamUrl = fallbackFormat.url;
        if (!streamUrl && typeof fallbackFormat.decipher === 'function') {
          try {
            streamUrl = await fallbackFormat.decipher(youtube.session.player);
          } catch {
            // Silent fallback
          }
        }
      }
    }

    if (streamUrl) {
      if (info.cpn && !streamUrl.includes('cpn=')) {
        streamUrl += `&cpn=${info.cpn}`;
      }
      const userAgent = CLIENT_USER_AGENTS[clientUsed] || CLIENT_USER_AGENTS.ANDROID;
      const upstreamHeaders = {
        'User-Agent': userAgent,
        'Accept': '*/*',
        'Accept-Encoding': 'identity'
      };
      if (req.headers.range) upstreamHeaders.Range = req.headers.range;

      try {
        const upstream = await fetch(streamUrl, { headers: upstreamHeaders, redirect: 'follow' });
        if (upstream.ok || upstream.status === 206) {
          webStream = upstream.body;
        }
      } catch {
        // Silent fallback
      }
    }

    if (!webStream) {
      const downloadOpts = {
        itag: Number.isFinite(itag) ? itag : undefined,
        type: requestedMode,
        quality: req.query.quality || 'best',
        format: 'any'
      };

      try {
        webStream = await info.download(downloadOpts);
      } catch {
        try {
          webStream = await info.download({ type: requestedMode, quality: 'best' });
        } catch {
          try {
            webStream = await youtube.download(videoId, downloadOpts);
          } catch {
            for (const fmt of rawFormats) {
              let tryUrl = fmt.url;
              if (!tryUrl && typeof fmt.decipher === 'function') {
                try {
                  tryUrl = await fmt.decipher(youtube.session.player);
                } catch {
                  continue;
                }
              }
              if (tryUrl) {
                if (info.cpn && !tryUrl.includes('cpn=')) tryUrl += `&cpn=${info.cpn}`;
                try {
                  const upstream = await fetch(tryUrl, {
                    headers: { 'User-Agent': CLIENT_USER_AGENTS[clientUsed] || CLIENT_USER_AGENTS.ANDROID, 'Accept': '*/*' },
                    redirect: 'follow'
                  });
                  if (upstream.ok || upstream.status === 206) {
                    webStream = upstream.body;
                    break;
                  }
                } catch {
                  // Ignore failed candidate format fetch
                }
              }
            }
          }
        }
      }
    }

    if (!webStream) {
      res.status(400).json({ error: 'This video stream is restricted. Please try selecting another quality option.' });
      return;
    }

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', contentType);

    const nodeStream = Readable.fromWeb(webStream);
    nodeStream.on('error', (err) => {
      console.error('Stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream interrupted.' });
      } else {
        res.destroy();
      }
    });

    req.on('close', () => {
      nodeStream.destroy();
    });

    nodeStream.pipe(res);
  } catch (error) {
    console.error('Download failed:', error);
    if (!res.headersSent) {
      res.status(400).json({ error: error.message || 'Download failed. Try another quality.' });
    } else {
      res.end();
    }
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`YouTube downloader running on port ${port}`);
});
