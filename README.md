# YouTube Video Download Manager

A simple Node.js + Express app that lets you fetch YouTube video metadata and download video or MP3 audio directly from your browser.

## Features

- Fetch YouTube video title, thumbnail, duration, and available video resolutions
- Download video in selected resolution as MP4
- Download audio as MP3
- Uses `yt-dlp` for metadata extraction and streaming downloads
- Lightweight client UI in `public/`

## Technology Stack

- Node.js
- Express
- `yt-dlp`
- `@distube/ytdl-core`, `ytdl-core`, `play-dl`, `youtube-dl-exec`
- Vanilla HTML/CSS/JavaScript frontend

## Prerequisites

- Node.js installed (v16+ recommended)
- `yt-dlp` installed and available on the system PATH

## Installation

1. Clone or copy the repository
2. Open the project folder in a terminal
3. Install dependencies:

```bash
npm install
```

4. Make sure `yt-dlp` is installed and accessible:

```bash
yt-dlp --version
```

If the command is not found, install `yt-dlp` from https://github.com/yt-dlp/yt-dlp

## Running the App

Start the server:

```bash
npm start
```

Then open your browser at:

```
http://localhost:3000
```

## Usage

1. Paste a YouTube URL into the input box
2. Click `Fetch`
3. Choose a resolution button to download video
4. Click `Download MP3` to download audio only

## Project Structure

- `server.js` — Express server and download endpoints
- `package.json` — project metadata and dependencies
- `public/index.html` — frontend user interface
- `public/script.js` — fetches video info and triggers downloads
- `public/style.css` — UI styling

## Notes

- The app caches video metadata in memory for 5 minutes to speed up repeated requests
- Downloads are streamed through `yt-dlp` and sent directly to the browser
- The server validates YouTube and `youtu.be` URLs before processing

## License

This project is licensed under ISC.
