# Running it on a server

Your PC sleeps, reboots and loses its connection, and every gap is lost evidence (it slept for about
2.5 hours on day one). A small always-on Linux server fixes that and lets your PC rest.

## Fast path (what we actually do)
1. Create a Hetzner Cloud server (Ubuntu 24.04, 4 vCPU / 8 GB) and paste `deploy/cloud-init.yaml` into its Cloud config box. It sets up a key-only user, Docker and the firewall.
2. Stop everything on your PC.
3. Run `.\deploy\deploy.ps1 -Server trader@SERVER_IP -IncludeState` from the project folder (PowerShell).

The manual steps below are the same thing done by hand.

## What you need
- A VPS: Ubuntu 24.04, **4 vCPU and 8 GB RAM** for all three ecosystems (2 vCPU / 4 GB is enough for one or
  two). Research is CPU-heavy. Typical cost is roughly 10 to 20 EUR a month, but check the provider's price.
  Pick an EU location (Hetzner, OVH and DigitalOcean all work).
- Your SSH key on it.
- Your `.env` file (it holds the API keys).

## Set up (about 20 minutes)
On the server, as a normal user (not root):

```bash
# 1. Basic safety: only SSH is reachable from outside.
sudo ufw default deny incoming && sudo ufw allow OpenSSH && sudo ufw enable
sudo apt-get update && sudo apt-get install -y unattended-upgrades

# 2. Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # log out and back in afterwards

# 3. The code (private repo: use a deploy key or a token)
git clone <your repo url> ai-trader && cd ai-trader
```

From your PC, copy the secrets file (never commit it):

```bash
scp .env user@SERVER:ai-trader/.env
ssh user@SERVER 'chmod 600 ai-trader/.env'
```

Then on the server:

```bash
cd ai-trader
docker compose up -d --build      # starts main, niche and hi
docker compose ps                 # all three should be "Up"
docker compose logs -f main       # watch it (Ctrl+C to stop watching)
```

## Look at the village
The ports are only open on the server itself, so tunnel from your PC:

```bash
ssh -L 8787:127.0.0.1:8787 -L 8788:127.0.0.1:8788 -L 8789:127.0.0.1:8789 user@SERVER
```

Leave that running and open http://localhost:8787 (Alpaca fund), :8788 (OKX niche), :8789 (high activity).
**Do not publish these ports to the internet**: there is no login and the page can pull the kill switch.

## Reports
```bash
docker compose exec main npm run report
docker compose exec main npm run daily
docker compose exec hi sh -c 'DATA_DIR=./data-hi npm run daily'
```

## Moving over from your PC
1. **Stop the PC's copies first.** Two processes trading the same Alpaca account will fight each other
   and corrupt the books. Close them all (or reboot the PC) before starting the server.
2. To keep the current seasons, copy the folders: `scp -r data data-niche data-hi user@SERVER:ai-trader/`
   (before the first `docker compose up`). Otherwise the server starts fresh seasons.

## Updating
```bash
cd ai-trader && git pull && docker compose up -d --build
```
State lives in the data folders on the server, so a rebuild keeps it. Back them up now and then:
`tar czf backup-$(date +%F).tgz data data-niche data-hi`.

## Real money (later, only after `npm run approve-live`)
Uncomment the `live` service in `docker-compose.yml`. It needs `LIVE_APPROVAL.json` (which only
`npm run approve-live` creates, and only when the paper evidence says PASSING), keeps its own `data-live`
folder, reads the paper evidence read-only, and unplugs itself if the evidence turns, the loss limit is hit,
the approval expires, or the books stop matching the account.

## Costs and limits to know
- The LLM calls (the strategist, the news desk) cost money per call; the daily budget in `.env` caps it.
- A server does not make the strategies better. It only keeps them running and the evidence clock honest.
