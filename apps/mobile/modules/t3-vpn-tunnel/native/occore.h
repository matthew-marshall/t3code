#ifndef OCCORE_H
#define OCCORE_H

#include <stdint.h>

/*
 * occore: a GlobalProtect tunnel that lives entirely inside the app process, or (packet mode,
 * see occore_start_packets) inside an iOS packet tunnel extension.
 *
 * libopenconnect talks to the gateway; instead of a tun device its packets go to
 * an in-process lwIP stack, which exposes one TCP port forward:
 *
 *   127.0.0.1:<local_port>  ->  <target_host>:<target_port> (through the VPN)
 *
 * Nothing is routed at the OS level, so only connections made to the local
 * port use the VPN. One tunnel per process (lwIP keeps global state).
 */

typedef struct occore occore;

enum occore_state {
	OCCORE_CONNECTING = 0,
	OCCORE_CONNECTED = 1,   /* tunnel up (or back up after a reconnect), forward accepting */
	OCCORE_STOPPED = 2,     /* mainloop exited; detail holds the reason */
};

typedef void (*occore_log_fn)(void *ctx, int level, const char *message);
typedef void (*occore_state_fn)(void *ctx, int state, const char *detail);

typedef struct {
	const char *gateway;        /* gateway host, e.g. HOST from gpclient --cookie-only */
	const char *cookie;         /* gateway cookie, e.g. COOKIE from gpclient --cookie-only */
	const char *server_cert_pin;/* "pin-sha256:..."; NULL accepts any cert and logs its pin */
	const char *os;             /* reported OS: "linux", "win", "mac"; match the cookie's login */
	const char *os_version;     /* optional */
	const char *client_version; /* optional GP app version */
	const char *user_agent;     /* optional, defaults to "PAN GlobalProtect" */
	const char *local_hostname; /* optional */

	const char *target_host;    /* IPv4 literal or hostname resolved via the VPN's DNS */
	uint16_t target_port;
	uint16_t local_port;        /* 0 picks a free port */

	occore_log_fn log;
	occore_state_fn on_state;   /* called from a background thread */
	void *ctx;
} occore_config;

/* Binds the local port and starts the tunnel in the background. Returns 0 or -errno. */
int occore_start(const occore_config *config, occore **out);

/*
 * The tunnel's address, the gateway's numeric address, the MTU and up to three DNS servers
 * (empty strings when absent).
 */
typedef void (*occore_network_fn)(void *ctx, const char *address, const char *gateway_address,
				  int mtu, const char *dns1, const char *dns2, const char *dns3);

/*
 * Packet mode, for an iOS packet tunnel extension: no lwIP and no local forward, so
 * target_host, target_port and local_port are ignored. The caller moves IP packets between
 * *packet_fd and the OS. It is a nonblocking AF_UNIX datagram socket; each datagram is one IP
 * packet after a 4-byte big-endian address family (AF_INET or AF_INET6), in both directions.
 * on_network is called, from a background thread, when the gateway assigns the tunnel's
 * settings and again after a reconnect; the state turns OCCORE_CONNECTED after it returns.
 * The core owns packet_fd and closes it in occore_stop. Returns 0 or -errno.
 */
int occore_start_packets(const occore_config *config, occore_network_fn on_network, occore **out,
			 int *packet_fd);

/* The bound local port (useful when config.local_port was 0). */
uint16_t occore_local_port(const occore *core);

/*
 * Replaces the local forward's listening socket, on the same port when it is free, and returns
 * 0 or -errno (-ETIMEDOUT after 3 s). Call when the app returns to the foreground: iOS reclaims a
 * suspended app's listening sockets, and a reclaimed listener never accepts again. Connections
 * already forwarded are unaffected. Read the port again afterwards with occore_local_port.
 */
int occore_reopen_listener(occore *core);

/* Cancels the tunnel, closes forwarded connections, and frees the core. */
void occore_stop(occore *core);

#endif
