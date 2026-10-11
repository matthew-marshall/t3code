/*
 * Desktop harness for occore. Reads the two lines printed by
 * `gpclient connect --cookie-only <portal>` on stdin:
 *
 *   gpclient connect --cookie-only <portal> | occore-cli <target-host> <target-port> [local-port] [pin]
 *
 * then forwards 127.0.0.1:<local-port> to <target-host>:<target-port> through the VPN
 * until Ctrl-C.
 */
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "occore.h"

static volatile sig_atomic_t g_stop;

static void on_signal(int sig)
{
	(void)sig;
	g_stop = 1;
}

static void on_log(void *ctx, int level, const char *message)
{
	(void)ctx;
	fprintf(stderr, "[oc:%d] %s\n", level, message);
}

static void on_state(void *ctx, int state, const char *detail)
{
	static const char *names[] = { "connecting", "connected", "stopped" };
	(void)ctx;
	fprintf(stderr, "[state] %s%s%s\n", names[state], detail ? ": " : "", detail ? detail : "");
	if (state == OCCORE_STOPPED)
		g_stop = 1;
}

/* Parses KEY='value' from gpclient's --cookie-only output. */
static char *read_value(const char *line, const char *key)
{
	size_t klen = strlen(key);
	const char *start;
	char *value, *end;
	if (strncmp(line, key, klen) || line[klen] != '=')
		return NULL;
	start = line + klen + 1;
	if (*start == '\'')
		start++;
	value = strdup(start);
	end = value + strlen(value);
	while (end > value && (end[-1] == '\n' || end[-1] == '\r' || end[-1] == '\''))
		*--end = 0;
	return value;
}

int main(int argc, char **argv)
{
	char line[8192];
	char *cookie = NULL, *host = NULL;
	occore_config cfg = { 0 };
	occore *core;
	int ret;

	if (argc < 3) {
		fprintf(stderr, "usage: gpclient connect --cookie-only <portal> | %s <target-host> <target-port> [local-port] [pin-sha256:...]\n", argv[0]);
		return 2;
	}
	while (fgets(line, sizeof(line), stdin)) {
		char *v;
		if ((v = read_value(line, "COOKIE")))
			cookie = v;
		else if ((v = read_value(line, "HOST")))
			host = v;
	}
	if (!cookie || !host) {
		fprintf(stderr, "expected COOKIE='...' and HOST='...' on stdin\n");
		return 2;
	}

	cfg.gateway = host;
	cfg.cookie = cookie;
	cfg.os = getenv("OCCORE_OS") ? getenv("OCCORE_OS") : "linux";
	cfg.target_host = argv[1];
	cfg.target_port = (uint16_t)atoi(argv[2]);
	cfg.local_port = argc > 3 ? (uint16_t)atoi(argv[3]) : 0;
	cfg.server_cert_pin = argc > 4 ? argv[4] : NULL;
	cfg.log = on_log;
	cfg.on_state = on_state;

	ret = occore_start(&cfg, &core);
	if (ret) {
		fprintf(stderr, "occore_start failed: %s\n", strerror(-ret));
		return 1;
	}
	fprintf(stderr, "Forwarding 127.0.0.1:%u -> %s:%u\n", occore_local_port(core), cfg.target_host,
		cfg.target_port);

	signal(SIGINT, on_signal);
	signal(SIGTERM, on_signal);
	while (!g_stop)
		usleep(200000);
	occore_stop(core);
	return 0;
}
