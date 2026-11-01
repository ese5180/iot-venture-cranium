#include "bt_ota_policy.h"

#include <errno.h>
#include <string.h>

#include <zephyr/sys/printk.h>

enum bt_ota_open bt_ota_may_open(const struct bt_ota_board *board)
{
	if (board->controller_failed) {
		return BT_OTA_REFUSED_NO_CONTROLLER;
	}

	if (board->link_up) {
		return BT_OTA_REFUSED_LINK_UP;
	}

	if (board->factory) {
		return BT_OTA_REFUSED_FACTORY;
	}

	if (!board->provisioned) {
		return BT_OTA_REFUSED_NOT_PROVISIONED;
	}

	/*
	 * ota_init() works out what became of a cloud job from the running version, so an image
	 * that arrived another way would have it report something that did not happen.
	 */
	if (board->job_record) {
		return BT_OTA_REFUSED_JOB_RECORD;
	}

	if (board->testing) {
		return board->bluetooth_trial ? BT_OTA_OPEN_PROOF : BT_OTA_REFUSED_CLOUD_TRIAL;
	}

	if (!board->idle) {
		return BT_OTA_REFUSED_BUSY;
	}

	/*
	 * Idle, and yet the secondary slot holds what the bootloader is going to use: an upload
	 * must not go there. Only if the update manager could not start can this come up.
	 */
	return board->swap_pending ? BT_OTA_REFUSED_SWAP_PENDING : BT_OTA_OPEN_UPLOAD;
}

const char *bt_ota_open_text(enum bt_ota_open open)
{
	switch (open) {
	case BT_OTA_REFUSED_NO_CONTROLLER:
		return "the network core does not run the Bluetooth controller: flash it over the debug port";
	case BT_OTA_REFUSED_FACTORY:
		return "factory mode: send INIT first";
	case BT_OTA_REFUSED_NOT_PROVISIONED:
		return "this board is not provisioned yet";
	case BT_OTA_REFUSED_JOB_RECORD:
		return "the outcome of a cloud update has yet to reach the cloud";
	case BT_OTA_REFUSED_CLOUD_TRIAL:
		return "this image came from the cloud, so only the cloud can prove it";
	case BT_OTA_REFUSED_BUSY:
		return "a cloud update is under way";
	case BT_OTA_REFUSED_SWAP_PENDING:
		return "the bootloader has a swap to do";
	case BT_OTA_REFUSED_LINK_UP:
		return "the last phone has not gone yet: try again in a moment";
	default:
		return "";
	}
}

void bt_ota_window_open(struct bt_ota_window *window, bool proof_only, uint16_t window_seconds)
{
	memset(window, 0, sizeof(*window));
	window->phase = BT_OTA_OPEN;
	window->proof_only = proof_only;
	window->window_left = window_seconds;
	window->session_left = BT_OTA_SESSION_LIMIT_SECONDS;
}

static uint32_t close_window(struct bt_ota_window *window, enum bt_ota_closed closed)
{
	/* What has arrived, and was not installed, does not stay. */
	uint32_t actions = window->phase == BT_OTA_READY ? BT_OTA_DO_DISCARD : 0;

	window->phase = BT_OTA_CLOSED;
	window->closed = closed;
	return actions | BT_OTA_DO_CLOSE;
}

/* A link that is gone: back to advertising, for as long as the window lasts. */
static uint32_t link_gone(struct bt_ota_window *window)
{
	window->phase = BT_OTA_OPEN;
	window->pairing_seconds = 0;
	window->quiet_seconds = 0;

	return window->window_left > 0 ? BT_OTA_DO_ADVERTISE
				       : close_window(window, BT_OTA_CLOSED_TIME_UP);
}

static uint32_t tick_open(struct bt_ota_window *window, const struct bt_ota_link *link)
{
	if (!link->connected) {
		return link_gone(window);
	}

	if (link->secure) {
		window->phase = BT_OTA_LINKED;
		window->quiet_seconds = 0;
		return 0;
	}

	if (window->window_left == 0) {
		return close_window(window, BT_OTA_CLOSED_TIME_UP);
	}

	if (++window->pairing_seconds >= BT_OTA_PAIRING_LIMIT_SECONDS) {
		window->pairing_seconds = 0;
		return BT_OTA_DO_DISCONNECT;
	}

	return 0;
}

static uint32_t tick_linked(struct bt_ota_window *window, const struct bt_ota_link *link,
			    bool active)
{
	if (!link->connected || !link->secure) {
		return link_gone(window);
	}

	/* The phone has done its part of a proof, and the rest may take a moment. */
	if (window->proof_only && link->list_reads > 0) {
		return BT_OTA_DO_TRY_PROOF;
	}

	window->quiet_seconds = active ? 0 : window->quiet_seconds + 1;
	if (window->quiet_seconds >= BT_OTA_QUIET_LIMIT_SECONDS) {
		window->quiet_seconds = 0;
		return BT_OTA_DO_DISCONNECT;
	}

	return 0;
}

uint32_t bt_ota_window_tick(struct bt_ota_window *window, const struct bt_ota_link *link)
{
	bool active = link->commands != window->commands_seen;

	if (window->phase == BT_OTA_CLOSED) {
		return 0;
	}

	window->commands_seen = link->commands;

	/* An offer has a time of its own: a person gets all of it, however late the image came. */
	if (window->phase == BT_OTA_READY) {
		if (window->offer_left == 0) {
			return close_window(window, BT_OTA_CLOSED_OFFER_EXPIRED);
		}
		window->offer_left--;
		return 0;
	}

	/* It has arrived, whatever the link has done in the same second. */
	if (link->upload_done && !window->proof_only) {
		window->phase = BT_OTA_READY;
		window->offer_left = BT_OTA_OFFER_SECONDS;
		return BT_OTA_DO_OFFER;
	}

	if (window->session_left == 0) {
		return close_window(window, BT_OTA_CLOSED_SESSION_LIMIT);
	}
	window->session_left--;

	if (window->window_left > 0) {
		window->window_left--;
	}

	if (link->failed_pairings >= BT_OTA_MAX_FAILED_PAIRINGS) {
		return close_window(window, BT_OTA_CLOSED_PAIRING_FAILED);
	}

	return window->phase == BT_OTA_LINKED ? tick_linked(window, link, active)
					      : tick_open(window, link);
}

uint32_t bt_ota_window_press(struct bt_ota_window *window, unsigned int button)
{
	if (window->phase == BT_OTA_CLOSED) {
		return 0;
	}

	if (button == 1) {
		return close_window(window, BT_OTA_CLOSED_BY_BUTTON);
	}

	return window->phase == BT_OTA_READY ? BT_OTA_DO_INSTALL : 0;
}

uint32_t bt_ota_window_offer_failed(struct bt_ota_window *window)
{
	return close_window(window, BT_OTA_CLOSED_OFFER_EXPIRED);
}

uint32_t bt_ota_window_abort(struct bt_ota_window *window)
{
	return close_window(window, BT_OTA_CLOSED_NO_CONTROLLER);
}

const char *bt_ota_closed_text(enum bt_ota_closed closed)
{
	switch (closed) {
	case BT_OTA_CLOSED_PAIRING_FAILED:
		return "too many failed pairings";
	case BT_OTA_CLOSED_SESSION_LIMIT:
		return "it has been open for as long as it can be";
	case BT_OTA_CLOSED_OFFER_EXPIRED:
		return "no image to install";
	case BT_OTA_CLOSED_BY_BUTTON:
		return "by Button 2";
	case BT_OTA_CLOSED_TRIAL_OVER:
		return "the trial is over";
	case BT_OTA_CLOSED_NO_CONTROLLER:
		return "the controller did not start";
	default:
		return "its time is up";
	}
}

bool bt_ota_command_allowed(uint16_t group, uint16_t id, uint8_t op, bool secure, bool uploads)
{
	if (!secure || group != BT_OTA_SMP_GROUP_IMAGE) {
		return false;
	}

	if (id == BT_OTA_SMP_ID_STATE) {
		return op == BT_OTA_SMP_OP_READ;
	}

	return id == BT_OTA_SMP_ID_UPLOAD && op == BT_OTA_SMP_OP_WRITE && uploads;
}

enum bt_ota_upload bt_ota_check_upload(const uint8_t *data, size_t len, uint64_t total,
				       uint32_t image_number, const struct fw_version *running,
				       uint64_t max_total)
{
	struct fw_version version;
	uint32_t magic;
	uint32_t image_size;
	uint16_t header_size;
	uint16_t protected_size;

	/* The same rule as the check on serial recovery's image number: there is one image. */
	if (image_number != 0) {
		return BT_OTA_UPLOAD_NOT_IMAGE_0;
	}

	if (data == NULL || len < BT_OTA_IMAGE_HEADER_LEN) {
		return BT_OTA_UPLOAD_NO_HEADER;
	}

	memcpy(&magic, data, sizeof(magic));
	if (magic != BT_OTA_IMAGE_MAGIC) {
		return BT_OTA_UPLOAD_NO_HEADER;
	}

	memcpy(&header_size, data + 8, sizeof(header_size));
	memcpy(&protected_size, data + 10, sizeof(protected_size));
	memcpy(&image_size, data + 12, sizeof(image_size));
	version.major = data[20];
	version.minor = data[21];
	memcpy(&version.revision, data + 22, sizeof(version.revision));
	memcpy(&version.build, data + 24, sizeof(version.build));

	if (total > max_total) {
		return BT_OTA_UPLOAD_TOO_LARGE;
	}

	if ((uint64_t)header_size + protected_size + image_size > total) {
		return BT_OTA_UPLOAD_BAD_SIZES;
	}

	return fw_version_compare(&version, running) > 0 ? BT_OTA_UPLOAD_OK
							 : BT_OTA_UPLOAD_NOT_NEWER;
}

const char *bt_ota_upload_text(enum bt_ota_upload verdict)
{
	switch (verdict) {
	case BT_OTA_UPLOAD_NOT_IMAGE_0:
		return "there is only image 0";
	case BT_OTA_UPLOAD_NO_HEADER:
		return "it does not start with an image header";
	case BT_OTA_UPLOAD_NOT_NEWER:
		return "it is not newer than what runs";
	case BT_OTA_UPLOAD_TOO_LARGE:
		return "it would reach the end of the slot";
	case BT_OTA_UPLOAD_BAD_SIZES:
		return "its header claims more than the file holds";
	default:
		return "";
	}
}

bool bt_ota_offer_ok(bool header_read, const struct fw_version *target,
		     const struct fw_version *running, bool swap_pending)
{
	return header_read && !swap_pending && fw_version_compare(target, running) > 0;
}

enum bt_ota_proof_result bt_ota_proof_check(const struct bt_ota_proof *proof)
{
	if (!proof->provisioned) {
		return BT_OTA_NOT_PROVISIONED;
	}

	/*
	 * With Wi-Fi in reach, an image that cannot get to the cloud is what the trial is there
	 * to catch. A person has no say in that: this image reverts unless it gets there.
	 */
	if (proof->wifi_up) {
		return BT_OTA_WAIT_FOR_CLOUD;
	}

	if (!proof->link_secure) {
		return BT_OTA_WAIT_FOR_LINK;
	}

	if (proof->list_reads == 0) {
		return BT_OTA_WAIT_FOR_LIST;
	}

	if (proof->uptime_seconds < proof->min_seconds) {
		return BT_OTA_WAIT_FOR_TIME;
	}

	return proof->wifi_answered ? BT_OTA_PROVED : BT_OTA_WAIT_FOR_WIFI_ANSWER;
}

const char *bt_ota_proof_text(enum bt_ota_proof_result result)
{
	switch (result) {
	case BT_OTA_PROVED:
		return "proved";
	case BT_OTA_WAIT_FOR_LINK:
		return "waiting for an authenticated link";
	case BT_OTA_WAIT_FOR_LIST:
		return "waiting for the phone to read the image list";
	case BT_OTA_WAIT_FOR_TIME:
		return "this image has not run for long enough yet";
	case BT_OTA_WAIT_FOR_WIFI_ANSWER:
		return "the Wi-Fi stack has not reported a join attempt yet";
	case BT_OTA_WAIT_FOR_CLOUD:
		return "there is Wi-Fi, so it has to reach the cloud";
	default:
		return "this board is not provisioned";
	}
}

const char *bt_ota_result_text(enum bt_ota_result result)
{
	switch (result) {
	case BT_OTA_RESULT_PENDING:
		return "pending";
	case BT_OTA_RESULT_SUCCEEDED:
		return "succeeded";
	case BT_OTA_RESULT_ROLLED_BACK:
		return "rolled_back";
	case BT_OTA_RESULT_NOT_INSTALLED:
		return "not_installed";
	case BT_OTA_RESULT_TRIAL_LOST:
		return "trial_lost";
	case BT_OTA_RESULT_SUPERSEDED:
		return "superseded";
	default:
		return "flash_error";
	}
}

const char *bt_ota_proof_by_text(enum bt_ota_proof_by proof)
{
	switch (proof) {
	case BT_OTA_PROOF_BY_CLOUD:
		return "cloud";
	case BT_OTA_PROOF_BY_PERSON:
		return "person";
	default:
		return "none";
	}
}

int bt_ota_record_json(const struct bt_ota_record *record, char *buf, size_t len)
{
	char from[FW_VERSION_STRING_MAX];
	char target[FW_VERSION_STRING_MAX];
	int written;

	if (fw_version_to_string(&record->from, from, sizeof(from)) != 0 ||
	    fw_version_to_string(&record->target, target, sizeof(target)) != 0) {
		return -ENOSPC;
	}

	written = snprintk(buf, len,
			   "{\"bt\":{\"from\":\"%s\",\"to\":\"%s\",\"result\":\"%s\","
			   "\"proof\":\"%s\",\"count\":%u}}",
			   from, target, bt_ota_result_text((enum bt_ota_result)record->result),
			   bt_ota_proof_by_text((enum bt_ota_proof_by)record->proof),
			   (unsigned int)record->count);

	return written < 0 || written >= (int)len ? -ENOSPC : written;
}
