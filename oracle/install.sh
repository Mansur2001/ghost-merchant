#!/usr/bin/env bash
# One-command Oracle install for Termux.
#
#   curl -fsSL http://<laptop-lan-ip>:8000/install.sh | bash
#
# Downloads into Termux's OWN home directory. The usual way this goes wrong is downloading
# through the phone's browser instead: the files land in /sdcard/Download, which Termux cannot
# even see until `termux-setup-storage` is granted — so `chmod` reports "no such file or
# directory" about a file you can see in your Downloads folder.

set -e

# The URL this script was fetched from, so we pull the siblings from the same place.
BASE="${ORACLE_BASE:-}"
if [ -z "$BASE" ]; then
  echo "Set ORACLE_BASE, e.g.  ORACLE_BASE=http://172.20.2.34:8000 bash install.sh"
  exit 1
fi

cd "$HOME"
echo "Installing into: $(pwd)"
echo

echo "1/3  Packages…"
pkg install -y nodejs termux-api curl >/dev/null 2>&1 || {
  echo "  pkg install failed — run it yourself to see why:"
  echo "     pkg install nodejs termux-api curl"
  exit 1
}
echo "     node $(node --version 2>/dev/null || echo '(missing)')"

echo "2/3  Downloading…"
for f in termux-oracle.js start-oracle.sh; do
  # -f makes curl fail on a 404 instead of cheerfully writing the error page to disk, which
  # is how you end up with a "script" full of HTML that node refuses to run.
  if curl -fsS "$BASE/$f" -o "$f"; then
    echo "     $f  ($(wc -c < "$f") bytes)"
  else
    echo "     FAILED to fetch $BASE/$f"
    echo "     Is the phone on the same WiFi, and is the laptop still serving?"
    exit 1
  fi
done

# Guard against a truncated or wrong-content download before it becomes a confusing runtime
# error twenty seconds later.
head -1 termux-oracle.js | grep -q '^#!/usr/bin/env node' || {
  echo "     termux-oracle.js does not look like the script (got an error page?)."
  exit 1
}

chmod +x start-oracle.sh
echo "3/3  Ready."
echo
echo "Edit the settings, then start it:"
echo "   nano start-oracle.sh     # check the secret and BACKEND_URL"
echo "   ./start-oracle.sh"
