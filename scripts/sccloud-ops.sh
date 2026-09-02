#!/bin/sh
# scCloud 运维薄封装（少碰 raw compose）
# 用法: sh ./scripts/sccloud-ops.sh {status|logs|stop|restart|pull|ps|promote-admin}

set -u

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

if [ ! -f .env ]; then
  echo "缺少 .env，请先 sh ./start.sh 或 sh ./scripts/setup-wizard.sh" >&2
  exit 1
fi

SUDO=""
if [ "$(id -u)" != "0" ] && ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    SUDO="sudo"
  fi
fi

DC="${SUDO} docker compose --env-file .env"
cmd="${1:-status}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "$cmd" in
  status|ps)
    $DC ps "$@"
    ;;
  logs)
    $DC logs --tail "${TAIL:-200}" -f "$@"
    ;;
  stop|down)
    $DC stop "$@"
    ;;
  restart)
    $DC restart "$@"
    ;;
  pull)
    $DC pull "$@"
    ;;
  up)
    $DC up -d "$@"
    ;;
  promote-admin)
    user="${1:-}"
    if [ -z "$user" ]; then
      echo "用法: sh ./scripts/sccloud-ops.sh promote-admin <username>" >&2
      exit 1
    fi
    # shellcheck disable=SC1091
    . ./.env
    $DC exec -T db mariadb -u"${DB_USER:-sccloud_app}" -p"${DB_PASS}" "${DB_NAME:-sccloud_v2}" \
      -e "UPDATE users SET role='admin', max_projects=100, total_quota=1000 WHERE username='${user}';"
    echo "已尝试将 ${user} 提升为 admin（请核对上方 SQL 结果）"
    ;;
  *)
    cat <<EOF
用法: sh ./scripts/sccloud-ops.sh <command>
  status | ps
  logs [service]          # TAIL=200 可改
  stop | restart | up | pull
  promote-admin <user>
EOF
    exit 1
    ;;
esac
