const form = document.querySelector('#lookup-form');
const input = document.querySelector('#url-input');
const statusEl = document.querySelector('#status');
const results = document.querySelector('#results');
const modeBtns = document.querySelectorAll('.mode-btn');

let currentMode = 'video';

modeBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    modeBtns.forEach((b) => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    currentMode = btn.dataset.mode;

    if (currentMode === 'playlist') {
      input.placeholder = 'Paste YouTube playlist link (e.g. https://www.youtube.com/playlist?list=...)';
    } else {
      input.placeholder = 'Paste YouTube video link (e.g. https://www.youtube.com/watch?v=...)';
    }
  });
});

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function formatDuration(duration) {
  if (!duration) return '';
  if (typeof duration === 'string') return duration;
  const seconds = Number(duration);
  if (!Number.isFinite(seconds)) return '';
  const mins = Math.floor(seconds / 60);
  const secs = String(Math.floor(seconds % 60)).padStart(2, '0');
  return `${mins}:${secs}`;
}

function formatOption(format) {
  return format.quality;
}

function qualityRank(format) {
  return Number.parseInt(format.quality, 10) || 0;
}

function uniqueVideoQualities(formats) {
  const byQuality = new Map();

  formats
    .filter((format) => format.type === 'video' || format.type === 'video+audio')
    .forEach((format) => {
      const current = byQuality.get(format.quality);
      const currentScore = current ? qualityRank(current) + (current.type === 'video+audio' ? 0.5 : 0) : -1;
      const nextScore = qualityRank(format) + (format.type === 'video+audio' ? 0.5 : 0);
      if (!current || nextScore > currentScore) byQuality.set(format.quality, format);
    });

  return [...byQuality.values()].sort((a, b) => qualityRank(b) - qualityRank(a));
}

function downloadUrl(videoId, mode, itag, quality) {
  const params = new URLSearchParams({ mode });
  if (itag) params.set('itag', itag);
  if (quality) params.set('quality', quality);
  return `/api/download/${encodeURIComponent(videoId)}?${params}`;
}

const DEFAULT_QUALITIES = [
  { label: '1080p', quality: '1080p' },
  { label: '720p', quality: '720p' },
  { label: '480p', quality: '480p' },
  { label: '360p', quality: '360p' },
  { label: 'Best available', quality: 'best' }
];

function videoCard(video, isPlaylist = false) {
  const formats = video.formats || [];
  const videoFormats = uniqueVideoQualities(formats);

  let qualityOptions = '';
  let initialQuality = 'best';
  let initialItag = '';

  if (videoFormats.length > 0) {
    qualityOptions = videoFormats.map((format) => (
      `<option value="${format.itag}" data-type="${escapeHtml(format.type)}" data-quality="${escapeHtml(format.quality)}">${escapeHtml(formatOption(format))}</option>`
    )).join('');
    initialQuality = videoFormats[0].quality;
    initialItag = videoFormats[0].itag;
  } else {
    qualityOptions = DEFAULT_QUALITIES.map((q) => (
      `<option value="" data-type="video+audio" data-quality="${q.quality}">${q.label}</option>`
    )).join('');
    initialQuality = DEFAULT_QUALITIES[0].quality;
  }

  const initialDownloadLink = downloadUrl(video.id, 'video+audio', initialItag, initialQuality);

  return `
    <article class="video-card" data-video-id="${escapeHtml(video.id)}">
      <img class="thumb" src="${escapeHtml(video.thumbnail)}" alt="">
      <div>
        <h2 class="video-title">${escapeHtml(video.title)}</h2>
        <p class="meta">${escapeHtml([video.author, formatDuration(video.duration)].filter(Boolean).join(' - '))}</p>
        <div class="actions">
          <select class="quality-select" aria-label="Video quality">
            ${qualityOptions}
          </select>
          <a class="download-link video-download" href="${initialDownloadLink}">Video</a>
          ${isPlaylist ? '' : `<a class="download-link secondary" href="${downloadUrl(video.id, 'audio', '', '')}">Audio</a>`}
        </div>
      </div>
    </article>
  `;
}

function renderVideo(video) {
  results.innerHTML = videoCard(video, false);
}

function renderPlaylist(playlist) {
  const rows = playlist.videos.map((video) => videoCard(video, true)).join('');
  results.innerHTML = `
    <div class="playlist-header">
      <div>
        <h2 class="video-title">${escapeHtml(playlist.title)}</h2>
        <p class="meta">${playlist.videoCount} video${playlist.videoCount === 1 ? '' : 's'} loaded</p>
      </div>
    </div>
    ${rows || '<div class="empty">No public videos found in this playlist.</div>'}
  `;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  results.innerHTML = '';
  setStatus('Fetching...');

  try {
    const data = await fetchJson('/api/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: input.value })
    });

    if (data.type === 'playlist') {
      renderPlaylist(data.playlist);
      setStatus('Playlist ready.');
    } else {
      renderVideo(data.video);
      setStatus('Video ready.');
    }
  } catch (error) {
    setStatus(error.message, true);
  }
});

results.addEventListener('change', (event) => {
  if (!event.target.matches('.quality-select')) return;
  const card = event.target.closest('[data-video-id]');
  const selected = event.target.selectedOptions[0];
  const link = card.querySelector('.video-download');
  const quality = selected.dataset.quality || selected.value || selected.text || 'best';
  const type = selected.dataset.type || 'video+audio';
  link.href = downloadUrl(card.dataset.videoId, type, selected.value, quality);
});

results.addEventListener('click', async (event) => {
  if (!event.target.matches('.load-video')) return;
  const card = event.target.closest('[data-video-id]');
  const videoId = card.dataset.videoId;
  event.target.disabled = true;
  event.target.textContent = 'Loading...';

  try {
    const data = await fetchJson(`/api/video/${encodeURIComponent(videoId)}`);
    card.outerHTML = videoCard(data.video);
  } catch (error) {
    setStatus(error.message, true);
    event.target.disabled = false;
    event.target.textContent = 'Load qualities';
  }
});