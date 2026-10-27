#!/usr/bin/env bash
# Installs the server's housekeeping: nightly backup, a watchdog that restarts a fund that stops answering,
# a weekly build-cache clean, and automatic security reboots at a quiet hour.
# Run on the server as the app user:  bash ~/ai-trader/deploy/maintenance.sh
set -euo pipefail
APP="$HOME/ai-trader"
mkdir -p "$HOME/backups"

# --- nightly backup of every fund's state (05:00 UTC), keeping 14 days
cat > "$HOME/backup-ai-trader.sh" <<EOF
#!/usr/bin/env bash
cd "$APP"
tar czf "$HOME/backups/ai-trader-\$(date +%F).tgz" data data-hi data-niche data-small 2>/dev/null || true
find "$HOME/backups" -name 'ai-trader-*.tgz' -mtime +14 -delete
EOF

# --- watchdog (every 5 minutes): a fund that fails its health check 3 times in a row is restarted
cat > "$HOME/watchdog-ai-trader.sh" <<EOF
#!/usr/bin/env bash
cd "$APP"
for pair in main:8787 niche:8788 hi:8789 small:8790; do
  svc=\${pair%%:*}; port=\${pair##*:}
  f="/tmp/ai-trader-fail-\$svc"
  if curl -s -m 8 "http://127.0.0.1:\$port/api/health" | grep -q '"ok":true'; then
    rm -f "\$f"
  else
    n=\$(( \$(cat "\$f" 2>/dev/null || echo 0) + 1 )); echo "\$n" > "\$f"
    if [ "\$n" -ge 3 ]; then
      echo "\$(date -u +%FT%TZ) restarting \$svc after \$n failed health checks" >> "$HOME/watchdog.log"
      docker compose restart "\$svc" >/dev/null 2>&1; rm -f "\$f"
    fi
  fi
done
EOF
chmod +x "$HOME/backup-ai-trader.sh" "$HOME/watchdog-ai-trader.sh"

# --- cron: add our lines once
# An empty crontab, or one with no matching lines, must not abort the script, hence the "|| true".
( { crontab -l 2>/dev/null || true; } | { grep -v 'ai-trader' || true; } ; \
  echo "0 5 * * * $HOME/backup-ai-trader.sh  # ai-trader"; \
  echo "*/5 * * * * $HOME/watchdog-ai-trader.sh  # ai-trader"; \
  echo "0 6 * * 0 docker builder prune -f >/dev/null 2>&1  # ai-trader" ) | crontab -

# --- security updates may need a reboot; do it at 04:30 UTC, when US stocks are flat (containers restart themselves)
sudo tee /etc/apt/apt.conf.d/52ai-trader-reboot >/dev/null <<'CONF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
CONF

echo "installed:"; crontab -l | grep ai-trader; ls -la "$HOME"/*ai-trader*.sh | awk '{print $9}'
