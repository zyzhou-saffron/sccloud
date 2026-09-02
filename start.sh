#!/bin/sh
# scCloud 一键启动（对齐闲鱼助手模式）
# 用法：
#   sh ./start.sh              # 优先 pull GHCR，失败再本地 build
#   sh ./start.sh --build      # 强制本地源码构建
#   sh ./start.sh --no-pull    # 跳过 pull，用本地已有镜像
#   sh ./start.sh --install-docker  # 缺 Docker 时才跑 get.docker.com（共享机勿默认）
#
# 注意：不使用 set -e（步骤失败有兜底）；使用 set -u。

set -u

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$PROJECT_DIR"

DO_BUILD=0
DO_PULL=1
INSTALL_DOCKER=0
for arg in "$@"; do
  case "$arg" in
    --build)   DO_BUILD=1; DO_PULL=0 ;;
    --no-pull) DO_PULL=0 ;;
    --install-docker) INSTALL_DOCKER=1 ;;
    -h|--help)
      cat <<'EOF'
用法: sh ./start.sh [--build|--no-pull|--install-docker]
  --build            强制 docker compose build
  --no-pull          不 pull，直接用本地镜像
  --install-docker   未检测到 Docker 时自动 get.docker.com（默认只提示）
EOF
      exit 0
      ;;
    *) echo "未知参数：$arg（支持：--build / --no-pull / --install-docker）" >&2; exit 1 ;;
  esac
done

color() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
info()  { printf '%s %s\n' "$(color '1;36' '•')" "$*"; }
ok()    { printf '%s %s\n' "$(color '1;32' '✓')" "$*"; }
warn()  { printf '%s %s\n' "$(color '1;33' '!')" "$*" >&2; }
die()   { printf '%s %s\n' "$(color '1;31' '✗')" "$*" >&2; exit 1; }

now_s() { date +%s; }
elapsed_str() { printf '%ds' $(($2 - $1)); }

SUDO=""

ensure_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return 0
  fi

  if [ "$INSTALL_DOCKER" != "1" ]; then
    die "未检测到 Docker Compose v2。请先安装 Docker，或加 --install-docker 自动安装：https://docs.docker.com/get-docker/"
  fi

  os_id="unknown"
  if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    os_id="${ID:-unknown}"
  fi

  if [ "$(id -u)" != "0" ]; then
    if command -v sudo >/dev/null 2>&1; then
      SUDO=sudo
    else
      die "Docker 未安装且无 root/sudo。请管理员安装 Docker。"
    fi
  else
    SUDO=""
  fi

  warn "未检测到 Docker，尝试自动安装（发行版：$os_id）..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh || die "下载 get.docker.com 失败"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO /tmp/get-docker.sh https://get.docker.com || die "下载 get.docker.com 失败"
  else
    die "需要 curl 或 wget 才能自动安装 Docker"
  fi

  sh /tmp/get-docker.sh || die "Docker 安装失败"
  rm -f /tmp/get-docker.sh

  if command -v systemctl >/dev/null 2>&1; then
    $SUDO systemctl enable docker 2>/dev/null || true
    $SUDO systemctl start docker 2>/dev/null || true
  fi

  if [ "$(id -u)" != "0" ]; then
    $SUDO usermod -aG docker "$(whoami)" 2>/dev/null || true
    info "已加入 docker 组，重新登录后可不加 sudo"
  fi

  i=0
  while [ "$i" -lt 30 ]; do
    if $SUDO docker info >/dev/null 2>&1; then
      ok "Docker 安装完成"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  die "Docker 已装但 daemon 未就绪"
}

check_port_available() {
  port=$1
  if command -v ss >/dev/null 2>&1; then
    ss -tln 2>/dev/null | grep -qE "[,:.]${port}[[:space:]]" && return 1
    return 0
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -tln 2>/dev/null | grep -qE "[.:]${port}[[:space:]]" && return 1
    return 0
  fi
  # macOS 兜底
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 1
  fi
  return 0
}

find_available_port() {
  base_port=$1
  p=$base_port
  end=$((base_port + 9))
  while [ "$p" -le "$end" ]; do
    if check_port_available "$p"; then
      echo "$p"
      return 0
    fi
    p=$((p + 1))
  done
  echo ""
  return 1
}

update_env_web_port() {
  new_port=$1
  if [ -f .env ]; then
    if grep -q '^WEB_PORT=' .env 2>/dev/null; then
      sed "s/^WEB_PORT=.*/WEB_PORT=$new_port/" .env > .env.tmp && mv .env.tmp .env
    else
      printf 'WEB_PORT=%s\n' "$new_port" >> .env
    fi
  fi
}

check_disk_space() {
  avail_kb=0
  if command -v df >/dev/null 2>&1; then
    avail_kb=$(df -Pk . 2>/dev/null | awk 'NR==2{print $4}') || avail_kb=0
  fi
  avail_gb=$((avail_kb / 1024 / 1024))
  if [ "$avail_kb" -gt 0 ]; then
    if [ "$avail_gb" -lt 10 ]; then
      warn "磁盘可用约 ${avail_gb}GB（建议 ≥10GB；R 镜像较大）"
    else
      ok "磁盘可用空间：${avail_gb}GB"
    fi
  fi
}

# GHCR /v2/ 401/403 也算可达
check_registry_reachable() {
  url="${1:-https://ghcr.io/v2/}"
  code=""
  if command -v curl >/dev/null 2>&1; then
    code=$(curl -sS --max-time 5 -o /dev/null -w "%{http_code}" "$url" 2>/dev/null) || code="000"
  elif command -v wget >/dev/null 2>&1; then
    code=$(wget --timeout=5 --server-response -qO /dev/null "$url" 2>&1 \
      | grep -oE 'HTTP/[0-9.]+ [0-9]+' | tail -1 | grep -oE '[0-9]+$') || code="000"
  fi
  case "$code" in
    200|401|403) return 0 ;;
    *) return 1 ;;
  esac
}

image_exists_locally() {
  ref=$1
  docker image inspect "$ref" >/dev/null 2>&1
}

ensure_r_engine_image() {
  # shellcheck disable=SC1091
  [ -f .env ] && . ./.env
  R_IMG="${R_ENGINE_IMAGE:-ghcr.io/zyzhou-saffron/sccloud-r-engine:latest}"

  if image_exists_locally "$R_IMG"; then
    ok "本地已有 R 镜像：$R_IMG"
    return 0
  fi

  # 尝试常见本地 tag
  for cand in sccloud-r-engine:latest sccloud-r-engine; do
    if image_exists_locally "$cand"; then
      info "发现本地镜像 $cand，retag → $R_IMG"
      docker tag "$cand" "$R_IMG" || true
      return 0
    fi
  done

  if [ -f ./data/sccloud-r-engine-image.tar.gz ]; then
    info "从 data/sccloud-r-engine-image.tar.gz 加载 R 镜像..."
    if gunzip -c ./data/sccloud-r-engine-image.tar.gz | docker load; then
      # load 后可能 tag 名不同，尽量 retag
      loaded=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -i 'r-engine\|sccloud-r' | head -1) || loaded=""
      if [ -n "$loaded" ] && [ "$loaded" != "$R_IMG" ]; then
        docker tag "$loaded" "$R_IMG" 2>/dev/null || true
      fi
      ok "R 镜像 load 完成"
      return 0
    fi
    warn "docker load 失败，继续尝试 build"
  fi

  if [ -d ./r-engine/r-library ] && [ -n "$(ls -A ./r-engine/r-library 2>/dev/null)" ]; then
    info "检测到 r-engine/r-library，将在 compose build 时构建 R 镜像"
    return 0
  fi

  if [ "$DO_BUILD" = "1" ] || [ "$DO_PULL" = "0" ]; then
    warn "本地无 R 镜像、无 tar、无 r-library。"
    warn "请任选其一："
    warn "  1) docker pull $R_IMG"
    warn "  2) 准备 r-engine/r-library 后 sh ./start.sh --build"
    warn "  3) 放入 data/sccloud-r-engine-image.tar.gz 后重试"
    return 1
  fi
  return 0
}

svc_health() {
  svc=$1
  $DOCKER_COMPOSE ps --format '{{.Health}}' "$svc" 2>/dev/null | head -1
}

svc_status() {
  svc=$1
  $DOCKER_COMPOSE ps --format '{{.Status}}' "$svc" 2>/dev/null | head -1
}

diagnose_failure() {
  echo ""
  warn "========== 自动诊断 =========="
  info "[1/3] 容器状态："
  $DOCKER_COMPOSE ps 2>/dev/null || true
  echo ""
  info "[2/3] 异常服务日志（各 ~40 行）："
  for svc in db redis backend r-engine r-engine-worker frontend web; do
    st=$(svc_status "$svc") || st=""
    if echo "$st" | grep -qiE 'exited|failed|unhealthy|restarting'; then
      echo "    --- $svc ($st) ---"
      $DOCKER_COMPOSE logs --tail 40 "$svc" 2>/dev/null | sed 's/^/    /'
      echo ""
    fi
  done
  info "[3/3] 磁盘："
  df -h . 2>/dev/null | sed 's/^/    /' || true
  echo ""
  info "完整日志：$DOCKER_COMPOSE logs --tail 200"
  info "重置：    $DOCKER_COMPOSE down -v && rm -f .env && sh ./start.sh"
  warn "=============================="
}

print_access_info() {
  admin_user="${BOOTSTRAP_ADMIN_USER:-admin}"
  admin_pass="${BOOTSTRAP_ADMIN_PASSWORD:-admin123}"
  if [ "$WEB_BIND" = "0.0.0.0" ]; then
    lan_ip=""
    if command -v ip >/dev/null 2>&1; then
      lan_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}') || true
    fi
    if [ -z "$lan_ip" ] && command -v hostname >/dev/null 2>&1; then
      lan_ip=$(hostname -I 2>/dev/null | awk '{print $1}') || true
    fi
    echo "访问地址："
    echo "  本机：    http://localhost:${WEB_PORT}"
    [ -n "$lan_ip" ] && echo "  局域网：  http://${lan_ip}:${WEB_PORT}"
  else
    echo "访问地址：http://127.0.0.1:${WEB_PORT}"
  fi
  echo ""
  echo "健康检查：http://127.0.0.1:${WEB_PORT}/healthz"
  echo ""
  echo "默认管理员（仅空库首次启动创建）："
  echo "  用户：${admin_user}"
  echo "  密码：${admin_pass}"
  echo "  请登录后立即修改密码。"
  echo ""
  echo "常用命令："
  echo "  sh ./scripts/sccloud-ops.sh status"
  echo "  sh ./scripts/sccloud-ops.sh logs"
  echo "  sh ./scripts/sccloud-ops.sh stop"
  echo ""
  warn "默认绑定 0.0.0.0:${WEB_PORT}。公网暴露前请加反向代理与 TLS。"
}

wait_health() {
  svc=$1
  label=$2
  max_i=${3:-60}
  printf '  %s' "$label"
  stage_start=$(now_s)
  ok_flag=0
  i=0
  while [ "$i" -lt "$max_i" ]; do
    h=$(svc_health "$svc") || h=""
    if [ "$h" = "healthy" ]; then
      ok_flag=1
      break
    fi
    st=$(svc_status "$svc") || st=""
    if echo "$st" | grep -qiE 'exited|failed'; then
      break
    fi
    printf '.'
    sleep 2
    i=$((i + 1))
  done
  stage_end=$(now_s)
  if [ "$ok_flag" = "1" ]; then
    printf ' ✓ (%s)\n' "$(elapsed_str "$stage_start" "$stage_end")"
    return 0
  fi
  printf ' ✗\n'
  return 1
}

# ---------- main ----------
ensure_docker

if [ "$(id -u)" != "0" ] && ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    SUDO="sudo"
  else
    die "当前用户无法访问 Docker daemon（试：sudo usermod -aG docker \$USER 后重新登录）"
  fi
fi

DOCKER_COMPOSE="${SUDO} docker compose --env-file .env"

check_disk_space

if [ ! -f .env ]; then
  info "首次启动，运行初始化向导..."
  sh ./scripts/setup-wizard.sh || die "setup-wizard 失败"
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

WEB_PORT="${WEB_PORT:-8080}"
WEB_BIND="${WEB_BIND_ADDRESS:-0.0.0.0}"

if ! check_port_available "$WEB_PORT"; then
  warn "端口 $WEB_PORT 已被占用（可能是其他服务，如闲鱼助手），自动换端口..."
  new_port=$(find_available_port $((WEB_PORT + 1))) || true
  if [ -n "$new_port" ]; then
    update_env_web_port "$new_port"
    WEB_PORT="$new_port"
    ok "WEB_PORT 已更新为 $WEB_PORT"
  else
    die "端口 $WEB_PORT ~ $((WEB_PORT + 9)) 均被占用，请改 .env 中 WEB_PORT"
  fi
fi

# 重新 export 给 compose
set -a
# shellcheck disable=SC1091
. ./.env
set +a
WEB_PORT="${WEB_PORT:-8080}"

build_ok=0

images_ready() {
  missing=0
  for img in \
    "${FRONTEND_IMAGE:-ghcr.io/zyzhou-saffron/sccloud-frontend:latest}" \
    "${BACKEND_IMAGE:-ghcr.io/zyzhou-saffron/sccloud-backend:latest}" \
    "${R_ENGINE_IMAGE:-ghcr.io/zyzhou-saffron/sccloud-r-engine:latest}"
  do
    if ! image_exists_locally "$img"; then
      warn "缺少镜像：$img"
      missing=1
    fi
  done
  [ "$missing" = "0" ]
}

if [ "$DO_BUILD" = "1" ]; then
  ensure_r_engine_image || true
  info "本地构建镜像（R 引擎首次可能很久）..."
  if $DOCKER_COMPOSE build; then
    build_ok=1
  else
    die "镜像构建失败"
  fi
else
  pull_ok=0
  if [ "$DO_PULL" = "1" ]; then
    info "检测 GHCR 连通性..."
    if check_registry_reachable "https://ghcr.io/v2/"; then
      ok "GHCR 可达"
      info "拉取镜像..."
      if $DOCKER_COMPOSE pull; then
        pull_ok=1
      else
        warn "compose pull 未全部成功，将尝试补全 R 镜像后 build"
      fi
    else
      warn "GHCR 不可达，回退本地镜像 / build"
    fi
  fi

  # R 镜像特殊兜底（即使 FE/BE pull 成功，R 也可能缺失）
  ensure_r_engine_image || true

  if images_ready; then
    ok "本地三业务镜像已就绪"
    build_ok=1
  elif [ "$pull_ok" = "1" ]; then
    info "pull 后仍缺镜像，补齐：docker compose build..."
    if $DOCKER_COMPOSE build; then
      build_ok=1
    else
      die "镜像不完整且 build 失败"
    fi
  else
    info "本地构建镜像..."
    if $DOCKER_COMPOSE build; then
      build_ok=1
    else
      die "镜像构建失败（R 需要 r-engine/r-library 或已有镜像）"
    fi
  fi
fi

[ "$build_ok" = "1" ] || die "镜像准备失败"

info "启动服务..."
$DOCKER_COMPOSE up -d || {
  diagnose_failure
  die "docker compose up 失败"
}

info "等待服务就绪..."
phase_start=$(now_s)

wait_health db "db..." 45 || { diagnose_failure; die "db 未就绪"; }
wait_health redis "redis..." 30 || { diagnose_failure; die "redis 未就绪"; }
wait_health backend "backend..." 90 || { diagnose_failure; die "backend 未就绪"; }

# r-engine 启动较慢
printf '  r-engine'
re_ok=0
i=0
stage_start=$(now_s)
while [ "$i" -lt 90 ]; do
  h=$(svc_health r-engine) || h=""
  if [ "$h" = "healthy" ]; then
    re_ok=1
    break
  fi
  st=$(svc_status r-engine) || st=""
  if echo "$st" | grep -qiE 'exited|failed'; then
    break
  fi
  printf '.'
  sleep 2
  i=$((i + 1))
done
stage_end=$(now_s)
if [ "$re_ok" = "1" ]; then
  printf ' ✓ (%s)\n' "$(elapsed_str "$stage_start" "$stage_end")"
else
  printf ' ✗（继续检查入口；分析功能可能不可用）\n'
  warn "r-engine 未 healthy，查看： $DOCKER_COMPOSE logs --tail 100 r-engine"
fi

printf '  web'
web_ok=0
i=0
stage_start=$(now_s)
HEALTH_URL="http://127.0.0.1:${WEB_PORT}/healthz"
while [ "$i" -lt 45 ]; do
  h=$(svc_health web) || h=""
  http_ok=0
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1 && http_ok=1
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- --timeout=3 "$HEALTH_URL" >/dev/null 2>&1 && http_ok=1
  else
    [ "$h" = "healthy" ] && http_ok=1
  fi
  if [ "$http_ok" = "1" ]; then
    web_ok=1
    break
  fi
  st=$(svc_status web) || st=""
  if echo "$st" | grep -qiE 'exited|failed'; then
    break
  fi
  printf '.'
  sleep 2
  i=$((i + 1))
done
stage_end=$(now_s)
total_end=$(now_s)

if [ "$web_ok" = "1" ]; then
  printf ' ✓ (%s)\n' "$(elapsed_str "$stage_start" "$stage_end")"
  echo ""
  ok "服务已就绪（总等待 $(elapsed_str "$phase_start" "$total_end")）"
  echo ""
  print_access_info
  exit 0
fi

printf ' ✗\n'
diagnose_failure
die "入口健康检查超时：$HEALTH_URL"
