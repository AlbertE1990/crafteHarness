#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SAMPLE_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
PROJECT_ROOT="$(cd -- "$SAMPLE_DIR/.." && pwd -P)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename -- "${BASH_SOURCE[0]}")"
ENV_FILE="$SAMPLE_DIR/.env.local"
RUNTIME_DIR="${CRAFT_SAMPLE_RUNTIME_DIR:-$SAMPLE_DIR/.runtime}"
PID_FILE="$RUNTIME_DIR/supervisor.pid"
APP_LOG="$RUNTIME_DIR/app.log"
SUPERVISOR_LOG="$RUNTIME_DIR/supervisor.log"
PNPM_COMMAND=()

log() {
  printf '[craft-harness-sample] %s\n' "$*"
}

fail() {
  printf '[craft-harness-sample] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./sample/scripts/deploy.sh [deploy|restart|start|stop|status|logs]

  deploy   安装依赖、打包、停止旧进程、迁移数据库并后台启动（默认）
  restart  与 deploy 相同，适合拉取新代码后重新部署
  start    使用现有依赖、数据库和构建产物后台启动
  stop     停止由本脚本启动的服务
  status   查看进程状态和日志路径
  logs     输出最近 100 行应用与 supervisor 日志

Optional environment variable:
  CRAFT_SAMPLE_RUNTIME_DIR  PID 和日志目录，默认 sample/.runtime
EOF
}

select_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    PNPM_COMMAND=(pnpm)
    return
  fi
  if command -v corepack >/dev/null 2>&1; then
    PNPM_COMMAND=(corepack pnpm)
    return
  fi
  fail '未找到 pnpm 或 corepack；请先安装 Node.js 20 或更高版本。'
}

validate_node() {
  command -v node >/dev/null 2>&1 || fail '未找到 Node.js。'
  local major
  major="$(node -p "Number(process.versions.node.split('.')[0])")"
  [[ "$major" =~ ^[0-9]+$ ]] || fail '无法识别 Node.js 版本。'
  (( major >= 20 )) || fail "需要 Node.js >= 20，当前为 $(node --version)。"
}

validate_port() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+$ ]] || fail 'sample/.env.local 中的 PORT 必须是整数。'
  (( value >= 1 && value <= 65535 )) || fail 'PORT 必须位于 1..65535。'
}

validate_environment() {
  [[ -f "$ENV_FILE" ]] || fail "缺少 $ENV_FILE；请从 sample/.env.example 复制并填写。"
  if grep -q 'replace-me' "$ENV_FILE"; then
    fail "$ENV_FILE 仍包含 replace-me，请填写真实模型密钥和数据库密码。"
  fi
  [[ -f "$SAMPLE_DIR/config/models.json" ]] || fail '缺少 sample/config/models.json。'
}

validate_build() {
  [[ -f "$PROJECT_ROOT/dist/index.js" ]] || fail "缺少 craft-harness 构建产物：$PROJECT_ROOT/dist/index.js。请运行 deploy。"
  [[ -f "$SAMPLE_DIR/dist-server/index.js" ]] || fail "缺少 Server 构建产物：$SAMPLE_DIR/dist-server/index.js。请运行 deploy。"
  [[ -f "$SAMPLE_DIR/dist/index.html" ]] || fail "缺少前端构建产物：$SAMPLE_DIR/dist/index.html。请运行 deploy。"
}

build_artifacts() {
  log '打包 craft-harness...'
  (cd -- "$PROJECT_ROOT" && "${PNPM_COMMAND[@]}" run build)
  [[ -f "$PROJECT_ROOT/dist/index.js" ]] || fail "craft-harness 打包命令成功，但未生成 $PROJECT_ROOT/dist/index.js。"

  log '打包 sample Server...'
  "${PNPM_COMMAND[@]}" --dir "$SAMPLE_DIR" run build:server
  [[ -f "$SAMPLE_DIR/dist-server/index.js" ]] || fail "Server 打包命令成功，但未生成 $SAMPLE_DIR/dist-server/index.js。"

  log '打包 sample 前端...'
  "${PNPM_COMMAND[@]}" --dir "$SAMPLE_DIR" run build:web
  [[ -f "$SAMPLE_DIR/dist/index.html" ]] || fail "前端打包命令成功，但未生成 $SAMPLE_DIR/dist/index.html。"
}

read_backend_port() {
  node --input-type=module - "$ENV_FILE" <<'NODE'
import process, { loadEnvFile } from 'node:process'

loadEnvFile(process.argv[2])
process.stdout.write(process.env.PORT?.trim() || '3000')
NODE
}

read_supervisor_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  IFS= read -r pid < "$PID_FILE"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$pid"
}

is_our_supervisor() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null || return 1
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  local command_line
  command_line="$(tr '\0' ' ' < "/proc/$pid/cmdline")"
  [[ "$command_line" == *"$SCRIPT_PATH __run"* ]]
}

stop_services() {
  local pid
  if ! pid="$(read_supervisor_pid)"; then
    rm -f -- "$PID_FILE"
    log '服务未运行。'
    return
  fi

  if ! is_our_supervisor "$pid"; then
    rm -f -- "$PID_FILE"
    log "PID 文件已过期，未终止 PID $pid。"
    return
  fi

  log "正在停止 supervisor PID $pid..."
  kill -TERM "$pid"
  local attempt
  for attempt in {1..30}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f -- "$PID_FILE"
      log '服务已停止。'
      return
    fi
    sleep 1
  done
  fail "PID $pid 在 30 秒内没有退出，请检查 $SUPERVISOR_LOG。"
}

show_status() {
  local pid
  if pid="$(read_supervisor_pid)" && is_our_supervisor "$pid"; then
    log "服务正在运行，supervisor PID $pid。"
    log "应用日志：$APP_LOG"
    return 0
  fi
  log '服务未运行。'
  return 1
}

show_logs() {
  local file
  for file in "$APP_LOG" "$SUPERVISOR_LOG"; do
    printf '\n===== %s =====\n' "$file"
    if [[ -f "$file" ]]; then
      tail -n 100 -- "$file"
    else
      printf '日志尚未生成。\n'
    fi
  done
}

cleanup_child() {
  local app_pid="${APP_PID:-}"
  [[ -z "$app_pid" ]] || kill -TERM "$app_pid" 2>/dev/null || true
  [[ -z "$app_pid" ]] || wait "$app_pid" 2>/dev/null || true
  if [[ -f "$PID_FILE" ]] && [[ "$(< "$PID_FILE")" == "$$" ]]; then
    rm -f -- "$PID_FILE"
  fi
}

run_supervisor() {
  mkdir -p -- "$RUNTIME_DIR"
  trap 'exit 0' TERM INT
  trap cleanup_child EXIT

  (
    cd -- "$PROJECT_ROOT"
    export NODE_ENV=production
    export CRAFT_SAMPLE_ENV_FILE="$ENV_FILE"
    export CRAFT_SAMPLE_STATIC_ROOT="$SAMPLE_DIR/dist"
    export CRAFT_AGENT_MODELS_FILE="$SAMPLE_DIR/config/models.json"
    export CRAFT_AGENT_MIGRATIONS_DIR="$SAMPLE_DIR/database/migrations"
    export CRAFT_HARNESS_DOCS_ROOT="$PROJECT_ROOT"
    exec node "$SAMPLE_DIR/dist-server/index.js"
  ) >> "$APP_LOG" 2>&1 &
  APP_PID=$!

  log "supervisor $$ 已启动应用 PID $APP_PID"
  set +e
  wait "$APP_PID"
  local exit_code=$?
  set -e
  log "应用进程退出，状态码 $exit_code。"
  return "$exit_code"
}

start_services() {
  validate_node
  select_pnpm
  validate_environment
  validate_build

  local backend_port
  backend_port="$(read_backend_port)"
  validate_port "$backend_port"

  local existing_pid
  if existing_pid="$(read_supervisor_pid)" && is_our_supervisor "$existing_pid"; then
    fail "服务已经运行（PID $existing_pid）；请使用 restart 或 stop。"
  fi
  rm -f -- "$PID_FILE"
  mkdir -p -- "$RUNTIME_DIR"

  nohup bash "$SCRIPT_PATH" __run >> "$SUPERVISOR_LOG" 2>&1 &
  local supervisor_pid=$!
  printf '%s\n' "$supervisor_pid" > "$PID_FILE"

  sleep 2
  if ! is_our_supervisor "$supervisor_pid"; then
    show_logs
    fail '服务启动失败。'
  fi
  log "部署完成：http://127.0.0.1:$backend_port"
  show_status
}

deploy() {
  validate_node
  select_pnpm
  validate_environment

  log '安装 workspace 依赖...'
  (cd -- "$PROJECT_ROOT" && "${PNPM_COMMAND[@]}" install --frozen-lockfile --prod=false)
  build_artifacts
  stop_services
  log '执行 MySQL 数据库迁移...'
  "${PNPM_COMMAND[@]}" --dir "$SAMPLE_DIR" db:migrate
  start_services
}

ACTION="${1:-deploy}"
case "$ACTION" in
  __run)
    run_supervisor
    ;;
  deploy|restart)
    deploy
    ;;
  start)
    start_services
    ;;
  stop)
    stop_services
    ;;
  status)
    show_status
    ;;
  logs)
    show_logs
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
