#include "bt_ota.h"

#include <errno.h>
#include <string.h>

#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/crypto.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/hci.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/dfu/mcuboot.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/init.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/logging/log_ctrl.h>
#include <zephyr/mgmt/mcumgr/grp/img_mgmt/img_mgmt.h>
#include <zephyr/mgmt/mcumgr/mgmt/callbacks.h>
#include <zephyr/mgmt/mcumgr/mgmt/mgmt_defines.h>
#include <zephyr/mgmt/mcumgr/transport/smp_bt.h>
#include <zephyr/storage/flash_map.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/reboot.h>

#include "app_events.h"
#include "cloud.h"
#include "console.h"
#include "device.h"
#include "identity.h"
#include "net.h"
#include "ota.h"
#include "ota_job.h"
#include "store.h"
#include "version.h"

LOG_MODULE_REGISTER(bt_ota, CONFIG_APP_LOG_LEVEL);

/*
 * What the security of this rests on, all of it from bt_ota.conf. These are not choices: if one
 * changes, by a stray -D or by a new default in the SDK, the build stops here.
 */
#if !defined(CONFIG_MCUMGR_TRANSPORT_BT_PERM_RW_AUTHEN)
#error "The SMP characteristic must require an authenticated link"
#endif
#if !defined(CONFIG_BT_SMP_SC_ONLY) || !defined(CONFIG_BT_SMP_ENFORCE_MITM) || \
	CONFIG_BT_SMP_MIN_ENC_KEY_SIZE != 16
#error "Pairing must be LE Secure Connections, MITM protected, with a 16-byte key"
#endif
#if defined(CONFIG_BT_BONDABLE) || defined(CONFIG_BT_SETTINGS)
#error "A pairing must last as long as the link: no bonds"
#endif
#if defined(CONFIG_BT_FIXED_PASSKEY) || defined(CONFIG_BT_APP_PASSKEY) || \
	defined(CONFIG_BT_USE_DEBUG_KEYS) || defined(CONFIG_BT_CONN_DISABLE_SECURITY)
#error "The Bluetooth host must draw a new passkey for every attempt, with real keys"
#endif
#if defined(CONFIG_MCUMGR_GRP_OS) || defined(CONFIG_MCUMGR_GRP_FS) || \
	defined(CONFIG_MCUMGR_GRP_SHELL) || defined(CONFIG_MCUMGR_GRP_STAT) || \
	defined(CONFIG_MCUMGR_GRP_SETTINGS) || defined(CONFIG_MCUMGR_GRP_ZBASIC) || \
	defined(CONFIG_MCUMGR_GRP_ENUM)
#error "MCUmgr must have the image group and no other"
#endif
#if defined(CONFIG_MCUMGR_TRANSPORT_UART) || defined(CONFIG_MCUMGR_TRANSPORT_RAW_UART) || \
	defined(CONFIG_MCUMGR_TRANSPORT_SHELL) || defined(CONFIG_MCUMGR_TRANSPORT_UDP) || \
	defined(CONFIG_MCUMGR_TRANSPORT_LORAWAN) || defined(CONFIG_MCUMGR_TRANSPORT_DUMMY) || \
	defined(CONFIG_MCUMGR_TRANSPORT_RAW_DUMMY)
#error "MCUmgr must have the Bluetooth transport and no other"
#endif
#if defined(CONFIG_MCUMGR_GRP_IMG_ALLOW_CONFIRM_NON_ACTIVE_SLOT) || \
	defined(CONFIG_MCUMGR_GRP_IMG_ALLOW_ERASE_PENDING) || \
	defined(CONFIG_MCUMGR_GRP_IMG_DIRECT_UPLOAD)
#error "MCUmgr must not be able to make a swap permanent, erase what is pending, or pick a slot"
#endif
#if !defined(CONFIG_MCUMGR_GRP_IMG_MUTEX)
#error "Closing a window relies on img_mgmt's lock: see close_window()"
#endif

BUILD_ASSERT(BT_OTA_SMP_OP_READ == MGMT_OP_READ && BT_OTA_SMP_OP_WRITE == MGMT_OP_WRITE);
BUILD_ASSERT(BT_OTA_SMP_GROUP_IMAGE == MGMT_GROUP_ID_IMAGE);
BUILD_ASSERT(BT_OTA_SMP_ID_STATE == IMG_MGMT_ID_STATE);
BUILD_ASSERT(BT_OTA_SMP_ID_UPLOAD == IMG_MGMT_ID_UPLOAD);
BUILD_ASSERT(BT_OTA_IMAGE_MAGIC == IMAGE_MAGIC);
BUILD_ASSERT(BT_OTA_IMAGE_HEADER_LEN == IMAGE_HEADER_SIZE);

#define SECONDARY_SLOT_ID PARTITION_ID(slot1_partition)
/* img_mgmt's number for the secondary slot. */
#define SECONDARY_SLOT    1
/* SHA-256: what img_mgmt_read_info() gives. */
#define IMAGE_SHA_LEN     32
/* An upload must stop short of the trailer. See bt_ota_check_upload(). */
#define MAX_UPLOAD        (PARTITION_SIZE(slot1_partition) - CONFIG_MCUBOOT_UPDATE_FOOTER_SIZE)

#define KEY_SIZE_REQUIRED 16
#define ADV_NAME_SIZE     (sizeof(CONFIG_BT_DEVICE_NAME) + 5)

/*
 * P1.10 picks the antenna of the network core's radio: low for its own, high for the one it
 * would share with Wi-Fi. It starts undriven, so it is driven low before anything is sent.
 */
static const struct gpio_dt_spec antenna_switch =
	GPIO_DT_SPEC_GET(DT_NODELABEL(nrf70), srrf_switch_gpios);

/* The main loop's. The Bluetooth and MCUmgr threads see only the atomics below. */
static struct bt_ota_window window;
static struct bt_ota_record record;
static bool have_record;
/* What has arrived, while it waits for a button. */
static struct bt_ota_record offered;
static bool bluetooth_trial;
static bool enabled;
static bool controller_failed;
static bool report_waiting;
static enum bt_ota_proof_result last_proof = BT_OTA_PROVED;
static char name[ADV_NAME_SIZE];

/* Set by the main loop, read by the threads that serve a phone. */
#define GATE_OPEN    BIT(0)
#define GATE_UPLOADS BIT(1)
static atomic_t gate;

/* Set by those threads, and read by the main loop once a second. */
static atomic_t ready;
static atomic_t start_failed;
static atomic_t connected;
static atomic_t secure;
static atomic_t failed_pairings;
static atomic_t commands;
static atomic_t list_reads;
static atomic_t upload_done;

/*
 * What a phone did, for the main loop to say. A line takes more stack than the Bluetooth threads
 * have to spare, and the passkey can come from the small one that works out the keys.
 */
#define SAY_CONNECTED BIT(0)
#define SAY_PAIRED    BIT(1)
#define SAY_CANCELLED BIT(2)
#define SAY_FAILED    BIT(3)
#define SAY_GONE      BIT(4)
static atomic_t to_say;
/* The passkey plus one, because 0 is a passkey too. */
static atomic_t passkey_to_say;
static atomic_t failure_reason;
static atomic_t gone_reason;

/* ---- the threads that serve a phone: only what the atomics hold ---------------------- */

static void say_what_happened(void);

/* If the queue is full the next tick says it. */
static void tell_main_loop(atomic_val_t what)
{
	const struct app_event event = {
		.type = APP_EVENT_CALL,
		.call.function = say_what_happened,
	};

	(void)atomic_or(&to_say, what);
	(void)app_event_post(&event);
}

static enum mgmt_cb_return on_command(uint32_t event, enum mgmt_cb_return prev_status, int32_t *rc,
				      uint16_t *group, bool *abort_more, void *data,
				      size_t data_size)
{
	const struct mgmt_evt_op_cmd_arg *command = data;
	atomic_val_t now = atomic_get(&gate);

	ARG_UNUSED(prev_status);
	ARG_UNUSED(group);
	ARG_UNUSED(abort_more);
	ARG_UNUSED(data_size);

	if (event == MGMT_EVT_OP_CMD_DONE) {
		/* Read back from flash, and sent over the same link: this path works. */
		if (command->group == MGMT_GROUP_ID_IMAGE && command->id == IMG_MGMT_ID_STATE &&
		    command->err == MGMT_ERR_EOK) {
			(void)atomic_inc(&list_reads);
		}
		return MGMT_CB_OK;
	}

	if (!bt_ota_command_allowed(command->group, command->id, command->op,
				    (now & GATE_OPEN) != 0 && atomic_get(&secure) != 0,
				    (now & GATE_UPLOADS) != 0)) {
		console_event("BT", "refused a command: group %u, id %u, op %u", command->group,
			      command->id, command->op);
		*rc = MGMT_ERR_EACCESSDENIED;
		return MGMT_CB_ERROR_RC;
	}

	(void)atomic_inc(&commands);
	return MGMT_CB_OK;
}

static enum mgmt_cb_return on_upload(uint32_t event, enum mgmt_cb_return prev_status, int32_t *rc,
				     uint16_t *group, bool *abort_more, void *data,
				     size_t data_size)
{
	ARG_UNUSED(prev_status);
	ARG_UNUSED(group);
	ARG_UNUSED(abort_more);
	ARG_UNUSED(data_size);

	if (event == MGMT_EVT_OP_IMG_MGMT_DFU_PENDING) {
		/* Nothing more goes in from here on, ahead of the main loop's next look. */
		(void)atomic_and(&gate, ~GATE_UPLOADS);
		(void)atomic_set(&upload_done, 1);
		return MGMT_CB_OK;
	}

	const struct img_mgmt_upload_check *check = data;

	/*
	 * Again, with img_mgmt's lock held this time. A piece that got past on_command() as a
	 * window shut stops here, and close_window() waits for that lock.
	 */
	if ((atomic_get(&gate) & GATE_UPLOADS) == 0) {
		*rc = MGMT_ERR_EACCESSDENIED;
		return MGMT_CB_ERROR_RC;
	}

	if (check->req->off == 0) {
		enum bt_ota_upload verdict = bt_ota_check_upload(
			check->req->img_data.value, check->req->img_data.len, check->action->size,
			check->req->image, fw_version_running(), MAX_UPLOAD);

		if (verdict != BT_OTA_UPLOAD_OK) {
			console_event("BT", "refused an upload: %s", bt_ota_upload_text(verdict));
			*rc = MGMT_ERR_EBADSTATE;
			return MGMT_CB_ERROR_RC;
		}

		console_event("BT", "upload started, %u bytes", (unsigned int)check->action->size);
	}

	return MGMT_CB_OK;
}

static struct mgmt_callback command_hook = {
	.callback = on_command,
	.event_id = MGMT_EVT_OP_CMD_RECV | MGMT_EVT_OP_CMD_DONE,
};

static struct mgmt_callback upload_hook = {
	.callback = on_upload,
	.event_id = MGMT_EVT_OP_IMG_MGMT_DFU_CHUNK | MGMT_EVT_OP_IMG_MGMT_DFU_PENDING,
};

/* From before anything can connect, so that nothing ever goes through MCUmgr without them. */
static int register_hooks(void)
{
	mgmt_callback_register(&command_hook);
	mgmt_callback_register(&upload_hook);
	return 0;
}

SYS_INIT(register_hooks, APPLICATION, CONFIG_APPLICATION_INIT_PRIORITY);

static void on_connected(struct bt_conn *conn, uint8_t err)
{
	if (err != 0) {
		return;
	}

	if ((atomic_get(&gate) & GATE_OPEN) == 0) {
		(void)bt_conn_disconnect(conn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
		return;
	}

	(void)atomic_set(&secure, 0);
	(void)atomic_set(&connected, 1);
	tell_main_loop(SAY_CONNECTED);

	/* Ask for pairing at once: nothing else on this link works without it. */
	if (bt_conn_set_security(conn, BT_SECURITY_L4) != 0) {
		(void)bt_conn_disconnect(conn, BT_HCI_ERR_AUTH_FAIL);
	}
}

static void on_disconnected(struct bt_conn *conn, uint8_t reason)
{
	ARG_UNUSED(conn);

	(void)atomic_set(&secure, 0);
	(void)atomic_set(&connected, 0);
	/* A proof takes one link from start to finish. */
	(void)atomic_set(&list_reads, 0);
	(void)atomic_set(&gone_reason, reason);
	tell_main_loop(SAY_GONE);
}

static void on_security_changed(struct bt_conn *conn, bt_security_t level, enum bt_security_err err)
{
	struct bt_conn_info info;

	if (err == BT_SECURITY_ERR_SUCCESS && level >= BT_SECURITY_L4 &&
	    (atomic_get(&gate) & GATE_OPEN) != 0 && bt_conn_get_info(conn, &info) == 0 &&
	    (info.security.flags & BT_SECURITY_FLAG_SC) != 0 &&
	    info.security.enc_key_size == KEY_SIZE_REQUIRED) {
		(void)atomic_set(&secure, 1);
		tell_main_loop(SAY_PAIRED);
		return;
	}

	/* What the host would not allow anyway. Refused here too, because this is the point. */
	(void)atomic_set(&secure, 0);
	(void)bt_conn_disconnect(conn, BT_HCI_ERR_AUTH_FAIL);
}

BT_CONN_CB_DEFINE(connection_callbacks) = {
	.connected = on_connected,
	.disconnected = on_disconnected,
	.security_changed = on_security_changed,
};

static enum bt_security_err on_pairing_accept(struct bt_conn *conn,
					      const struct bt_conn_pairing_feat *const feat)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(feat);

	return (atomic_get(&gate) & GATE_OPEN) != 0 ? BT_SECURITY_ERR_SUCCESS
						    : BT_SECURITY_ERR_PAIR_NOT_ALLOWED;
}

/* A new one for every attempt: the Bluetooth host draws it, and it is never fixed. */
static void on_passkey_display(struct bt_conn *conn, unsigned int passkey)
{
	ARG_UNUSED(conn);

	(void)atomic_set(&passkey_to_say, (atomic_val_t)passkey + 1);
	tell_main_loop(0);
}

static void on_auth_cancel(struct bt_conn *conn)
{
	ARG_UNUSED(conn);

	tell_main_loop(SAY_CANCELLED);
}

static void on_pairing_failed(struct bt_conn *conn, enum bt_security_err reason)
{
	ARG_UNUSED(conn);

	(void)atomic_inc(&failed_pairings);
	(void)atomic_set(&failure_reason, (atomic_val_t)reason);
	tell_main_loop(SAY_FAILED);
}

static const struct bt_conn_auth_cb auth_callbacks = {
	.pairing_accept = on_pairing_accept,
	.passkey_display = on_passkey_display,
	.cancel = on_auth_cancel,
};

static struct bt_conn_auth_info_cb auth_info_callbacks = {
	.pairing_failed = on_pairing_failed,
};

/* On the system work queue, when the controller has answered. */
static void on_bt_ready(int err)
{
	(void)atomic_set(err != 0 ? &start_failed : &ready, 1);
}

/* ---- the main loop's side ---------------------------------------------------------- */

static void apply(uint32_t actions);

static void say_what_happened(void)
{
	atomic_val_t what = atomic_set(&to_say, 0);
	atomic_val_t passkey = atomic_set(&passkey_to_say, 0);

	if (what & SAY_CONNECTED) {
		console_event("BT", "a phone connected");
	}

	if (passkey != 0) {
		console_event("BT", "passkey %06u", (unsigned int)(passkey - 1));
	}

	if (what & SAY_PAIRED) {
		console_event("BT", "paired: LE Secure Connections, authenticated");
	}

	if (what & SAY_CANCELLED) {
		console_event("BT", "pairing cancelled");
	}

	if (what & SAY_FAILED) {
		console_event("BT", "pairing failed: %d", (int)atomic_get(&failure_reason));
	}

	if (what & SAY_GONE) {
		console_event("BT", "the phone is gone: reason 0x%02x",
			      (unsigned int)atomic_get(&gone_reason));
	}
}

static void save_record(void)
{
	report_waiting = true;
	if (store_write(STORE_BT_OTA_RECORD, &record, sizeof(record)) != 0) {
		LOG_ERR("The record of this update could not be stored");
	}
}

static void say_record(const char *what)
{
	char from[FW_VERSION_STRING_MAX];
	char target[FW_VERSION_STRING_MAX];

	(void)fw_version_to_string(&record.from, from, sizeof(from));
	(void)fw_version_to_string(&record.target, target, sizeof(target));
	console_event("BT", "%s: %s from %s, %s, proof %s, update %u of this board", what, target,
		      from, bt_ota_result_text((enum bt_ota_result)record.result),
		      bt_ota_proof_by_text((enum bt_ota_proof_by)record.proof),
		      (unsigned int)record.count);
}

static void finish_record(enum bt_ota_result result, enum bt_ota_proof_by proof)
{
	record.phase = BT_OTA_RECORD_DONE;
	record.result = result;
	record.proof = proof;
	save_record();
	say_record("update over Bluetooth");
}

void bt_ota_on_boot(bool on_trial, bool has_trailer, bool job_record)
{
	if (store_read(STORE_BT_OTA_RECORD, &record, sizeof(record)) != 0 ||
	    record.magic != BT_OTA_RECORD_MAGIC) {
		memset(&record, 0, sizeof(record));
		return;
	}

	have_record = true;
	report_waiting = true;

	if (record.phase == BT_OTA_RECORD_DONE) {
		say_record("last update over Bluetooth");
		return;
	}

	if (job_record) {
		finish_record(BT_OTA_RESULT_SUPERSEDED, BT_OTA_PROOF_BY_NONE);
		return;
	}

	switch (ota_restart_outcome(fw_version_compare(&record.target, fw_version_running()) == 0,
				    on_trial, has_trailer, record.phase == BT_OTA_RECORD_TESTING)) {
	case OTA_RESTART_ON_TRIAL:
		record.phase = BT_OTA_RECORD_TESTING;
		save_record();
		bluetooth_trial = true;
		say_record("on trial");
		console_event("BT", "kept when it reaches the cloud; with no Wi-Fi in reach, hold "
				    "Button 1, pair, and read the image list");
		break;
	case OTA_RESTART_CONFIRMED:
		/* Confirmed, and restarted before this could be written. By whom is not known. */
		finish_record(BT_OTA_RESULT_SUCCEEDED, BT_OTA_PROOF_BY_NONE);
		break;
	case OTA_RESTART_TRIAL_LOST:
		finish_record(BT_OTA_RESULT_TRIAL_LOST, BT_OTA_PROOF_BY_NONE);
		break;
	case OTA_RESTART_ROLLED_BACK:
		finish_record(BT_OTA_RESULT_ROLLED_BACK, BT_OTA_PROOF_BY_NONE);
		break;
	default:
		finish_record(BT_OTA_RESULT_NOT_INSTALLED, BT_OTA_PROOF_BY_NONE);
		break;
	}
}

static bool provisioned(void)
{
	return identity_settings_get() != NULL && net_has_credentials();
}

/* Bluetooth stays off until the first window. A controller that is not there costs two seconds. */
static int start_bluetooth(void)
{
	int err;

	if (enabled) {
		return 0;
	}

	if (!gpio_is_ready_dt(&antenna_switch) ||
	    gpio_pin_configure_dt(&antenna_switch, GPIO_OUTPUT_INACTIVE) != 0) {
		LOG_WRN("The antenna switch could not be set");
	}

	err = bt_conn_auth_cb_register(&auth_callbacks);
	if (err == 0) {
		err = bt_conn_auth_info_cb_register(&auth_info_callbacks);
	}
	if (err == 0) {
		err = bt_enable(on_bt_ready);
	}

	if (err != 0) {
		/* bt_enable() cannot be called again after this. */
		console_event("BT", "Bluetooth could not start: %d", err);
		controller_failed = true;
		return err;
	}

	enabled = true;
	return 0;
}

static void reset_link_state(void)
{
	(void)atomic_set(&failed_pairings, 0);
	(void)atomic_set(&commands, 0);
	(void)atomic_set(&list_reads, 0);
	(void)atomic_set(&upload_done, 0);
}

static void open_window(bool proof_only)
{
	if (start_bluetooth() != 0) {
		console_event("BT", "%s", bt_ota_open_text(BT_OTA_REFUSED_NO_CONTROLLER));
		return;
	}

	reset_link_state();
	name[0] = '\0';
	last_proof = BT_OTA_PROVED;
	bt_ota_window_open(&window, proof_only, CONFIG_APP_BT_OTA_WINDOW_SECONDS);

	if (proof_only) {
		atomic_set(&gate, GATE_OPEN);
	} else {
		ota_bt_enter();
		atomic_set(&gate, GATE_OPEN | GATE_UPLOADS);
	}

	console_event("BT", "open for %d s%s", CONFIG_APP_BT_OTA_WINDOW_SECONDS,
		      proof_only ? ", to prove the image on trial" : "");
}

static void disconnect_one(struct bt_conn *conn, void *data)
{
	ARG_UNUSED(data);

	(void)bt_conn_disconnect(conn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
}

static const struct bt_data advertised[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
	BT_DATA_BYTES(BT_DATA_UUID128_ALL, SMP_BT_SVC_UUID_VAL),
};

static void advertise(void)
{
	struct bt_data sd[1];
	uint16_t tag = 0;
	int err;

	if (!atomic_get(&ready) || atomic_get(&connected)) {
		return;
	}

	/* Not the board's name in the cloud: nothing that identifies it goes on the air. */
	if (name[0] == '\0') {
		(void)bt_rand(&tag, sizeof(tag));
		(void)snprintk(name, sizeof(name), "%s-%04X", CONFIG_BT_DEVICE_NAME, tag);
		console_event("BT", "advertising as %s", name);
	}

	sd[0].type = BT_DATA_NAME_COMPLETE;
	sd[0].data_len = (uint8_t)strlen(name);
	sd[0].data = (const uint8_t *)name;

	/* Already running, or the last link's connection object is not free yet: next tick. */
	err = bt_le_adv_start(BT_LE_ADV_CONN_FAST_1, advertised, ARRAY_SIZE(advertised), sd,
			      ARRAY_SIZE(sd));
	if (err != 0 && err != -EALREADY && err != -ENOMEM) {
		LOG_WRN("Advertising did not start: %d", err);
	}
}

static void discard_image(void)
{
	int err = boot_erase_img_bank(SECONDARY_SLOT_ID);

	if (err != 0) {
		LOG_WRN("The secondary slot could not be erased: %d", err);
	}
}

static void close_window(bool discard)
{
	/* The gate first: nothing new gets in from here on. */
	atomic_set(&gate, 0);
	atomic_set(&secure, 0);
	if (atomic_get(&ready)) {
		(void)bt_le_adv_stop();
	}
	bt_conn_foreach(BT_CONN_TYPE_LE, disconnect_one, NULL);

	/*
	 * Or a later upload of the same file would carry on where this one stopped. This takes
	 * img_mgmt's lock, so it waits for a piece that is being written: after it nothing more
	 * arrives, and upload_done is the last word on whether the whole image got there. In a
	 * proof window nothing can have arrived, and the slot holds the image to go back to.
	 */
	img_mgmt_reset_upload();

	if (discard || (atomic_get(&upload_done) && !window.proof_only)) {
		discard_image();
		atomic_set(&upload_done, 0);
	}

	console_event("BT", "closed: %s", bt_ota_closed_text(window.closed));
	ota_bt_leave();
}

static void offer_image(void)
{
	struct mcuboot_img_header header;
	uint8_t hash[IMAGE_SHA_LEN] = { 0 };
	struct image_version version;
	struct fw_version target = { 0 };
	bool header_read = boot_read_bank_header(SECONDARY_SLOT_ID, &header, sizeof(header)) == 0 &&
			   header.mcuboot_version == 1 &&
			   img_mgmt_read_info(SECONDARY_SLOT, &version, hash, NULL) == 0;
	char text[FW_VERSION_STRING_MAX];

	(void)bt_le_adv_stop();

	if (header_read) {
		target.major = header.h.v1.sem_ver.major;
		target.minor = header.h.v1.sem_ver.minor;
		target.revision = header.h.v1.sem_ver.revision;
		target.build = header.h.v1.sem_ver.build_num;
	}

	if (!bt_ota_offer_ok(header_read, &target, fw_version_running(),
			     mcuboot_swap_type_multi(0) != BOOT_SWAP_TYPE_NONE)) {
		console_event("BT", "what arrived cannot be installed");
		apply(bt_ota_window_offer_failed(&window));
		return;
	}

	memset(&offered, 0, sizeof(offered));
	offered.magic = BT_OTA_RECORD_MAGIC;
	offered.phase = BT_OTA_RECORD_ARMED;
	offered.result = BT_OTA_RESULT_PENDING;
	offered.proof = BT_OTA_PROOF_BY_NONE;
	offered.count = record.count + 1;
	offered.from = *fw_version_running();
	offered.target = target;
	memcpy(offered.hash, hash, sizeof(offered.hash));

	(void)fw_version_to_string(&target, text, sizeof(text));
	console_event("BT",
		      "firmware %s has arrived, hash %02x%02x%02x%02x%02x%02x%02x%02x: press Button 1 "
		      "to install it, Button 2 to erase it",
		      text, hash[0], hash[1], hash[2], hash[3], hash[4], hash[5], hash[6], hash[7]);
}

/* The way a cloud update ends: the record, then the swap, for a trial, then the restart. */
static void install_image(void)
{
	/* A file long enough to bring a swap request of its own: see verify_download(). */
	if (mcuboot_swap_type_multi(0) != BOOT_SWAP_TYPE_NONE ||
	    store_write(STORE_BT_OTA_RECORD, &offered, sizeof(offered)) != 0) {
		console_event("BT", "the image could not be installed");
		apply(bt_ota_window_offer_failed(&window));
		return;
	}

	record = offered;
	have_record = true;

	if (boot_request_upgrade_multi(0, BOOT_UPGRADE_TEST) != 0) {
		finish_record(BT_OTA_RESULT_FLASH_ERROR, BT_OTA_PROOF_BY_NONE);
		apply(bt_ota_window_offer_failed(&window));
		return;
	}

	say_record("restarting into the bootloader");
	cloud_disconnect();
	LOG_PANIC();
	sys_reboot(SYS_REBOOT_COLD);
}

static void close_proof_window(void)
{
	if (window.phase != BT_OTA_CLOSED) {
		window.phase = BT_OTA_CLOSED;
		window.closed = BT_OTA_CLOSED_TRIAL_OVER;
		close_window(false);
	}
}

void bt_ota_on_cloud_proof(void)
{
	if (bluetooth_trial) {
		bluetooth_trial = false;
		finish_record(BT_OTA_RESULT_SUCCEEDED, BT_OTA_PROOF_BY_CLOUD);
		close_proof_window();
	}
}

static void try_proof(void)
{
	const struct bt_ota_proof proof = {
		.uptime_seconds = (uint32_t)(k_uptime_get() / MSEC_PER_SEC),
		.min_seconds = CONFIG_APP_BT_OTA_TRIAL_MIN_SECONDS,
		.provisioned = provisioned(),
		.wifi_up = net_is_up() || net_wifi_associated(),
		.wifi_answered = net_wifi_answered(),
		.link_secure = atomic_get(&secure) != 0,
		.list_reads = (uint32_t)atomic_get(&list_reads),
	};
	enum bt_ota_proof_result result = bt_ota_proof_check(&proof);

	if (result != last_proof && result != BT_OTA_PROVED) {
		console_event("BT", "trial: %s", bt_ota_proof_text(result));
	}
	last_proof = result;

	if (result == BT_OTA_PROVED && bluetooth_trial && ota_bt_confirm() == 0) {
		bluetooth_trial = false;
		finish_record(BT_OTA_RESULT_SUCCEEDED, BT_OTA_PROOF_BY_PERSON);
		close_proof_window();
	}
}

static void apply(uint32_t actions)
{
	if (actions & BT_OTA_DO_ADVERTISE) {
		advertise();
	}

	if (actions & BT_OTA_DO_DISCONNECT) {
		bt_conn_foreach(BT_CONN_TYPE_LE, disconnect_one, NULL);
	}

	if (actions & BT_OTA_DO_OFFER) {
		offer_image();
	}

	if (actions & BT_OTA_DO_TRY_PROOF) {
		try_proof();
	}

	if (actions & BT_OTA_DO_INSTALL) {
		install_image();
	}

	if (actions & BT_OTA_DO_CLOSE) {
		close_window((actions & BT_OTA_DO_DISCARD) != 0);
	}
}

bool bt_ota_on_button(uint8_t button, bool long_press, bool physical)
{
	struct bt_ota_board board;
	enum bt_ota_open open;

	/* A command on the console is not a person. It stays out of this altogether. */
	if (!physical) {
		return false;
	}

	if (window.phase != BT_OTA_CLOSED) {
		apply(bt_ota_window_press(&window, button));
		return true;
	}

	/*
	 * Button 1 still does what it did for a cloud update on offer, however long it is held. Only
	 * a build with CONFIG_APP_OTA_REQUIRE_USER_CONSENT has offers.
	 */
	if (button != APP_BUTTON_1 || !long_press || ota_state() == OTA_AWAITING_USER) {
		return false;
	}

	board = (struct bt_ota_board){
		.controller_failed = controller_failed,
		.factory = device_is_factory(),
		.provisioned = provisioned(),
		.idle = ota_state() == OTA_IDLE,
		.testing = ota_state() == OTA_TESTING,
		.bluetooth_trial = bluetooth_trial,
		.job_record = ota_bt_has_job(),
		.swap_pending = mcuboot_swap_type_multi(0) != BOOT_SWAP_TYPE_NONE,
		.link_up = atomic_get(&connected) != 0,
	};
	open = bt_ota_may_open(&board);

	switch (open) {
	case BT_OTA_OPEN_UPLOAD:
		open_window(false);
		return true;
	case BT_OTA_OPEN_PROOF:
		open_window(true);
		return true;
	default:
		console_event("BT", "not opening: %s", bt_ota_open_text(open));
		return true;
	}
}

void bt_ota_on_tick(void)
{
	struct bt_ota_link link;

	say_what_happened();

	if (report_waiting && have_record && cloud_is_connected()) {
		bt_ota_on_cloud_up();
	}

	/* bt_enable() cannot be called again, so this stands until the next restart. */
	if (atomic_get(&start_failed) != 0 && !controller_failed) {
		controller_failed = true;
		console_event("BT", "%s", bt_ota_open_text(BT_OTA_REFUSED_NO_CONTROLLER));
		if (window.phase != BT_OTA_CLOSED) {
			apply(bt_ota_window_abort(&window));
		}
	}

	if (window.phase == BT_OTA_CLOSED) {
		/* A disconnection can fail: a phone from a closed window does not get to stay. */
		if (atomic_get(&connected) != 0) {
			bt_conn_foreach(BT_CONN_TYPE_LE, disconnect_one, NULL);
		}
		return;
	}

	link = (struct bt_ota_link){
		.connected = atomic_get(&connected) != 0,
		.secure = atomic_get(&secure) != 0,
		.failed_pairings = (uint32_t)atomic_get(&failed_pairings),
		.commands = (uint32_t)atomic_get(&commands),
		.list_reads = (uint32_t)atomic_get(&list_reads),
		.upload_done = atomic_get(&upload_done) != 0,
	};

	apply(bt_ota_window_tick(&window, &link));
}

void bt_ota_on_cloud_up(void)
{
	char json[192];

	if (!have_record || bt_ota_record_json(&record, json, sizeof(json)) < 0) {
		return;
	}

	if (cloud_shadow_report(json) == 0) {
		report_waiting = false;
	}
}

bool bt_ota_is_open(void)
{
	return window.phase != BT_OTA_CLOSED;
}

enum ui_state bt_ota_ui_state(void)
{
	switch (window.phase) {
	case BT_OTA_READY:
		return UI_UPDATE_OFFERED;
	case BT_OTA_LINKED:
		return UI_UPDATE_IN_PROGRESS;
	default:
		return UI_BT_WINDOW;
	}
}
