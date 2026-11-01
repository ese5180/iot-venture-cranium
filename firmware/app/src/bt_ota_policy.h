/*
 * What a firmware update over Bluetooth is allowed to do, with no Bluetooth in it: when a
 * window may open, how long it stays open, which commands a phone may send, which images it
 * may upload, and what proves that an image installed this way is good. This module has no
 * side effects and no hardware dependencies, so it can be tested on a host.
 *
 * src/bt_ota.c does what these functions decide. firmware/README.md says why they decide it.
 */

#ifndef BT_OTA_POLICY_H_
#define BT_OTA_POLICY_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "version.h"

/* A phone that connects has this long to finish pairing. Pairing times out by itself at 30 s. */
#define BT_OTA_PAIRING_LIMIT_SECONDS 45
/* An authenticated link on which nothing has happened for this long is dropped. */
#define BT_OTA_QUIET_LIMIT_SECONDS   30
/* The most a window can last up to the arrival of an image. A slot at 1 KB/s would just fit. */
#define BT_OTA_SESSION_LIMIT_SECONDS 900
/* A person has this long to press a button when an image has arrived. */
#define BT_OTA_OFFER_SECONDS         120
/* Each failure can give away one bit of a passkey, so a window does not take many. */
#define BT_OTA_MAX_FAILED_PAIRINGS   3

/* A window can only be opened with this. MCUboot's image header, and the sizes in it. */
#define BT_OTA_IMAGE_MAGIC      0x96f3b83dU
#define BT_OTA_IMAGE_HEADER_LEN 32

/* The numbers of the SMP commands, checked against MCUmgr's headers in bt_ota.c. */
#define BT_OTA_SMP_OP_READ     0
#define BT_OTA_SMP_OP_WRITE    2
#define BT_OTA_SMP_GROUP_IMAGE 1
#define BT_OTA_SMP_ID_STATE    0
#define BT_OTA_SMP_ID_UPLOAD   1

/* ---- opening a window ----------------------------------------------------------- */

/* What the board is doing when a person holds Button 1. */
struct bt_ota_board {
	/* The controller on the network core did not answer: it needs a debug-port flash. */
	bool controller_failed;
	bool factory;
	/* It knows where to connect and has a Wi-Fi network stored. */
	bool provisioned;
	/* The update manager is idle. */
	bool idle;
	/* An image is running on trial. */
	bool testing;
	/* Installed over Bluetooth, going by the record of that. */
	bool bluetooth_trial;
	/* A cloud job's record exists: it is on trial, or its outcome is not reported yet. */
	bool job_record;
	/* The bootloader has a swap or a revert coming, so the secondary slot is spoken for. */
	bool swap_pending;
	/* The last window's phone has not gone yet. A new window takes a new pairing. */
	bool link_up;
};

enum bt_ota_open {
	/* Open a window for uploads. */
	BT_OTA_OPEN_UPLOAD,
	/* Open a window in which a person can prove the image on trial, and do nothing else. */
	BT_OTA_OPEN_PROOF,
	BT_OTA_REFUSED_NO_CONTROLLER,
	BT_OTA_REFUSED_FACTORY,
	BT_OTA_REFUSED_NOT_PROVISIONED,
	BT_OTA_REFUSED_JOB_RECORD,
	BT_OTA_REFUSED_CLOUD_TRIAL,
	BT_OTA_REFUSED_BUSY,
	BT_OTA_REFUSED_SWAP_PENDING,
	BT_OTA_REFUSED_LINK_UP,
};

enum bt_ota_open bt_ota_may_open(const struct bt_ota_board *board);

/* The sentence for the console, for a refusal. */
const char *bt_ota_open_text(enum bt_ota_open open);

/* ---- a window ------------------------------------------------------------------- */

enum bt_ota_phase {
	/* Nothing advertises, and nothing can connect. */
	BT_OTA_CLOSED,
	/* Advertising, or a phone is connected that has not paired yet. */
	BT_OTA_OPEN,
	/* A phone is connected over an authenticated link. */
	BT_OTA_LINKED,
	/* A whole image is in the secondary slot, and waits for a button. */
	BT_OTA_READY,
};

enum bt_ota_closed {
	BT_OTA_CLOSED_TIME_UP,
	BT_OTA_CLOSED_PAIRING_FAILED,
	BT_OTA_CLOSED_SESSION_LIMIT,
	BT_OTA_CLOSED_OFFER_EXPIRED,
	BT_OTA_CLOSED_BY_BUTTON,
	/* The image on trial was confirmed, so there is nothing left to prove. */
	BT_OTA_CLOSED_TRIAL_OVER,
	BT_OTA_CLOSED_NO_CONTROLLER,
};

struct bt_ota_window {
	enum bt_ota_phase phase;
	bool proof_only;
	uint16_t window_left;
	uint16_t session_left;
	uint16_t offer_left;
	uint16_t pairing_seconds;
	uint16_t quiet_seconds;
	uint32_t commands_seen;
	enum bt_ota_closed closed;
};

/* What the Bluetooth callbacks have seen, as the main loop reads it once a second. */
struct bt_ota_link {
	bool connected;
	/* LE Secure Connections, MITM protected, with a full-length key. */
	bool secure;
	/* Since the window opened. */
	uint32_t failed_pairings;
	uint32_t commands;
	uint32_t list_reads;
	bool upload_done;
};

/* What the main loop has to do, as a bit mask. */
#define BT_OTA_DO_ADVERTISE  (1U << 0)
#define BT_OTA_DO_DISCONNECT (1U << 1)
/* Check the image that arrived, and offer it to the person at the board. */
#define BT_OTA_DO_OFFER      (1U << 2)
/* See whether the image on trial has proved itself. */
#define BT_OTA_DO_TRY_PROOF  (1U << 3)
#define BT_OTA_DO_INSTALL    (1U << 4)
/* Erase what is in the secondary slot. */
#define BT_OTA_DO_DISCARD    (1U << 5)
#define BT_OTA_DO_CLOSE      (1U << 6)

void bt_ota_window_open(struct bt_ota_window *window, bool proof_only, uint16_t window_seconds);

/* Once a second, while a window is open. */
uint32_t bt_ota_window_tick(struct bt_ota_window *window, const struct bt_ota_link *link);

/* A real press of a real button. button is 0 for Button 1, 1 for Button 2. */
uint32_t bt_ota_window_press(struct bt_ota_window *window, unsigned int button);

/* The image that arrived was no good. */
uint32_t bt_ota_window_offer_failed(struct bt_ota_window *window);

/* The controller did not start after all. */
uint32_t bt_ota_window_abort(struct bt_ota_window *window);

const char *bt_ota_closed_text(enum bt_ota_closed closed);

/* ---- what a phone may do -------------------------------------------------------- */

/*
 * The gate in front of every SMP command. secure: the link is authenticated, with the window
 * open. uploads: this window takes an image, and none has arrived yet. Only two commands
 * exist for a phone: reading the list of images, and uploading. In particular it cannot ask
 * for a swap, confirm an image or erase a slot, in any state. A swap is asked for by this
 * firmware, after a press, and only for a trial, and an image is only confirmed by the proof
 * below.
 */
bool bt_ota_command_allowed(uint16_t group, uint16_t id, uint8_t op, bool secure, bool uploads);

enum bt_ota_upload {
	BT_OTA_UPLOAD_OK,
	BT_OTA_UPLOAD_NOT_IMAGE_0,
	BT_OTA_UPLOAD_NO_HEADER,
	BT_OTA_UPLOAD_NOT_NEWER,
	BT_OTA_UPLOAD_TOO_LARGE,
	BT_OTA_UPLOAD_BAD_SIZES,
};

/*
 * The first piece of an upload, before anything is written. max_total is what can be written
 * without reaching the trailer at the end of the slot: a file long enough to bring its own
 * swap request could make an update permanent, with no trial.
 */
enum bt_ota_upload bt_ota_check_upload(const uint8_t *data, size_t len, uint64_t total,
				       uint32_t image_number, const struct fw_version *running,
				       uint64_t max_total);

const char *bt_ota_upload_text(enum bt_ota_upload verdict);

/*
 * What is in the secondary slot, when it has all arrived: the header can be read, it is
 * strictly newer than what runs, and nothing has asked for a swap.
 */
bool bt_ota_offer_ok(bool header_read, const struct fw_version *target,
		     const struct fw_version *running, bool swap_pending);

/* ---- the trial ------------------------------------------------------------------ */

struct bt_ota_proof {
	uint32_t uptime_seconds;
	uint32_t min_seconds;
	bool provisioned;
	/* Associated with an access point, address or not. Then it is for the cloud to decide. */
	bool wifi_up;
	/* The Wi-Fi stack has reported the result of a join attempt since this image started. */
	bool wifi_answered;
	bool link_secure;
	uint32_t list_reads;
};

enum bt_ota_proof_result {
	BT_OTA_PROVED,
	BT_OTA_WAIT_FOR_LINK,
	BT_OTA_WAIT_FOR_LIST,
	BT_OTA_WAIT_FOR_TIME,
	BT_OTA_WAIT_FOR_WIFI_ANSWER,
	BT_OTA_WAIT_FOR_CLOUD,
	BT_OTA_NOT_PROVISIONED,
};

enum bt_ota_proof_result bt_ota_proof_check(const struct bt_ota_proof *proof);

const char *bt_ota_proof_text(enum bt_ota_proof_result result);

/* ---- the record ----------------------------------------------------------------- */

#define BT_OTA_RECORD_MAGIC 0x42544f31U /* "BTO1" */
#define BT_OTA_HASH_LEN     8

enum bt_ota_record_phase {
	/* The swap was requested, and the board was about to restart. */
	BT_OTA_RECORD_ARMED = 1,
	/* The new image has started at least once. */
	BT_OTA_RECORD_TESTING = 2,
	/* Over, one way or the other. */
	BT_OTA_RECORD_DONE = 3,
};

enum bt_ota_result {
	BT_OTA_RESULT_PENDING,
	BT_OTA_RESULT_SUCCEEDED,
	BT_OTA_RESULT_ROLLED_BACK,
	BT_OTA_RESULT_NOT_INSTALLED,
	BT_OTA_RESULT_TRIAL_LOST,
	/* A cloud job installed something else after this one. */
	BT_OTA_RESULT_SUPERSEDED,
	BT_OTA_RESULT_FLASH_ERROR,
};

enum bt_ota_proof_by {
	BT_OTA_PROOF_BY_NONE,
	BT_OTA_PROOF_BY_CLOUD,
	BT_OTA_PROOF_BY_PERSON,
};

/*
 * The last update over Bluetooth, in TF-M storage. There is no cloud job to carry this. A
 * record of one size only: see store_read().
 */
struct bt_ota_record {
	uint32_t magic;
	uint8_t phase;
	uint8_t result;
	uint8_t proof;
	uint8_t reserved;
	/* How many times this board has been asked to install an image this way. */
	uint32_t count;
	struct fw_version from;
	struct fw_version target;
	/* The first bytes of the image's SHA-256, as `image list` and tools/recover.py show it. */
	uint8_t hash[BT_OTA_HASH_LEN];
};

const char *bt_ota_result_text(enum bt_ota_result result);
const char *bt_ota_proof_by_text(enum bt_ota_proof_by proof);

/*
 * The record as a member of the device shadow's reported state. Only values this firmware
 * controls: versions, numbers and words. Returns the length, or a negative number if it does
 * not fit.
 */
int bt_ota_record_json(const struct bt_ota_record *record, char *buf, size_t len);

#endif /* BT_OTA_POLICY_H_ */
