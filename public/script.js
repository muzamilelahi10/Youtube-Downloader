// ── DOM refs ──────────────────────────────────────────────────────────────────
const urlInput  = document.getElementById('url');
const result    = document.getElementById('result');
const btn       = document.getElementById('fetchBtn');
const toast     = document.getElementById('toast');
const toastMsg  = document.getElementById('toast-msg');

// ── Toast helper ──────────────────────────────────────────────────────────────
let toastTimer;
function showToast(icon, msg, durationMs = 3500) {
  toast.querySelector('.toast-icon').textContent = icon;
  toastMsg.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), durationMs);
}

// ── Utility ───────────────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
}

// ── Fetch video info ──────────────────────────────────────────────────────────
async function fetchInfo() {
  const url = urlInput.value.trim();
  if (!url) { showToast('⚠️', 'Please paste a YouTube URL first'); return; }

  btn.disabled = true;
  btn.textContent = 'Fetching…';

  result.innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <p>Fetching video info…</p>
    </div>
  `;

  const t0 = Date.now();

  try {
    const res  = await fetch('/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();

    if (data.error) {
      result.innerHTML = `<p class="error-msg">⚠️ ${data.error}</p>`;
      return;
    }

    const elapsed    = ((Date.now() - t0) / 1000).toFixed(1);
    const fromCache  = elapsed < 0.5; // sub-500 ms reply = definitely cached
    const cacheBadge = fromCache
      ? `<span class="cache-badge">⚡ Cached</span>`
      : '';

    // Build resolution buttons
    const resolutionBtns = data.formats.map(f => {
      const size     = f.filesize ? `<span class="size-tag">${formatBytes(f.filesize)}</span>` : '';
      const codecTag = f.vcodec  ? f.vcodec.split('.')[0] : '';
      return `
        <button class="res-btn" data-format-id="${f.formatId}" title="${f.vcodec}" id="res-${f.formatId}">
          <span class="res-label">${f.label}</span>
          <span class="res-meta">
            <span class="codec-tag">${codecTag}</span>
            ${size}
          </span>
        </button>
      `;
    }).join('');

    result.innerHTML = `
      <div class="video-card">
        <div class="thumb-wrap">
          <img src="${data.thumbnail}" alt="thumbnail" loading="lazy" />
          ${data.duration ? `<span class="duration-badge">${data.duration}</span>` : ''}
        </div>
        <div class="video-info">
          <div class="video-title">${data.title}${cacheBadge}</div>
          ${data.channel ? `<div class="video-channel">${data.channel}</div>` : ''}
        </div>

        <div class="download-section">
          <div class="section-header">
            <span class="section-icon-wrap audio">🎵</span>
            <span class="section-label">Audio</span>
          </div>
          <button class="audio-download-btn" id="audioBtn">
            <span>⬇ Download MP3</span>
          </button>
        </div>

        <div class="download-section">
          <div class="section-header">
            <span class="section-icon-wrap video">🎬</span>
            <span class="section-label">Video — Select Resolution</span>
          </div>
          <div class="res-grid">
            ${resolutionBtns}
          </div>
        </div>
      </div>
    `;

    if (fromCache) {
      showToast('⚡', 'Loaded instantly from cache!', 2500);
    }

    // ── Audio download handler ──────────────────────────────────────────────
    document.getElementById('audioBtn').onclick = function () {
      this.classList.add('downloading');
      this.querySelector('span').textContent = '⏳ Preparing…';
      showToast('🎵', 'Audio download starting…', 4000);
      window.open(`/download-audio?url=${encodeURIComponent(url)}`, '_blank');
      // Re-enable after a moment
      setTimeout(() => {
        this.classList.remove('downloading');
        this.querySelector('span').textContent = '⬇ Download MP3';
      }, 3000);
    };

    // ── Video resolution download handlers ─────────────────────────────────
    document.querySelectorAll('.res-btn').forEach(b => {
      b.onclick = function () {
        const label = this.querySelector('.res-label').textContent;
        const fmtId = this.dataset.formatId;
        // Brief visual feedback
        this.classList.add('downloading');
        showToast('🎬', `Starting ${label} download…`, 4000);
        window.open(`/download?url=${encodeURIComponent(url)}&formatId=${encodeURIComponent(fmtId)}`, '_blank');
        setTimeout(() => this.classList.remove('downloading'), 3000);
      };
    });

  } catch (err) {
    result.innerHTML = `<p class="error-msg">⚠️ Error loading video. Check the URL and try again.</p>`;
    console.error(err);
  } finally {
    btn.disabled   = false;
    btn.textContent = 'Fetch';
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────
btn.onclick = fetchInfo;

// Press Enter to fetch
urlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') fetchInfo();
});

// Auto-paste from clipboard on focus if empty
urlInput.addEventListener('focus', async () => {
  if (urlInput.value.trim()) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text.includes('youtube.com') || text.includes('youtu.be')) {
      urlInput.value = text.trim();
      showToast('📋', 'YouTube link pasted from clipboard', 2000);
    }
  } catch {} // clipboard permission denied — silently ignore
});