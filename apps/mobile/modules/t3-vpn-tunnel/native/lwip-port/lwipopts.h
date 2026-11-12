#ifndef OCCORE_LWIPOPTS_H
#define OCCORE_LWIPOPTS_H

/* Single-threaded lwIP driven by occore's poll loop. */
#define NO_SYS 1
#define SYS_LIGHTWEIGHT_PROT 0
#define LWIP_NETCONN 0
#define LWIP_SOCKET 0

#define LWIP_IPV4 1
#define LWIP_IPV6 0
#define LWIP_TCP 1
#define LWIP_UDP 1
#define LWIP_DNS 1
#define LWIP_ICMP 1
/* Raw ICMP, for occore_probe's ping. */
#define LWIP_RAW 1
#define LWIP_ARP 0
#define LWIP_ETHERNET 0
#define LWIP_DHCP 0
#define LWIP_AUTOIP 0
#define LWIP_IGMP 0
#define IP_REASSEMBLY 1
#define IP_FRAG 1

#define LWIP_NETIF_STATUS_CALLBACK 0
#define LWIP_NETIF_LINK_CALLBACK 0
#define LWIP_SINGLE_NETIF 1

/* Memory: generous; this runs on a phone, not a microcontroller. */
#define MEM_ALIGNMENT 8
#define MEM_SIZE (4 * 1024 * 1024)
#define MEMP_NUM_PBUF 256
#define MEMP_NUM_TCP_PCB 64
#define MEMP_NUM_TCP_PCB_LISTEN 4
#define MEMP_NUM_TCP_SEG 1024
#define MEMP_NUM_UDP_PCB 8
#define MEMP_NUM_RAW_PCB 2
#define MEMP_NUM_SYS_TIMEOUT 16
#define PBUF_POOL_SIZE 512

/* TCP tuned for a ~1400 byte tunnel MTU. */
#define TCP_MSS 1300
#define TCP_WND (48 * TCP_MSS)
#define TCP_SND_BUF (48 * TCP_MSS)
#define TCP_SND_QUEUELEN (4 * TCP_SND_BUF / TCP_MSS)
#define TCP_QUEUE_OOSEQ 1
#define LWIP_TCP_KEEPALIVE 1

#define DNS_MAX_SERVERS 3
#define DNS_TABLE_SIZE 4

#define LWIP_STATS 0
#define LWIP_DEBUG 0
#define LWIP_CHKSUM_ALGORITHM 3

/* libopenconnect exports its own udp_connect(); keep lwIP's out of its way. */
#define udp_connect lwip_udp_connect

#endif
