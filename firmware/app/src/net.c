#include "net.h"

#include <errno.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/net/conn_mgr_connectivity.h>
#include <zephyr/net/conn_mgr_monitor.h>
#include <zephyr/net/net_if.h>
#include <zephyr/net/net_mgmt.h>
#include <zephyr/net/wifi_credentials.h>
#include <zephyr/net/wifi_mgmt.h>
#include <zephyr/sys/atomic.h>

#include "app_events.h"

LOG_MODULE_REGISTER(net, CONFIG_APP_LOG_LEVEL);

#define L4_EVENTS    (NET_EVENT_L4_CONNECTED | NET_EVENT_L4_DISCONNECTED)
#define CONN_EVENTS  (NET_EVENT_CONN_IF_FATAL_ERROR)
#define RETRY_SECONDS 30
#define MAX_STORED_NETWORKS CONFIG_WIFI_CREDENTIALS_MAX_ENTRIES

static struct net_mgmt_event_callback l4_callback;
static struct net_mgmt_event_callback conn_callback;

static atomic_t link_up;
static int seconds_down;

static bool security_allowed(enum wifi_security_type type)
{
	switch (type) {
	case WIFI_SECURITY_TYPE_PSK:
	case WIFI_SECURITY_TYPE_PSK_SHA256:
	case WIFI_SECURITY_TYPE_SAE:
	case WIFI_SECURITY_TYPE_SAE_H2E:
	case WIFI_SECURITY_TYPE_SAE_AUTO:
		return true;
	default:
		/* Open, WEP, WPA (TKIP), mixed WPA/WPA2 and anything unknown. */
		return false;
	}
}

static int link_status(struct wifi_iface_status *status)
{
	struct net_if *iface = net_if_get_first_wifi();

	if (iface == NULL) {
		return -ENODEV;
	}

	memset(status, 0, sizeof(*status));
	return net_mgmt(NET_REQUEST_WIFI_IFACE_STATUS, iface, status, sizeof(*status));
}

/*
 * The stored credentials are checked before use, but the access point decides what is
 * actually negotiated. Check the result and leave a network that is not acceptable.
 */
static bool link_is_acceptable(void)
{
	struct wifi_iface_status status;

	if (link_status(&status) != 0) {
		return false;
	}

	if (!security_allowed(status.security)) {
		LOG_ERR("Leaving \"%s\": its security mode (%d) is not allowed", status.ssid,
			status.security);
		(void)net_mgmt(NET_REQUEST_WIFI_DISCONNECT, net_if_get_first_wifi(), NULL, 0);
		return false;
	}

	return true;
}

static void on_l4_event(struct net_mgmt_event_callback *callback, uint64_t event,
			struct net_if *iface)
{
	ARG_UNUSED(callback);
	ARG_UNUSED(iface);

	if (event == NET_EVENT_L4_CONNECTED) {
		if (!link_is_acceptable()) {
			return;
		}
		atomic_set(&link_up, 1);
		(void)app_event_post_simple(APP_EVENT_NET_UP);
	} else if (event == NET_EVENT_L4_DISCONNECTED) {
		if (atomic_set(&link_up, 0)) {
			(void)app_event_post_simple(APP_EVENT_NET_DOWN);
		}
	}
}

static void on_conn_event(struct net_mgmt_event_callback *callback, uint64_t event,
			  struct net_if *iface)
{
	ARG_UNUSED(callback);
	ARG_UNUSED(iface);

	if (event == NET_EVENT_CONN_IF_FATAL_ERROR) {
		/* Not fatal for the application: net_tick() tries again. */
		LOG_WRN("Network interface reported a connection error");
	}
}

struct prune_context {
	char ssids[MAX_STORED_NETWORKS][WIFI_SSID_MAX_LEN];
	size_t lengths[MAX_STORED_NETWORKS];
	size_t count;
};

static void collect_disallowed(void *arg, const char *ssid, size_t ssid_len)
{
	struct prune_context *context = arg;
	static struct wifi_credentials_personal stored;

	if (wifi_credentials_get_by_ssid_personal_struct(ssid, ssid_len, &stored) != 0) {
		return;
	}

	if (!security_allowed(stored.header.type) && context->count < MAX_STORED_NETWORKS &&
	    ssid_len <= WIFI_SSID_MAX_LEN) {
		memcpy(context->ssids[context->count], ssid, ssid_len);
		context->lengths[context->count] = ssid_len;
		context->count++;
	}

	memset(&stored, 0, sizeof(stored));
}

static void prune_disallowed_networks(void)
{
	static struct prune_context context;

	context.count = 0;
	wifi_credentials_for_each_ssid(collect_disallowed, &context);

	for (size_t i = 0; i < context.count; i++) {
		LOG_WRN("Removing a stored network whose security mode is not allowed");
		(void)wifi_credentials_delete_by_ssid(context.ssids[i], context.lengths[i]);
	}
}

int net_init(void)
{
	int err;

	net_mgmt_init_event_callback(&l4_callback, on_l4_event, L4_EVENTS);
	net_mgmt_add_event_callback(&l4_callback);

	net_mgmt_init_event_callback(&conn_callback, on_conn_event, CONN_EVENTS);
	net_mgmt_add_event_callback(&conn_callback);

	err = conn_mgr_all_if_up(true);
	if (err) {
		LOG_ERR("Network interface could not be brought up: %d", err);
		return err;
	}

	prune_disallowed_networks();
	return 0;
}

int net_connect(void)
{
	int err;

	if (wifi_credentials_is_empty()) {
		return -ENOENT;
	}

	seconds_down = 0;
	err = conn_mgr_all_if_connect(true);
	if (err) {
		LOG_WRN("Connection request failed: %d", err);
	}

	return err;
}

void net_tick(void)
{
	if (atomic_get(&link_up) || wifi_credentials_is_empty()) {
		seconds_down = 0;
		return;
	}

	if (++seconds_down >= RETRY_SECONDS) {
		LOG_INF("Still offline: trying to join the network again");
		(void)net_connect();
	}
}

bool net_is_up(void)
{
	return atomic_get(&link_up) != 0;
}

bool net_has_credentials(void)
{
	return !wifi_credentials_is_empty();
}

int net_credentials_set(const char *ssid, size_t ssid_len, enum net_security security,
			const char *passphrase, size_t passphrase_len)
{
	enum wifi_security_type type;
	uint32_t flags = 0;
	int err;

	if (ssid == NULL || passphrase == NULL || ssid_len == 0 ||
	    ssid_len > WIFI_SSID_MAX_LEN) {
		return -EINVAL;
	}

	switch (security) {
	case NET_SECURITY_WPA2_PSK:
		type = WIFI_SECURITY_TYPE_PSK;
		break;
	case NET_SECURITY_WPA2_PSK_SHA256:
		type = WIFI_SECURITY_TYPE_PSK_SHA256;
		break;
	case NET_SECURITY_WPA3_SAE:
		/* Accept both SAE methods; WPA3 requires protected management frames. */
		type = WIFI_SECURITY_TYPE_SAE_AUTO;
		flags |= WIFI_CREDENTIALS_FLAG_MFP_REQUIRED;
		break;
	default:
		return -EINVAL;
	}

	if (passphrase_len < WIFI_PSK_MIN_LEN ||
	    passphrase_len > WIFI_CREDENTIALS_MAX_PASSWORD_LEN) {
		return -EINVAL;
	}

	if (type != WIFI_SECURITY_TYPE_SAE_AUTO && passphrase_len > WIFI_PSK_MAX_LEN) {
		return -EINVAL;
	}

	/* One network per device: replace whatever was stored before. */
	(void)wifi_credentials_delete_all();

	err = wifi_credentials_set_personal(ssid, ssid_len, type, NULL, 0, passphrase,
					    passphrase_len, flags, 0, 0);
	if (err) {
		LOG_ERR("Storing the network failed: %d", err);
	}

	return err;
}

int net_credentials_clear(void)
{
	struct net_if *iface = net_if_get_first_wifi();

	if (iface != NULL) {
		(void)net_mgmt(NET_REQUEST_WIFI_DISCONNECT, iface, NULL, 0);
	}

	return wifi_credentials_delete_all();
}

int net_mac_address(char *buf, size_t len)
{
	struct net_if *iface = net_if_get_first_wifi();
	const struct net_linkaddr *link;
	int written;

	if (iface == NULL) {
		return -ENODEV;
	}

	link = net_if_get_link_addr(iface);
	if (link == NULL || link->len != 6) {
		return -ENODATA;
	}

	written = snprintk(buf, len, "%02x:%02x:%02x:%02x:%02x:%02x", link->addr[0], link->addr[1],
			   link->addr[2], link->addr[3], link->addr[4], link->addr[5]);
	return (written < 0 || written >= (int)len) ? -ENOSPC : 0;
}

int net_rssi(void)
{
	struct wifi_iface_status status;

	if (!net_is_up() || link_status(&status) != 0) {
		return 0;
	}

	return status.rssi;
}
