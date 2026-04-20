#!/bin/bash

echo "Checking yt-dlp installation..."

# Try to find yt-dlp in PATH
if command -v yt-dlp &> /dev/null; then
    echo "✓ yt-dlp found in PATH"
    exit 0
fi

# Try Python pip install
echo "Installing yt-dlp via pip..."
if command -v python3 &> /dev/null; then
    python3 -m pip install yt-dlp --quiet
elif command -v python &> /dev/null; then
    python -m pip install yt-dlp --quiet
else
    echo "Python not found, attempting binary download..."
    
    # Detect OS
    OS=$(uname -s)
    ARCH=$(uname -m)
    
    if [ "$OS" = "Linux" ] && [ "$ARCH" = "x86_64" ]; then
        echo "Downloading yt-dlp for Linux x86_64..."
        curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp 2>/dev/null || curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ./yt-dlp
        chmod +x /usr/local/bin/yt-dlp 2>/dev/null || chmod +x ./yt-dlp
    fi
fi

# Final check
if command -v yt-dlp &> /dev/null; then
    echo "✓ yt-dlp is ready"
    yt-dlp --version
else
    echo "⚠ Warning: yt-dlp could not be installed automatically"
fi
