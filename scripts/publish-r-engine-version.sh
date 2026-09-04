#!/bin/sh
# 发版时给已有 sccloud-r-engine 镜像打 semver tag 并推 GHCR（不 build）。
#
# 用法:
#   sh ./scripts/publish-r-engine-version.sh v1.1.0
#   sh ./scripts/publish-r-engine-version.sh 1.1.0
#   SOURCE=ghcr.io/zyzhou-saffron/sccloud-r-engine:5308110 \
#     sh ./scripts/publish-r-engine-version.sh v1.1.0
#   sh ./scripts/publish-r-engine-version.sh v1.1.0 --also-latest
#   sh ./scripts/publish-r-engine-version.sh v1.1.0 --dry-run
#
# 前提:
#   - 源镜像已是本版内容（默认 pull SOURCE，一般为 :latest）
#   - docker login ghcr.io，token 需 write:packages
#   - 不替代 FE/BE 的 docker-publish；也不上传 Release 大 tar
#
# 环境变量:
#   IMAGE   目标仓库，默认 ghcr.io/zyzhou-saffron/sccloud-r-engine
#   SOURCE  源引用，默认 ${IMAGE}:latest

set -eu

IMAGE="${IMAGE:-ghcr.io/zyzhou-saffron/sccloud-r-engine}"
SOURCE="${SOURCE:-${IMAGE}:latest}"
ALSO_LATEST=0
DRY_RUN=0
VER_ARG=""

usage() {
  cat <<'EOF'
用法: sh ./scripts/publish-r-engine-version.sh <vX.Y.Z|X.Y.Z> [--from REF] [--also-latest] [--dry-run]

给已有 sccloud-r-engine 打 semver tag 并 push（不 build）。
默认 SOURCE=$IMAGE:latest；token 需 write:packages。
EOF
  exit "${1:-0}"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage 0 ;;
    --also-latest) ALSO_LATEST=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --from)
      [ "$#" -ge 2 ] || { echo "缺少 --from 值" >&2; exit 2; }
      SOURCE=$2
      shift 2
      ;;
    -*)
      echo "未知选项: $1" >&2
      usage 2
      ;;
    *)
      if [ -n "$VER_ARG" ]; then
        echo "多余参数: $1" >&2
        usage 2
      fi
      VER_ARG=$1
      shift
      ;;
  esac
done

if [ -z "$VER_ARG" ]; then
  echo "请传入版本，例如 v1.1.0" >&2
  usage 2
fi

# 归一: TAG_V=v1.1.0  TAG_PLAIN=1.1.0
case "$VER_ARG" in
  v*) TAG_V=$VER_ARG; TAG_PLAIN=${VER_ARG#v} ;;
  *)  TAG_PLAIN=$VER_ARG; TAG_V=v$VER_ARG ;;
esac

case "$TAG_PLAIN" in
  *[!0-9A-Za-z.-]*|'')
    echo "版本不合法: $VER_ARG" >&2
    exit 2
    ;;
esac

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run]'
    for a in "$@"; do printf ' %s' "$a"; done
    printf '\n'
  else
    "$@"
  fi
}

TAGS_MSG="$TAG_V  $TAG_PLAIN"
if [ "$ALSO_LATEST" -eq 1 ]; then
  TAGS_MSG="$TAGS_MSG  latest"
fi

echo "SOURCE=$SOURCE"
echo "IMAGE=$IMAGE"
echo "tags: $TAGS_MSG"
echo "dry-run=$DRY_RUN"

if [ "$DRY_RUN" -eq 0 ] && ! command -v docker >/dev/null 2>&1; then
  echo "需要 docker" >&2
  exit 1
fi

run docker pull "$SOURCE"
run docker tag "$SOURCE" "${IMAGE}:${TAG_V}"
run docker tag "$SOURCE" "${IMAGE}:${TAG_PLAIN}"
if [ "$ALSO_LATEST" -eq 1 ]; then
  run docker tag "$SOURCE" "${IMAGE}:latest"
fi

run docker push "${IMAGE}:${TAG_V}"
run docker push "${IMAGE}:${TAG_PLAIN}"
if [ "$ALSO_LATEST" -eq 1 ]; then
  run docker push "${IMAGE}:latest"
fi

echo "done: ${IMAGE}:${TAG_V} + ${IMAGE}:${TAG_PLAIN}"
if [ "$ALSO_LATEST" -eq 1 ]; then
  echo "done: ${IMAGE}:latest"
fi
