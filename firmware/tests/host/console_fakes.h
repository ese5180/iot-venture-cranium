/*
 * A board in memory for the console's host tests: fakes of the storage, network, cloud,
 * update and platform functions that the console's code calls. Storage can fail on
 * request, and can lose power after a given number of writes.
 */

#ifndef CONSOLE_FAKES_H_
#define CONSOLE_FAKES_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "app_events.h"
#include "console_stream.h"
#include "net.h"
#include "ota.h"

#define FAKE_RECORDS      8
#define FAKE_RECORD_MAX   512
#define FAKE_OUTPUT_MAX   32768
#define FAKE_OPS_MAX      4096

struct fake_record {
	bool present;
	size_t size;
	uint8_t data[FAKE_RECORD_MAX];
};

struct fake_board {
	/* What survives a restart. */
	struct fake_record records[FAKE_RECORDS];
	bool wifi_stored;
	char wifi_ssid[NET_SSID_MAX + 1];
	char wifi_password[NET_PASSWORD_MAX + 2];
	/* Where the console kept the password while it was being stored. */
	const char *password_argument;
	size_t password_argument_length;
	enum net_security wifi_security;
	bool ca_cloud;
	bool ca_download;
	bool certificate;
	bool private_key;

	/* Writes that still go through before the power goes. Negative: it stays on. */
	int cut_after;
	/* INIT loses power right before the flag, as a test image does. */
	bool lose_power_before_flag;

	/* Storage failures on request, per record. */
	bool fail_write[FAKE_RECORDS];
	bool fail_read[FAKE_RECORDS];
	bool fail_erase[FAKE_RECORDS];
	bool corrupt_read[FAKE_RECORDS];
	bool fail_wifi_clear;
	bool fail_wifi_set;
	bool fail_tls_delete;
	/* Only the write that completes first-time setup fails. */
	bool fail_flag_complete;

	enum ota_state ota;
	bool link_up;
	bool link_up_without_address;
	bool cloud_connected;
	int cloud_disconnects;

	/* What the code did, in order: "W3" is a write of record 3, "reply", "join" and so on. */
	char ops[FAKE_OPS_MAX];

	/* Everything that came out, one line after the other. */
	char output[FAKE_OUTPUT_MAX];
	char events[FAKE_OUTPUT_MAX];
	char echo[FAKE_OUTPUT_MAX];
	int finals;
	int reboots;
	int main_calls;
	int joins;
	int cloud_changes;
	bool event_queue_full;
	int button_presses;
	struct app_event last_button;

	bool keygen_fails;
	/* An update begins while the key is being created, which takes seconds. */
	bool update_starts_during_keygen;
	/* Between the steps of creating a key, there is a private key in memory. */
	bool key_in_memory;
	int key_stores;
	int key_store_err;
	int key_print_err;
	enum console_stream_kind stored_kind;
	size_t stored_length;
	uint8_t stored[CONSOLE_STREAM_MAX];
	int certificates_stored;
	bool certificate_store_fails;

	uint8_t stuck_count;
	/* NULL for what the tests of STATS go by. */
	const char *reset_reason;
	/* The test image's TEST_WIFI_DEAD: how often it was asked, and what it answers. */
	int wifi_dead_calls;
	int wifi_dead_result;

	int64_t now_ms;
};

extern struct fake_board fake;

/* A blank board: erased storage, nothing connected. */
void fake_reset(void);

/* Forget what came out and what was done so far, and keep the board's state. */
void fake_clear_log(void);

/* Remember that something happened, for tests of what comes before what. */
void fake_note_op(const char *op);

#endif /* CONSOLE_FAKES_H_ */
