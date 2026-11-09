#!/usr/bin/env bash
# Start the self-hosted HumanLayer stack for this checkout with one command.
#
#   ./scripts/humanlayer-up.sh            start everything, wait until healthy, open the app
#   ./scripts/humanlayer-up.sh --no-open  same, without opening the browser
#   ./scripts/humanlayer-up.sh --restart  restart the app processes even if they are healthy
#   ./scripts/humanlayer-up.sh --stop     stop the app processes and the containers
#
# What it does:
#   1. Checks the tools it needs (Docker, Bun, Node >= 24, tmux, Caddy) and the setup files.
#   2. Runs `devstack sync --compose`: starts Postgres, Electric, Redis, MinIO and
#      durable-streams, applies database migrations, refreshes the generated .env block and
#      the Caddy routes.
#   3. Starts the API, UI, cloud app, sync proxy, daemon and Caddy in a tmux session. It uses
#      `riptide:node-proxy` so the Electric proxy runs on real Node (it crashes under Bun).
#   4. Waits until the app, API and sync routes answer over HTTPS, then opens the app.
#
# Safe to run again at any time: a healthy stack is left alone.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$HOME/.humanlayer/dev"
SYNC_LOG="$STATE_DIR/humanlayer-up-sync.log"
HEALTH_TIMEOUT_SECONDS=240

OPEN_BROWSER=true
ACTION=up
for arg in "$@"; do
	case "$arg" in
		--no-open) OPEN_BROWSER=false ;;
		--restart) ACTION=restart ;;
		--stop) ACTION=stop ;;
		-h | --help)
			sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*)
			echo "Unknown option: $arg (try --help)" >&2
			exit 2
			;;
	esac
done

if [ -t 1 ]; then
	BOLD=$'\e[1m' DIM=$'\e[2m' GREEN=$'\e[32m' RED=$'\e[31m' YELLOW=$'\e[33m' RESET=$'\e[0m'
else
	BOLD='' DIM='' GREEN='' RED='' YELLOW='' RESET=''
fi
step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
ok() { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die() {
	printf '%sError:%s %s\n' "$RED" "$RESET" "$1" >&2
	shift
	for line in "$@"; do printf '       %s\n' "$line" >&2; done
	exit 1
}

# Reads one KEY=value line from the root .env without sourcing the whole file.
env_value() {
	grep -m1 "^$1=" "$REPO_ROOT/.env" 2>/dev/null | cut -d= -f2- | tr -d '"'"'" || true
}

# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

find_bun() {
	if command -v bun >/dev/null 2>&1; then
		dirname "$(command -v bun)"
	elif [ -x "$HOME/.bun/bin/bun" ]; then
		echo "$HOME/.bun/bin"
	fi
}

# Prints the bin directory of a Node >= 24, preferring the newest nvm install.
find_node24() {
	local dir major
	if [ -d "$HOME/.nvm/versions/node" ]; then
		while IFS= read -r dir; do
			major="${dir##*/v}"
			major="${major%%.*}"
			if [ "$major" -ge 24 ] 2>/dev/null && [ -x "$dir/bin/node" ]; then
				echo "$dir/bin"
				return
			fi
		done < <(find "$HOME/.nvm/versions/node" -mindepth 1 -maxdepth 1 -type d -name 'v*' | sort -V -r)
	fi
	if command -v node >/dev/null 2>&1; then
		major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
		if [ "$major" -ge 24 ] 2>/dev/null; then
			dirname "$(command -v node)"
		fi
	fi
}

check_tools() {
	step "Checking tools"
	command -v docker >/dev/null 2>&1 || die "Docker is not installed."
	docker info >/dev/null 2>&1 || die "Docker is not running or this user cannot use it." \
		"Start it with: sudo systemctl start docker"
	ok "Docker"

	BUN_DIR="$(find_bun)"
	[ -n "$BUN_DIR" ] || die "Bun is not installed." 'Install it with: curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"'
	ok "Bun $("$BUN_DIR/bun" --version)"

	NODE_DIR="$(find_node24)"
	[ -n "$NODE_DIR" ] || die "Node 24 or newer is required." "Install it with: nvm install 24"
	ok "Node $("$NODE_DIR/node" --version)"

	command -v tmux >/dev/null 2>&1 || die "tmux is not installed." "Install it with: sudo apt install -y tmux"
	ok "tmux"

	command -v caddy >/dev/null 2>&1 || die "Caddy is not installed." \
		"Install it from Caddy's apt repository: https://caddyserver.com/docs/install#debian-ubuntu-raspbian"
	ensure_caddy_can_bind
	ok "Caddy"

	export PATH="$NODE_DIR:$BUN_DIR:$PATH"
}

# Caddy serves the app on ports 80 and 443. Linux lets only root bind ports below
# net.ipv4.ip_unprivileged_port_start (1024 by default), so the Caddy binary needs the
# cap_net_bind_service file capability. Each apt upgrade of Caddy replaces the binary and drops
# that capability, so check it on every run instead of letting Caddy fail later in tmux.
ensure_caddy_can_bind() {
	local caddy_bin unprivileged_start
	caddy_bin="$(readlink -f "$(command -v caddy)")"
	unprivileged_start="$(cat /proc/sys/net/ipv4/ip_unprivileged_port_start 2>/dev/null || echo 1024)"
	if [ "$unprivileged_start" -le 80 ] 2>/dev/null; then
		return 0
	fi
	if ! command -v getcap >/dev/null 2>&1; then
		warn "Could not check whether Caddy can listen on ports 80 and 443 (getcap is missing)."
		warn "Install it with: sudo apt install -y libcap2-bin"
		return 0
	fi
	if getcap "$caddy_bin" | grep -q cap_net_bind_service; then
		return 0
	fi

	warn "Caddy cannot listen on ports 80 and 443. Caddy upgrades from apt remove this permission."
	if [ -t 0 ] && command -v sudo >/dev/null 2>&1; then
		warn "Granting it with sudo; enter your password if asked."
		if sudo setcap cap_net_bind_service=+ep "$caddy_bin" && getcap "$caddy_bin" | grep -q cap_net_bind_service; then
			ok "Caddy can now listen on ports 80 and 443"
			return 0
		fi
	fi
	die "Caddy cannot listen on ports 80 and 443." \
		"Fix it with: sudo setcap cap_net_bind_service=+ep $caddy_bin" \
		"Then run this script again."
}

check_setup() {
	[ -f "$REPO_ROOT/.env" ] || die "Missing $REPO_ROOT/.env" "Set up the stack first (see the self-hosting notes)."
	[ -f "$REPO_ROOT/.devstack.json" ] || die "Missing $REPO_ROOT/.devstack.json" \
		"Create the stack first with: bun --bun run devstack sync --compose --seed"
	[ -d "$REPO_ROOT/node_modules" ] || die "Dependencies are not installed." "Run: cd $REPO_ROOT && bun install"

	STACK_ID="$(env_value DEVSTACK_ID)"
	COMPOSE_PROJECT="$(env_value DEVSTACK_COMPOSE_PROJECT)"
	[ -n "$STACK_ID" ] && [ -n "$COMPOSE_PROJECT" ] || die "The devstack block in .env is missing." \
		"Regenerate it with: bun --bun run devstack sync --compose"
	TMUX_SESSION="riptide-$STACK_ID"
	APP_URL="https://app.$STACK_ID.localhost"
}

# ---------------------------------------------------------------------------
# Stack state
# ---------------------------------------------------------------------------

route_ok() {
	curl -fsS -o /dev/null -m 5 "$1" >/dev/null 2>&1
}

stack_healthy() {
	route_ok "https://api.$STACK_ID.localhost/health" &&
		route_ok "https://sync.$STACK_ID.localhost/" &&
		route_ok "$APP_URL/"
}

session_exists() {
	tmux has-session -t "=$TMUX_SESSION" 2>/dev/null
}

session_exited() {
	tmux capture-pane -p -J -t "=$TMUX_SESSION:" -S -5000 2>/dev/null | grep -q '^\[humanlayer exited\]'
}

show_recent_logs() {
	local output caddy_error
	output="$(tmux capture-pane -p -J -t "=$TMUX_SESSION:" -S -5000 2>/dev/null || true)"
	echo
	echo "${DIM}Last lines from the app processes (tmux session $TMUX_SESSION):${RESET}"
	printf '%s\n' "$output" |
		grep -v '^[[:space:]]*$' | grep -iE 'error|fail|exited|cannot|missing' | tail -15 | cut -c1-220 || true
	# caddy.log is mostly per-request errors; show only the startup error that stopped Caddy.
	if printf '%s\n' "$output" | grep -q 'Caddy exited during startup'; then
		caddy_error="$(grep '"level":"error"' "$STATE_DIR/caddy.log" 2>/dev/null | grep -v '"logger":"http\.log' |
			tail -1 | sed -n 's/.*"msg":"\([^"]*\)".*/\1/p' || true)"
		[ -z "$caddy_error" ] || echo "${RED}Caddy:${RESET} $caddy_error"
	fi
	echo "${DIM}Full output: tmux attach -t $TMUX_SESSION   (detach with Ctrl+B, then D)${RESET}"
}

# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------

start_services() {
	step "Starting containers and applying migrations"
	mkdir -p "$STATE_DIR"
	if ! (cd "$REPO_ROOT" && bun --bun run devstack sync --compose >"$SYNC_LOG" 2>&1); then
		tail -20 "$SYNC_LOG" >&2
		die "devstack sync failed." "Full log: $SYNC_LOG"
	fi
	ok "Postgres, Electric, Redis, MinIO and durable-streams are up"
}

stop_app_processes() {
	if session_exists; then
		# Ctrl+C first so Turbo stops the daemon and dev servers cleanly.
		tmux send-keys -t "=$TMUX_SESSION:" C-c 2>/dev/null || true
		for _ in $(seq 1 30); do
			session_exited && break
			sleep 0.5
		done
		tmux kill-session -t "=$TMUX_SESSION" 2>/dev/null || true
		ok "Stopped the app processes"
	fi
	stop_leftover_processes
}

# The dev servers run with --watch and can outlive their tmux session (after a crash, or when
# the session is closed). Stop any bun/node process still running from this checkout's apps/
# directory. Agent sessions run in your project directories, so they are not touched.
stop_leftover_processes() {
	local pid cwd alive
	local pids=()
	# Match on argv[0]: Node renames its process to "MainThread", so the process name is unreliable.
	for pid in $(pgrep -u "$(id -u)" -f '^([^ ]*/)?(bun|node)( |$)' 2>/dev/null || true); do
		cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null)" || continue
		case "$cwd" in "$REPO_ROOT"/apps/*) pids+=("$pid") ;; esac
	done
	[ "${#pids[@]}" -gt 0 ] || return 0

	kill "${pids[@]}" 2>/dev/null || true
	for _ in $(seq 1 20); do
		alive=0
		for pid in "${pids[@]}"; do
			if kill -0 "$pid" 2>/dev/null; then alive=1; fi
		done
		[ "$alive" -eq 0 ] && break
		sleep 0.5
	done
	kill -9 "${pids[@]}" 2>/dev/null || true
	ok "Stopped ${#pids[@]} leftover dev process(es)"
}

start_app_processes() {
	step "Starting the app processes"
	local cmd
	# DAEMON_IDENTITY would make the local daemon impersonate another host; never inherit it.
	cmd="cd $(printf '%q' "$REPO_ROOT") && env -u DAEMON_IDENTITY -u RIPTIDE_DAEMON_EXPECTED_IDENTITY"
	cmd+=" PATH=$(printf '%q' "$PATH") bun run riptide:node-proxy; echo; echo '[humanlayer exited]'; exec bash"
	tmux new-session -d -s "$TMUX_SESSION" -c "$REPO_ROOT" "$cmd"
	ok "Started in tmux session $TMUX_SESSION"
}

wait_until_healthy() {
	step "Waiting for HumanLayer to answer (up to ${HEALTH_TIMEOUT_SECONDS}s)"
	local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
	while [ "$SECONDS" -lt "$deadline" ]; do
		if stack_healthy; then
			ok "App, API and sync routes are healthy"
			return 0
		fi
		if session_exited; then
			show_recent_logs
			die "The app processes exited during startup."
		fi
		sleep 2
	done
	show_recent_logs
	die "HumanLayer did not become healthy within ${HEALTH_TIMEOUT_SECONDS}s."
}

print_summary() {
	echo
	printf '%sHumanLayer is running:%s %s\n' "$GREEN$BOLD" "$RESET" "$APP_URL"
	echo "${DIM}  Logs:  tmux attach -t $TMUX_SESSION   (detach with Ctrl+B, then D)${RESET}"
	echo "${DIM}  Stop:  $REPO_ROOT/scripts/humanlayer-up.sh --stop${RESET}"
	if [ "$OPEN_BROWSER" = true ] && command -v xdg-open >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
		xdg-open "$APP_URL" >/dev/null 2>&1 &
	fi
}

do_stop() {
	check_setup
	step "Stopping HumanLayer"
	stop_app_processes
	if docker compose -f "$REPO_ROOT/docker-compose.yaml" -p "$COMPOSE_PROJECT" stop >/dev/null 2>&1; then
		ok "Stopped the containers (data is kept)"
	else
		warn "Could not stop the containers; check: docker compose -p $COMPOSE_PROJECT ps"
	fi
}

do_up() {
	check_tools
	check_setup

	if [ "$ACTION" = up ] && session_exists && ! session_exited && stack_healthy; then
		step "HumanLayer is already running"
		print_summary
		return
	fi

	start_services
	stop_app_processes
	start_app_processes
	wait_until_healthy
	print_summary
}

case "$ACTION" in
	stop) do_stop ;;
	*) do_up ;;
esac
