# Boo Consumet API

Lightweight Consumet-compatible API for Boo anime streaming.

## Deploy on Render.com (Free)

1. Create a [Render](https://render.com) account
2. Click **New → Web Service**
3. Connect this repository (push to GitHub first)
4. Settings will auto-detect from `render.yaml`
5. Build Command: `npm install`
6. Start Command: `npm start`
7. Deploy! 🚀

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /anime/gogoanime/:query` | Search anime |
| `GET /anime/gogoanime/info/:id` | Get anime info + episodes |
| `GET /anime/gogoanime/watch/:episodeId` | Get HLS streaming URLs |
| `GET /health` | Health check |

## Keep Alive (prevent Render sleep)

Render free tier sleeps after 15min of inactivity. Add a cron job or use [UptimeRobot](https://uptimerobot.com) to ping `/health` every 10 minutes.

In your Boo app, a keep-alive ping is built into the API routes.

## Configuration

Set these environment variables on Render:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3001 | Server port |

## After Deployment

Copy your Render URL (e.g., `https://boo-consumet.onrender.com`) and set it in your Boo `.env`:

```
CONSUMET_REMOTE_URL=https://boo-consumet.onrender.com
```
