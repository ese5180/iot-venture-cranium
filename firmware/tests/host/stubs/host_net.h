/*
 * Host build: the network stack as net.c sees it, for test_app.c, which defines the functions
 * and raises the events.
 */
#ifndef HOST_STUB_NET_H_
#define HOST_STUB_NET_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Each its own bit, so a callback's mask can be checked as on the real thing. */
#define NET_EVENT_L4_CONNECTED         (1ULL << 0)
#define NET_EVENT_L4_DISCONNECTED      (1ULL << 1)
#define NET_EVENT_L4_IPV4_CONNECTED    (1ULL << 2)
#define NET_EVENT_L4_IPV4_DISCONNECTED (1ULL << 3)
#define NET_EVENT_L4_IPV6_CONNECTED    (1ULL << 4)
#define NET_EVENT_CONN_IF_FATAL_ERROR  (1ULL << 5)
#define NET_EVENT_WIFI_CONNECT_RESULT  (1ULL << 6)

struct net_if {
	int unused;
};

struct net_mgmt_event_callback {
	void (*handler)(struct net_mgmt_event_callback *callback, uint64_t event,
			struct net_if *iface);
	uint64_t mask;
	const void *info;
};

void net_mgmt_init_event_callback(struct net_mgmt_event_callback *callback,
				  void (*handler)(struct net_mgmt_event_callback *callback,
						  uint64_t event, struct net_if *iface),
				  uint64_t mask);
void net_mgmt_add_event_callback(struct net_mgmt_event_callback *callback);

enum net_request {
	NET_REQUEST_WIFI_IFACE_STATUS,
	NET_REQUEST_WIFI_DISCONNECT,
};
int net_mgmt(enum net_request request, struct net_if *iface, void *data, size_t length);

int conn_mgr_all_if_up(bool blocking);
int conn_mgr_all_if_connect(bool blocking);

struct net_in_addr {
	uint8_t bytes[4];
};
enum net_addr_state {
	NET_ADDR_PREFERRED,
};
#define NET_AF_INET       2
#define NET_IPV4_ADDR_LEN 16

struct net_linkaddr {
	uint8_t addr[6];
	uint8_t len;
};

struct net_if *net_if_get_first_wifi(void);
struct net_linkaddr *net_if_get_link_addr(struct net_if *iface);
struct net_in_addr *net_if_ipv4_get_global_addr(struct net_if *iface, enum net_addr_state state);
char *net_addr_ntop(int family, const void *address, char *buffer, size_t size);

enum wifi_security_type {
	WIFI_SECURITY_TYPE_NONE,
	WIFI_SECURITY_TYPE_PSK,
	WIFI_SECURITY_TYPE_PSK_SHA256,
	WIFI_SECURITY_TYPE_SAE,
	WIFI_SECURITY_TYPE_SAE_H2E,
	WIFI_SECURITY_TYPE_SAE_AUTO,
	WIFI_SECURITY_TYPE_WEP,
};

#define WIFI_SSID_MAX_LEN 32
#define WIFI_PSK_MIN_LEN  8
#define WIFI_PSK_MAX_LEN  64

enum wifi_conn_status {
	WIFI_STATUS_CONN_SUCCESS,
	WIFI_STATUS_CONN_FAIL,
	WIFI_STATUS_CONN_WRONG_PASSWORD,
	WIFI_STATUS_CONN_TIMEOUT,
	WIFI_STATUS_CONN_AP_NOT_FOUND,
	WIFI_STATUS_CONN_LAST_STATUS,
};

struct wifi_status {
	int status;
};

enum wifi_iface_state {
	WIFI_STATE_DISCONNECTED = 0,
	WIFI_STATE_SCANNING = 3,
	WIFI_STATE_ASSOCIATING = 5,
	WIFI_STATE_ASSOCIATED = 6,
	WIFI_STATE_COMPLETED = 9,
};

struct wifi_iface_status {
	char ssid[WIFI_SSID_MAX_LEN + 1];
	enum wifi_iface_state state;
	enum wifi_security_type security;
	int rssi;
};

#define WIFI_CREDENTIALS_FLAG_MFP_REQUIRED 1
#define WIFI_CREDENTIALS_MAX_PASSWORD_LEN  128

struct wifi_credentials_personal {
	struct {
		enum wifi_security_type type;
	} header;
};

bool wifi_credentials_is_empty(void);
void wifi_credentials_for_each_ssid(void (*callback)(void *arg, const char *ssid, size_t length),
				    void *arg);
int wifi_credentials_delete_all(void);
int wifi_credentials_set_personal(const char *ssid, size_t ssid_length,
				  enum wifi_security_type type, const uint8_t *bssid,
				  size_t bssid_length, const char *password,
				  size_t password_length, uint32_t flags, uint8_t channel,
				  uint32_t timeout);
int wifi_credentials_get_by_ssid_personal_struct(const char *ssid, size_t length,
						 struct wifi_credentials_personal *stored);
int wifi_credentials_delete_by_ssid(const char *ssid, size_t length);

#endif
