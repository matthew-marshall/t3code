/*
 * occore: libopenconnect + an in-process lwIP stack + one localhost TCP forward.
 *
 * Two threads:
 *   - oc thread:   openconnect_make_cstp_connection() + openconnect_mainloop().
 *   - net thread:  owns all lwIP state. poll()s the tun socketpair, a wake pipe,
 *                  the local listener and every forwarded client socket.
 *
 * Packets cross between them over an AF_UNIX datagram socketpair that libopenconnect
 * treats as its tun fd. On Apple platforms openconnect frames tun packets with a
 * 4-byte address family prefix (TUN_HAS_AF_PREFIX), so the net thread adds and strips it.
 *
 * Packet mode (occore_start_packets) runs only the oc thread: the caller owns the other end
 * of the socketpair and moves its packets to and from the OS, with the prefix kept.
 */
#include "occore.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include <openconnect.h>

/* <netinet/tcp.h> defines TCP_MSS too; lwIP's (lwipopts.h) is the one we mean. */
#undef TCP_MSS

#include "lwip/dns.h"
#include "lwip/init.h"
#include "lwip/ip4.h"
#include "lwip/netif.h"
#include "lwip/pbuf.h"
#include "lwip/tcp.h"
#include "lwip/timeouts.h"

#define AF_PREFIX_LEN 4
#define MAX_PACKET 65535
#define READ_CHUNK 16384

struct conn {
	struct conn *next;
	struct occore *core;
	unsigned id;
	unsigned long long sent, received; /* bytes local->remote, remote->local */
	int fd;
	struct tcp_pcb *pcb;
	struct pbuf *pending;   /* bytes from the remote not yet written to fd */
	int remote_connected;
	int fd_eof;             /* local client finished sending */
	int remote_eof;         /* remote finished sending */
	int dead;
};

struct net_config {
	char addr[INET_ADDRSTRLEN];
	char dns[3][INET_ADDRSTRLEN];
	int mtu;
};

struct occore {
	occore_config cfg;
	occore_network_fn on_network; /* set in packet mode only */
	char *strings[9];       /* owned copies of cfg strings */

	struct openconnect_info *vpninfo;
	int cmd_fd;             /* openconnect command pipe */
	int oc_tun_fd;          /* openconnect side of the socketpair */
	int net_tun_fd;         /* lwIP side */
	int wake_rd, wake_wr;
	int listen_fd;
	uint16_t local_port;

	pthread_t oc_thread, net_thread;
	pthread_mutex_t lock;
	int pending_net;        /* guarded by lock */
	struct net_config net;  /* guarded by lock */
	int quit;               /* guarded by lock */
	int reopen_requested;   /* guarded by lock */
	unsigned reopen_generation; /* guarded by lock; bumped after each requested reopen */
	int reopen_result;      /* guarded by lock */
	pthread_cond_t reopened;
	int tun_attached;       /* oc thread only */

	/* net thread only */
	struct netif netif;
	int netif_up;
	ip_addr_t target_ip;
	int target_state;       /* 0 unresolved, 1 resolving, 2 resolved */
	struct conn *conns;
	unsigned next_conn_id;
	unsigned long long tun_tx, tun_rx; /* packets to / from the gateway */
	unsigned char pkt[AF_PREFIX_LEN + MAX_PACKET];
};

/* lwIP keeps global state, so there can only be one core at a time. */
static struct occore *g_core;

static void logf_(struct occore *core, int level, const char *fmt, ...)
{
	char buf[1024];
	va_list ap;
	if (!core->cfg.log)
		return;
	va_start(ap, fmt);
	vsnprintf(buf, sizeof(buf), fmt, ap);
	va_end(ap);
	core->cfg.log(core->cfg.ctx, level, buf);
}

static void set_state(struct occore *core, int state, const char *detail)
{
	if (core->cfg.on_state)
		core->cfg.on_state(core->cfg.ctx, state, detail);
}

static void wake(struct occore *core)
{
	char c = 'w';
	(void)!write(core->wake_wr, &c, 1);
}

static int set_nonblock(int fd)
{
	int flags = fcntl(fd, F_GETFL);
	return flags < 0 ? -1 : fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

u32_t sys_now(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (u32_t)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}

/* ---------- openconnect thread ---------- */

static void oc_progress(void *privdata, int level, const char *fmt, ...)
{
	struct occore *core = privdata;
	char buf[1024];
	va_list ap;
	size_t len;
	if (!core->cfg.log)
		return;
	va_start(ap, fmt);
	vsnprintf(buf, sizeof(buf), fmt, ap);
	va_end(ap);
	len = strlen(buf);
	while (len && (buf[len - 1] == '\n' || buf[len - 1] == '\r'))
		buf[--len] = 0;
	core->cfg.log(core->cfg.ctx, level, buf);
}

static int oc_validate_cert(void *privdata, const char *reason)
{
	struct occore *core = privdata;
	const char *hash = openconnect_get_peer_cert_hash(core->vpninfo);

	if (!core->cfg.server_cert_pin) {
		logf_(core, PRG_INFO, "Accepting unpinned gateway certificate (%s). Pin: %s",
		      reason, hash ? hash : "(unknown)");
		return 0;
	}
	if (openconnect_check_peer_cert_hash(core->vpninfo, core->cfg.server_cert_pin) == 0)
		return 0;
	logf_(core, PRG_ERR, "Gateway certificate does not match the pin. Got %s",
	      hash ? hash : "(unknown)");
	return 1;
}

static void oc_setup_tun(void *privdata)
{
	struct occore *core = privdata;
	const struct oc_ip_info *ip = NULL;

	if (openconnect_get_ip_info(core->vpninfo, &ip, NULL, NULL) || !ip || !ip->addr) {
		logf_(core, PRG_ERR, "Gateway did not assign an IPv4 address");
		return;
	}

	if (core->on_network) {
		int mtu = ip->mtu > 0 ? ip->mtu : 1400;
		if (!core->tun_attached) {
			if (openconnect_setup_tun_fd(core->vpninfo, core->oc_tun_fd)) {
				logf_(core, PRG_ERR, "openconnect_setup_tun_fd failed");
				return;
			}
			core->tun_attached = 1;
		}
		logf_(core, PRG_INFO, "Tunnel address %s, MTU %d; sign-in lifetime %d s, warn %d s before",
		      ip->addr, mtu, openconnect_get_gp_session_lifetime(core->vpninfo),
		      openconnect_get_gp_lifetime_notify_prior(core->vpninfo));
		core->on_network(core->cfg.ctx, ip->addr, ip->gateway_addr ? ip->gateway_addr : "", mtu,
				 ip->dns[0] ? ip->dns[0] : "",
				 ip->dns[1] ? ip->dns[1] : "", ip->dns[2] ? ip->dns[2] : "");
		set_state(core, OCCORE_CONNECTED, ip->addr);
		return;
	}

	pthread_mutex_lock(&core->lock);
	memset(&core->net, 0, sizeof(core->net));
	snprintf(core->net.addr, sizeof(core->net.addr), "%s", ip->addr);
	for (int i = 0; i < 3; i++)
		if (ip->dns[i])
			snprintf(core->net.dns[i], sizeof(core->net.dns[i]), "%s", ip->dns[i]);
	core->net.mtu = ip->mtu > 0 ? ip->mtu : 1400;
	core->pending_net = 1;
	pthread_mutex_unlock(&core->lock);

	if (!core->tun_attached) {
		if (openconnect_setup_tun_fd(core->vpninfo, core->oc_tun_fd)) {
			logf_(core, PRG_ERR, "openconnect_setup_tun_fd failed");
			return;
		}
		core->tun_attached = 1;
	}
	logf_(core, PRG_INFO, "Tunnel address %s, MTU %d; sign-in lifetime %d s, warn %d s before",
	      ip->addr, core->net.mtu, openconnect_get_gp_session_lifetime(core->vpninfo),
	      openconnect_get_gp_lifetime_notify_prior(core->vpninfo));
	wake(core);
}

static void oc_reconnected(void *privdata)
{
	set_state(privdata, OCCORE_CONNECTED, "reconnected");
}

static void *oc_thread_main(void *arg)
{
	struct occore *core = arg;
	struct openconnect_info *v = core->vpninfo;
	int ret;
	char detail[128];

	set_state(core, OCCORE_CONNECTING, NULL);

	ret = openconnect_make_cstp_connection(v);
	if (ret) {
		snprintf(detail, sizeof(detail), "connect failed: %s", strerror(-ret));
		set_state(core, OCCORE_STOPPED, detail);
		return NULL;
	}
	/*
	 * TLS only unless asked: a UDP (ESP) path can die silently, as it does while the app is
	 * suspended, and traffic then vanishes until dead-peer detection, about 50 s. TLS fails loudly
	 * and reconnects at once. T3's traffic does not need ESP's lower latency.
	 */
	if (!core->cfg.use_esp || openconnect_setup_dtls(v, 60))
		openconnect_disable_dtls(v);

	/* Returns 0 only for a pause/detach command, which we never send. */
	do {
		ret = openconnect_mainloop(v, 300, 10);
	} while (ret == 0);

	snprintf(detail, sizeof(detail), "%s",
		 ret == -EINTR ? "stopped" :
		 ret == -EPERM ? "gateway rejected the cookie" :
		 ret == -EPIPE ? "gateway closed the session" : strerror(-ret));
	set_state(core, OCCORE_STOPPED, detail);
	return NULL;
}

/* ---------- lwIP netif over the socketpair ---------- */

static err_t tun_output(struct netif *netif, struct pbuf *p, const ip4_addr_t *dst)
{
	struct occore *core = netif->state;
	uint32_t af = htonl(AF_INET);
	(void)dst;

	if (p->tot_len > MAX_PACKET)
		return ERR_BUF;
	memcpy(core->pkt, &af, AF_PREFIX_LEN);
	pbuf_copy_partial(p, core->pkt + AF_PREFIX_LEN, p->tot_len, 0);
	if (send(core->net_tun_fd, core->pkt, AF_PREFIX_LEN + p->tot_len, 0) < 0)
		return ERR_IF; /* datagram dropped; TCP will retransmit */
	core->tun_tx++;
	return ERR_OK;
}

static err_t tun_netif_init(struct netif *netif)
{
	netif->name[0] = 'o';
	netif->name[1] = 'c';
	netif->output = tun_output;
	return ERR_OK;
}

static void tun_input(struct occore *core)
{
	for (;;) {
		ssize_t n = recv(core->net_tun_fd, core->pkt, sizeof(core->pkt), 0);
		struct pbuf *p;
		if (n <= AF_PREFIX_LEN)
			return;
		if (!core->netif_up)
			continue;
		core->tun_rx++;
		n -= AF_PREFIX_LEN;
		p = pbuf_alloc(PBUF_RAW, (u16_t)n, PBUF_POOL);
		if (!p)
			continue;
		pbuf_take(p, core->pkt + AF_PREFIX_LEN, (u16_t)n);
		if (core->netif.input(p, &core->netif) != ERR_OK)
			pbuf_free(p);
	}
}

/* ---------- forwarded connections ---------- */

static void conn_flush(struct conn *c)
{
	while (c->pending) {
		ssize_t n = write(c->fd, c->pending->payload, c->pending->len);
		if (n < 0) {
			if (errno != EAGAIN && errno != EWOULDBLOCK)
				c->dead = 1;
			return;
		}
		c->received += (unsigned long long)n;
		if (c->pcb)
			tcp_recved(c->pcb, (u16_t)n);
		c->pending = pbuf_free_header(c->pending, (u16_t)n);
	}
	if (c->remote_eof)
		shutdown(c->fd, SHUT_WR);
}

static err_t conn_recv(void *arg, struct tcp_pcb *pcb, struct pbuf *p, err_t err)
{
	struct conn *c = arg;
	(void)pcb;
	(void)err;
	if (!c)
		return ERR_OK;
	if (!p) {
		c->remote_eof = 1;
	} else if (c->pending) {
		pbuf_cat(c->pending, p);
	} else {
		c->pending = p;
	}
	conn_flush(c);
	return ERR_OK;
}

static err_t conn_connected(void *arg, struct tcp_pcb *pcb, err_t err)
{
	struct conn *c = arg;
	(void)pcb;
	(void)err;
	if (c) {
		c->remote_connected = 1;
		logf_(c->core, PRG_INFO, "Forward #%u: connected to target", c->id);
	}
	return ERR_OK;
}

static void conn_err(void *arg, err_t err)
{
	struct conn *c = arg;
	if (!c)
		return;
	/* lwIP has already freed the pcb. */
	c->pcb = NULL;
	c->dead = 1;
	/* lwIP err_t: -13 aborted, -14 reset, -15 closed, -4 routing, -3 timeout. */
	logf_(c->core, PRG_ERR, "Forward #%u: %s (lwIP err %d)", c->id,
	      c->remote_connected ? "connection reset" : "connect failed", err);
}

static void conn_start(struct conn *c)
{
	struct occore *core = c->core;
	c->pcb = tcp_new();
	if (!c->pcb) {
		c->dead = 1;
		return;
	}
	tcp_arg(c->pcb, c);
	tcp_recv(c->pcb, conn_recv);
	tcp_err(c->pcb, conn_err);
	if (tcp_connect(c->pcb, &core->target_ip, core->cfg.target_port, conn_connected) != ERR_OK) {
		tcp_abort(c->pcb);
		c->pcb = NULL;
		c->dead = 1;
	}
}

static void conn_free(struct conn *c)
{
	if (c->pcb) {
		tcp_arg(c->pcb, NULL);
		tcp_recv(c->pcb, NULL);
		tcp_err(c->pcb, NULL);
		if (tcp_close(c->pcb) != ERR_OK)
			tcp_abort(c->pcb);
	}
	if (c->pending)
		pbuf_free(c->pending);
	close(c->fd);
	free(c);
}

static void conn_read_local(struct conn *c)
{
	char buf[READ_CHUNK];
	size_t room = tcp_sndbuf(c->pcb);
	ssize_t n;

	if (room > sizeof(buf))
		room = sizeof(buf);
	n = read(c->fd, buf, room);
	if (n > 0) {
		c->sent += (unsigned long long)n;
		if (tcp_write(c->pcb, buf, (u16_t)n, TCP_WRITE_FLAG_COPY) != ERR_OK)
			c->dead = 1;
		else
			tcp_output(c->pcb);
	} else if (n == 0) {
		c->fd_eof = 1;
		tcp_shutdown(c->pcb, 0, 1);
	} else if (errno != EAGAIN && errno != EWOULDBLOCK) {
		c->dead = 1;
	}
}

static void target_resolved(const char *name, const ip_addr_t *addr, void *arg)
{
	struct occore *core = arg;
	if (!addr) {
		logf_(core, PRG_ERR, "Could not resolve %s through the VPN", name);
		core->target_state = 0;
		for (struct conn *c = core->conns; c; c = c->next)
			c->dead = 1;
		return;
	}
	core->target_ip = *addr;
	core->target_state = 2;
	logf_(core, PRG_INFO, "Resolved %s to %s", name, ipaddr_ntoa(addr));
	for (struct conn *c = core->conns; c; c = c->next)
		if (!c->pcb && !c->dead)
			conn_start(c);
}

static void resolve_target(struct occore *core)
{
	ip_addr_t addr;
	err_t err;
	if (core->target_state)
		return;
	core->target_state = 1;
	err = dns_gethostbyname(core->cfg.target_host, &addr, target_resolved, core);
	if (err == ERR_OK)
		target_resolved(core->cfg.target_host, &addr, core);
	else if (err != ERR_INPROGRESS)
		target_resolved(core->cfg.target_host, NULL, core);
}

static int bind_listener(struct occore *core, uint16_t port);

/*
 * Net thread only. iOS reclaims a suspended app's listening sockets (Apple TN2277): after the
 * phone has been locked a while, the listener looks open but never accepts again, while the
 * VPN itself reconnects on its own. The listener is replaced, on the same port when possible so
 * the app's next connection attempt needs nothing new.
 */
static int reopen_listener(struct occore *core)
{
	uint16_t port = core->local_port;
	int ret;

	if (core->listen_fd >= 0)
		close(core->listen_fd);
	core->listen_fd = -1;
	ret = bind_listener(core, port);
	if (ret) {
		if (core->listen_fd >= 0)
			close(core->listen_fd);
		core->listen_fd = -1;
		ret = bind_listener(core, 0);
	}
	if (ret)
		logf_(core, PRG_ERR, "Local forward could not be reopened: %s", strerror(-ret));
	else
		logf_(core, PRG_INFO, "Local forward reopened on 127.0.0.1:%u", core->local_port);
	return ret;
}

static void accept_local(struct occore *core)
{
	for (;;) {
		int one = 1;
		int fd = accept(core->listen_fd, NULL, NULL);
		struct conn *c;
		if (fd < 0) {
			/* A client that gave up in the backlog is not the listener's fault. */
			if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR || errno == ECONNABORTED)
				return;
			logf_(core, PRG_INFO, "Local forward failed (%s)", strerror(errno));
			reopen_listener(core);
			return;
		}
		set_nonblock(fd);
		setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
		setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
		c = calloc(1, sizeof(*c));
		if (!c) {
			close(fd);
			continue;
		}
		c->core = core;
		c->id = ++core->next_conn_id;
		c->fd = fd;
		logf_(core, PRG_INFO, "Forward #%u: accepted", c->id);
		c->next = core->conns;
		core->conns = c;
		if (core->target_state == 2)
			conn_start(c);
		else
			resolve_target(core);
	}
}

/* ---------- net thread ---------- */

static void apply_net_config(struct occore *core)
{
	struct net_config net;
	ip4_addr_t addr, mask, gw;

	pthread_mutex_lock(&core->lock);
	if (!core->pending_net) {
		pthread_mutex_unlock(&core->lock);
		return;
	}
	net = core->net;
	core->pending_net = 0;
	pthread_mutex_unlock(&core->lock);

	ip4addr_aton(net.addr, &addr);
	IP4_ADDR(&mask, 255, 255, 255, 255);
	IP4_ADDR(&gw, 0, 0, 0, 0);

	if (!core->netif_up) {
		netif_add(&core->netif, &addr, &mask, &gw, core, tun_netif_init, ip_input);
		netif_set_default(&core->netif);
		netif_set_link_up(&core->netif);
		netif_set_up(&core->netif);
		core->netif_up = 1;
	} else {
		netif_set_addr(&core->netif, &addr, &mask, &gw);
	}
	core->netif.mtu = (u16_t)net.mtu;

	for (int i = 0; i < 3; i++) {
		ip_addr_t dns;
		if (net.dns[i][0] && ipaddr_aton(net.dns[i], &dns))
			dns_setserver((u8_t)i, &dns);
	}
	if (ipaddr_aton(core->cfg.target_host, &core->target_ip))
		core->target_state = 2;

	set_state(core, OCCORE_CONNECTED, net.addr);
}

static void *net_thread_main(void *arg)
{
	struct occore *core = arg;
	struct pollfd *fds = NULL;
	struct conn **fd_conns = NULL;
	size_t cap = 0;

	for (;;) {
		size_t n = 0, count = 3;
		u32_t sleep_ms;
		int quit;

		int reopen;

		pthread_mutex_lock(&core->lock);
		quit = core->quit;
		reopen = core->reopen_requested;
		core->reopen_requested = 0;
		pthread_mutex_unlock(&core->lock);
		if (quit)
			break;
		if (reopen) {
			int ret = reopen_listener(core);
			pthread_mutex_lock(&core->lock);
			core->reopen_result = ret;
			core->reopen_generation++;
			pthread_cond_broadcast(&core->reopened);
			pthread_mutex_unlock(&core->lock);
		}

		apply_net_config(core);

		/* Reap finished connections. */
		for (struct conn **pp = &core->conns; *pp;) {
			struct conn *c = *pp;
			int done = c->fd_eof && c->remote_eof && !c->pending;
			if (c->dead || done) {
				*pp = c->next;
				logf_(core, PRG_INFO,
				      "Forward #%u: closed%s (sent %llu, received %llu bytes; tunnel packets out %llu, in %llu)",
				      c->id, c->dead ? " with error" : "", c->sent, c->received, core->tun_tx,
				      core->tun_rx);
				conn_free(c);
			} else {
				pp = &c->next;
			}
		}

		for (struct conn *c = core->conns; c; c = c->next)
			count++;
		if (count > cap) {
			cap = count * 2;
			fds = realloc(fds, cap * sizeof(*fds));
			fd_conns = realloc(fd_conns, cap * sizeof(*fd_conns));
		}

		fds[n++] = (struct pollfd){ .fd = core->wake_rd, .events = POLLIN };
		fds[n++] = (struct pollfd){ .fd = core->net_tun_fd, .events = POLLIN };
		/* Leave new clients in the accept backlog until the tunnel is up. */
		fds[n++] = (struct pollfd){ .fd = core->listen_fd, .events = core->netif_up ? POLLIN : 0 };
		for (struct conn *c = core->conns; c; c = c->next) {
			short ev = 0;
			if (c->remote_connected && c->pcb && !c->fd_eof && tcp_sndbuf(c->pcb) > 0)
				ev |= POLLIN;
			if (c->pending)
				ev |= POLLOUT;
			fd_conns[n] = c;
			fds[n++] = (struct pollfd){ .fd = c->fd, .events = ev };
		}

		sleep_ms = sys_timeouts_sleeptime();
		if (poll(fds, (nfds_t)n, sleep_ms == SYS_TIMEOUTS_SLEEPTIME_INFINITE ? 1000 : (int)sleep_ms) < 0 &&
		    errno != EINTR)
			break;

		if (fds[0].revents) {
			char buf[64];
			while (read(core->wake_rd, buf, sizeof(buf)) > 0)
				;
		}
		if (fds[1].revents & POLLIN)
			tun_input(core);
		if (fds[2].revents & (POLLERR | POLLHUP | POLLNVAL)) {
			logf_(core, PRG_INFO, "Local forward was closed by the system");
			reopen_listener(core);
		} else if (fds[2].revents & POLLIN) {
			accept_local(core);
		}
		for (size_t i = 3; i < n; i++) {
			struct conn *c = fd_conns[i];
			if (c->dead)
				continue;
			if (fds[i].revents & (POLLERR | POLLNVAL))
				c->dead = 1;
			else if (fds[i].revents & POLLOUT)
				conn_flush(c);
			if (!c->dead && (fds[i].revents & (POLLIN | POLLHUP)) && c->pcb && c->remote_connected && !c->fd_eof)
				conn_read_local(c);
		}

		sys_check_timeouts();
	}

	while (core->conns) {
		struct conn *c = core->conns;
		core->conns = c->next;
		conn_free(c);
	}
	free(fds);
	free(fd_conns);
	return NULL;
}

/* ---------- public API ---------- */

static const char *own(struct occore *core, int slot, const char *s)
{
	core->strings[slot] = s ? strdup(s) : NULL;
	return core->strings[slot];
}

static void core_free(struct occore *core)
{
	if (core->vpninfo)
		openconnect_vpninfo_free(core->vpninfo); /* closes cmd_fd, and oc_tun_fd once attached */
	if (!core->tun_attached && core->oc_tun_fd >= 0)
		close(core->oc_tun_fd);
	if (core->net_tun_fd >= 0)
		close(core->net_tun_fd);
	if (core->listen_fd >= 0)
		close(core->listen_fd);
	if (core->wake_rd >= 0)
		close(core->wake_rd);
	if (core->wake_wr >= 0)
		close(core->wake_wr);
	pthread_cond_destroy(&core->reopened);
	pthread_mutex_destroy(&core->lock);
	for (size_t i = 0; i < sizeof(core->strings) / sizeof(core->strings[0]); i++)
		free(core->strings[i]);
	free(core);
	g_core = NULL;
}

static int bind_listener(struct occore *core, uint16_t port)
{
	struct sockaddr_in sa = { .sin_family = AF_INET, .sin_port = htons(port) };
	socklen_t len = sizeof(sa);
	int one = 1;

	sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	core->listen_fd = socket(AF_INET, SOCK_STREAM, 0);
	if (core->listen_fd < 0)
		return -errno;
	setsockopt(core->listen_fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
	if (bind(core->listen_fd, (struct sockaddr *)&sa, sizeof(sa)) || listen(core->listen_fd, 64) ||
	    getsockname(core->listen_fd, (struct sockaddr *)&sa, &len))
		return -errno;
	set_nonblock(core->listen_fd);
	core->local_port = ntohs(sa.sin_port);
	return 0;
}

static int start(const occore_config *config, occore_network_fn on_network, occore **out,
		 int *packet_fd)
{
	struct occore *core;
	int pair[2], wake_pipe[2], ret;
	static int lwip_ready;
	int packets = on_network != NULL;

	if (g_core)
		return -EBUSY;
	if (!config->gateway || !config->cookie ||
	    (!packets && (!config->target_host || !config->target_port)))
		return -EINVAL;

	signal(SIGPIPE, SIG_IGN);

	core = calloc(1, sizeof(*core));
	if (!core)
		return -ENOMEM;
	g_core = core;
	core->oc_tun_fd = core->net_tun_fd = core->listen_fd = core->wake_rd = core->wake_wr = -1;
	pthread_mutex_init(&core->lock, NULL);
	pthread_cond_init(&core->reopened, NULL);

	core->cfg = *config;
	core->cfg.gateway = own(core, 0, config->gateway);
	core->cfg.cookie = own(core, 1, config->cookie);
	core->cfg.server_cert_pin = own(core, 2, config->server_cert_pin);
	core->cfg.os = own(core, 3, config->os);
	core->cfg.os_version = own(core, 4, config->os_version);
	core->cfg.client_version = own(core, 5, config->client_version);
	core->cfg.user_agent = own(core, 6, config->user_agent ? config->user_agent : "PAN GlobalProtect");
	core->cfg.local_hostname = own(core, 7, config->local_hostname);
	core->cfg.target_host = own(core, 8, config->target_host);
	core->on_network = on_network;

	if (!packets && (ret = bind_listener(core, config->local_port)))
		goto fail;
	if (socketpair(AF_UNIX, SOCK_DGRAM, 0, pair) || pipe(wake_pipe)) {
		ret = -errno;
		goto fail;
	}
	core->oc_tun_fd = pair[0];
	core->net_tun_fd = pair[1];
	core->wake_rd = wake_pipe[0];
	core->wake_wr = wake_pipe[1];
	set_nonblock(core->net_tun_fd);
	set_nonblock(core->wake_rd);
	set_nonblock(core->wake_wr);

	if (!packets && !lwip_ready) {
		lwip_init();
		lwip_ready = 1;
	}

	openconnect_init_ssl();
	core->vpninfo = openconnect_vpninfo_new(core->cfg.user_agent, oc_validate_cert, NULL, NULL,
						oc_progress, core);
	if (!core->vpninfo) {
		ret = -ENOMEM;
		goto fail;
	}
	openconnect_set_loglevel(core->vpninfo, PRG_INFO);
	if (core->cfg.server_cert_pin)
		openconnect_set_system_trust(core->vpninfo, 0);
	if ((ret = openconnect_set_protocol(core->vpninfo, "gp")) ||
	    (ret = openconnect_parse_url(core->vpninfo, core->cfg.gateway)) ||
	    (ret = openconnect_set_cookie(core->vpninfo, core->cfg.cookie)))
		goto fail;
	openconnect_set_useragent(core->vpninfo, core->cfg.user_agent);
	if (core->cfg.os)
		openconnect_set_reported_os(core->vpninfo, core->cfg.os);
	if (core->cfg.os_version)
		openconnect_set_gp_os_version(core->vpninfo, core->cfg.os_version);
	if (core->cfg.client_version)
		openconnect_set_gp_app_version(core->vpninfo, core->cfg.client_version);
	if (core->cfg.local_hostname)
		openconnect_set_localname(core->vpninfo, core->cfg.local_hostname);
	openconnect_set_setup_tun_handler(core->vpninfo, oc_setup_tun);
	openconnect_set_reconnected_handler(core->vpninfo, oc_reconnected);

	core->cmd_fd = openconnect_setup_cmd_pipe(core->vpninfo);
	if (core->cmd_fd < 0) {
		ret = -EIO;
		goto fail;
	}

	if (packets) {
		if ((ret = -pthread_create(&core->oc_thread, NULL, oc_thread_main, core)))
			goto fail;
		*packet_fd = core->net_tun_fd;
		*out = core;
		return 0;
	}
	if ((ret = -pthread_create(&core->net_thread, NULL, net_thread_main, core)))
		goto fail;
	if ((ret = -pthread_create(&core->oc_thread, NULL, oc_thread_main, core))) {
		pthread_mutex_lock(&core->lock);
		core->quit = 1;
		pthread_mutex_unlock(&core->lock);
		wake(core);
		pthread_join(core->net_thread, NULL);
		goto fail;
	}

	*out = core;
	return 0;

fail:
	core_free(core);
	return ret < 0 ? ret : -EIO;
}

int occore_start(const occore_config *config, occore **out)
{
	return start(config, NULL, out, NULL);
}

int occore_start_packets(const occore_config *config, occore_network_fn on_network, occore **out,
			 int *packet_fd)
{
	if (!on_network || !packet_fd)
		return -EINVAL;
	return start(config, on_network, out, packet_fd);
}

int occore_session_lifetime(const occore *core)
{
	return openconnect_get_gp_session_lifetime(core->vpninfo);
}

int occore_lifetime_notify_prior(const occore *core)
{
	return openconnect_get_gp_lifetime_notify_prior(core->vpninfo);
}

uint16_t occore_local_port(const occore *core)
{
	return core->local_port;
}

int occore_reopen_listener(occore *core)
{
	struct timespec deadline;
	unsigned generation;
	int ret = -ETIMEDOUT;

	if (core->on_network)
		return -EINVAL; /* packet mode has no local forward */
	clock_gettime(CLOCK_REALTIME, &deadline);
	deadline.tv_sec += 3;

	pthread_mutex_lock(&core->lock);
	generation = core->reopen_generation;
	core->reopen_requested = 1;
	pthread_mutex_unlock(&core->lock);
	wake(core);

	pthread_mutex_lock(&core->lock);
	while (core->reopen_generation == generation && !core->quit) {
		if (pthread_cond_timedwait(&core->reopened, &core->lock, &deadline) == ETIMEDOUT)
			break;
	}
	if (core->reopen_generation != generation)
		ret = core->reopen_result;
	pthread_mutex_unlock(&core->lock);
	return ret;
}

void occore_stop(occore *core)
{
	char cmd = OC_CMD_CANCEL;

	(void)!write(core->cmd_fd, &cmd, 1);
	pthread_join(core->oc_thread, NULL);

	if (core->on_network) {
		core_free(core);
		return;
	}

	pthread_mutex_lock(&core->lock);
	core->quit = 1;
	pthread_cond_broadcast(&core->reopened);
	pthread_mutex_unlock(&core->lock);
	wake(core);
	pthread_join(core->net_thread, NULL);

	if (core->netif_up)
		netif_remove(&core->netif);
	core_free(core);
}
