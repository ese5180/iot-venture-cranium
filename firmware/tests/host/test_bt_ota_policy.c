/*
 * Host-side tests of what a firmware update over Bluetooth is allowed to do: every reason to
 * refuse a window, every way one ends, every command a phone might send, every image it might
 * upload, and what proves an image on trial.
 *
 * What this cannot show is that Bluetooth does what these decisions ask of it. test_bt_ota.c
 * checks src/bt_ota.c against a fake of the host, and only a phone can check the rest.
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "bt_ota_policy.h"

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

#define WINDOW_SECONDS 120

/* ---- opening a window ----------------------------------------------------------- */

static struct bt_ota_board idle_board(void)
{
	return (struct bt_ota_board){ .provisioned = true, .idle = true };
}

static void test_a_window_opens_on_an_idle_provisioned_board(void)
{
	struct bt_ota_board board = idle_board();

	CHECK(bt_ota_may_open(&board) == BT_OTA_OPEN_UPLOAD);
}

static void test_what_refuses_a_window(void)
{
	struct bt_ota_board board = idle_board();

	board.controller_failed = true;
	CHECK(bt_ota_may_open(&board) == BT_OTA_REFUSED_NO_CONTROLLER);

	board = idle_board();
	board.factory = true;
	CHECK(bt_ota_may_open(&board) == BT_OTA_REFUSED_FACTORY);

	board = idle_board();
	board.provisioned = false;
	CHECK(bt_ota_may_open(&board) == BT_OTA_REFUSED_NOT_PROVISIONED);

	/* A cloud update's outcome, worked out from the version, would come out wrong. */
	board = idle_board();
	board.job_record = true;
	CHECK(bt_ota_may_open(&board) == BT_OTA_REFUSED_JOB_RECORD);

	/* An update on offer or under way: Button 1 is for that, and the slot is taken. */
	board = idle_board();
	board.idle = false;
	CHECK(bt_ota_may_open(&board) == BT_OTA_REFUSED_BUSY);

	/* Idle, but the secondary slot holds what the bootloader is going to use. */
	board = idle_board();
	board.swap_pending = true;
	CHECK(bt_ota_may_open(&board) == BT_OTA_REFUSED_SWAP_PENDING);

	/* The last window's phone is still there: a new window takes a new pairing. */
	board = idle_board();
	board.link_up = true;
	CHECK(bt_ota_may_open(&board) == BT_OTA_REFUSED_LINK_UP);
	board.idle = false;
	board.testing = true;
	board.bluetooth_trial = true;
	CHECK(bt_ota_may_open(&board) == BT_OTA_REFUSED_LINK_UP);
}

static void test_on_trial_a_window_can_only_prove_what_bluetooth_installed(void)
{
	struct bt_ota_board board = idle_board();

	board.idle = false;
	board.testing = true;

	/* No record says who installed it: the cloud decides. */
	CHECK(bt_ota_may_open(&board) == BT_OTA_REFUSED_CLOUD_TRIAL);

	board.bluetooth_trial = true;
	CHECK(bt_ota_may_open(&board) == BT_OTA_OPEN_PROOF);

	/* The revert that is coming is no reason to refuse this: it takes no upload. */
	board.swap_pending = true;
	CHECK(bt_ota_may_open(&board) == BT_OTA_OPEN_PROOF);

	/* Never for an image that a cloud job installed, whatever else says otherwise. */
	board.job_record = true;
	CHECK(bt_ota_may_open(&board) == BT_OTA_REFUSED_JOB_RECORD);
}

static void test_every_refusal_has_words(void)
{
	static const enum bt_ota_open refusals[] = {
		BT_OTA_REFUSED_NO_CONTROLLER,   BT_OTA_REFUSED_FACTORY,
		BT_OTA_REFUSED_NOT_PROVISIONED, BT_OTA_REFUSED_JOB_RECORD,
		BT_OTA_REFUSED_CLOUD_TRIAL,     BT_OTA_REFUSED_BUSY,
		BT_OTA_REFUSED_SWAP_PENDING,    BT_OTA_REFUSED_LINK_UP,
	};

	for (size_t i = 0; i < sizeof(refusals) / sizeof(refusals[0]); i++) {
		CHECK(bt_ota_open_text(refusals[i])[0] != '\0');
	}
}

/* ---- a window ------------------------------------------------------------------- */

static void test_advertises_until_the_time_is_up_and_not_a_second_longer(void)
{
	struct bt_ota_window window;
	struct bt_ota_link link = { 0 };
	uint32_t actions = 0;

	bt_ota_window_open(&window, false, WINDOW_SECONDS);
	CHECK(window.phase == BT_OTA_OPEN);

	for (int second = 1; second < WINDOW_SECONDS; second++) {
		actions = bt_ota_window_tick(&window, &link);
		CHECK(actions == BT_OTA_DO_ADVERTISE);
	}

	actions = bt_ota_window_tick(&window, &link);
	CHECK(actions == BT_OTA_DO_CLOSE);
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(window.closed == BT_OTA_CLOSED_TIME_UP);

	/* And nothing from a closed window, ever. */
	CHECK(bt_ota_window_tick(&window, &link) == 0);
	CHECK(bt_ota_window_press(&window, 0) == 0);
	CHECK(bt_ota_window_press(&window, 1) == 0);
}

static void test_a_phone_that_does_not_pair_is_dropped(void)
{
	struct bt_ota_window window;
	struct bt_ota_link link = { .connected = true };
	uint32_t actions = 0;

	bt_ota_window_open(&window, false, WINDOW_SECONDS);

	for (int second = 1; second < BT_OTA_PAIRING_LIMIT_SECONDS; second++) {
		actions = bt_ota_window_tick(&window, &link);
		CHECK(actions == 0);
	}

	CHECK(bt_ota_window_tick(&window, &link) == BT_OTA_DO_DISCONNECT);
	CHECK(window.phase == BT_OTA_OPEN);

	/* Gone: advertising again, for what is left of the window. */
	link.connected = false;
	CHECK(bt_ota_window_tick(&window, &link) == BT_OTA_DO_ADVERTISE);
}

static void test_a_connection_that_has_not_paired_cannot_hold_a_window_open(void)
{
	struct bt_ota_window window;
	struct bt_ota_link link = { .connected = true };
	uint32_t actions = 0;

	/* Shorter than the pairing limit, so that only the window can end it. */
	bt_ota_window_open(&window, false, 30);

	for (int second = 1; second <= 30 && actions == 0; second++) {
		actions = bt_ota_window_tick(&window, &link);
		CHECK(second == 30 || actions == 0);
	}

	CHECK(actions == BT_OTA_DO_CLOSE);
	CHECK(window.closed == BT_OTA_CLOSED_TIME_UP);
}

static void test_three_failed_pairings_close_the_window(void)
{
	struct bt_ota_window window;
	struct bt_ota_link link = { .failed_pairings = BT_OTA_MAX_FAILED_PAIRINGS - 1 };

	bt_ota_window_open(&window, false, WINDOW_SECONDS);
	CHECK(bt_ota_window_tick(&window, &link) == BT_OTA_DO_ADVERTISE);

	link.failed_pairings = BT_OTA_MAX_FAILED_PAIRINGS;
	CHECK(bt_ota_window_tick(&window, &link) == BT_OTA_DO_CLOSE);
	CHECK(window.closed == BT_OTA_CLOSED_PAIRING_FAILED);
}

static void test_an_authenticated_link_outlives_the_window_while_it_is_busy(void)
{
	struct bt_ota_window window;
	struct bt_ota_link link = { .connected = true, .secure = true };

	bt_ota_window_open(&window, false, 5);
	CHECK(bt_ota_window_tick(&window, &link) == 0);
	CHECK(window.phase == BT_OTA_LINKED);

	for (int second = 0; second < 200; second++) {
		link.commands++;
		CHECK(bt_ota_window_tick(&window, &link) == 0);
	}

	CHECK(window.phase == BT_OTA_LINKED);
}

static void test_a_quiet_link_is_dropped_and_ends_a_window_that_is_over(void)
{
	struct bt_ota_window window;
	struct bt_ota_link link = { .connected = true, .secure = true };
	uint32_t actions = 0;

	bt_ota_window_open(&window, false, 5);
	CHECK(bt_ota_window_tick(&window, &link) == 0);

	for (int second = 1; second < BT_OTA_QUIET_LIMIT_SECONDS; second++) {
		actions = bt_ota_window_tick(&window, &link);
		CHECK(actions == 0);
	}

	CHECK(bt_ota_window_tick(&window, &link) == BT_OTA_DO_DISCONNECT);

	link.connected = false;
	link.secure = false;
	CHECK(bt_ota_window_tick(&window, &link) == BT_OTA_DO_CLOSE);
	CHECK(window.phase == BT_OTA_CLOSED);
}

static void test_a_link_lost_within_the_window_advertises_again(void)
{
	struct bt_ota_window window;
	struct bt_ota_link link = { .connected = true, .secure = true };

	bt_ota_window_open(&window, false, WINDOW_SECONDS);
	CHECK(bt_ota_window_tick(&window, &link) == 0);

	link.connected = false;
	link.secure = false;
	CHECK(bt_ota_window_tick(&window, &link) == BT_OTA_DO_ADVERTISE);
	CHECK(window.phase == BT_OTA_OPEN);
}

static void test_a_link_that_loses_its_security_counts_as_lost(void)
{
	struct bt_ota_window window;
	struct bt_ota_link link = { .connected = true, .secure = true };

	bt_ota_window_open(&window, false, WINDOW_SECONDS);
	CHECK(bt_ota_window_tick(&window, &link) == 0);

	link.secure = false;
	CHECK(bt_ota_window_tick(&window, &link) == BT_OTA_DO_ADVERTISE);
	CHECK(window.phase == BT_OTA_OPEN);
}

static void arrive(struct bt_ota_window *window, struct bt_ota_link *link)
{
	*link = (struct bt_ota_link){ .connected = true, .secure = true };
	bt_ota_window_open(window, false, WINDOW_SECONDS);
	CHECK(bt_ota_window_tick(window, link) == 0);
	link->upload_done = true;
	CHECK(bt_ota_window_tick(window, link) == BT_OTA_DO_OFFER);
	CHECK(window->phase == BT_OTA_READY);
}

static void test_an_image_that_arrives_is_offered_also_if_the_link_just_went(void)
{
	struct bt_ota_window window;
	struct bt_ota_link link = { .connected = true, .secure = true };

	bt_ota_window_open(&window, false, WINDOW_SECONDS);
	CHECK(bt_ota_window_tick(&window, &link) == 0);

	link = (struct bt_ota_link){ .upload_done = true };
	CHECK(bt_ota_window_tick(&window, &link) == BT_OTA_DO_OFFER);
	CHECK(window.phase == BT_OTA_READY);
}

static void test_button_1_installs_what_arrived_and_nothing_before_that(void)
{
	struct bt_ota_window window;
	struct bt_ota_link link = { 0 };

	bt_ota_window_open(&window, false, WINDOW_SECONDS);
	CHECK(bt_ota_window_press(&window, 0) == 0);
	CHECK(window.phase == BT_OTA_OPEN);

	arrive(&window, &link);
	CHECK(bt_ota_window_press(&window, 0) == BT_OTA_DO_INSTALL);
}

static void test_button_2_erases_what_arrived_and_closes(void)
{
	struct bt_ota_window window;
	struct bt_ota_link link = { 0 };

	arrive(&window, &link);
	CHECK(bt_ota_window_press(&window, 1) == (BT_OTA_DO_DISCARD | BT_OTA_DO_CLOSE));
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(window.closed == BT_OTA_CLOSED_BY_BUTTON);
}

static void test_button_2_closes_an_open_window_with_nothing_to_erase(void)
{
	struct bt_ota_window window;

	bt_ota_window_open(&window, false, WINDOW_SECONDS);
	CHECK(bt_ota_window_press(&window, 1) == BT_OTA_DO_CLOSE);
	CHECK(window.phase == BT_OTA_CLOSED);
}

static void test_an_offer_nobody_takes_is_erased(void)
{
	struct bt_ota_window window;
	struct bt_ota_link link = { 0 };

	arrive(&window, &link);

	for (int second = 0; second < BT_OTA_OFFER_SECONDS; second++) {
		CHECK(bt_ota_window_tick(&window, &link) == 0);
	}

	CHECK(bt_ota_window_tick(&window, &link) == (BT_OTA_DO_DISCARD | BT_OTA_DO_CLOSE));
	CHECK(window.closed == BT_OTA_CLOSED_OFFER_EXPIRED);
}

static void test_an_image_that_is_no_good_is_erased(void)
{
	struct bt_ota_window window;
	struct bt_ota_link link = { 0 };

	arrive(&window, &link);
	CHECK(bt_ota_window_offer_failed(&window) == (BT_OTA_DO_DISCARD | BT_OTA_DO_CLOSE));
	CHECK(window.phase == BT_OTA_CLOSED);
}

static void test_an_image_that_arrives_late_gets_the_whole_offer(void)
{
	struct bt_ota_window window;
	struct bt_ota_link link = { .connected = true, .secure = true };

	bt_ota_window_open(&window, false, WINDOW_SECONDS);
	CHECK(bt_ota_window_tick(&window, &link) == 0);

	/* The very last second of the session. */
	window.session_left = 0;
	link.upload_done = true;
	CHECK(bt_ota_window_tick(&window, &link) == BT_OTA_DO_OFFER);

	for (int second = 0; second < BT_OTA_OFFER_SECONDS; second++) {
		CHECK(bt_ota_window_tick(&window, &link) == 0);
		CHECK(window.phase == BT_OTA_READY);
	}

	CHECK(bt_ota_window_tick(&window, &link) == (BT_OTA_DO_DISCARD | BT_OTA_DO_CLOSE));
	CHECK(window.closed == BT_OTA_CLOSED_OFFER_EXPIRED);
}

static void test_a_window_can_be_given_up_on(void)
{
	struct bt_ota_window window;
	struct bt_ota_link link = { 0 };

	bt_ota_window_open(&window, false, WINDOW_SECONDS);
	CHECK(bt_ota_window_abort(&window) == BT_OTA_DO_CLOSE);
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(window.closed == BT_OTA_CLOSED_NO_CONTROLLER);

	arrive(&window, &link);
	CHECK(bt_ota_window_abort(&window) == (BT_OTA_DO_DISCARD | BT_OTA_DO_CLOSE));
}

static void test_nothing_lasts_past_the_session_limit(void)
{
	struct bt_ota_window window;
	struct bt_ota_link link = { .connected = true, .secure = true };
	uint32_t actions = 0;
	int seconds = 0;

	bt_ota_window_open(&window, false, WINDOW_SECONDS);

	while (actions == 0 && seconds < BT_OTA_SESSION_LIMIT_SECONDS + 10) {
		link.commands++;
		actions = bt_ota_window_tick(&window, &link);
		seconds++;
	}

	CHECK(actions == BT_OTA_DO_CLOSE);
	CHECK(seconds == BT_OTA_SESSION_LIMIT_SECONDS + 1);
	CHECK(window.closed == BT_OTA_CLOSED_SESSION_LIMIT);
}

static void test_a_proof_window_takes_no_upload_and_asks_for_the_proof(void)
{
	struct bt_ota_window window;
	struct bt_ota_link link = { .connected = true, .secure = true };

	bt_ota_window_open(&window, true, WINDOW_SECONDS);
	CHECK(bt_ota_window_tick(&window, &link) == 0);

	/* It cannot come to this, but if it did, nothing is offered. */
	link.upload_done = true;
	CHECK(bt_ota_window_tick(&window, &link) == 0);
	CHECK(window.phase == BT_OTA_LINKED);

	link.list_reads = 1;
	CHECK(bt_ota_window_tick(&window, &link) == BT_OTA_DO_TRY_PROOF);
}

static void test_reading_the_list_proves_nothing_in_a_window_for_uploads(void)
{
	struct bt_ota_window window;
	struct bt_ota_link link = { .connected = true, .secure = true, .list_reads = 1 };

	bt_ota_window_open(&window, false, WINDOW_SECONDS);
	CHECK(bt_ota_window_tick(&window, &link) == 0);
	CHECK(bt_ota_window_tick(&window, &link) == 0);
	CHECK(window.phase == BT_OTA_LINKED);
}

static void test_a_proof_that_only_needs_time_does_not_lose_its_link(void)
{
	struct bt_ota_window window;
	struct bt_ota_link link = { .connected = true, .secure = true, .list_reads = 1 };

	bt_ota_window_open(&window, true, WINDOW_SECONDS);
	CHECK(bt_ota_window_tick(&window, &link) == 0);

	for (int second = 0; second < BT_OTA_QUIET_LIMIT_SECONDS * 2; second++) {
		CHECK(bt_ota_window_tick(&window, &link) == BT_OTA_DO_TRY_PROOF);
	}
}

static void test_every_way_of_closing_has_words(void)
{
	static const enum bt_ota_closed closed[] = {
		BT_OTA_CLOSED_TIME_UP,      BT_OTA_CLOSED_PAIRING_FAILED,
		BT_OTA_CLOSED_SESSION_LIMIT, BT_OTA_CLOSED_OFFER_EXPIRED,
		BT_OTA_CLOSED_BY_BUTTON,    BT_OTA_CLOSED_TRIAL_OVER,
		BT_OTA_CLOSED_NO_CONTROLLER,
	};

	for (size_t i = 0; i < sizeof(closed) / sizeof(closed[0]); i++) {
		CHECK(bt_ota_closed_text(closed[i])[0] != '\0');
	}
}

/* ---- what a phone may do -------------------------------------------------------- */

static void test_without_a_secure_link_nothing_runs(void)
{
	for (uint16_t group = 0; group < 70; group++) {
		for (uint16_t id = 0; id < 10; id++) {
			CHECK(!bt_ota_command_allowed(group, id, BT_OTA_SMP_OP_READ, false, true));
			CHECK(!bt_ota_command_allowed(group, id, BT_OTA_SMP_OP_WRITE, false, true));
		}
	}
}

static void test_the_only_commands_there_are(void)
{
	for (uint16_t group = 0; group < 70; group++) {
		for (uint16_t id = 0; id < 10; id++) {
			for (uint8_t op = 0; op < 4; op++) {
				bool expected = group == BT_OTA_SMP_GROUP_IMAGE &&
						((id == BT_OTA_SMP_ID_STATE &&
						  op == BT_OTA_SMP_OP_READ) ||
						 (id == BT_OTA_SMP_ID_UPLOAD &&
						  op == BT_OTA_SMP_OP_WRITE));

				CHECK(bt_ota_command_allowed(group, id, op, true, true) == expected);
			}
		}
	}
}

static void test_a_phone_cannot_ask_for_a_swap_confirm_or_erase(void)
{
	/* `image test` and `image confirm` are a write of the state. */
	CHECK(!bt_ota_command_allowed(BT_OTA_SMP_GROUP_IMAGE, BT_OTA_SMP_ID_STATE,
				      BT_OTA_SMP_OP_WRITE, true, true));
	/* `image erase`. */
	CHECK(!bt_ota_command_allowed(BT_OTA_SMP_GROUP_IMAGE, 5, BT_OTA_SMP_OP_WRITE, true, true));
	/* `os reset`, had that group been built. */
	CHECK(!bt_ota_command_allowed(0, 5, BT_OTA_SMP_OP_WRITE, true, true));
}

static void test_uploads_only_where_the_window_takes_them(void)
{
	CHECK(bt_ota_command_allowed(BT_OTA_SMP_GROUP_IMAGE, BT_OTA_SMP_ID_UPLOAD,
				     BT_OTA_SMP_OP_WRITE, true, true));
	CHECK(!bt_ota_command_allowed(BT_OTA_SMP_GROUP_IMAGE, BT_OTA_SMP_ID_UPLOAD,
				      BT_OTA_SMP_OP_WRITE, true, false));
	/* Reading the list needs no uploads: it is the proof in a proof window. */
	CHECK(bt_ota_command_allowed(BT_OTA_SMP_GROUP_IMAGE, BT_OTA_SMP_ID_STATE,
				     BT_OTA_SMP_OP_READ, true, false));
}

/* ---- what may be uploaded -------------------------------------------------------- */

static const struct fw_version running = { .major = 1, .minor = 5, .revision = 0, .build = 0 };
#define MAX_UPLOAD 925696ULL

/* MCUboot's image header, byte for byte. */
static void header(uint8_t *data, uint32_t magic, uint16_t header_size, uint16_t protected_size,
		   uint32_t image_size, struct fw_version version)
{
	memset(data, 0, BT_OTA_IMAGE_HEADER_LEN);
	memcpy(data, &magic, sizeof(magic));
	memcpy(data + 8, &header_size, sizeof(header_size));
	memcpy(data + 10, &protected_size, sizeof(protected_size));
	memcpy(data + 12, &image_size, sizeof(image_size));
	data[20] = version.major;
	data[21] = version.minor;
	memcpy(data + 22, &version.revision, sizeof(version.revision));
	memcpy(data + 24, &version.build, sizeof(version.build));
}

static enum bt_ota_upload check_version(struct fw_version version)
{
	uint8_t data[BT_OTA_IMAGE_HEADER_LEN];

	header(data, BT_OTA_IMAGE_MAGIC, 0x800, 0, 700000, version);
	return bt_ota_check_upload(data, sizeof(data), 750000, 0, &running, MAX_UPLOAD);
}

static void test_only_a_strictly_newer_image_is_taken(void)
{
	CHECK(check_version((struct fw_version){ 1, 5, 0, 1 }) == BT_OTA_UPLOAD_OK);
	CHECK(check_version((struct fw_version){ 1, 5, 1, 0 }) == BT_OTA_UPLOAD_OK);
	CHECK(check_version((struct fw_version){ 2, 0, 0, 0 }) == BT_OTA_UPLOAD_OK);
	CHECK(check_version((struct fw_version){ 1, 5, 0, 0 }) == BT_OTA_UPLOAD_NOT_NEWER);
	CHECK(check_version((struct fw_version){ 1, 4, 9, 9 }) == BT_OTA_UPLOAD_NOT_NEWER);
	CHECK(check_version((struct fw_version){ 0, 0, 0, 0 }) == BT_OTA_UPLOAD_NOT_NEWER);
}

static void test_there_is_only_image_0(void)
{
	uint8_t data[BT_OTA_IMAGE_HEADER_LEN];
	const struct fw_version newer = { 1, 6, 0, 0 };

	header(data, BT_OTA_IMAGE_MAGIC, 0x800, 0, 700000, newer);

	CHECK(bt_ota_check_upload(data, sizeof(data), 750000, 0, &running, MAX_UPLOAD) ==
	      BT_OTA_UPLOAD_OK);

	/* The number that serial recovery's check is there for, and others. */
	for (uint32_t image = 1; image < 8; image++) {
		CHECK(bt_ota_check_upload(data, sizeof(data), 750000, image, &running,
					  MAX_UPLOAD) == BT_OTA_UPLOAD_NOT_IMAGE_0);
	}

	CHECK(bt_ota_check_upload(data, sizeof(data), 750000, UINT32_MAX, &running, MAX_UPLOAD) ==
	      BT_OTA_UPLOAD_NOT_IMAGE_0);
}

static void test_what_is_not_an_image_header(void)
{
	uint8_t data[BT_OTA_IMAGE_HEADER_LEN];
	const struct fw_version newer = { 1, 6, 0, 0 };

	header(data, BT_OTA_IMAGE_MAGIC, 0x800, 0, 700000, newer);
	CHECK(bt_ota_check_upload(NULL, 0, 750000, 0, &running, MAX_UPLOAD) ==
	      BT_OTA_UPLOAD_NO_HEADER);
	CHECK(bt_ota_check_upload(data, sizeof(data) - 1, 750000, 0, &running, MAX_UPLOAD) ==
	      BT_OTA_UPLOAD_NO_HEADER);

	header(data, 0x12345678U, 0x800, 0, 700000, newer);
	CHECK(bt_ota_check_upload(data, sizeof(data), 750000, 0, &running, MAX_UPLOAD) ==
	      BT_OTA_UPLOAD_NO_HEADER);
}

static void test_an_upload_stops_short_of_the_trailer(void)
{
	uint8_t data[BT_OTA_IMAGE_HEADER_LEN];
	const struct fw_version newer = { 1, 6, 0, 0 };

	/* A file this long could carry a swap request of its own, for a permanent update. */
	header(data, BT_OTA_IMAGE_MAGIC, 0x800, 0, 700000, newer);
	CHECK(bt_ota_check_upload(data, sizeof(data), MAX_UPLOAD, 0, &running, MAX_UPLOAD) ==
	      BT_OTA_UPLOAD_OK);
	CHECK(bt_ota_check_upload(data, sizeof(data), MAX_UPLOAD + 1, 0, &running, MAX_UPLOAD) ==
	      BT_OTA_UPLOAD_TOO_LARGE);
	CHECK(bt_ota_check_upload(data, sizeof(data), UINT64_MAX, 0, &running, MAX_UPLOAD) ==
	      BT_OTA_UPLOAD_TOO_LARGE);
}

static void test_a_header_cannot_claim_more_than_the_file_holds(void)
{
	uint8_t data[BT_OTA_IMAGE_HEADER_LEN];
	const struct fw_version newer = { 1, 6, 0, 0 };

	header(data, BT_OTA_IMAGE_MAGIC, 0x800, 0x100, 1000, newer);
	CHECK(bt_ota_check_upload(data, sizeof(data), 0x800 + 0x100 + 1000, 0, &running,
				  MAX_UPLOAD) == BT_OTA_UPLOAD_OK);
	CHECK(bt_ota_check_upload(data, sizeof(data), 0x800 + 0x100 + 999, 0, &running,
				  MAX_UPLOAD) == BT_OTA_UPLOAD_BAD_SIZES);

	/* These add up to more than 32 bits: they must not wrap around to something small. */
	header(data, BT_OTA_IMAGE_MAGIC, 0xffff, 0xffff, UINT32_MAX, newer);
	CHECK(bt_ota_check_upload(data, sizeof(data), 750000, 0, &running, MAX_UPLOAD) ==
	      BT_OTA_UPLOAD_BAD_SIZES);
}

static void test_what_arrived_is_offered_only_if_it_is_still_good(void)
{
	const struct fw_version newer = { 1, 6, 0, 0 };
	const struct fw_version same = running;

	CHECK(bt_ota_offer_ok(true, &newer, &running, false));
	CHECK(!bt_ota_offer_ok(false, &newer, &running, false));
	CHECK(!bt_ota_offer_ok(true, &same, &running, false));
	/* Only this firmware asks for a swap, and it has not. */
	CHECK(!bt_ota_offer_ok(true, &newer, &running, true));
}

/* ---- the trial ------------------------------------------------------------------ */

static struct bt_ota_proof good_proof(void)
{
	return (struct bt_ota_proof){
		.uptime_seconds = 60,
		.min_seconds = 60,
		.provisioned = true,
		.wifi_answered = true,
		.link_secure = true,
		.list_reads = 1,
	};
}

static void test_a_proof_takes_all_of_it(void)
{
	struct bt_ota_proof proof = good_proof();

	CHECK(bt_ota_proof_check(&proof) == BT_OTA_PROVED);

	proof = good_proof();
	proof.link_secure = false;
	CHECK(bt_ota_proof_check(&proof) == BT_OTA_WAIT_FOR_LINK);

	proof = good_proof();
	proof.list_reads = 0;
	CHECK(bt_ota_proof_check(&proof) == BT_OTA_WAIT_FOR_LIST);

	proof = good_proof();
	proof.uptime_seconds = 59;
	CHECK(bt_ota_proof_check(&proof) == BT_OTA_WAIT_FOR_TIME);

	proof = good_proof();
	proof.wifi_answered = false;
	CHECK(bt_ota_proof_check(&proof) == BT_OTA_WAIT_FOR_WIFI_ANSWER);

	proof = good_proof();
	proof.provisioned = false;
	CHECK(bt_ota_proof_check(&proof) == BT_OTA_NOT_PROVISIONED);
}

static void test_with_wifi_up_a_person_has_no_say(void)
{
	struct bt_ota_proof proof = good_proof();

	/* An image with Wi-Fi up that does not get to the cloud is what the trial is for. */
	proof.wifi_up = true;
	CHECK(bt_ota_proof_check(&proof) == BT_OTA_WAIT_FOR_CLOUD);
}

static void test_every_proof_result_has_words(void)
{
	for (int result = BT_OTA_PROVED; result <= BT_OTA_NOT_PROVISIONED; result++) {
		CHECK(bt_ota_proof_text((enum bt_ota_proof_result)result)[0] != '\0');
	}
}

/* ---- the record ----------------------------------------------------------------- */

static void test_the_record_keeps_its_size(void)
{
	/* store_read() needs an exact size: changing this loses what a board has stored. */
	CHECK(sizeof(struct bt_ota_record) == 36);
}

static void test_the_record_in_the_shadow(void)
{
	struct bt_ota_record record = {
		.magic = BT_OTA_RECORD_MAGIC,
		.phase = BT_OTA_RECORD_DONE,
		.result = BT_OTA_RESULT_SUCCEEDED,
		.proof = BT_OTA_PROOF_BY_PERSON,
		.count = 3,
		.from = { 1, 5, 0, 0 },
		.target = { 1, 6, 0, 2 },
	};
	char json[192];
	char small[16];
	int written = bt_ota_record_json(&record, json, sizeof(json));

	CHECK(written > 0);
	CHECK(strcmp(json, "{\"bt\":{\"from\":\"1.5.0+0\",\"to\":\"1.6.0+2\",\"result\":\"succeeded\","
			   "\"proof\":\"person\",\"count\":3}}") == 0);
	CHECK(written == (int)strlen(json));

	CHECK(bt_ota_record_json(&record, small, sizeof(small)) < 0);

	/* The longest there can be fits the buffer bt_ota.c gives it. */
	record.from = (struct fw_version){ 255, 255, 65535, 4294967295U };
	record.target = record.from;
	record.result = BT_OTA_RESULT_NOT_INSTALLED;
	record.count = 4294967295U;
	CHECK(bt_ota_record_json(&record, json, sizeof(json)) > 0);
}

static void test_every_result_has_a_word(void)
{
	for (int result = BT_OTA_RESULT_PENDING; result <= BT_OTA_RESULT_FLASH_ERROR; result++) {
		CHECK(bt_ota_result_text((enum bt_ota_result)result)[0] != '\0');
	}

	CHECK(strcmp(bt_ota_proof_by_text(BT_OTA_PROOF_BY_NONE), "none") == 0);
	CHECK(strcmp(bt_ota_proof_by_text(BT_OTA_PROOF_BY_CLOUD), "cloud") == 0);
	CHECK(strcmp(bt_ota_proof_by_text(BT_OTA_PROOF_BY_PERSON), "person") == 0);
}

int main(void)
{
	test_a_window_opens_on_an_idle_provisioned_board();
	test_what_refuses_a_window();
	test_on_trial_a_window_can_only_prove_what_bluetooth_installed();
	test_every_refusal_has_words();

	test_advertises_until_the_time_is_up_and_not_a_second_longer();
	test_a_phone_that_does_not_pair_is_dropped();
	test_a_connection_that_has_not_paired_cannot_hold_a_window_open();
	test_three_failed_pairings_close_the_window();
	test_an_authenticated_link_outlives_the_window_while_it_is_busy();
	test_a_quiet_link_is_dropped_and_ends_a_window_that_is_over();
	test_a_link_lost_within_the_window_advertises_again();
	test_a_link_that_loses_its_security_counts_as_lost();
	test_an_image_that_arrives_is_offered_also_if_the_link_just_went();
	test_button_1_installs_what_arrived_and_nothing_before_that();
	test_button_2_erases_what_arrived_and_closes();
	test_button_2_closes_an_open_window_with_nothing_to_erase();
	test_an_offer_nobody_takes_is_erased();
	test_an_image_that_is_no_good_is_erased();
	test_an_image_that_arrives_late_gets_the_whole_offer();
	test_a_window_can_be_given_up_on();
	test_nothing_lasts_past_the_session_limit();
	test_a_proof_window_takes_no_upload_and_asks_for_the_proof();
	test_reading_the_list_proves_nothing_in_a_window_for_uploads();
	test_a_proof_that_only_needs_time_does_not_lose_its_link();
	test_every_way_of_closing_has_words();

	test_without_a_secure_link_nothing_runs();
	test_the_only_commands_there_are();
	test_a_phone_cannot_ask_for_a_swap_confirm_or_erase();
	test_uploads_only_where_the_window_takes_them();

	test_only_a_strictly_newer_image_is_taken();
	test_there_is_only_image_0();
	test_what_is_not_an_image_header();
	test_an_upload_stops_short_of_the_trailer();
	test_a_header_cannot_claim_more_than_the_file_holds();
	test_what_arrived_is_offered_only_if_it_is_still_good();

	test_a_proof_takes_all_of_it();
	test_with_wifi_up_a_person_has_no_say();
	test_every_proof_result_has_words();

	test_the_record_keeps_its_size();
	test_the_record_in_the_shadow();
	test_every_result_has_a_word();

	printf("%d checks, %d failures\n", checks, failures);
	return failures != 0;
}
