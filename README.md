# YouTube Downloader

Render-ready Node app for fetching a YouTube video or playlist link, showing available video qualities, and downloading video or audio.

## Local Run

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Render Deploy

Push this folder to a Git repository and create a Render web service. Render can use the included `render.yaml`, or use:

- Build command: `npm install`
- Start command: `npm start`
- Node version: `20`

Set `PLAYLIST_LIMIT` if you want to load more or fewer playlist videos.
