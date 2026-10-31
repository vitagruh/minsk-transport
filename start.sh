#!/bin/sh
# Запуск приложения на Linux и macOS.
# Использование: ./start.sh        — только этот компьютер
#                ./start.sh lan    — доступ из локальной сети
set -eu

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден."
  echo "Установите Node.js 20 или новее: https://nodejs.org/"
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
case "$NODE_MAJOR" in
  ''|*[!0-9]*) NODE_MAJOR=0 ;;
esac
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Нужен Node.js 20 или новее. Установленная версия:"
  node -v
  exit 1
fi

PORT="${PORT:-3000}"
export PORT

if [ "${1:-}" = "lan" ]; then
  HOST=0.0.0.0
  export HOST
  echo "Режим локальной сети. Адреса этого компьютера:"
  node -e '
    const os = require("node:os");
    const port = process.env.PORT;
    const addresses = Object.values(os.networkInterfaces())
      .flat()
      .filter((item) => item && (item.family === "IPv4" || item.family === 4) && !item.internal)
      .map((item) => item.address);
    if (addresses.length) {
      for (const address of addresses) console.log(`  http://${address}:${port}`);
    } else {
      console.log("  сетевые адреса не найдены — проверьте подключение к сети");
    }
  '
  echo "Разрешите входящие соединения на порт $PORT в брандмауэре."
  echo ""
else
  HOST="${HOST:-127.0.0.1}"
  export HOST
  echo "Локальный адрес: http://127.0.0.1:$PORT"
fi

echo "Остановка: Ctrl+C"
echo ""

exec node server.js
