/*
 * Host-side tests of main.c and net.c: when the board joins a network, what it says about
 * that on the console, and what LED1 shows. The real files are compiled here, against a fake
 * network stack whose events the tests raise, and fakes of the other modules. The console's
 * commands fake exactly this part, so these tests are where it gets looked at.
 *
 * What this cannot show is how the real Wi-Fi stack behaves: which events come, and when.
 */

#define CONFIG_WIFI_CREDENTIALS_MAX_ENTRIES 2
#define CONFIG_APP_CLOUD_RETRY_SECONDS      30
#define CONFIG_APP_SHADOW_INTERVAL_SECONDS  60

#include <errno.h>
#include <setjmp.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "net.c"

#define main cranium_main
#include "main.c"
#undef main

static int failures;
static int checks;

#define CHECK(condition)                                                                     \
	do {                                                                                 \
		checks++;                                                                    \
		if (!(condition)) {                                                          \
			failures++;                                                          \
			printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);         \
		}                                                                            \
	} while (0)

#define CHECK_TEXT(actual, expected)                                                         \
	do {                                                                                 \
		const char *actual_ = (actual);                                              \
		checks++;                                                                    \
		if (strcmp(actual_, (expected)) != 0) {                                      \
			failures++;                                                          \
			printf("FAIL %s:%d: \"%s\", expected \"%s\"\n", __FILE__, __LINE__,  \
			       actual_, (expected));                                         \
		}                                                                            \
	} while (0)

static struct {
	/* The board, as the other modules would have it. */
	enum device_boot boot_result;
	bool factory;
	bool has_settings;
	enum ota_state ota;
	bool cloud_up;
	int factory_resets;
	int reboots;
	int ota_buttons;
	int watchdog_feeds;
	enum ui_state ui;
	char console[2048];

	/* The network stack. */
	struct net_mgmt_event_callback *callbacks[4];
	int callback_count;
	bool network_stored;
	enum wifi_security_type link_security;
	bool has_address;
	int connect_requests;
	int disconnect_requests;
	int connect_result;
	const struct wifi_status *event_info;
#if defined(CONFIG_APP_BT_OTA)
	enum wifi_iface_state wifi_state;
	int status_result;
#endif
} board;

static jmp_buf out_of_the_event_loop;

/* ---- the kernel ----------------------------------------------------------------- */

int k_msgq_put(struct k_msgq *queue, const void *message, k_timeout_t timeout)
{
	ARG_UNUSED(timeout);

	if (queue->used == queue->capacity) {
		return -ENOMSG;
	}

	memcpy(queue->buffer + queue->used * queue->message_size, message, queue->message_size);
	queue->used++;
	return 0;
}

int k_msgq_get(struct k_msgq *queue, void *message, k_timeout_t timeout)
{
	ARG_UNUSED(timeout);

	/* Nothing to do: back to the test, as the real loop would go to sleep. */
	if (queue->used == 0) {
		longjmp(out_of_the_event_loop, 1);
	}

	memcpy(message, queue->buffer, queue->message_size);
	queue->used--;
	memmove(queue->buffer, queue->buffer + queue->message_size,
		queue->used * queue->message_size);
	return 0;
}

void k_timer_start(struct k_timer *timer, k_timeout_t duration, k_timeout_t period)
{
	ARG_UNUSED(timer);
	ARG_UNUSED(duration);
	ARG_UNUSED(period);
}

int32_t k_msleep(int32_t ms)
{
	ARG_UNUSED(ms);
	return 0;
}

int64_t k_uptime_get(void)
{
	return 0;
}

void k_oops(void)
{
}

void host_log_panic(void)
{
}

void sys_reboot(int type)
{
	ARG_UNUSED(type);
	board.reboots++;
}

/* ---- the network stack ---------------------------------------------------------- */

void net_mgmt_init_event_callback(struct net_mgmt_event_callback *callback,
				  void (*handler)(struct net_mgmt_event_callback *callback,
						  uint64_t event, struct net_if *iface),
				  uint64_t mask)
{
	callback->handler = handler;
	callback->mask = mask;
}

void net_mgmt_add_event_callback(struct net_mgmt_event_callback *callback)
{
	board.callbacks[board.callback_count++] = callback;
}

/* Only those who asked for an event get it, as on the real thing. */
static void raise_event(uint64_t event, const struct wifi_status *info)
{
	for (int i = 0; i < board.callback_count; i++) {
		if (board.callbacks[i]->mask & event) {
			board.callbacks[i]->info = info;
			board.callbacks[i]->handler(board.callbacks[i], event, NULL);
		}
	}
}

int net_mgmt(enum net_request request, struct net_if *iface, void *data, size_t length)
{
	ARG_UNUSED(iface);
	ARG_UNUSED(length);

	if (request == NET_REQUEST_WIFI_DISCONNECT) {
		board.disconnect_requests++;
	} else {
		struct wifi_iface_status *status = data;

		strcpy(status->ssid, "MyNetwork");
		status->security = board.link_security;
		status->rssi = -51;
#if defined(CONFIG_APP_BT_OTA)
		status->state = board.wifi_state;
		return board.status_result;
#endif
	}

	return 0;
}

int conn_mgr_all_if_up(bool blocking)
{
	ARG_UNUSED(blocking);
	return 0;
}

int conn_mgr_all_if_connect(bool blocking)
{
	ARG_UNUSED(blocking);
	board.connect_requests++;
	return board.connect_result;
}

struct net_if *net_if_get_first_wifi(void)
{
	static struct net_if iface;

	return &iface;
}

struct net_linkaddr *net_if_get_link_addr(struct net_if *iface)
{
	static struct net_linkaddr link = { { 0x02, 0x00, 0x00, 0x00, 0x00, 0x01 }, 6 };

	ARG_UNUSED(iface);
	return &link;
}

struct net_in_addr *net_if_ipv4_get_global_addr(struct net_if *iface, enum net_addr_state state)
{
	static struct net_in_addr address = { { 192, 168, 1, 42 } };

	ARG_UNUSED(iface);
	ARG_UNUSED(state);
	return board.has_address ? &address : NULL;
}

char *net_addr_ntop(int family, const void *address, char *buffer, size_t size)
{
	const uint8_t *bytes = address;

	ARG_UNUSED(family);
	snprintf(buffer, size, "%d.%d.%d.%d", bytes[0], bytes[1], bytes[2], bytes[3]);
	return buffer;
}

bool wifi_credentials_is_empty(void)
{
	return !board.network_stored;
}

void wifi_credentials_for_each_ssid(void (*callback)(void *arg, const char *ssid, size_t length),
				    void *arg)
{
	if (board.network_stored) {
		callback(arg, "MyNetwork", 9);
	}
}

int wifi_credentials_delete_all(void)
{
	board.network_stored = false;
	return 0;
}

int wifi_credentials_set_personal(const char *ssid, size_t ssid_length,
				  enum wifi_security_type type, const uint8_t *bssid,
				  size_t bssid_length, const char *password,
				  size_t password_length, uint32_t flags, uint8_t channel,
				  uint32_t timeout)
{
	ARG_UNUSED(ssid);
	ARG_UNUSED(ssid_length);
	ARG_UNUSED(type);
	ARG_UNUSED(bssid);
	ARG_UNUSED(bssid_length);
	ARG_UNUSED(password);
	ARG_UNUSED(password_length);
	ARG_UNUSED(flags);
	ARG_UNUSED(channel);
	ARG_UNUSED(timeout);
	board.network_stored = true;
	return 0;
}

int wifi_credentials_get_by_ssid_personal_struct(const char *ssid, size_t length,
						 struct wifi_credentials_personal *stored)
{
	ARG_UNUSED(ssid);
	ARG_UNUSED(length);
	stored->header.type = WIFI_SECURITY_TYPE_PSK;
	return 0;
}

int wifi_credentials_delete_by_ssid(const char *ssid, size_t length)
{
	ARG_UNUSED(ssid);
	ARG_UNUSED(length);
	return 0;
}

/* ---- the other modules ---------------------------------------------------------- */

void console_event(const char *tag, const char *format, ...)
{
	size_t used = strlen(board.console);
	va_list args;

	used += (size_t)snprintf(board.console + used, sizeof(board.console) - used, "[%s] ", tag);
	va_start(args, format);
	used += (size_t)vsnprintf(board.console + used, sizeof(board.console) - used, format, args);
	va_end(args);
	snprintf(board.console + used, sizeof(board.console) - used, "\n");
}

void console_start(void)
{
}

enum device_boot device_boot(void)
{
	return board.boot_result;
}

bool device_is_factory(void)
{
	return board.factory;
}

const char *device_id(void)
{
	return "fe5b26c0c5b1dcd7";
}

int factory_reset(void)
{
	board.factory_resets++;
	return 0;
}

int identity_init(void)
{
	return 0;
}

const char *identity_thing_name(void)
{
	return "cranium-fe5b26c0c5b1dcd7";
}

const struct identity_settings *identity_settings_get(void)
{
	static const struct identity_settings settings;

	return board.has_settings ? &settings : NULL;
}

int health_init(void)
{
	return 0;
}

void health_feed(void)
{
	board.watchdog_feeds++;
}

int ui_init(void)
{
	return 0;
}

void ui_set_state(enum ui_state state)
{
	board.ui = state;
}

const char *fw_version_running_string(void)
{
	return "1.3.0+0";
}

int cloud_init(void)
{
	return 0;
}

void cloud_connect(void)
{
}

void cloud_disconnect(void)
{
	board.cloud_up = false;
}

bool cloud_is_connected(void)
{
	return board.cloud_up;
}

int cloud_shadow_report(const char *reported_json)
{
	ARG_UNUSED(reported_json);
	return 0;
}

int cloud_jobs_request_next(void)
{
	return 0;
}

bool cloud_job_message_get(enum cloud_job_message *kind, const char **payload, size_t *len)
{
	ARG_UNUSED(kind);
	ARG_UNUSED(payload);
	ARG_UNUSED(len);
	return false;
}

bool cloud_job_message_done(void)
{
	return false;
}

int ota_init(void)
{
	return 0;
}

void ota_on_cloud_up(void)
{
}

void ota_on_job_message(enum cloud_job_message kind, const char *payload, size_t len)
{
	ARG_UNUSED(kind);
	ARG_UNUSED(payload);
	ARG_UNUSED(len);
}

void ota_on_job_ack(char kind, uint16_t sequence, bool accepted, bool permanent)
{
	ARG_UNUSED(kind);
	ARG_UNUSED(sequence);
	ARG_UNUSED(accepted);
	ARG_UNUSED(permanent);
}

void ota_on_button(enum app_button button)
{
	ARG_UNUSED(button);
	board.ota_buttons++;
}

void ota_on_download(enum app_download_event what, int value)
{
	ARG_UNUSED(what);
	ARG_UNUSED(value);
}

void ota_on_tick(void)
{
}

#if defined(CONFIG_APP_BT_OTA)
static struct {
	bool open;
	bool takes_the_button;
	int buttons;
	bool last_physical;
	bool last_long;
	int ticks;
	enum ui_state ui;
} bt;

bool bt_ota_on_button(uint8_t button, bool long_press, bool physical)
{
	ARG_UNUSED(button);
	bt.buttons++;
	bt.last_physical = physical;
	bt.last_long = long_press;
	return bt.takes_the_button;
}

void bt_ota_on_tick(void)
{
	bt.ticks++;
}

bool bt_ota_is_open(void)
{
	return bt.open;
}

enum ui_state bt_ota_ui_state(void)
{
	return bt.ui;
}
#endif

enum ota_state ota_state(void)
{
	return board.ota;
}

const char *ota_state_name(void)
{
	return "idle";
}

const char *ota_job_id(void)
{
	return NULL;
}

int ota_progress(void)
{
	return 0;
}

const char *ota_last_result(void)
{
	return "none";
}

const char *ota_last_error(void)
{
	return "";
}

bool ota_take_changed(void)
{
	return false;
}

/* ---- helpers -------------------------------------------------------------------- */

/* Boot, all the way into the event loop. */
static void boot(enum device_boot result, bool factory, bool stored, bool settings)
{
	memset(&board, 0, sizeof(board));
	event_queue.used = 0;
	atomic_set(&link_up, 0);
	atomic_set(&last_failure, 0);
	seconds_down = 0;

	board.boot_result = result;
	board.factory = factory;
	board.network_stored = stored;
	board.has_settings = settings;
	board.link_security = WIFI_SECURITY_TYPE_PSK;
	board.has_address = true;

	if (setjmp(out_of_the_event_loop) == 0) {
		(void)cranium_main();
	}
}

/* What the main loop does with whatever has been posted. */
static void run_loop(void)
{
	struct app_event event;

	while (event_queue.used > 0) {
		(void)k_msgq_get(&event_queue, &event, K_NO_WAIT);
		handle(&event);
	}
}

static void ticks(int count)
{
	for (int i = 0; i < count; i++) {
		on_tick();
		run_loop();
	}
}

static void forget_console(void)
{
	board.console[0] = '\0';
}

static void wifi_result(int status)
{
	const struct wifi_status info = { .status = status };

	raise_event(NET_EVENT_WIFI_CONNECT_RESULT, &info);
	run_loop();
}

/* ---- joining, and reporting it ---------------------------------------------------- */

static void test_only_ipv4_counts_as_up(void)
{
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	CHECK(board.connect_requests == 1);
	forget_console();

	/*
	 * On a network with router advertisements, the IPv6 address comes first, while DHCP
	 * waits. The stack raises this event then, and not again for the IPv4 address.
	 */
	board.has_address = false;
	raise_event(NET_EVENT_L4_CONNECTED, NULL);
	raise_event(NET_EVENT_L4_IPV6_CONNECTED, NULL);
	run_loop();
	CHECK(!net_is_up());
	CHECK_TEXT(board.console, "");

	board.has_address = true;
	raise_event(NET_EVENT_L4_IPV4_CONNECTED, NULL);
	run_loop();
	CHECK(net_is_up());
	CHECK_TEXT(board.console, "[WIFI] connected ip=192.168.1.42 rssi=-51\n");
	CHECK(cloud_retry_in >= 0);
	CHECK(board.ui == UI_CLOUD_CONNECTING);

	/* NET agrees. */
	{
		struct net_status status;

		net_status_get(&status);
		CHECK(status.connected);
		CHECK(status.stored);
		CHECK_TEXT(status.ip, "192.168.1.42");
		CHECK(status.rssi == -51);
		CHECK_TEXT(status.ssid, "MyNetwork");
		CHECK_TEXT(status.mac, "02:00:00:00:00:01");
	}

	/* Losing IPv4 is losing the network, even with IPv6 still there. */
	forget_console();
	raise_event(NET_EVENT_L4_IPV4_DISCONNECTED, NULL);
	run_loop();
	CHECK(!net_is_up());
	CHECK_TEXT(board.console, "[WIFI] disconnected\n");
	CHECK(board.ui == UI_NETWORK_CONNECTING);

	/* Once only. */
	forget_console();
	raise_event(NET_EVENT_L4_IPV4_DISCONNECTED, NULL);
	run_loop();
	CHECK_TEXT(board.console, "");

	/* The line always has an address field, even if the address went already. */
	board.has_address = false;
	raise_event(NET_EVENT_L4_IPV4_CONNECTED, NULL);
	run_loop();
	CHECK_TEXT(board.console, "[WIFI] connected ip=none rssi=-51\n");
}

static void test_a_failed_join_is_reported_once_per_attempt(void)
{
	static const struct {
		int status;
		const char *line;
	} results[] = {
		{ WIFI_STATUS_CONN_WRONG_PASSWORD, "[WIFI] failed reason=wrong password\n" },
		{ WIFI_STATUS_CONN_AP_NOT_FOUND, "[WIFI] failed reason=network not found\n" },
		{ WIFI_STATUS_CONN_TIMEOUT, "[WIFI] failed reason=timeout\n" },
		{ -ETIMEDOUT, "[WIFI] failed reason=timeout\n" },
		{ WIFI_STATUS_CONN_FAIL, "[WIFI] failed reason=connection failed\n" },
	};

	for (size_t i = 0; i < ARRAY_SIZE(results); i++) {
		boot(DEVICE_BOOT_OPERATING, false, true, true);
		forget_console();
		wifi_result(results[i].status);
		CHECK_TEXT(board.console, results[i].line);
		CHECK(!net_is_up());
	}

	/* The stack retries by itself, and the same reason can come many times. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	forget_console();
	wifi_result(WIFI_STATUS_CONN_WRONG_PASSWORD);
	wifi_result(WIFI_STATUS_CONN_WRONG_PASSWORD);
	wifi_result(WIFI_STATUS_CONN_WRONG_PASSWORD);
	CHECK_TEXT(board.console, "[WIFI] failed reason=wrong password\n");

	/* A new attempt may say it again. */
	(void)net_connect();
	wifi_result(WIFI_STATUS_CONN_WRONG_PASSWORD);
	CHECK_TEXT(board.console, "[WIFI] failed reason=wrong password\n"
				  "[WIFI] failed reason=wrong password\n");

	/* Success is not a failure. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	forget_console();
	wifi_result(0);
	CHECK_TEXT(board.console, "");

	/* A request the stack refused outright. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	forget_console();
	board.connect_result = -EIO;
	(void)net_connect();
	run_loop();
	CHECK_TEXT(board.console, "[WIFI] failed reason=request refused\n");

	/* A network that talked us down to a security mode that is not allowed gets left. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	forget_console();
	board.link_security = WIFI_SECURITY_TYPE_NONE;
	raise_event(NET_EVENT_L4_IPV4_CONNECTED, NULL);
	run_loop();
	CHECK(!net_is_up());
	CHECK(board.disconnect_requests == 1);
	CHECK_TEXT(board.console, "[WIFI] failed reason=security mode not allowed\n");
}

static void test_silence_from_the_stack_is_a_failure_too(void)
{
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	forget_console();

	ticks(RETRY_SECONDS - 1);
	CHECK_TEXT(board.console, "");
	CHECK(board.connect_requests == 1);

	ticks(1);
	CHECK_TEXT(board.console, "[WIFI] failed reason=no answer\n");
	CHECK(board.connect_requests == 2);

	/* With a reason on record there is nothing to add, and it tries again all the same. */
	forget_console();
	wifi_result(WIFI_STATUS_CONN_WRONG_PASSWORD);
	forget_console();
	ticks(RETRY_SECONDS);
	CHECK_TEXT(board.console, "");
	CHECK(board.connect_requests == 3);

	/* Up, it stops trying. */
	raise_event(NET_EVENT_L4_IPV4_CONNECTED, NULL);
	run_loop();
	ticks(RETRY_SECONDS * 2);
	CHECK(board.connect_requests == 3);
}

static void test_clearing_the_network_disconnects(void)
{
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	raise_event(NET_EVENT_L4_IPV4_CONNECTED, NULL);
	run_loop();
	forget_console();

	CHECK(net_credentials_clear() == 0);
	CHECK(board.disconnect_requests == 1);
	CHECK(!net_has_credentials());

	/* The stack then tells that the link is gone. */
	raise_event(NET_EVENT_L4_IPV4_DISCONNECTED, NULL);
	run_loop();
	CHECK_TEXT(board.console, "[WIFI] disconnected\n");
	CHECK(board.ui == UI_UNPROVISIONED);

	/* And no more attempts without a network. */
	ticks(RETRY_SECONDS * 2);
	CHECK(board.connect_requests == 1);
}

/* ---- factory mode, and what the board does at boot ---------------------------------- */

static void test_factory_mode_stays_off_the_network(void)
{
	/* Even with a network left in storage, as after a power cut during a reset. */
	boot(DEVICE_BOOT_FACTORY, true, true, false);
	CHECK(board.connect_requests == 0);
	CHECK(board.ui == UI_FACTORY);

	/* The loop keeps running and feeding the watchdog, and it does not retry. */
	ticks(RETRY_SECONDS * 3);
	CHECK(board.connect_requests == 0);
	CHECK(board.watchdog_feeds == RETRY_SECONDS * 3);
	CHECK_TEXT(board.console, "");
	CHECK(board.ui == UI_FACTORY);

	/* Its LED is not the one of a board that is merely not provisioned. */
	boot(DEVICE_BOOT_OPERATING, false, false, false);
	CHECK(board.ui == UI_UNPROVISIONED);
	CHECK(UI_FACTORY != UI_UNPROVISIONED);
}

static void test_the_board_joins_at_boot_whenever_a_network_is_stored(void)
{
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	CHECK(board.connect_requests == 1);
	CHECK(board.ui == UI_NETWORK_CONNECTING);

	/* Also without cloud settings yet. */
	boot(DEVICE_BOOT_OPERATING, false, true, false);
	CHECK(board.connect_requests == 1);
	CHECK(board.ui == UI_UNPROVISIONED);

	/* And after a migration, or storage that could not be read. */
	boot(DEVICE_BOOT_MIGRATED, false, true, true);
	CHECK(board.connect_requests == 1);
	CHECK_TEXT(board.console, "[CONSOLE] migrated: device id set to fe5b26c0c5b1dcd7\n");

	boot(DEVICE_BOOT_MIGRATION_FAILED, false, true, true);
	CHECK(board.connect_requests == 1);

	boot(DEVICE_BOOT_UNREADABLE, false, true, true);
	CHECK(board.connect_requests == 1);
	CHECK(board.ui == UI_NETWORK_CONNECTING);

	/* Nothing stored: nothing to join. */
	boot(DEVICE_BOOT_OPERATING, false, false, true);
	CHECK(board.connect_requests == 0);

	/* The WIFI command's event. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	CHECK(app_event_post_simple(APP_EVENT_NET_JOIN) == 0);
	run_loop();
	CHECK(board.connect_requests == 2);
}

static void test_button_2(void)
{
	const struct app_event long_press = {
		.type = APP_EVENT_BUTTON,
		.button = { .id = APP_BUTTON_2, .long_press = true },
	};
	const struct app_event short_press = {
		.type = APP_EVENT_BUTTON,
		.button = { .id = APP_BUTTON_2, .long_press = false },
	};

	/* A long press resets and restarts, whatever factory_reset() returned. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	CHECK(app_event_post(&long_press) == 0);
	run_loop();
	CHECK(board.factory_resets == 1);
	CHECK(board.reboots == 1);

	/* Not during an update. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	board.ota = OTA_TESTING;
	CHECK(app_event_post(&long_press) == 0);
	run_loop();
	CHECK(board.factory_resets == 0);
	CHECK(board.reboots == 0);

	/* A short press is for the update logic. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	CHECK(app_event_post(&short_press) == 0);
	run_loop();
	CHECK(board.factory_resets == 0);
	CHECK(board.ota_buttons == 1);
}

#if defined(CONFIG_APP_BT_OTA)
static void test_a_button_goes_to_bluetooth_first(void)
{
	const struct app_event press = {
		.type = APP_EVENT_BUTTON,
		.button = { .id = APP_BUTTON_2, .long_press = true, .physical = true },
	};

	memset(&bt, 0, sizeof(bt));

	/* Taken: holding Button 2 with a window open must not be the factory reset. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	bt.takes_the_button = true;
	CHECK(app_event_post(&press) == 0);
	run_loop();
	CHECK(bt.buttons == 1);
	CHECK(bt.last_physical);
	CHECK(bt.last_long);
	CHECK(board.factory_resets == 0);
	CHECK(board.ota_buttons == 0);

	/* Not taken: everything is as it was. */
	bt.takes_the_button = false;
	CHECK(app_event_post(&press) == 0);
	run_loop();
	CHECK(bt.buttons == 2);
	CHECK(board.factory_resets == 1);
}

static void test_what_the_tick_and_led1_do_for_bluetooth(void)
{
	memset(&bt, 0, sizeof(bt));
	boot(DEVICE_BOOT_OPERATING, false, true, true);

	ticks(1);
	CHECK(bt.ticks == 1);
	CHECK(board.ui != UI_BT_WINDOW);

	bt.open = true;
	bt.ui = UI_BT_WINDOW;
	ticks(1);
	CHECK(board.ui == UI_BT_WINDOW);

	bt.open = false;
	ticks(1);
	CHECK(board.ui != UI_BT_WINDOW);
	memset(&bt, 0, sizeof(bt));
}

static void test_the_wifi_stack_answers_or_it_does_not(void)
{
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	atomic_set(&wifi_answered, 0);
	CHECK(!net_wifi_answered());

	/* A failure is an answer: it took the driver, its firmware and the supplicant to say so. */
	wifi_result(WIFI_STATUS_CONN_AP_NOT_FOUND);
	CHECK(net_wifi_answered());
}

static void test_associated_is_what_the_wifi_stack_says_now(void)
{
	boot(DEVICE_BOOT_OPERATING, false, true, true);

	board.status_result = 0;
	board.wifi_state = WIFI_STATE_DISCONNECTED;
	CHECK(!net_wifi_associated());
	board.wifi_state = WIFI_STATE_SCANNING;
	CHECK(!net_wifi_associated());
	board.wifi_state = WIFI_STATE_ASSOCIATING;
	CHECK(!net_wifi_associated());

	/* Associated with no address, as on a network whose DHCP gives none: no L4 event comes. */
	board.wifi_state = WIFI_STATE_ASSOCIATED;
	CHECK(net_wifi_associated());
	CHECK(!net_is_up());
	board.wifi_state = WIFI_STATE_COMPLETED;
	CHECK(net_wifi_associated());
	CHECK(!net_is_up());

	/* A stack that cannot say counts as Wi-Fi being there, so that no person can vouch for it. */
	board.wifi_state = WIFI_STATE_DISCONNECTED;
	board.status_result = -EIO;
	CHECK(net_wifi_associated());
	board.status_result = 0;
}
#endif

int main(void)
{
	test_only_ipv4_counts_as_up();
	test_a_failed_join_is_reported_once_per_attempt();
	test_silence_from_the_stack_is_a_failure_too();
	test_clearing_the_network_disconnects();
	test_factory_mode_stays_off_the_network();
	test_the_board_joins_at_boot_whenever_a_network_is_stored();
	test_button_2();
#if defined(CONFIG_APP_BT_OTA)
	test_a_button_goes_to_bluetooth_first();
	test_what_the_tick_and_led1_do_for_bluetooth();
	test_the_wifi_stack_answers_or_it_does_not();
	test_associated_is_what_the_wifi_stack_says_now();
#endif

	printf("%d application checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
