# 🐕 Dog Medication Tracker

A self-hosted PWA + push notification system for tracking daily dog medication, powered by Home Assistant.

Both household members receive persistent push notifications until someone confirms the medication was given. Built to run on Unraid (or any Docker host) alongside Home Assistant.

## Architecture

```
┌─────────────┐     WebSocket      ┌──────────────────┐
│    Home      │◄──────────────────►│   Relay Server   │
│  Assistant   │                    │  (Node.js/Docker) │
└─────────────┘                    └────────┬─────────┘
                                            │
                                   Web Push │ (via FCM)
                                            │
                              ┌─────────────┼─────────────┐
                              ▼                           ▼
                        ┌──────────┐               ┌──────────┐
                        │ Phone 1  │               │ Phone 2  │
                        │  (PWA)   │               │  (PWA)   │
                        └──────────┘               └──────────┘
```

## Components

- **`/relay`** — Node.js service that bridges HA → Web Push notifications
- **`/pwa`** — Progressive Web App dashboard (React/Vite)
- **`/ha-config`** — Home Assistant YAML configuration

## Quick Start

### 1. Generate VAPID Keys

```bash
cd relay
npm install
npx web-push generate-vapid-keys
```

Copy the keys into `relay/.env`.

### 2. Configure Environment

```bash
cp relay/.env.example relay/.env
# Edit with your HA URL, token, and VAPID keys
```

### 3. Home Assistant Setup

Add the contents of `ha-config/configuration.yaml` to your HA config.
Replace `PHONE_1_NAME` and `PHONE_2_NAME` with your actual device names.
Restart HA.

### 4. Deploy with Docker Compose

```bash
docker-compose up -d
```

This starts both the relay server and serves the PWA.

### 5. Install the PWA

1. Open `http://your-unraid-ip:3000` on both phones
2. Tap "Enable Notifications" and allow when prompted
3. Tap the browser menu → "Add to Home Screen"

## Unraid Setup

### Option A: Docker Compose (recommended)
Install the Docker Compose plugin from Community Apps, then point it at the `docker-compose.yml`.

### Option B: Manual Docker
1. Build: `docker build -t dog-med-tracker .`
2. Add container in Unraid Docker tab pointing to `dog-med-tracker:latest`
3. Map port 3000
4. Add environment variables from `.env.example`

## Environment Variables

| Variable | Description |
|----------|-------------|
| `HA_URL` | Home Assistant URL (e.g. `http://192.168.1.50:8123`) |
| `HA_TOKEN` | Long-lived access token from HA |
| `VAPID_PUBLIC_KEY` | Generated VAPID public key |
| `VAPID_PRIVATE_KEY` | Generated VAPID private key |
| `VAPID_EMAIL` | Your email (for VAPID, can be anything) |
| `PORT` | Server port (default: 3000) |
| `REMINDER_TIMES` | Comma-separated reminder times (default: `08:00,12:00,17:00`) |
| `ESCALATION_TIME` | Evening escalation time (default: `20:00`) |

## License

MIT
