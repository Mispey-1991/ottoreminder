# CLAUDE.md — Dog Medication Tracker

## What This Is
A self-hosted system for tracking daily dog medication between two household members. Push notifications persist until someone confirms the medication was given.

## Architecture
- **`/relay`** — Node.js Express server that:
  - Connects to Home Assistant via WebSocket API
  - Listens for `input_boolean.dog_medication_given` state changes
  - Sends Web Push notifications via VAPID/FCM
  - Runs scheduled reminders via node-cron
  - Serves the PWA static files
  - Provides REST API endpoints (`/api/status`, `/api/confirm`, `/api/push/subscribe`, etc.)
  - Stores push subscriptions and history as JSON files in `/data`

- **`/pwa`** — React (Vite) Progressive Web App that:
  - Registers a service worker for push notifications and offline caching
  - Subscribes to Web Push via the relay server's VAPID key
  - Polls `/api/status` every 10 seconds for live state
  - Can confirm medication directly via `/api/confirm`
  - Shows history and streak tracking

- **`/ha-config`** — Home Assistant YAML configuration:
  - `input_boolean`, `input_text`, `input_datetime` helpers
  - Automations for daily reset, reminders, confirmation handling, snooze, escalation

## Running Locally
```bash
cd relay && npm install && cp .env.example .env  # fill in .env
cd ../pwa && npm install && npm run build
cd ../relay && node server.js
```

## Docker
```bash
docker-compose up -d
```

## Key Files
- `relay/server.js` — main server logic
- `pwa/src/App.jsx` — main UI component
- `pwa/public/sw.js` — service worker (push + cache)
- `ha-config/configuration.yaml` — HA helpers + automations

## Environment Variables
See `relay/.env.example` for all required vars (HA_URL, HA_TOKEN, VAPID keys).

## Notes
- The relay server must be accessible from both phones (Unraid local network)
- VAPID keys are generated once: `cd relay && npx web-push generate-vapid-keys`
- PWA icons (icon-192.png, icon-512.png) need to be generated from paw-icon.svg
- The HA config requires replacing PHONE_1_NAME and PHONE_2_NAME with actual device names
