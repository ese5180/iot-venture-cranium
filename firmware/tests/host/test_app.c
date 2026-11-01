/*
 * Host-side tests of main.c, net.c and stuck.c: when the board joins a network, what it says about
 * that on the console, what LED1 shows, and when it restarts itself. The real files are compiled
 * here, against a fake network stack whose events the tests raise, and fakes of the other modules.
 * The console's commands fake exactly this part, so these tests are where it gets looked at.
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

/* Log lines go nowhere on a host. This one, about the last restart, is one to see. */
#undef LOG_WRN
#define LOG_WRN(...) console_event("stuck", "WRN: " __VA_ARGS__)
#include "stuck.c"
#undef LOG_WRN
#define LOG_WRN(...) do { } while (0)

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
	int panics;
	int ota_buttons;
	int watchdog_feeds;
	enum ui_state ui;
	char console[2048];
	bool private_key;
	bool certificate;
	bool trial;
	bool cloud_connecting;
	int cloud_connects;
	int cloud_inits;
	uint32_t update_progress;

	/* What had happened by the time of the restart. */
	int reboot_type;
	int panics_at_reboot;
	int writes_at_reboot;
	bool stuck_line_at_write;

	/* The network stack. */
	struct net_mgmt_event_callback *callbacks[4];
	int callback_count;
	bool network_stored;
	enum wifi_security_type link_security;
	bool has_address;
	int connect_requests;
	int disconnect_requests;
	int connect_result;
	int up_requests;
	int up_result;
	/*
	 * conn_mgr's thread holds conn_mgr_mon_lock and the binding's lock, and waits for the
	 * supplicant in net_l2_wifi_init(). What takes one of those would never return on a board.
	 */
	bool conn_mgr_thread_waits;
	const struct wifi_status *event_info;
#if defined(CONFIG_APP_BT_OTA)
	enum wifi_iface_state wifi_state;
	int status_result;
#endif
} board;

/* What survives a restart, and the time since the last one. See boot() and boot_again(). */
static struct {
	bool present;
	struct stuck_record record;
	int writes;
	int erases;
	/* What store_read() returns. It fills the buffer first, as a read of the wrong size does. */
	int read_result;
	bool write_fails;
} stored;
static int64_t uptime_ms;
/* What conn_mgr_all_if_up() says from the start of the next boot on. */
static int up_result_at_boot;
/* The supplicant is not ready by the time main() starts, on the next boots. */
static bool supplicant_late;

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

long long k_uptime_get(void)
{
	return uptime_ms;
}

void k_oops(void)
{
}

void host_log_panic(void)
{
	board.panics++;
}

void sys_reboot(int type)
{
	board.reboot_type = type;
	board.reboots++;
	board.panics_at_reboot = board.panics;
	board.writes_at_reboot = stored.writes;
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

int conn_mgr_all_if_up(bool skip_ignored)
{
	/* skip_ignored looks at what is ignored under conn_mgr_mon_lock. False goes straight on. */
	CHECK(!skip_ignored || !board.conn_mgr_thread_waits);
	board.up_requests++;
	return board.up_result;
}

int conn_mgr_all_if_connect(bool skip_ignored)
{
	/* Whatever it is given, it ends up at the binding's lock. */
	ARG_UNUSED(skip_ignored);
	CHECK(!board.conn_mgr_thread_waits);
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

bool health_trial_active(void)
{
	return board.trial;
}

bool factory_has_private_key(void)
{
	return board.private_key;
}

bool factory_has_certificate(void)
{
	return board.certificate;
}

int store_read(enum store_id id, void *data, size_t size)
{
	CHECK(id == STORE_STUCK);
	CHECK(size == sizeof(stored.record));

	/* What is in the buffer after a failed read means nothing, however good it looks. */
	if (stored.read_result != 0) {
		const struct stuck_record looks_good = { .magic = STUCK_RECORD_MAGIC,
							 .count = STUCK_COUNT_MAX,
							 .reason = STUCK_REASON_WIFI_SILENT };

		memcpy(data, &looks_good, size);
		return stored.read_result;
	}

	if (!stored.present) {
		return -ENOENT;
	}

	memcpy(data, &stored.record, size);
	return 0;
}

int store_write(enum store_id id, const void *data, size_t size)
{
	CHECK(id == STORE_STUCK);
	CHECK(size == sizeof(stored.record));
	stored.writes++;
	board.stuck_line_at_write = strstr(board.console, "[STUCK] restarting") != NULL;

	if (stored.write_fails) {
		return -EIO;
	}

	memcpy(&stored.record, data, size);
	stored.present = true;
	return 0;
}

int store_erase(enum store_id id)
{
	CHECK(id == STORE_STUCK);
	stored.erases++;
	stored.present = false;
	return 0;
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
	board.cloud_inits++;
	return 0;
}

void cloud_connect(void)
{
	board.cloud_connects++;
	board.cloud_connecting = true;
}

bool cloud_is_connecting(void)
{
	return board.cloud_connecting;
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

uint32_t ota_stuck_progress(void)
{
	return board.update_progress;
}

/* ---- helpers -------------------------------------------------------------------- */

/* NET_EVENT_SUPPLICANT_READY, as the network management thread hands it to a static handler. */
static void supplicant_is_ready(void)
{
	board.conn_mgr_thread_waits = false;
	supplicant_ready_handler.handler(NET_EVENT_SUPPLICANT_READY, NULL, NULL, 0,
					 supplicant_ready_handler.user_data);
}

static void run_main(enum device_boot result, bool factory, bool network, bool settings,
		     bool private_key, bool certificate)
{
	memset(&board, 0, sizeof(board));
	memset(&keys, 0, sizeof(keys));
	board.up_result = up_result_at_boot;
	event_queue.used = 0;
	uptime_ms = 0;
	atomic_set(&link_up, 0);
	atomic_set(&last_failure, 0);
	atomic_set(&wifi_answers, 0);
	atomic_set(&tick_queued, 0);
	atomic_set(&stack_ready, 0);
	atomic_set(&join_waiting, 0);
	seconds_down = 0;
	cloud_retry_in = -1;
	cloud_backoff = CONFIG_APP_CLOUD_RETRY_SECONDS;

	board.boot_result = result;
	board.factory = factory;
	board.network_stored = network;
	board.has_settings = settings;
	board.private_key = private_key;
	board.certificate = certificate;
	board.link_security = WIFI_SECURITY_TYPE_PSK;
	board.has_address = true;

	/* The handler is there from the start, so this can come before main() has done anything. */
	board.conn_mgr_thread_waits = true;
	if (!supplicant_late) {
		supplicant_is_ready();
	}

	if (setjmp(out_of_the_event_loop) == 0) {
		(void)cranium_main();
	}
}

/* Boot a board that has never restarted for being stuck, all the way into the event loop. */
static void boot(enum device_boot result, bool factory, bool network, bool settings)
{
	memset(&stored, 0, sizeof(stored));
	run_main(result, factory, network, settings, true, true);
}

/* The restart it has just decided on: what is in storage stays, and RAM does not. */
static void boot_again(void)
{
	run_main(board.boot_result, board.factory, board.network_stored, board.has_settings,
		 board.private_key, board.certificate);
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
		uptime_ms += MSEC_PER_SEC;
		on_tick();
		run_loop();
	}
}

static void forget_console(void)
{
	board.console[0] = '\0';
}

/* For a long time: the console's buffer here is not made for that. */
static void ticks_quietly(int count)
{
	for (int i = 0; i < count; i++) {
		ticks(1);
		forget_console();
	}
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
	atomic_set(&wifi_answers, 0);
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

/* ---- a board that is stuck ---------------------------------------------------------- */

#define WIFI_SILENT STUCK_WIFI_SILENT_SECONDS
#define NO_CLOUD    STUCK_NO_CLOUD_SECONDS
#define STALL       STUCK_UPDATE_STALL_SECONDS
#define HOURS       3600

static void link_comes_up(void)
{
	raise_event(NET_EVENT_L4_IPV4_CONNECTED, NULL);
	run_loop();
}

static void link_goes_down(void)
{
	raise_event(NET_EVENT_L4_IPV4_DISCONNECTED, NULL);
	run_loop();
}

/* The restart went as the trial's does: a line, the record, the log flushed, and then the reset. */
static void check_restart(const char *line, uint8_t count, enum stuck_reason reason)
{
	CHECK(board.reboots == 1);
	CHECK(board.reboot_type == SYS_REBOOT_COLD);
	CHECK(strstr(board.console, line) != NULL);
	CHECK(board.panics_at_reboot == 1);
	CHECK(board.writes_at_reboot == stored.writes);
	CHECK(stored.writes == 0 || board.stuck_line_at_write);
	CHECK(stored.present);
	CHECK(stored.record.magic == STUCK_RECORD_MAGIC);
	CHECK(stored.record.count == count);
	CHECK(stored.record.reason == reason);
}

/*
 * The hang on firmware 1.5.0, on the real main loop. WIFI goes in during the second the board has
 * joined. The link is gone 4 seconds later, and the stack never says another word. net_tick() goes
 * on asking every 30 s and prints `no answer`, so the console looks alive.
 */
static void test_the_incident_on_the_main_loop(void)
{
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	ticks(20);
	wifi_result(0);
	link_comes_up();
	CHECK(app_event_post_simple(APP_EVENT_NET_JOIN) == 0);
	run_loop();
	ticks(4);
	forget_console();
	link_goes_down();

	ticks(WIFI_SILENT - 1);
	CHECK(board.reboots == 0);
	CHECK(strstr(board.console, "[WIFI] failed reason=no answer\n") != NULL);
	CHECK(strstr(board.console, "[STUCK]") == NULL);
	CHECK(board.connect_requests >= 4);

	ticks(1);
	check_restart("[STUCK] restarting reason=wifi_silent count=1\n", 1, STUCK_REASON_WIFI_SILENT);
	CHECK(stuck_count() == 1);
	CHECK(stored.writes == 1);

	/* It does not go on deciding: on the board nothing runs after this. */
	ticks(5);
	CHECK(board.reboots == 1);
	CHECK(stored.writes == 1);

	/* The next boot says what happened, and the stack answers again. */
	boot_again();
	CHECK_TEXT(board.console,
		   "[stuck] WRN: Restarted earlier for being stuck: reason=wifi_silent count=1\n");
	CHECK(stuck_count() == 1);
	ticks(14);
	wifi_result(WIFI_STATUS_CONN_WRONG_PASSWORD);
	ticks_quietly(WIFI_SILENT - 1);
	CHECK(board.reboots == 0);
}

static void test_a_missing_hotspot_never_restarts_the_board(void)
{
	static const int reasons[] = { WIFI_STATUS_CONN_AP_NOT_FOUND, WIFI_STATUS_CONN_WRONG_PASSWORD,
				       WIFI_STATUS_CONN_TIMEOUT, -ETIMEDOUT, WIFI_STATUS_CONN_FAIL };

	boot(DEVICE_BOOT_OPERATING, false, true, true);
	for (int second = 0; second < 12 * HOURS; second += 20) {
		ticks_quietly(19);
		wifi_result(WIFI_STATUS_CONN_AP_NOT_FOUND);
		ticks_quietly(1);
		CHECK(board.reboots == 0);
	}
	CHECK(board.connect_requests > 1000);
	CHECK(stored.writes == 0);

	/* The same for anything else the stack can say, and when it says it again it counts again. */
	for (size_t i = 0; i < ARRAY_SIZE(reasons); i++) {
		boot(DEVICE_BOOT_OPERATING, false, true, true);
		for (int second = 0; second < HOURS; second += WIFI_SILENT - 1) {
			ticks_quietly(WIFI_SILENT - 2);
			wifi_result(reasons[i]);
			ticks_quietly(1);
			CHECK(board.reboots == 0);
		}
	}

	/* And after hours of that, silence is silence. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	for (int second = 0; second < HOURS; second += 20) {
		ticks_quietly(19);
		wifi_result(WIFI_STATUS_CONN_AP_NOT_FOUND);
		ticks_quietly(1);
	}
	ticks_quietly(WIFI_SILENT - 1);
	CHECK(board.reboots == 0);
	ticks(1);
	CHECK(board.reboots == 1);
}

static void test_a_request_the_stack_refuses_is_silence(void)
{
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	board.connect_result = -EIO;
	ticks(WIFI_SILENT - 1);
	CHECK(board.reboots == 0);
	CHECK(strstr(board.console, "[WIFI] failed reason=request refused\n") != NULL);
	ticks(1);
	check_restart("[STUCK] restarting reason=wifi_silent count=1\n", 1, STUCK_REASON_WIFI_SILENT);
}

/*
 * The fake stops a test that takes one of the locks that conn_mgr's thread holds while it waits for
 * the supplicant, where the board would never come back from the call.
 */
static void test_a_chip_that_does_not_come_up_leaves_the_main_loop_running(void)
{
	/*
	 * The interface did not start, so no ADMIN_UP event was raised and the supplicant never gets
	 * ready. conn_mgr_all_if_up() fails, in net_init() and in net_connect().
	 */
	supplicant_late = true;
	up_result_at_boot = -EIO;
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	up_result_at_boot = 0;
	supplicant_late = false;

	CHECK(board.connect_requests == 0);
	CHECK(board.up_requests == 2);
	/* The interface can still come up later, and then the cloud has to be there to connect to. */
	CHECK(board.cloud_inits == 1);
	run_loop();
	CHECK(strstr(board.console, "[WIFI] failed reason=request refused\n") != NULL);

	ticks(WIFI_SILENT - 1);
	CHECK(board.connect_requests == 0);
	CHECK(board.watchdog_feeds == WIFI_SILENT - 1);
	CHECK(board.reboots == 0);
	ticks(1);
	check_restart("[STUCK] restarting reason=wifi_silent count=1\n", 1, STUCK_REASON_WIFI_SILENT);

	/* When it does come up, it joins, as if nothing had happened. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	CHECK(board.up_requests == 2);
	CHECK(board.connect_requests == 1);

	/* Somebody else just got it up: that is not a failure. */
	board.up_result = -EALREADY;
	CHECK(net_connect() == 0);
	CHECK(board.connect_requests == 2);
}

static void test_a_supplicant_that_never_gets_ready_leaves_the_main_loop_running(void)
{
	/* The interface did start, by itself or for net_init(), and that is as far as it got. */
	supplicant_late = true;
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	supplicant_late = false;

	CHECK(board.connect_requests == 0);
	CHECK(board.cloud_inits == 1);

	/* Nothing has been refused, so nothing says so. net_tick() speaks up when its time comes. */
	run_loop();
	CHECK_TEXT(board.console, "");
	ticks(29);
	CHECK_TEXT(board.console, "");
	ticks(1);
	CHECK(strstr(board.console, "[WIFI] failed reason=no answer\n") != NULL);
	CHECK(strstr(board.console, "request refused") == NULL);

	ticks(WIFI_SILENT - 31);
	CHECK(board.connect_requests == 0);
	CHECK(board.watchdog_feeds == WIFI_SILENT - 1);
	CHECK(board.reboots == 0);
	ticks(1);
	check_restart("[STUCK] restarting reason=wifi_silent count=1\n", 1, STUCK_REASON_WIFI_SILENT);
}

static void test_a_healthy_chip_joins_when_the_supplicant_is_ready(void)
{
	/* It takes a while, as on any boot. Nothing about that is a failure, and nothing says so. */
	supplicant_late = true;
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	supplicant_late = false;
	CHECK(net_connect() == -EAGAIN);
	CHECK(board.connect_requests == 0);
	ticks(5);
	CHECK(board.connect_requests == 0);
	CHECK(board.watchdog_feeds == 5);
	CHECK_TEXT(board.console, "");

	/* The join starts as soon as it is, once. */
	supplicant_is_ready();
	CHECK(event_queue.used == 1);
	run_loop();
	CHECK(board.connect_requests == 1);
	CHECK(net_connect() == 0);
	CHECK(board.connect_requests == 2);
	CHECK_TEXT(board.console, "");

	/* Ready again, after the driver's recovery: nobody is waiting, so nothing joins for it. */
	supplicant_is_ready();
	CHECK(event_queue.used == 0);

	/* It was ready before main() got here: the join at boot is the only one. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	CHECK(board.connect_requests == 1);
	CHECK(event_queue.used == 0);
	CHECK(atomic_get(&join_waiting) == 0);

	/* A network that goes in meanwhile gets one join as well. */
	supplicant_late = true;
	boot(DEVICE_BOOT_OPERATING, false, false, true);
	supplicant_late = false;
	board.network_stored = true;
	CHECK(app_event_post_simple(APP_EVENT_NET_JOIN) == 0);
	run_loop();
	CHECK(board.connect_requests == 0);
	supplicant_is_ready();
	run_loop();
	CHECK(board.connect_requests == 1);

	/* Nothing to join, or factory mode: being ready starts nothing. */
	supplicant_late = true;
	boot(DEVICE_BOOT_OPERATING, false, false, true);
	supplicant_is_ready();
	CHECK(event_queue.used == 0);
	boot(DEVICE_BOOT_FACTORY, true, true, true);
	supplicant_is_ready();
	CHECK(event_queue.used == 0);
	supplicant_late = false;

	/* The handler listens for this event, and any other does nothing. */
	CHECK(supplicant_ready_handler.event_mask == NET_EVENT_SUPPLICANT_READY);
	supplicant_late = true;
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	supplicant_late = false;
	supplicant_ready_handler.handler(NET_EVENT_WIFI_CONNECT_RESULT, NULL, NULL, 0, NULL);
	CHECK(atomic_get(&stack_ready) == 0);
	CHECK(event_queue.used == 0);
}

static void test_what_stands_in_the_way_of_a_restart(void)
{
	/* Factory mode: off the network, and no timer has any reason to run. */
	boot(DEVICE_BOOT_FACTORY, true, true, true);
	ticks_quietly(NO_CLOUD * 2);
	CHECK(board.reboots == 0);
	CHECK(board.connect_requests == 0);
	CHECK(board.watchdog_feeds == NO_CLOUD * 2);

	/* No network stored. */
	boot(DEVICE_BOOT_OPERATING, false, false, true);
	ticks_quietly(NO_CLOUD * 2);
	CHECK(board.reboots == 0);
	CHECK(board.connect_requests == 0);

	/* A network, a key and a certificate, and no cloud settings. It could not connect ever. */
	boot(DEVICE_BOOT_OPERATING, false, true, false);
	CHECK(board.private_key && board.certificate);
	ticks_quietly(NO_CLOUD * 2);
	CHECK(board.reboots == 0);

	/* The key is there, and the signed certificate is still to come after KEYGEN. */
	run_main(DEVICE_BOOT_OPERATING, false, true, true, true, false);
	ticks_quietly(NO_CLOUD * 2);
	CHECK(board.reboots == 0);

	/* A certificate, and no key. */
	run_main(DEVICE_BOOT_OPERATING, false, true, true, false, true);
	ticks_quietly(NO_CLOUD * 2);
	CHECK(board.reboots == 0);

	/* Neither of them: it could not get to the cloud anyway. */
	run_main(DEVICE_BOOT_OPERATING, false, true, true, false, false);
	ticks_quietly(NO_CLOUD * 2);
	CHECK(board.reboots == 0);

	/* It gets them, and within a minute of that the timer runs. */
	board.private_key = true;
	board.certificate = true;
	ticks_quietly(KEYS_CHECK_SECONDS + WIFI_SILENT - 1);
	CHECK(board.reboots <= 1);
	ticks_quietly(1);
	CHECK(board.reboots == 1);

	/* Asked once a minute, and not every second: it goes into TF-M. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	ticks(1);
	board.private_key = false;
	ticks_quietly(KEYS_CHECK_SECONDS - 1);
	CHECK(keys.present);
	ticks_quietly(1);
	CHECK(!keys.present);
	CHECK(board.reboots == 0);

	/* An image on trial: its own deadline ends that, which is not this code's business. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	board.trial = true;
	ticks_quietly(NO_CLOUD * 2);
	CHECK(board.reboots == 0);
	board.trial = false;
	ticks_quietly(WIFI_SILENT - 1);
	CHECK(board.reboots == 0);
	ticks(1);
	CHECK(board.reboots == 1);

	/* Taking the network away in the last second, and giving it back: a full wait. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	ticks(WIFI_SILENT - 1);
	CHECK(net_credentials_clear() == 0);
	ticks(1);
	CHECK(board.reboots == 0);
	board.network_stored = true;
	ticks_quietly(WIFI_SILENT - 1);
	CHECK(board.reboots == 0);
	ticks(1);
	CHECK(board.reboots == 1);
}

static void test_no_cloud_on_the_main_loop(void)
{
	/* The link stays up, as for a chip that hung while associated. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	wifi_result(0);
	link_comes_up();
	ticks_quietly(NO_CLOUD - 1);
	CHECK(board.reboots == 0);
	ticks(1);
	check_restart("[STUCK] restarting reason=no_cloud count=1\n", 1, STUCK_REASON_NO_CLOUD);

	/* Connected: for ever. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	wifi_result(0);
	link_comes_up();
	board.cloud_up = true;
	ticks_quietly(2 * HOURS);
	CHECK(board.reboots == 0);
}

static void test_each_update_state(void)
{
	static const struct {
		enum ota_state state;
		enum stuck_update kind;
	} states[] = {
		{ OTA_IDLE, STUCK_UPDATE_NONE },
		{ OTA_AWAITING_USER, STUCK_UPDATE_NONE },
		{ OTA_RETRY_WAIT, STUCK_UPDATE_WATCHED },
		{ OTA_REFRESHING, STUCK_UPDATE_WATCHED },
		{ OTA_STARTING, STUCK_UPDATE_WATCHED },
		{ OTA_DOWNLOADING, STUCK_UPDATE_WATCHED },
		{ OTA_COMMITTING, STUCK_UPDATE_WATCHED },
		{ OTA_REBOOTING, STUCK_UPDATE_WATCHED },
		{ OTA_VERIFYING, STUCK_UPDATE_BOUNDED },
		{ OTA_TESTING, STUCK_UPDATE_BOUNDED },
#if defined(CONFIG_APP_BT_OTA)
		{ OTA_BLUETOOTH, STUCK_UPDATE_BOUNDED },
#endif
	};

	for (size_t i = 0; i < ARRAY_SIZE(states); i++) {
		boot(DEVICE_BOOT_OPERATING, false, true, true);
		board.ota = states[i].state;
		CHECK(update_kind() == states[i].kind);

		switch (states[i].kind) {
		case STUCK_UPDATE_NONE:
			ticks_quietly(WIFI_SILENT - 1);
			CHECK(board.reboots == 0);
			ticks(1);
			check_restart("[STUCK] restarting reason=wifi_silent count=1\n", 1,
				      STUCK_REASON_WIFI_SILENT);
			break;
		case STUCK_UPDATE_WATCHED:
			ticks_quietly(STALL - 1);
			CHECK(board.reboots == 0);
			board.update_progress++;
			ticks_quietly(1);
			ticks_quietly(STALL - 1);
			CHECK(board.reboots == 0);
			ticks(1);
			check_restart("[STUCK] restarting reason=update_stall count=0\n", 0,
				      STUCK_REASON_UPDATE_STALL);
			CHECK(stuck_count() == 0);
			break;
		default:
			ticks_quietly(2 * HOURS);
			CHECK(board.reboots == 0);
			break;
		}
	}
}

static void test_the_back_off_across_restarts(void)
{
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	ticks_quietly(WIFI_SILENT);
	CHECK(board.reboots == 1);
	CHECK(stored.record.count == 1);

	boot_again();
	ticks_quietly(5 * 60 - 1);
	CHECK(board.reboots == 0);
	ticks(1);
	CHECK(board.reboots == 1);
	CHECK(stored.record.count == 2);

	boot_again();
	ticks_quietly(30 * 60 - 1);
	CHECK(board.reboots == 0);
	ticks(1);
	CHECK(board.reboots == 1);
	CHECK(stored.record.count == 3);
	CHECK(stored.erases == 0);

	/* The stack answers now, and goes on answering: 30 minutes, and the record is gone. */
	boot_again();
	for (int second = 0; second < 30 * 60 - 20; second += 20) {
		ticks_quietly(19);
		wifi_result(WIFI_STATUS_CONN_AP_NOT_FOUND);
		ticks_quietly(1);
	}
	CHECK(stored.present);
	CHECK(stuck_count() == 3);
	ticks_quietly(20);
	CHECK(!stored.present);
	CHECK(stored.erases == 1);
	CHECK(stuck_count() == 0);
	CHECK(board.reboots == 0);
	ticks_quietly(WIFI_SILENT - 25);
	CHECK(stored.erases == 1);
}

static void test_storage_that_fails_never_blocks_a_restart(void)
{
	/*
	 * A record that cannot be read: a count of 0, with no back-off, whatever the read has left in
	 * the buffer. -EBADMSG is what store_read() says for a record of another size, after filling it.
	 */
	static const int failed_reads[] = { -EIO, -EBADMSG };

	for (size_t i = 0; i < ARRAY_SIZE(failed_reads); i++) {
		boot(DEVICE_BOOT_OPERATING, false, true, true);
		stored.present = true;
		stored.record = (struct stuck_record){ .magic = STUCK_RECORD_MAGIC, .count = 4, .reason = 1 };
		stored.read_result = failed_reads[i];
		boot_again();
		CHECK(stuck_count() == 0);
		CHECK_TEXT(board.console, "");
		ticks(WIFI_SILENT - 1);
		CHECK(board.reboots == 0);
		ticks(1);
		CHECK(board.reboots == 1);
	}

	/* A record that does not exist. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	CHECK(stuck_count() == 0);
	ticks(WIFI_SILENT);
	CHECK(board.reboots == 1);

	/* Rubbish in the record: the same. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	stored.present = true;
	stored.record = (struct stuck_record){ .magic = 0x12345678, .count = 4, .reason = 1 };
	boot_again();
	CHECK(stuck_count() == 0);
	ticks(WIFI_SILENT);
	CHECK(board.reboots == 1);

	/* A record that cannot be written: the restart happens anyway. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	stored.write_fails = true;
	ticks(WIFI_SILENT);
	CHECK(stored.writes == 1);
	CHECK(board.reboots == 1);
	CHECK(!stored.present);
}

/* These stay on a board from one firmware to the next, so that none can ever move or be shared. */
static void test_each_record_has_its_own_place_in_storage(void)
{
	static const int ids[] = { STORE_DEVICE_CONFIG, STORE_OTA_RECORD, STORE_DEVICE_ID,
				   STORE_INIT_FLAG, STORE_BT_OTA_RECORD, STORE_STUCK };

	for (size_t i = 0; i < ARRAY_SIZE(ids); i++) {
		for (size_t j = i + 1; j < ARRAY_SIZE(ids); j++) {
			CHECK(ids[i] != ids[j]);
		}
	}

	CHECK(STORE_STUCK == 6);
}

static void test_a_good_join_result_ends_the_silence_with_the_link_still_down(void)
{
	/* The stack has joined, and DHCP is slow. The chip is answering, so that is no reason. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	ticks_quietly(WIFI_SILENT - 1);
	wifi_result(0);
	ticks_quietly(1);
	ticks_quietly(WIFI_SILENT - 1);
	CHECK(board.reboots == 0);
	ticks(1);
	check_restart("[STUCK] restarting reason=wifi_silent count=1\n", 1, STUCK_REASON_WIFI_SILENT);
}

static void test_new_settings_give_the_cloud_its_full_wait(void)
{
	static const enum app_event_type events[] = { APP_EVENT_CLOUD_CHANGED, APP_EVENT_NET_JOIN };

	for (size_t i = 0; i < ARRAY_SIZE(events); i++) {
		boot(DEVICE_BOOT_OPERATING, false, true, true);
		wifi_result(0);
		link_comes_up();
		ticks_quietly(NO_CLOUD - 1);
		CHECK(app_event_post_simple(events[i]) == 0);
		run_loop();
		ticks_quietly(NO_CLOUD - 1);
		CHECK(board.reboots == 0);
		ticks(1);
		check_restart("[STUCK] restarting reason=no_cloud count=1\n", 1, STUCK_REASON_NO_CLOUD);
	}
}

static void test_a_restart_at_the_top_of_the_count_writes_nothing(void)
{
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	stored.present = true;
	stored.record = (struct stuck_record){ .magic = STUCK_RECORD_MAGIC, .count = STUCK_COUNT_MAX,
					       .reason = STUCK_REASON_NO_CLOUD };
	boot_again();
	CHECK(stuck_count() == STUCK_COUNT_MAX);
	ticks_quietly(6 * HOURS - 1);
	CHECK(board.reboots == 0);
	CHECK(strstr(board.console, "[STUCK]") == NULL);
	ticks(1);
	CHECK(board.reboots == 1);
	CHECK(strstr(board.console, "[STUCK] restarting reason=wifi_silent count=4\n") != NULL);
	CHECK(stored.writes == 0);
	CHECK(stored.record.reason == STUCK_REASON_NO_CLOUD);
}

#if defined(CONFIG_APP_BT_OTA)
static void test_a_bluetooth_window_holds_the_restart(void)
{
	memset(&bt, 0, sizeof(bt));
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	bt.open = true;
	bt.ui = UI_BT_WINDOW;
	ticks_quietly(17 * 60);
	CHECK(board.reboots == 0);
	bt.open = false;
	ticks_quietly(WIFI_SILENT - 1);
	CHECK(board.reboots == 0);
	ticks(1);
	CHECK(board.reboots == 1);
	memset(&bt, 0, sizeof(bt));
}
#endif

/* ---- the two holes next to it ------------------------------------------------------- */

static void test_the_cloud_gets_tried_again_after_a_lost_event(void)
{
	/* NET_UP was lost: the link is up, and nothing has been asked of the cloud. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	atomic_set(&link_up, 1);
	CHECK(cloud_retry_in == -1);
	ticks(1);
	CHECK(cloud_retry_in == CONFIG_APP_CLOUD_RETRY_SECONDS - 1);
	ticks(CONFIG_APP_CLOUD_RETRY_SECONDS - 1);
	CHECK(board.cloud_connects == 0);
	ticks(1);
	CHECK(board.cloud_connects == 1);
	CHECK(cloud_retry_in == -1);

	/* While an attempt runs, nothing more is asked. */
	ticks(CONFIG_APP_CLOUD_RETRY_SECONDS * 2);
	CHECK(board.cloud_connects == 1);
	CHECK(cloud_retry_in == -1);

	/* The attempt ended, and CLOUD_DOWN never came. */
	board.cloud_connecting = false;
	ticks(CONFIG_APP_CLOUD_RETRY_SECONDS);
	CHECK(board.cloud_connects == 1);
	ticks(1);
	CHECK(board.cloud_connects == 2);

	/* With the cloud up, the link down, or no settings, nothing is armed. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	ticks(3);
	CHECK(cloud_retry_in == -1);

	boot(DEVICE_BOOT_OPERATING, false, true, true);
	atomic_set(&link_up, 1);
	board.cloud_up = true;
	ticks(3);
	CHECK(cloud_retry_in == -1);

	boot(DEVICE_BOOT_OPERATING, false, true, false);
	atomic_set(&link_up, 1);
	ticks(3);
	CHECK(cloud_retry_in == -1);

	/* A retry that is already on its way is left alone. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	link_comes_up();
	CHECK(cloud_retry_in == CLOUD_SETTLE_SECONDS);
	ticks(1);
	CHECK(cloud_retry_in == CLOUD_SETTLE_SECONDS - 1);
}

static void test_ticks_do_not_pile_up(void)
{
	boot(DEVICE_BOOT_OPERATING, false, true, true);

	/* The main loop is held up for a minute, and the timer goes on. */
	for (int i = 0; i < 60; i++) {
		on_tick_timer(&tick_timer);
	}
	CHECK(event_queue.used == 1);

	/* So everything else still fits. */
	for (unsigned int i = 1; i < event_queue.capacity; i++) {
		CHECK(app_event_post_simple(APP_EVENT_NET_DOWN) == 0);
	}
	CHECK(app_event_post_simple(APP_EVENT_NET_DOWN) != 0);

	/* It gets to it, and the next one can go in. */
	uptime_ms += MSEC_PER_SEC;
	run_loop();
	CHECK(event_queue.used == 0);
	CHECK(board.watchdog_feeds == 1);
	on_tick_timer(&tick_timer);
	CHECK(event_queue.used == 1);
	run_loop();
	CHECK(board.watchdog_feeds == 2);

	/* A queue that was full when the timer fired does not stop the ticks for good. */
	for (unsigned int i = 0; i < event_queue.capacity; i++) {
		CHECK(app_event_post_simple(APP_EVENT_NET_DOWN) == 0);
	}
	on_tick_timer(&tick_timer);
	CHECK(atomic_get(&tick_queued) == 0);
	run_loop();
	on_tick_timer(&tick_timer);
	CHECK(event_queue.used == 1);
	run_loop();
	CHECK(board.watchdog_feeds == 3);
}

static void test_a_held_up_main_loop_does_not_hold_up_the_timers(void)
{
	/* They go by uptime: the seconds count, also when there was only one tick for all of them. */
	boot(DEVICE_BOOT_OPERATING, false, true, true);
	uptime_ms += (WIFI_SILENT - 1) * MSEC_PER_SEC;
	on_tick();
	CHECK(board.reboots == 0);
	uptime_ms += MSEC_PER_SEC;
	on_tick();
	CHECK(board.reboots == 1);
}

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
	test_a_bluetooth_window_holds_the_restart();
#endif
	test_the_incident_on_the_main_loop();
	test_a_missing_hotspot_never_restarts_the_board();
	test_a_request_the_stack_refuses_is_silence();
	test_a_chip_that_does_not_come_up_leaves_the_main_loop_running();
	test_a_supplicant_that_never_gets_ready_leaves_the_main_loop_running();
	test_a_healthy_chip_joins_when_the_supplicant_is_ready();
	test_what_stands_in_the_way_of_a_restart();
	test_no_cloud_on_the_main_loop();
	test_each_update_state();
	test_the_back_off_across_restarts();
	test_storage_that_fails_never_blocks_a_restart();
	test_each_record_has_its_own_place_in_storage();
	test_a_good_join_result_ends_the_silence_with_the_link_still_down();
	test_new_settings_give_the_cloud_its_full_wait();
	test_a_restart_at_the_top_of_the_count_writes_nothing();
	test_the_cloud_gets_tried_again_after_a_lost_event();
	test_ticks_do_not_pile_up();
	test_a_held_up_main_loop_does_not_hold_up_the_timers();

	printf("%d application checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
