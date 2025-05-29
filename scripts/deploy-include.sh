cd "$(dirname "$0")/.."

rsync -av \
  public \
  services \
  uploads \
  config.json \
  package.json \
  README.md \
  server.js \
  scripts \
  admin@192.168.1.72:~/snappic-print-server/