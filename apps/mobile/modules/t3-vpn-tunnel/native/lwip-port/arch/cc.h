#ifndef OCCORE_ARCH_CC_H
#define OCCORE_ARCH_CC_H

#include <stdio.h>
#include <stdlib.h>
#include <sys/time.h>
#include <arpa/inet.h>

/* Use the system htons/ntohl instead of lwIP's macro versions. */
#define LWIP_DONT_PROVIDE_BYTEORDER_FUNCTIONS 1
#define lwip_htons(x) htons(x)
#define lwip_htonl(x) htonl(x)

#define LWIP_TIMEVAL_PRIVATE 0
#define LWIP_ERRNO_STDINCLUDE 1
#define LWIP_RAND() ((u32_t)arc4random())

#define LWIP_PLATFORM_DIAG(x) do { printf x; } while (0)
#define LWIP_PLATFORM_ASSERT(x) do { fprintf(stderr, "lwip assert: %s\n", x); abort(); } while (0)

#endif
