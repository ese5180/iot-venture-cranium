#include "console_fakes.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>

#include <hw_id.h>
#include <zephyr/net/tls_credentials.h>

#include "cloud.h"
#include "console_cmd.h"
#include "console_port.h"
#include "store.h"
#include "stuck.h"

struct fake_board fake;

void fake_reset(void)
{
	memset(&fake, 0, sizeof(fake));
	fake.cut_after = -1;
	fake.ota = OTA_IDLE;
}

void fake_clear_log(void)
{
	fake.ops[0] = '\0';
	fake.output[0] = '\0';
	fake.events[0] = '\0';
	fake.echo[0] = '\0';
	fake.finals = 0;
	fake.reboots = 0;
	fake.joins = 0;
	fake.cloud_changes = 0;
	fake.button_presses = 0;
}

void fake_note_op(const char *op)
{
	size_t used = strlen(fake.ops);

	snprintf(fake.ops + used, sizeof(fake.ops) - used, "%s ", op);
}

static void note_record_op(char kind, int id)
{
	char op[8];

	snprintf(op, sizeof(op), "%c%d", kind, id);
	fake_note_op(op);
}

static void append(char *buffer, size_t size, const char *text, size_t length)
{
	size_t used = strlen(buffer);

	snprintf(buffer + used, size - used, "%.*s", (int)length, text);
}

/* True once the power has gone: from then on nothing reaches storage. */
static bool power_gone(void)
{
	if (fake.cut_after < 0) {
		return false;
	}

	if (fake.cut_after == 0) {
		return true;
	}

	fake.cut_after--;
	return false;
}

/* ---- store.h -------------------------------------------------------------------- */

int store_read(enum store_id id, void *data, size_t size)
{
	struct fake_record *record = &fake.records[id];

	note_record_op('R', id);

	if (fake.fail_read[id]) {
		return -EIO;
	}

	if (!record->present) {
		return -ENOENT;
	}

	if (record->size != size) {
		return -EBADMSG;
	}

	memcpy(data, record->data, size);

	if (fake.corrupt_read[id]) {
		((uint8_t *)data)[0] ^= 0x01;
	}

	return 0;
}

int store_write(enum store_id id, const void *data, size_t size)
{
	struct fake_record *record = &fake.records[id];

	note_record_op('W', id);

	if (fake.fail_write[id]) {
		return -EIO;
	}

	if (fake.fail_flag_complete && id == STORE_INIT_FLAG &&
	    memcmp(data, "TINI", 4) == 0) {
		return -EIO;
	}

	if (power_gone()) {
		return 0;
	}

	memcpy(record->data, data, size);
	record->size = size;
	record->present = true;
	return 0;
}

int store_erase(enum store_id id)
{
	note_record_op('E', id);

	if (fake.fail_erase[id]) {
		return -EIO;
	}

	if (!power_gone()) {
		fake.records[id].present = false;
	}

	return 0;
}

/* ---- net.h ---------------------------------------------------------------------- */

int net_credentials_set(const char *ssid, size_t ssid_len, enum net_security security,
			const char *passphrase, size_t passphrase_len)
{
	fake_note_op("wifi-set");

	fake.password_argument = passphrase;
	fake.password_argument_length = passphrase_len;

	if (fake.fail_wifi_set) {
		return -EIO;
	}

	if (!power_gone()) {
		memcpy(fake.wifi_ssid, ssid, ssid_len);
		fake.wifi_ssid[ssid_len] = '\0';
		memcpy(fake.wifi_password, passphrase, passphrase_len);
		fake.wifi_password[passphrase_len] = '\0';
		fake.wifi_security = security;
		fake.wifi_stored = true;
	}

	return 0;
}

int net_credentials_clear(void)
{
	fake_note_op("wifi-clear");

	if (fake.fail_wifi_clear) {
		return -EIO;
	}

	if (!power_gone()) {
		fake.wifi_stored = false;
		memset(fake.wifi_password, 0, sizeof(fake.wifi_password));
	}

	fake.link_up = false;
	return 0;
}

bool net_has_credentials(void)
{
	return fake.wifi_stored;
}

bool net_is_up(void)
{
	return fake.link_up;
}

void net_status_get(struct net_status *status)
{
	memset(status, 0, sizeof(*status));
	status->stored = fake.wifi_stored;
	status->connected = fake.link_up;
	strcpy(status->ssid, fake.wifi_ssid);
	strcpy(status->mac, "02:00:00:00:00:01");
	if (fake.link_up) {
		strcpy(status->ip, fake.link_up_without_address ? "" : "192.168.1.42");
		status->rssi = -51;
	}
}

/* ---- cloud.h, ota.h, app_events.h ------------------------------------------------ */

void cloud_disconnect(void)
{
	fake.cloud_disconnects++;
	fake.cloud_connected = false;
}

bool cloud_is_connected(void)
{
	return fake.cloud_connected;
}

enum ota_state ota_state(void)
{
	return fake.ota;
}

const char *ota_state_name(void)
{
	return fake.ota == OTA_IDLE ? "idle" : "testing";
}

const char *ota_last_result(void)
{
	return "none";
}

uint8_t stuck_count(void)
{
	return fake.stuck_count;
}

int app_event_post(const struct app_event *event)
{
	if (fake.event_queue_full) {
		return -ENOMSG;
	}

	if (event->type == APP_EVENT_BUTTON) {
		fake.button_presses++;
		fake.last_button = *event;
	}

	return 0;
}

int app_event_post_simple(enum app_event_type type)
{
	if (type == APP_EVENT_NET_JOIN) {
		fake.joins++;
		fake_note_op("join");
	} else if (type == APP_EVENT_CLOUD_CHANGED) {
		fake.cloud_changes++;
	}

	return 0;
}

/* ---- hw_id.h, tls_credentials.h -------------------------------------------------- */

int hw_id_get(char *buf, size_t buf_len)
{
	snprintf(buf, buf_len, "FE5B26C0C5B1DCD7");
	return 0;
}

static bool *credential_slot(sec_tag_t tag, enum tls_credential_type type)
{
	if (type == TLS_CREDENTIAL_PRIVATE_KEY) {
		return &fake.private_key;
	}

	if (type == TLS_CREDENTIAL_PUBLIC_CERTIFICATE) {
		return &fake.certificate;
	}

	return tag == CONFIG_MQTT_HELPER_SEC_TAG ? &fake.ca_cloud : &fake.ca_download;
}

int tls_credential_get(sec_tag_t tag, enum tls_credential_type type, void *cred, size_t *len)
{
	(void)cred;
	(void)len;

	return *credential_slot(tag, type) ? -EFBIG : -ENOENT;
}

int tls_credential_delete(sec_tag_t tag, enum tls_credential_type type)
{
	bool *slot = credential_slot(tag, type);
	bool existed = *slot;

	fake_note_op("tls-delete");

	if (fake.fail_tls_delete) {
		return -EIO;
	}

	if (!power_gone()) {
		*slot = false;
	}

	return existed ? 0 : -ENOENT;
}

/* ---- console_port.h -------------------------------------------------------------- */

void console_port_reply(const char *text, size_t length, bool final)
{
	append(fake.output, sizeof(fake.output), text, length);
	append(fake.output, sizeof(fake.output), "\n", 1);
	fake_note_op(final ? "final" : "line");

	if (final) {
		fake.finals++;
	}
}

void console_port_event(const char *text, size_t length)
{
	append(fake.events, sizeof(fake.events), text, length);
	append(fake.events, sizeof(fake.events), "\n", 1);
}

void console_port_echo(const char *text, size_t length)
{
	append(fake.echo, sizeof(fake.echo), text, length);
}

int console_port_on_main(int (*function)(void *arg), void *arg)
{
	fake.main_calls++;
	return function(arg);
}

void console_port_reboot(void)
{
	fake.reboots++;
	fake_note_op("reboot");
}

void console_port_before_init_flag(void)
{
	if (fake.lose_power_before_flag) {
		fake.cut_after = 0;
		fake_note_op("power-loss");
		console_event("CONSOLE", "test image: losing power before the init flag");
	}
}

#if defined(CONFIG_APP_TEST_FAULT_WIFI_DEAD)
int console_port_wifi_dead(void)
{
	fake.wifi_dead_calls++;
	fake_note_op("wifi-dead");
	return fake.wifi_dead_result;
}
#endif

int64_t console_port_uptime_ms(void)
{
	return fake.now_ms;
}

size_t console_port_free_heap(void)
{
	return 12345;
}

const char *console_port_reset_reason(void)
{
	return fake.reset_reason != NULL ? fake.reset_reason : "reset pin";
}

int console_port_keygen_create(const char **reason)
{
	if (fake.keygen_fails) {
		*reason = "key generation failed";
		return -EIO;
	}

	fake.key_in_memory = true;

	if (fake.update_starts_during_keygen) {
		fake.ota = OTA_DOWNLOADING;
	}

	return 0;
}

int console_port_keygen_store(void)
{
	fake.key_stores++;
	fake_note_op("tls-delete");
	fake.private_key = false;
	fake.certificate = false;

	if (fake.key_store_err == 0) {
		fake.private_key = true;
	}

	return fake.key_store_err;
}

int console_port_keygen_print(void)
{
	if (fake.key_print_err != 0) {
		return fake.key_print_err;
	}

	console_reply_line("-----BEGIN CERTIFICATE REQUEST-----");
	console_reply_line("TUlJQkZBS0JnUUM=");
	console_reply_line("-----END CERTIFICATE REQUEST-----");
	return 0;
}

void console_port_keygen_end(void)
{
	fake.key_in_memory = false;
}

int console_port_store_certificate(enum console_stream_kind kind, const uint8_t *der, size_t length)
{
	if (fake.certificate_store_fails) {
		return -EIO;
	}

	fake.certificates_stored++;
	fake.stored_kind = kind;
	fake.stored_length = length;
	memcpy(fake.stored, der, length);

	if (kind == CONSOLE_STREAM_CERT) {
		fake.certificate = true;
	} else {
		fake.ca_cloud = true;
		fake.ca_download = true;
	}

	return 0;
}
