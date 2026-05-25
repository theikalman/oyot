#!/bin/bash
set -e
cd "$(dirname "$0")"

SIGNALING_PORT=${SIGNALING_PORT:-3001}

echo "Starting Oyot Signaling Server on ws://0.0.0.0:$SIGNALING_PORT"
cd signaling-server
npm install
npm run dev -- --port "$SIGNALING_PORT"