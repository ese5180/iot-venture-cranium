#include "console_cmd.h"

#include <errno.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include <zephyr/sys/printk.h>
#include <zephyr/sys/util.h>

#include "app_events.h"
#include "cloud.h"
#include "console_parser.h"
#include "console_port.h"
#include "console_stream.h"
#include "device.h"
#include "factory.h"
#include "identity.h"
#include "net.h"
#include "ota.h"
#include "version.h"

#define REPLY_MAX       256
#define EVENT_MAX       160
#define MAX_ARGS        4
/* An unknown command is shown by name, which is not worth more than this. */
#define NAME_SHOWN_MAX  32
#define USAGE_COLUMN    30
#define KEY_VALUE       "%-14s %s"
#define BOX_RULE        "+----------------------------------------------+"
#define BOX_WIDTH       44

/* What an on_main_guarded() function was not run for. No API here returns this. */
#define REFUSED_BY_UPDATE (-EINPROGRESS)

#define ID_RULE "id must be 1-%d letters or digits"

static const char *const section_names[SECTION_COUNT] = {
	[SECTION_DEVICE] = "Device",
	[SECTION_WIFI] = "Wi-Fi",
	[SECTION_CLOUD] = "Cloud",
	[SECTION_STATUS] = "Status",
	[SECTION_STREAM] = "Loading a certificate",
	[SECTION_TEST] = "Test bench",
};

static const struct console_command *find_command(const char *name);

static struct console_reader reader;
/* The reply being assembled. Only the console task uses this. */
static char reply_text[REPLY_MAX];
static bool final_sent;

/* A line that does not fit is marked as such, and never just cut off. */
static size_t format_into(char *buffer, size_t size, const char *format, va_list args)
{
	int written = vsnprintk(buffer, size, format, args);

	if (written < 0) {
		buffer[0] = '\0';
		return 0;
	}

	if ((size_t)written >= size) {
		memcpy(buffer + size - 4, "...", 4);
		return size - 1;
	}

	return (size_t)written;
}

void console_reply_line(const char *format, ...)
{
	va_list args;
	size_t length;

	va_start(args, format);
	length = format_into(reply_text, sizeof(reply_text), format, args);
	va_end(args);

	console_port_reply(reply_text, length, false);
}

/* The one line that ends a command. A second one is not sent. */
static void reply_final(const char *head, const char *format, va_list args)
{
	size_t used = strlen(head);

	if (final_sent) {
		return;
	}

	final_sent = true;
	memcpy(reply_text, head, used);
	used += format_into(reply_text + used, sizeof(reply_text) - used, format, args);
	console_port_reply(reply_text, used, true);
}

static void __printf_like(1, 2) reply_ok(const char *format, ...)
{
	va_list args;

	va_start(args, format);
	reply_final("OK ", format, args);
	va_end(args);
}

static void __printf_like(1, 2) reply_err(const char *format, ...)
{
	va_list args;

	va_start(args, format);
	reply_final("ERR ", format, args);
	va_end(args);
}

static void reply_done(void)
{
	if (!final_sent) {
		final_sent = true;
		console_port_reply("OK", 2, true);
	}
}

void console_event(const char *tag, const char *format, ...)
{
	char line[EVENT_MAX];
	int used = snprintk(line, sizeof(line), "[%s] ", tag);
	va_list args;

	va_start(args, format);
	used += (int)format_into(line + used, sizeof(line) - (size_t)used, format, args);
	va_end(args);

	console_port_event(line, (size_t)used);
}

/* ---- the main loop's side ------------------------------------------------------- */

struct guarded_call {
	int (*function)(void *arg);
	void *arg;
};

/*
 * On the main loop, so that the update state cannot change between this check and the
 * function: a trial's record, and what the trial needs to reach the cloud, must survive.
 */
static int run_unless_updating(void *arg)
{
	const struct guarded_call *call = arg;

	return ota_state() != OTA_IDLE ? REFUSED_BY_UPDATE : call->function(call->arg);
}

static int on_main_guarded(int (*function)(void *arg), void *arg)
{
	struct guarded_call call = { .function = function, .arg = arg };

	return console_port_on_main(run_unless_updating, &call);
}

/* Says so and returns true if the function was not run because of an update. */
static bool refused_by_update(int err)
{
	if (err == REFUSED_BY_UPDATE) {
		reply_err("update in progress");
		return true;
	}

	return false;
}

static int do_nothing(void *arg)
{
	ARG_UNUSED(arg);
	return 0;
}

static int do_cloud_off(void *arg)
{
	ARG_UNUSED(arg);
	cloud_disconnect();
	return 0;
}

/* ---- device --------------------------------------------------------------------- */

static void cmd_help(int argc, char **argv);

struct init_call {
	const char *id;
	enum device_init_step step;
};

static int do_init_prepare(void *arg)
{
	struct init_call *call = arg;

	cloud_disconnect();
	call->step = device_init_prepare(call->id);
	return 0;
}

static int do_init_finish(void *arg)
{
	struct init_call *call = arg;

	call->step = device_init_finish();
	return 0;
}

static void cmd_init(int argc, char **argv)
{
	struct init_call call = { .id = argv[0] };

	ARG_UNUSED(argc);

	/* Before anything is touched, so that a typo cannot wipe the board. */
	if (!device_id_valid(argv[0])) {
		reply_err(ID_RULE, DEVICE_ID_MAX);
		return;
	}

	if (refused_by_update(on_main_guarded(do_init_prepare, &call))) {
		return;
	}

	if (call.step == DEVICE_INIT_OK) {
		console_port_before_init_flag();
		(void)console_port_on_main(do_init_finish, &call);
	}

	if (call.step != DEVICE_INIT_OK) {
		reply_err("init failed at step: %s", device_init_step_name(call.step));
		return;
	}

	reply_ok("initialised as %s, rebooting", argv[0]);
	console_port_reboot();
}

static void cmd_get_id(int argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	reply_ok("%s|%s", device_id(), fw_version_running_string());
}

static void cmd_thing(int argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	reply_ok("%s", identity_thing_name());
}

static void cmd_echo(int argc, char **argv)
{
	ARG_UNUSED(argc);

	if (console_equal_nocase(argv[0], "ON")) {
		reader.echo = true;
		reply_ok("echo on");
	} else if (console_equal_nocase(argv[0], "OFF")) {
		reader.echo = false;
		reply_ok("echo off");
	} else {
		reply_err("usage: %s", find_command("ECHO")->usage);
	}
}

static void cmd_reboot(int argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	(void)console_port_on_main(do_cloud_off, NULL);
	reply_ok("rebooting");
	console_port_reboot();
}

/*
 * MCUboot cannot be updated over the air here, so it gets no new way in: it listens for
 * half a second after every reset anyway, and tools/recover.py catches that window.
 */
static void cmd_enter_bootloader(int argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	(void)console_port_on_main(do_cloud_off, NULL);
	reply_ok("rebooting, the bootloader listens for half a second: use tools/recover.py --console");
	console_port_reboot();
}

static int do_set_id(void *arg)
{
	return device_id_set(arg);
}

static void cmd_set_id(int argc, char **argv)
{
	int err;

	ARG_UNUSED(argc);

	if (!device_id_valid(argv[0])) {
		reply_err(ID_RULE, DEVICE_ID_MAX);
		return;
	}

	err = on_main_guarded(do_set_id, argv[0]);
	if (refused_by_update(err)) {
		return;
	}

	if (err) {
		reply_err("id could not be stored (%d)", err);
		return;
	}

	reply_ok("id set to %s", argv[0]);
}

static int do_reset_config(void *arg)
{
	int err = identity_settings_clear();

	ARG_UNUSED(arg);

	cloud_disconnect();
	return err;
}

static void cmd_reset_config(int argc, char **argv)
{
	int err = on_main_guarded(do_reset_config, NULL);

	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	if (refused_by_update(err)) {
		return;
	}

	if (err) {
		reply_err("settings could not be cleared (%d)", err);
		return;
	}

	reply_ok("cloud settings cleared; id, wifi, certificates and key kept");
}

static int do_factory_reset(void *arg)
{
	ARG_UNUSED(arg);

	cloud_disconnect();
	return factory_reset();
}

static void cmd_factory_reset(int argc, char **argv)
{
	int err = on_main_guarded(do_factory_reset, NULL);

	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	if (refused_by_update(err)) {
		return;
	}

	if (err) {
		/* The board is in factory mode by now, and INIT is what erases there. */
		reply_err("not everything could be erased (%d), send INIT|<id> to try again", err);
		return;
	}

	reply_ok("erased, rebooting into factory mode");
	console_port_reboot();
}

/* ---- Wi-Fi ---------------------------------------------------------------------- */

struct wifi_call {
	const char *ssid;
	size_t ssid_len;
	enum net_security security;
	const char *password;
	size_t password_len;
};

static int do_wifi(void *arg)
{
	const struct wifi_call *call = arg;

	return net_credentials_set(call->ssid, call->ssid_len, call->security, call->password,
				   call->password_len);
}

/* The password stays in the reader's buffer, which is wiped when the command is over. */
static void save_network(const char *ssid, enum net_security security, const char *password)
{
	struct wifi_call call = {
		.ssid = ssid,
		.ssid_len = strlen(ssid),
		.security = security,
		.password = password,
		.password_len = strlen(password),
	};
	int err;

	if (call.ssid_len == 0 || call.ssid_len > NET_SSID_MAX) {
		reply_err("ssid must be 1-%d bytes", NET_SSID_MAX);
		return;
	}

	if (call.password_len == 0) {
		reply_err("open networks are not allowed");
		return;
	}

	if (call.password_len < NET_PASSWORD_MIN || call.password_len > NET_PASSWORD_MAX) {
		reply_err("password must be %d-%d characters", NET_PASSWORD_MIN, NET_PASSWORD_MAX);
		return;
	}

	err = on_main_guarded(do_wifi, &call);
	if (refused_by_update(err)) {
		return;
	}

	if (err) {
		reply_err("the network could not be stored (%d)", err);
		return;
	}

	reply_ok("saved, connecting to %s", ssid);

	/* After the reply, so that the [WIFI] line about the join always comes behind it. */
	(void)app_event_post_simple(APP_EVENT_NET_JOIN);
}

static void cmd_wifi(int argc, char **argv)
{
	ARG_UNUSED(argc);

	save_network(argv[0], NET_SECURITY_WPA2_PSK, argv[1]);
}

static void cmd_wifi_sec(int argc, char **argv)
{
	static const struct {
		const char *name;
		enum net_security security;
	} securities[] = {
		{ "WPA2_PSK", NET_SECURITY_WPA2_PSK },
		{ "WPA2_PSK_SHA256", NET_SECURITY_WPA2_PSK_SHA256 },
		{ "WPA3_SAE", NET_SECURITY_WPA3_SAE },
	};

	ARG_UNUSED(argc);

	for (size_t i = 0; i < sizeof(securities) / sizeof(securities[0]); i++) {
		if (console_equal_nocase(argv[1], securities[i].name)) {
			save_network(argv[0], securities[i].security, argv[2]);
			return;
		}
	}

	reply_err("security must be WPA2_PSK, WPA2_PSK_SHA256 or WPA3_SAE");
}

static int do_clear_wifi(void *arg)
{
	ARG_UNUSED(arg);
	return net_credentials_clear();
}

static void cmd_clear_wifi(int argc, char **argv)
{
	int err = on_main_guarded(do_clear_wifi, NULL);

	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	if (refused_by_update(err)) {
		return;
	}

	if (err) {
		reply_err("the network could not be erased (%d)", err);
		return;
	}

	reply_ok("network erased, disconnecting");
}

static struct net_status net_view;

static const char *net_state_name(void)
{
	if (net_view.connected) {
		return "connected";
	}

	return net_view.stored ? "not connected" : "no network stored";
}

static void cmd_net(int argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	net_status_get(&net_view);

	console_reply_line(KEY_VALUE, "state", net_state_name());
	console_reply_line(KEY_VALUE, "ssid", net_view.stored ? net_view.ssid : "unset");
	console_reply_line(KEY_VALUE, "ip", net_view.ip[0] != '\0' ? net_view.ip : "none");
	console_reply_line("%-14s %d", "rssi", net_view.connected ? net_view.rssi : 0);
	console_reply_line(KEY_VALUE, "mac", net_view.mac[0] != '\0' ? net_view.mac : "unknown");
	reply_done();
}

/* ---- cloud ---------------------------------------------------------------------- */

struct cloud_call {
	const char *endpoint;
	const char *download_url_prefix;
};

static int do_cloud(void *arg)
{
	const struct cloud_call *call = arg;
	int err = call->endpoint[0] == '\0'
			  ? identity_settings_clear()
			  : identity_settings_set(call->endpoint, call->download_url_prefix);

	if (err) {
		return err;
	}

	cloud_disconnect();
	(void)app_event_post_simple(APP_EVENT_CLOUD_CHANGED);
	return 0;
}

static void cmd_cloud(int argc, char **argv)
{
	struct cloud_call call = {
		.endpoint = argv[0],
		.download_url_prefix = argc > 1 ? argv[1] : "",
	};
	bool clearing = call.endpoint[0] == '\0' && call.download_url_prefix[0] == '\0';
	int err;

	if (!clearing && (call.endpoint[0] == '\0' || call.download_url_prefix[0] == '\0')) {
		reply_err("usage: %s", find_command("CLOUD")->usage);
		return;
	}

	err = on_main_guarded(do_cloud, &call);
	if (refused_by_update(err)) {
		return;
	}

	if (err == -EINVAL) {
		reply_err("endpoint must be a host name and the prefix an https:// URL with a path");
		return;
	}

	if (err) {
		reply_err("the settings could not be stored (%d)", err);
		return;
	}

	reply_ok("cloud settings %s", clearing ? "cleared" : "saved");
}

static int do_store_key(void *arg)
{
	ARG_UNUSED(arg);
	return console_port_keygen_store();
}

/* An update can begin while the key is being created: only here is the old key given up. */
static void store_and_print_key(void)
{
	int err = on_main_guarded(do_store_key, NULL);

	if (refused_by_update(err)) {
		return;
	}

	if (err) {
		reply_err("private key could not be stored (%d)", err);
		return;
	}

	err = console_port_keygen_print();
	if (err) {
		reply_err("request could not be encoded (%d)", err);
		return;
	}

	reply_ok("key pair created");
}

static void cmd_keygen(int argc, char **argv)
{
	bool replace = argc == 1 && console_equal_nocase(argv[0], "REPLACE");
	const char *reason = "key pair";
	int err;

	if (argc == 1 && !replace) {
		reply_err("usage: %s", find_command("KEYGEN")->usage);
		return;
	}

	if (refused_by_update(on_main_guarded(do_nothing, NULL))) {
		return;
	}

	if (factory_has_private_key() && !replace) {
		reply_err("a device key exists, KEYGEN|REPLACE discards it and its certificate");
		return;
	}

	err = console_port_keygen_create(&reason);
	if (err) {
		reply_err("%s (%d)", reason, err);
	} else {
		store_and_print_key();
	}

	console_port_keygen_end();
}

/* ---- status --------------------------------------------------------------------- */

/* Copies of what the main loop owns. Nothing here is secret. */
static struct {
	bool has_settings;
	char endpoint[IDENTITY_ENDPOINT_MAX];
	char download_url_prefix[IDENTITY_URL_PREFIX_MAX];
	const char *update_state;
	char update_last[16];
} main_view;

static int read_main_view(void *arg)
{
	const struct identity_settings *config = identity_settings_get();

	ARG_UNUSED(arg);

	main_view.has_settings = config != NULL;
	if (config != NULL) {
		strncpy(main_view.endpoint, config->endpoint, sizeof(main_view.endpoint) - 1);
		strncpy(main_view.download_url_prefix, config->download_url_prefix,
			sizeof(main_view.download_url_prefix) - 1);
	}

	main_view.update_state = ota_state_name();
	strncpy(main_view.update_last, ota_last_result(), sizeof(main_view.update_last) - 1);
	return 0;
}

static const char *set_or_unset(bool set)
{
	return set ? "set" : "unset";
}

static const char *mode_name(void)
{
	return device_is_factory() ? "FACTORY" : "OPERATING";
}

static void print_device(void)
{
	console_reply_line(KEY_VALUE, "state", mode_name());
	console_reply_line(KEY_VALUE, "id", device_id());
	console_reply_line(KEY_VALUE, "thing name", identity_thing_name());
	console_reply_line(KEY_VALUE, "firmware", fw_version_running_string());
}

static void print_wifi(void)
{
	net_status_get(&net_view);

	console_reply_line(KEY_VALUE, "wifi network", net_view.stored ? net_view.ssid : "unset");
	console_reply_line(KEY_VALUE, "wifi password", set_or_unset(net_view.stored));
	console_reply_line(KEY_VALUE, "wifi link", net_view.connected ? "up" : "down");
	console_reply_line(KEY_VALUE, "wifi address",
			   net_view.mac[0] != '\0' ? net_view.mac : "unknown");
}

static void print_cloud(void)
{
	console_reply_line(KEY_VALUE, "endpoint",
			   main_view.has_settings ? main_view.endpoint : "unset");
	console_reply_line(KEY_VALUE, "download from",
			   main_view.has_settings ? main_view.download_url_prefix : "unset");
	console_reply_line(KEY_VALUE, "cloud",
			   cloud_is_connected() ? "connected" : "not connected");
}

static void print_certs(void)
{
	console_reply_line(KEY_VALUE, "root CA", set_or_unset(factory_has_root_ca()));
	console_reply_line(KEY_VALUE, "private key", set_or_unset(factory_has_private_key()));
	console_reply_line(KEY_VALUE, "certificate", set_or_unset(factory_has_certificate()));
}

static void print_update(void)
{
	console_reply_line("%-14s %s (last: %s)", "update", main_view.update_state,
			   main_view.update_last);
}

static const struct {
	const char *name;
	void (*print)(void);
} status_sections[] = {
	{ "device", print_device },
	{ "wifi", print_wifi },
	{ "cloud", print_cloud },
	{ "certs", print_certs },
	{ "update", print_update },
};

#define STATUS_SECTION_COUNT (sizeof(status_sections) / sizeof(status_sections[0]))

static void cmd_status(int argc, char **argv)
{
	char names[48] = "";

	(void)console_port_on_main(read_main_view, NULL);

	for (size_t i = 0; i < STATUS_SECTION_COUNT; i++) {
		if (argc == 1 && console_equal_nocase(argv[0], status_sections[i].name)) {
			status_sections[i].print();
			reply_done();
			return;
		}
	}

	if (argc == 0) {
		for (size_t i = 0; i < STATUS_SECTION_COUNT; i++) {
			status_sections[i].print();
		}
		reply_done();
		return;
	}

	for (size_t i = 0; i < STATUS_SECTION_COUNT; i++) {
		strcat(names, " ");
		strcat(names, status_sections[i].name);
	}

	reply_err("unknown section, use one of:%s", names);
}

static void __printf_like(2, 3) box_line(const char *prefix, const char *format, ...)
{
	char text[BOX_WIDTH + 1];
	va_list args;

	va_start(args, format);
	(void)format_into(text, sizeof(text), format, args);
	va_end(args);

	console_reply_line("%s| %-*s |", prefix, BOX_WIDTH, text);
}

static void box_field(const char *prefix, const char *label, const char *value)
{
	box_line(prefix, "%-9s %s", label, value);
}

static void box_wifi(const char *prefix)
{
	net_status_get(&net_view);

	if (!net_view.stored) {
		box_field(prefix, "WiFi", "unset");
	} else if (net_view.connected) {
		box_line(prefix, "%-9s %s, %d dBm", "WiFi", net_view.ssid, net_view.rssi);
	} else {
		box_line(prefix, "%-9s %s, not connected", "WiFi", net_view.ssid);
	}
}

void console_cmd_boot_box(void)
{
	static const char prefix[] = "[BOOT] ";

	console_reply_line("%s%s", prefix, BOX_RULE);
	box_field(prefix, "State", mode_name());
	box_field(prefix, "ID", device_id()[0] != '\0' ? device_id() : "unset");
	box_field(prefix, "Thing", identity_thing_name());
	box_field(prefix, "Firmware", fw_version_running_string());
	box_wifi(prefix);
	box_field(prefix, "Type HELP", "");

	/* The last line ends this reply, which lets the log lines held back meanwhile go. */
	(void)snprintk(reply_text, sizeof(reply_text), "%s%s", prefix, BOX_RULE);
	console_port_reply(reply_text, strlen(reply_text), true);
}

static void cmd_stats(int argc, char **argv)
{
	char value[32];
	int64_t seconds = console_port_uptime_ms() / 1000;

	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	console_reply_line(BOX_RULE);
	box_field("", "State", mode_name());
	box_field("", "ID", device_id());
	box_field("", "Thing", identity_thing_name());
	box_field("", "Firmware", fw_version_running_string());
	box_wifi("");

	(void)snprintk(value, sizeof(value), "%ud %02u:%02u:%02u", (unsigned int)(seconds / 86400),
		       (unsigned int)((seconds / 3600) % 24), (unsigned int)((seconds / 60) % 60),
		       (unsigned int)(seconds % 60));
	box_field("", "Uptime", value);

	(void)snprintk(value, sizeof(value), "%u bytes", (unsigned int)console_port_free_heap());
	box_field("", "Free heap", value);

	box_field("", "Reset", console_port_reset_reason());
	console_reply_line(BOX_RULE);
	reply_done();
}

/* ---- loading a certificate ------------------------------------------------------ */

static bool parse_number(const char *text, uint32_t *out)
{
	uint64_t value = 0;

	if (*text == '\0') {
		return false;
	}

	for (; *text != '\0'; text++) {
		if (*text < '0' || *text > '9') {
			return false;
		}

		value = value * 10 + (uint64_t)(*text - '0');
		if (value > UINT32_MAX) {
			return false;
		}
	}

	*out = (uint32_t)value;
	return true;
}

static bool parse_crc(const char *text, uint16_t *out)
{
	uint32_t value = 0;
	size_t length = strlen(text);

	if (length == 0 || length > 4) {
		return false;
	}

	for (; *text != '\0'; text++) {
		char c = *text;
		uint32_t digit;

		if (c >= '0' && c <= '9') {
			digit = (uint32_t)(c - '0');
		} else if (c >= 'a' && c <= 'f') {
			digit = (uint32_t)(c - 'a') + 10;
		} else if (c >= 'A' && c <= 'F') {
			digit = (uint32_t)(c - 'A') + 10;
		} else {
			return false;
		}

		value = (value << 4) | digit;
	}

	*out = (uint16_t)value;
	return true;
}

static const char *stream_kind_name(enum console_stream_kind kind)
{
	return kind == CONSOLE_STREAM_CA ? "CA" : "CERT";
}

static void cmd_stream_start(int argc, char **argv)
{
	uint32_t total;
	uint32_t chunk_count;
	uint16_t crc;
	enum console_stream_kind kind;

	ARG_UNUSED(argc);

	if (refused_by_update(on_main_guarded(do_nothing, NULL))) {
		return;
	}

	if (!parse_number(argv[0], &total) || !parse_number(argv[1], &chunk_count) ||
	    !parse_crc(argv[2], &crc)) {
		reply_err("usage: %s", find_command("STREAM_START")->usage);
		return;
	}

	if (console_equal_nocase(argv[3], "CA")) {
		kind = CONSOLE_STREAM_CA;
	} else if (console_equal_nocase(argv[3], "CERT")) {
		kind = CONSOLE_STREAM_CERT;
	} else {
		reply_err("a stream is a CA or a CERT");
		return;
	}

	if (!console_stream_start(total, chunk_count, crc, kind, console_port_uptime_ms())) {
		reply_err("total_bytes must be 1-%d, and chunk_count 1 to total_bytes",
			  CONSOLE_STREAM_MAX);
		return;
	}

	reply_ok("ready for %u chunks", (unsigned int)chunk_count);
}

struct store_call {
	enum console_stream_kind kind;
	const uint8_t *der;
	size_t length;
};

static int do_store_certificate(void *arg)
{
	const struct store_call *call = arg;

	return console_port_store_certificate(call->kind, call->der, call->length);
}

/* The whole stream passed its CRC: only now does anything get stored. */
static void apply_stream(void)
{
	struct store_call call;
	int err;

	call.der = console_stream_data(&call.length, &call.kind);

	if (call.length < 64 || call.der[0] != 0x30) {
		reply_err("the data is not a DER certificate");
		return;
	}

	err = on_main_guarded(do_store_certificate, &call);
	if (refused_by_update(err)) {
		return;
	}

	if (err) {
		reply_err("the certificate could not be stored (%d)", err);
		return;
	}

	reply_ok("%s stored (%u bytes)", stream_kind_name(call.kind), (unsigned int)call.length);
}

static void cmd_stream_chunk(int argc, char **argv)
{
	static const char *const failures[] = {
		[CONSOLE_STREAM_NOT_ACTIVE] = "no transfer is under way",
		[CONSOLE_STREAM_WRONG_INDEX] = "wrong chunk index, transfer aborted",
		[CONSOLE_STREAM_BAD_BASE64] = "chunk is not base64, transfer aborted",
		[CONSOLE_STREAM_TOO_MUCH] = "more data than announced, transfer aborted",
		[CONSOLE_STREAM_WRONG_LENGTH] = "less data than announced, transfer aborted",
		[CONSOLE_STREAM_BAD_CRC] = "crc mismatch, transfer aborted, nothing stored",
	};
	uint32_t index;
	enum console_stream_result result;

	ARG_UNUSED(argc);

	/* No stream gets this far, so what is not a number is a wrong index like any other. */
	if (!parse_number(argv[0], &index)) {
		index = UINT32_MAX;
	}

	result = console_stream_chunk(index, argv[1], console_port_uptime_ms());

	if (result == CONSOLE_STREAM_MORE) {
		reply_ok("chunk %u taken", (unsigned int)index);
	} else if (result == CONSOLE_STREAM_COMPLETE) {
		apply_stream();
	} else {
		reply_err("%s", failures[result]);
	}
}

static void cmd_stream_status(int argc, char **argv)
{
	struct console_stream_status status;

	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	console_stream_get_status(&status);

	if (!status.active) {
		reply_ok("idle");
		return;
	}

	reply_ok("%s chunk %u of %u, %u of %u bytes", stream_kind_name(status.kind),
		 (unsigned int)status.next_index, (unsigned int)status.chunk_count,
		 (unsigned int)status.received, (unsigned int)status.total);
}

static void cmd_stream_cancel(int argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	reply_ok("%s", console_stream_cancel() ? "transfer cancelled" : "nothing to cancel");
}

/* ---- test bench ----------------------------------------------------------------- */

/*
 * A press of a button without a finger on it, so that a test bench can drive an update
 * from start to finish. It takes the path of the real button. Like everything here it
 * does not exist in a release build, where only a person can consent.
 */
static void cmd_button(int argc, char **argv)
{
	struct app_event event = { .type = APP_EVENT_BUTTON };

	ARG_UNUSED(argc);

	if (strcmp(argv[0], "1") == 0) {
		event.button.id = APP_BUTTON_1;
	} else if (strcmp(argv[0], "2") == 0) {
		event.button.id = APP_BUTTON_2;
	} else {
		reply_err("button must be 1 or 2");
		return;
	}

	if (app_event_post(&event) != 0) {
		reply_err("the application is busy");
		return;
	}

	reply_ok("button %s", argv[0]);
}

/* ---- the table ------------------------------------------------------------------ */

static const struct console_command commands[] = {
	{ "HELP", "?", "HELP", "list the commands", SECTION_DEVICE, true, 0, 0, cmd_help },
	{ "INIT", NULL, "INIT|<id>",
	  "first-time setup: erase everything, store the id, restart", SECTION_DEVICE, true, 1, 1,
	  cmd_init },
	{ "GET_ID", NULL, "GET_ID", "reply with <id>|<firmware version>", SECTION_DEVICE, true, 0, 0,
	  cmd_get_id },
	{ "THING", NULL, "THING", "reply with the AWS IoT thing name", SECTION_DEVICE, true, 0, 0,
	  cmd_thing },
	{ "ECHO", NULL, "ECHO|<ON or OFF>", "send typed characters back, or not", SECTION_DEVICE, true,
	  1, 1, cmd_echo },
	{ "REBOOT", NULL, "REBOOT", "restart", SECTION_DEVICE, true, 0, 0, cmd_reboot },
	{ "ENTER_BOOTLOADER", NULL, "ENTER_BOOTLOADER",
	  "restart; catch the bootloader with tools/recover.py --console", SECTION_DEVICE, true, 0, 0,
	  cmd_enter_bootloader },
	{ "SET_ID", NULL, "SET_ID|<id>", "change the id, keep everything else", SECTION_DEVICE, false,
	  1, 1, cmd_set_id },
	{ "RESET_CONFIG", NULL, "RESET_CONFIG",
	  "clear the cloud settings only; keep id, wifi, certificates, key", SECTION_DEVICE, false, 0,
	  0, cmd_reset_config },
	{ "FACTORY_RESET", NULL, "FACTORY_RESET",
	  "erase everything, also the id, and restart in factory mode", SECTION_DEVICE, false, 0, 0,
	  cmd_factory_reset },

	{ "WIFI", NULL, "WIFI|<ssid>|<password>", "save a WPA2 network and join it", SECTION_WIFI,
	  false, 2, 2, cmd_wifi },
	{ "WIFI_SEC", NULL, "WIFI_SEC|<ssid>|<WPA2_PSK or WPA2_PSK_SHA256 or WPA3_SAE>|<password>",
	  "the same, with the security mode named", SECTION_WIFI, false, 3, 3, cmd_wifi_sec },
	{ "CLEAR_WIFI", NULL, "CLEAR_WIFI", "erase the network and disconnect", SECTION_WIFI, false, 0,
	  0, cmd_clear_wifi },
	{ "NET", NULL, "NET", "show connection state, ssid, ip, rssi and mac", SECTION_WIFI, false, 0,
	  0, cmd_net },

	{ "CLOUD", NULL, "CLOUD|<endpoint>|<download-url-prefix>",
	  "save the AWS IoT endpoint and the download prefix; empty clears", SECTION_CLOUD, false, 1,
	  2, cmd_cloud },
	{ "KEYGEN", NULL, "KEYGEN[|REPLACE]", "create the device key, print a signing request",
	  SECTION_CLOUD, false, 0, 1, cmd_keygen },

	{ "STATS", NULL, "STATS", "show state, id, firmware, wifi, uptime, memory, last reset",
	  SECTION_STATUS, false, 0, 0, cmd_stats },
	{ "STATUS", NULL, "STATUS[|<section>]",
	  "print the configuration: device, wifi, cloud, certs or update", SECTION_STATUS, false, 0, 1,
	  cmd_status },

	{ "STREAM_START", NULL, "STREAM_START|<total_bytes>|<chunk_count>|<crc16_hex>|<CA or CERT>",
	  "start loading a certificate", SECTION_STREAM, false, 4, 4, cmd_stream_start },
	{ "STREAM_CHUNK", NULL, "STREAM_CHUNK|<index>|<base64>", "the next piece of it",
	  SECTION_STREAM, false, 2, 2, cmd_stream_chunk },
	{ "STREAM_STATUS", NULL, "STREAM_STATUS", "show how far it is", SECTION_STREAM, false, 0, 0,
	  cmd_stream_status },
	{ "STREAM_CANCEL", NULL, "STREAM_CANCEL", "give up on it", SECTION_STREAM, false, 0, 0,
	  cmd_stream_cancel },

	{ "BUTTON", NULL, "BUTTON|<1 or 2>", "act as if the button was pressed", SECTION_TEST, false,
	  1, 1, cmd_button },
};

#define COMMAND_COUNT (sizeof(commands) / sizeof(commands[0]))

static const struct console_command *find_command(const char *name)
{
	for (size_t i = 0; i < COMMAND_COUNT; i++) {
		if (console_equal_nocase(name, commands[i].name) ||
		    (commands[i].alias != NULL && strcmp(name, commands[i].alias) == 0)) {
			return &commands[i];
		}
	}

	return NULL;
}

static void cmd_help(int argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	console_reply_line("Cranium console, firmware %s", fw_version_running_string());
	console_reply_line("Commands marked * also work in factory mode.");

	for (int section = 0; section < SECTION_COUNT; section++) {
		console_reply_line("%s:", section_names[section]);

		for (size_t i = 0; i < COMMAND_COUNT; i++) {
			const struct console_command *command = &commands[i];

			if ((int)command->section != section) {
				continue;
			}

			console_reply_line("%c %-*s %s%s%s", command->in_factory ? '*' : ' ',
					   USAGE_COLUMN, command->usage, command->description,
					   command->alias != NULL ? ", also " : "",
					   command->alias != NULL ? command->alias : "");
		}
	}

	reply_done();
}

static void run_line(char *line)
{
	char *name;
	char *rest = console_split_name(line, &name);
	char *argv[MAX_ARGS];
	const struct console_command *command;
	int argc;

	if (name[0] == '\0') {
		reply_err("no command, type HELP");
		return;
	}

	command = find_command(name);
	if (command == NULL) {
		/* Only the name: what follows it, after a '|' or a blank, could be a password. */
		reply_err("unknown command %.*s, type HELP", (int)MIN(strcspn(name, " \t"), NAME_SHOWN_MAX),
			  name);
		return;
	}

	if (device_is_factory() && !command->in_factory) {
		reply_err("factory mode, send INIT|<id> first");
		return;
	}

	argc = console_split_args(rest, argv, command->max_args);
	if (argc < command->min_args || argc > command->max_args) {
		reply_err("usage: %s", command->usage);
		return;
	}

	command->handler(argc, argv);
	reply_done();
}

/* ---- the task's entry points ---------------------------------------------------- */

void console_cmd_init(void)
{
	console_reader_init(&reader, console_port_echo);
}

void console_cmd_feed(char byte)
{
	enum console_read_result result = console_reader_feed(&reader, byte);

	final_sent = false;

	switch (result) {
	case CONSOLE_READ_LINE:
		run_line(reader.line);
		console_reader_done(&reader);
		break;
	case CONSOLE_READ_TOO_LONG:
		reply_err("line too long, the limit is %d bytes", CONSOLE_LINE_MAX);
		break;
	case CONSOLE_READ_INVALID:
		reply_err("line discarded, it held a control character");
		break;
	case CONSOLE_READ_LOST:
		reply_err("line discarded, bytes of it were lost");
		break;
	case CONSOLE_READ_MORE:
	default:
		break;
	}
}

void console_cmd_input_lost(void)
{
	console_reader_mark_lost(&reader);
}

void console_cmd_tick(void)
{
	if (console_stream_expire(console_port_uptime_ms())) {
		console_event("CONSOLE", "stream aborted: idle timeout");
	}
}

const struct console_command *console_cmd_table(size_t *count)
{
	*count = COMMAND_COUNT;
	return commands;
}
