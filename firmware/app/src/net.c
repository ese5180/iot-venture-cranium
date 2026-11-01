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

#include <supp_events.h>

#include "app_events.h"
#include "console.h"

LOG_MODULE_REGISTER(net, CONFIG_APP_LOG_LEVEL);

/*
 * Up means IPv4, which is what the cloud is reached over. NET_EVENT_L4_CONNECTED is not
 * good enough: it comes with whichever address arrives first, DHCP waits up to ten seconds
 * before it even starts, and it does not come again when the IPv4 address follows.
 */
#define L4_EVENTS    (NET_EVENT_L4_IPV4_CONNECTED | NET_EVENT_L4_IPV4_DISCONNECTED)
#define CONN_EVENTS  (NET_EVENT_CONN_IF_FATAL_ERROR)
#define WIFI_EVENTS  (NET_EVENT_WIFI_CONNECT_RESULT)
#define RETRY_SECONDS 30
#define MAX_STORED_NETWORKS CONFIG_WIFI_CREDENTIALS_MAX_ENTRIES

/* Why a join failed, next to the connect results that the Wi-Fi stack reports. */
#define JOIN_FAILED_SECURITY (WIFI_STATUS_CONN_LAST_STATUS + 1)
#define JOIN_FAILED_NO_ANSWER (WIFI_STATUS_CONN_LAST_STATUS + 2)
#define JOIN_FAILED_REQUEST (WIFI_STATUS_CONN_LAST_STATUS + 3)

static struct net_mgmt_event_callback l4_callback;
static struct net_mgmt_event_callback conn_callback;
static struct net_mgmt_event_callback wifi_callback;

static atomic_t link_up;
/* See net_wifi_answers(). net_connect() does not touch it, unlike the two below. */
static atomic_t wifi_answers;
/* The reason last reported since the last attempt began: it is said only once. */
static atomic_t last_failure;
static int seconds_down;
/* The supplicant has said that it is ready, once. See net_connect(). */
static atomic_t stack_ready;
/* net_connect() was called before that, and it is to be called again when it comes. */
static atomic_t join_waiting;

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

/* From any thread: only hand it over. The main loop says it on the console. */
static void post_join_failed(int reason)
{
	const struct app_event event = {
		.type = APP_EVENT_NET_JOIN_FAILED,
		.join_failed.reason = (int16_t)reason,
	};

	if (atomic_set(&last_failure, reason) != reason) {
		(void)app_event_post(&event);
	}
}

static void on_l4_event(struct net_mgmt_event_callback *callback, uint64_t event,
			struct net_if *iface)
{
	ARG_UNUSED(callback);
	ARG_UNUSED(iface);

	if (event == NET_EVENT_L4_IPV4_CONNECTED) {
		if (!link_is_acceptable()) {
			post_join_failed(JOIN_FAILED_SECURITY);
			return;
		}
		atomic_set(&link_up, 1);
		atomic_set(&last_failure, 0);
		(void)app_event_post_simple(APP_EVENT_NET_UP);
	} else if (event == NET_EVENT_L4_IPV4_DISCONNECTED) {
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

/*
 * A wrong password never gets as far as an L4 event. This is where it shows, together
 * with a network that cannot be found. The Wi-Fi stack retries by itself, so the same
 * reason can come many times.
 */
static void on_wifi_event(struct net_mgmt_event_callback *callback, uint64_t event,
			  struct net_if *iface)
{
	const struct wifi_status *status = callback->info;

	ARG_UNUSED(iface);

	if (event == NET_EVENT_WIFI_CONNECT_RESULT) {
		atomic_inc(&wifi_answers);
	}

	if (event == NET_EVENT_WIFI_CONNECT_RESULT && status != NULL && status->status != 0) {
		post_join_failed(status->status);
	}
}

/*
 * Registered at build time and not in net_init(), which may run after the event has come. It can
 * come again later, after the driver's recovery, when nobody is waiting for it.
 */
static void on_supplicant_ready(uint64_t event, struct net_if *iface, void *info, size_t length,
				void *user_data)
{
	ARG_UNUSED(iface);
	ARG_UNUSED(info);
	ARG_UNUSED(length);
	ARG_UNUSED(user_data);

	if (event != NET_EVENT_SUPPLICANT_READY) {
		return;
	}

	atomic_set(&stack_ready, 1);

	if (atomic_set(&join_waiting, 0)) {
		(void)app_event_post_simple(APP_EVENT_NET_JOIN);
	}
}

NET_MGMT_REGISTER_EVENT_HANDLER(supplicant_ready_handler, NET_EVENT_SUPPLICANT_READY,
				on_supplicant_ready, NULL);

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

	net_mgmt_init_event_callback(&wifi_callback, on_wifi_event, WIFI_EVENTS);
	net_mgmt_add_event_callback(&wifi_callback);

	/* false: see net_connect(). This must not wait for the Wi-Fi stack. */
	err = conn_mgr_all_if_up(false);
	if (err) {
		LOG_ERR("Network interface could not be brought up: %d", err);
		return err;
	}

	prune_disallowed_networks();
	return 0;
}

/*
 * False: on_supplicant_ready() posts APP_EVENT_NET_JOIN when the event comes, so this gets called
 * again. If the event comes during this call, whoever takes the flag acts on it: one join, not two.
 */
static bool stack_ready_or_join_later(void)
{
	if (atomic_get(&stack_ready)) {
		return true;
	}

	atomic_set(&join_waiting, 1);
	return atomic_get(&stack_ready) && atomic_set(&join_waiting, 0);
}

int net_connect(void)
{
	int err;

	if (wifi_credentials_is_empty()) {
		return -ENOENT;
	}

	seconds_down = 0;
	atomic_set(&last_failure, 0);

	/*
	 * A chip that did not come up must not stop the main thread here. Until the supplicant is
	 * ready, conn_mgr's thread holds conn_mgr_mon_lock and the binding's lock, and waits for it
	 * with no limit in net_l2_wifi_init(). The main thread would then stop with it, with no tick,
	 * and only the watchdog could restart the board, with no reason and no back-off.
	 *
	 * So the interface comes first, with skip_ignored false: true looks at what is ignored under
	 * conn_mgr_mon_lock. False goes straight to net_if_up(), which returns the driver's error. On
	 * an interface that is up already, it does nothing.
	 *
	 * conn_mgr_all_if_connect() takes both locks whatever it is given, so it has to wait for the
	 * supplicant. On a healthy chip the join then starts when the supplicant is ready, which is
	 * when it started while the main thread waited here, and nothing is said on the console. If
	 * that does not happen, net_tick() says `no answer`, which is what it is.
	 */
	err = conn_mgr_all_if_up(false);
	if (err == 0 || err == -EALREADY) {
		if (!stack_ready_or_join_later()) {
			return -EAGAIN;
		}

		err = conn_mgr_all_if_connect(true);
	}

	if (err) {
		LOG_WRN("Connection request failed: %d", err);
		post_join_failed(JOIN_FAILED_REQUEST);
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
		/* Neither a result nor a connection: nobody has said anything about it yet. */
		if (atomic_get(&last_failure) == 0) {
			net_report_join_failed(JOIN_FAILED_NO_ANSWER);
		}

		LOG_INF("Still offline: trying to join the network again");
		(void)net_connect();
	}
}

static const char *join_failure_text(int reason)
{
	switch (reason) {
	case WIFI_STATUS_CONN_WRONG_PASSWORD:
		return "wrong password";
	case WIFI_STATUS_CONN_AP_NOT_FOUND:
		return "network not found";
	case WIFI_STATUS_CONN_TIMEOUT:
	case -ETIMEDOUT:
		return "timeout";
	case JOIN_FAILED_SECURITY:
		return "security mode not allowed";
	case JOIN_FAILED_NO_ANSWER:
		return "no answer";
	case JOIN_FAILED_REQUEST:
		return "request refused";
	default:
		return "connection failed";
	}
}

void net_report_join_failed(int reason)
{
	console_event("WIFI", "failed reason=%s", join_failure_text(reason));
}

/* The address as text, or an empty string when there is none. */
static void ip_address(char *buf, size_t len)
{
	struct net_if *iface = net_if_get_first_wifi();
	struct net_in_addr *address =
		iface != NULL ? net_if_ipv4_get_global_addr(iface, NET_ADDR_PREFERRED) : NULL;

	buf[0] = '\0';
	if (address != NULL) {
		(void)net_addr_ntop(NET_AF_INET, address, buf, len);
	}
}

void net_report_up(void)
{
	char ip[NET_IPV4_ADDR_LEN];

	ip_address(ip, sizeof(ip));
	console_event("WIFI", "connected ip=%s rssi=%d", ip[0] != '\0' ? ip : "none", net_rssi());
}

void net_report_down(void)
{
	console_event("WIFI", "disconnected");
}

bool net_is_up(void)
{
	return atomic_get(&link_up) != 0;
}

uint32_t net_wifi_answers(void)
{
	return (uint32_t)atomic_get(&wifi_answers);
}

#if defined(CONFIG_APP_BT_OTA)
bool net_wifi_answered(void)
{
	return atomic_get(&wifi_answers) != 0;
}

bool net_wifi_associated(void)
{
	struct wifi_iface_status status;

	/* A stack that does not say is no stack to vouch for: this counts as Wi-Fi being there. */
	return link_status(&status) != 0 || status.state >= WIFI_STATE_ASSOCIATED;
}
#endif

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

static void copy_stored_ssid(void *arg, const char *ssid, size_t ssid_len)
{
	struct net_status *status = arg;

	/* One network per device: if there ever are more, the first is the one to show. */
	if (!status->stored && ssid_len <= NET_SSID_MAX) {
		memcpy(status->ssid, ssid, ssid_len);
		status->ssid[ssid_len] = '\0';
		status->stored = true;
	}
}

void net_status_get(struct net_status *status)
{
	memset(status, 0, sizeof(*status));

	wifi_credentials_for_each_ssid(copy_stored_ssid, status);

	status->connected = net_is_up();
	if (status->connected) {
		ip_address(status->ip, sizeof(status->ip));
		status->rssi = net_rssi();
	}

	if (net_mac_address(status->mac, sizeof(status->mac)) != 0) {
		status->mac[0] = '\0';
	}
}
