/*
 * Host-side tests of src/bt_ota.c: that what a phone can get at goes through the policy, and
 * that the board does what the policy decides, in the right order. The real file is compiled
 * here, to get at what it keeps static, against a fake of the Bluetooth host, of MCUmgr and of
 * the bootloader's API. The tests play the part of the phone and of the person.
 *
 * What this cannot show is how the real ones behave: whether a phone pairs at all, which
 * events come and when, or how fast an upload goes. Nothing about this has been on the air
 * here. See "Firmware update over Bluetooth" in firmware/README.md for what a person has to do.
 */

#define CONFIG_APP_BT_OTA                   1
#define CONFIG_APP_CONSOLE                  1
#define CONFIG_APP_BT_OTA_WINDOW_SECONDS    120
#define CONFIG_APP_BT_OTA_TRIAL_MIN_SECONDS 60
#define CONFIG_APP_LOG_LEVEL                0
#define CONFIG_APPLICATION_INIT_PRIORITY    90
#define CONFIG_BT_DEVICE_NAME               "Cranium"
#define CONFIG_MCUBOOT_UPDATE_FOOTER_SIZE   0x2000

/* What bt_ota.conf sets, and what bt_ota.c stops the build without. */
#define CONFIG_MCUMGR_TRANSPORT_BT_PERM_RW_AUTHEN 1
#define CONFIG_MCUMGR_GRP_IMG_MUTEX               1
#define CONFIG_BT_SMP_SC_ONLY                     1
#define CONFIG_BT_SMP_ENFORCE_MITM                1
#define CONFIG_BT_SMP_MIN_ENC_KEY_SIZE            16

#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/*
 * What SYS_INIT asks for gets run by fresh_board(), the way a boot runs it, so that a hook that is
 * only registered by the test does not count.
 */
#include <zephyr/init.h>
#undef SYS_INIT
static int (*boot_functions[4])(void);
static int boot_function_count;
#define SYS_INIT(function, level, priority)                                                  \
	__attribute__((constructor)) static void run_at_boot_##function(void)                \
	{                                                                                    \
		boot_functions[boot_function_count++] = function;                            \
	}

#include "bt_ota.c"

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

/* version.c on a host: there is no VERSION file, so this is what runs. */
#define RUNNING_MAJOR 0
#define RUNNING_MINOR 0

static struct {
	/* The board. */
	bool factory;
	bool has_settings;
	bool has_network;
	bool wifi_up;
	bool wifi_associated;
	bool wifi_answered;
	bool cloud_up;
	enum ota_state ota;
	bool job_record;
	int64_t uptime_ms;

	/* Who did what, in that order. */
	char ops[512];
	char console[4096];
	char last_shadow[256];

	/* Bluetooth. */
	int enable_result;
	int enables;
	int advertising;
	int adv_starts;
	int disconnects;
	int disconnect_result;
	bool connected;
	bt_ready_cb_t ready_callback;
	struct bt_conn_info info;
	int set_security_result;
	const struct bt_conn_auth_cb *auth;
	struct bt_conn_auth_info_cb *auth_info;

	/* What goes to the main loop. */
	int calls_posted;
	void (*posted_function)(void);
	bool event_queue_full;

	/* The bootloader. */
	int swap_type;
	int request_result;
	int request_permanent;
	int requests;
	int erases;
	int header_result;
	uint32_t header_version;
	struct fw_version slot_version;
	int info_result;

	/* Storage. */
	bool stored;
	struct bt_ota_record stored_record;
	int store_write_result;
	int store_writes;

	int confirm_result;
	int confirms;
	int enters;
	int leaves;
	int reboots;
	int upload_resets;
	int shadow_result;
	int shadow_reports;
	struct mgmt_callback *hooks[4];
	int hook_count;
} fake;

static struct bt_conn phone;

static void op(const char *what)
{
	strncat(fake.ops, what, sizeof(fake.ops) - strlen(fake.ops) - 1);
	strncat(fake.ops, " ", sizeof(fake.ops) - strlen(fake.ops) - 1);
}

/* ---- the kernel and the rest of the application ----------------------------------- */

int64_t k_uptime_get(void)
{
	return fake.uptime_ms;
}

void host_log_panic(void)
{
	op("log_panic");
}

void sys_reboot(int type)
{
	ARG_UNUSED(type);
	fake.reboots++;
	op("reboot");
}

void console_event(const char *tag, const char *format, ...)
{
	char line[256];
	va_list args;

	va_start(args, format);
	vsnprintf(line, sizeof(line), format, args);
	va_end(args);

	strncat(fake.console, "[", sizeof(fake.console) - strlen(fake.console) - 1);
	strncat(fake.console, tag, sizeof(fake.console) - strlen(fake.console) - 1);
	strncat(fake.console, "] ", sizeof(fake.console) - strlen(fake.console) - 1);
	strncat(fake.console, line, sizeof(fake.console) - strlen(fake.console) - 1);
	strncat(fake.console, "\n", sizeof(fake.console) - strlen(fake.console) - 1);
}

const struct identity_settings *identity_settings_get(void)
{
	static const struct identity_settings settings;

	return fake.has_settings ? &settings : NULL;
}

bool device_is_factory(void)
{
	return fake.factory;
}

bool net_has_credentials(void)
{
	return fake.has_network;
}

bool net_is_up(void)
{
	return fake.wifi_up;
}

bool net_wifi_answered(void)
{
	return fake.wifi_answered;
}

bool net_wifi_associated(void)
{
	return fake.wifi_associated;
}

int app_event_post(const struct app_event *event)
{
	if (fake.event_queue_full) {
		return -ENOMSG;
	}

	CHECK(event->type == APP_EVENT_CALL);
	fake.calls_posted++;
	fake.posted_function = event->call.function;
	return 0;
}

void cloud_disconnect(void)
{
	op("cloud_disconnect");
}

bool cloud_is_connected(void)
{
	return fake.cloud_up;
}

int cloud_shadow_report(const char *reported_json)
{
	fake.shadow_reports++;
	strncpy(fake.last_shadow, reported_json, sizeof(fake.last_shadow) - 1);
	return fake.shadow_result;
}

enum ota_state ota_state(void)
{
	return fake.ota;
}

bool ota_bt_has_job(void)
{
	return fake.job_record;
}

void ota_bt_enter(void)
{
	fake.enters++;
	fake.ota = OTA_BLUETOOTH;
}

void ota_bt_leave(void)
{
	fake.leaves++;
	if (fake.ota == OTA_BLUETOOTH) {
		fake.ota = OTA_IDLE;
	}
}

int ota_bt_confirm(void)
{
	fake.confirms++;
	op("confirm");
	if (fake.confirm_result == 0) {
		fake.ota = OTA_IDLE;
	}
	return fake.confirm_result;
}

int store_read(enum store_id id, void *data, size_t size)
{
	if (id != STORE_BT_OTA_RECORD || size != sizeof(struct bt_ota_record)) {
		return -EINVAL;
	}

	if (!fake.stored) {
		return -ENOENT;
	}

	memcpy(data, &fake.stored_record, size);
	return 0;
}

int store_write(enum store_id id, const void *data, size_t size)
{
	if (id != STORE_BT_OTA_RECORD || size != sizeof(struct bt_ota_record)) {
		return -EINVAL;
	}

	fake.store_writes++;
	op("store_write");
	if (fake.store_write_result == 0) {
		memcpy(&fake.stored_record, data, size);
		fake.stored = true;
	}
	return fake.store_write_result;
}

/* ---- Bluetooth -------------------------------------------------------------------- */

int bt_enable(bt_ready_cb_t cb)
{
	fake.enables++;
	fake.ready_callback = cb;
	return fake.enable_result;
}

int bt_le_adv_start(const void *param, const struct bt_data *ad, size_t ad_len,
		    const struct bt_data *sd, size_t sd_len)
{
	ARG_UNUSED(param);
	ARG_UNUSED(ad);
	ARG_UNUSED(ad_len);
	ARG_UNUSED(sd);
	ARG_UNUSED(sd_len);

	fake.adv_starts++;
	if (fake.advertising) {
		return -EALREADY;
	}
	fake.advertising = 1;
	return 0;
}

int bt_le_adv_stop(void)
{
	fake.advertising = 0;
	return 0;
}

int bt_rand(void *buf, size_t len)
{
	memset(buf, 0xab, len);
	return 0;
}

/* As the real one: a second set of callbacks is refused. */
int bt_conn_auth_cb_register(const struct bt_conn_auth_cb *cb)
{
	if (fake.auth != NULL) {
		return -EALREADY;
	}

	fake.auth = cb;
	return 0;
}

int bt_conn_auth_info_cb_register(struct bt_conn_auth_info_cb *cb)
{
	if (fake.auth_info != NULL) {
		return -EALREADY;
	}

	fake.auth_info = cb;
	return 0;
}

int bt_conn_disconnect(struct bt_conn *conn, uint8_t reason)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(reason);
	fake.disconnects++;
	return fake.disconnect_result;
}

int bt_conn_set_security(struct bt_conn *conn, bt_security_t level)
{
	ARG_UNUSED(conn);
	CHECK(level == BT_SECURITY_L4);
	return fake.set_security_result;
}

int bt_conn_get_info(const struct bt_conn *conn, struct bt_conn_info *info)
{
	ARG_UNUSED(conn);
	*info = fake.info;
	return 0;
}

void bt_conn_foreach(int type, void (*func)(struct bt_conn *conn, void *data), void *data)
{
	ARG_UNUSED(type);
	if (fake.connected) {
		func(&phone, data);
	}
}

/* ---- MCUmgr and the bootloader ------------------------------------------------------ */

void mgmt_callback_register(struct mgmt_callback *callback)
{
	CHECK(fake.hook_count < (int)ARRAY_SIZE(fake.hooks));
	fake.hooks[fake.hook_count++] = callback;
}

/* As mgmt_callback_notify() does it: only what asked for this very event hears it. */
static enum mgmt_cb_return notify(uint32_t event, void *data, size_t size, int32_t *rc)
{
	enum mgmt_cb_return result = MGMT_CB_OK;

	*rc = MGMT_ERR_EOK;

	for (int i = 0; i < fake.hook_count; i++) {
		const struct mgmt_callback *hook = fake.hooks[i];
		uint16_t group = 0;
		bool abort_more = false;
		int32_t hook_rc = *rc;

		if (MGMT_EVT_GET_GROUP(hook->event_id) != MGMT_EVT_GET_GROUP(event) ||
		    (MGMT_EVT_GET_ID(event) & MGMT_EVT_GET_ID(hook->event_id)) !=
			    MGMT_EVT_GET_ID(event)) {
			continue;
		}

		if (hook->callback(event, result, &hook_rc, &group, &abort_more, data, size) !=
			    MGMT_CB_OK &&
		    result == MGMT_CB_OK) {
			result = MGMT_CB_ERROR_RC;
			*rc = hook_rc;
		}
	}

	return result;
}

void img_mgmt_reset_upload(void)
{
	fake.upload_resets++;
	op("reset_upload");
}

int img_mgmt_read_info(int image_slot, struct image_version *ver, uint8_t *hash, uint32_t *flags)
{
	ARG_UNUSED(ver);
	ARG_UNUSED(flags);
	CHECK(image_slot == SECONDARY_SLOT);
	memset(hash, 0x5a, IMAGE_SHA_LEN);
	return fake.info_result;
}

int boot_read_bank_header(uint8_t area_id, struct mcuboot_img_header *header, size_t header_size)
{
	ARG_UNUSED(area_id);
	ARG_UNUSED(header_size);

	header->mcuboot_version = fake.header_version;
	header->h.v1.sem_ver.major = fake.slot_version.major;
	header->h.v1.sem_ver.minor = fake.slot_version.minor;
	header->h.v1.sem_ver.revision = fake.slot_version.revision;
	header->h.v1.sem_ver.build_num = fake.slot_version.build;
	return fake.header_result;
}

int mcuboot_swap_type_multi(int image_index)
{
	CHECK(image_index == 0);
	return fake.swap_type;
}

int boot_request_upgrade_multi(int image_index, int permanent)
{
	CHECK(image_index == 0);
	fake.requests++;
	fake.request_permanent = permanent;
	op("request_swap");
	return fake.request_result;
}

int boot_erase_img_bank(uint8_t area_id)
{
	ARG_UNUSED(area_id);
	fake.erases++;
	op("erase");
	return 0;
}

static void fresh_board(void)
{
	memset(&fake, 0, sizeof(fake));
	fake.has_settings = true;
	fake.has_network = true;
	fake.ota = OTA_IDLE;
	fake.swap_type = BOOT_SWAP_TYPE_NONE;
	fake.header_version = 1;
	fake.slot_version = (struct fw_version){ RUNNING_MAJOR, RUNNING_MINOR + 1, 0, 0 };
	fake.info.security.enc_key_size = KEY_SIZE_REQUIRED;
	fake.info.security.flags = BT_SECURITY_FLAG_SC;
	fake.uptime_ms = 100000;

	memset(&window, 0, sizeof(window));
	memset(&record, 0, sizeof(record));
	memset(&offered, 0, sizeof(offered));
	have_record = false;
	bluetooth_trial = false;
	enabled = false;
	controller_failed = false;
	report_waiting = false;
	last_proof = BT_OTA_PROVED;
	name[0] = '\0';
	atomic_set(&gate, 0);
	atomic_set(&ready, 0);
	atomic_set(&start_failed, 0);
	atomic_set(&connected, 0);
	atomic_set(&secure, 0);
	atomic_set(&to_say, 0);
	atomic_set(&passkey_to_say, 0);
	reset_link_state();

	for (int i = 0; i < boot_function_count; i++) {
		(void)boot_functions[i]();
	}
}

/* What the main loop gets to on its next event. */
static void run_what_was_posted(void)
{
	CHECK(fake.posted_function != NULL);
	if (fake.posted_function != NULL) {
		fake.posted_function();
	}
}

/* ---- the phone and the person -------------------------------------------------------- */

static void hold_button_1(void)
{
	CHECK(bt_ota_on_button(APP_BUTTON_1, true, true));
}

static void open_by_hand(void)
{
	hold_button_1();
	CHECK(window.phase == BT_OTA_OPEN);
	on_bt_ready(0);
}

static void phone_connects(void)
{
	fake.connected = true;
	connection_callbacks.connected(&phone, 0);
}

static void phone_leaves(void)
{
	fake.connected = false;
	connection_callbacks.disconnected(&phone, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
}

/*
 * Without callbacks that can show a passkey and hear of a failure, a host has nothing to pair with
 * at this security level.
 */
static void phone_pairs(void)
{
	bool can_pair = fake.auth != NULL && fake.auth->passkey_display != NULL &&
			fake.auth->cancel != NULL && fake.auth_info != NULL &&
			fake.auth_info->pairing_failed != NULL;

	phone_connects();
	if (can_pair) {
		CHECK(fake.auth->pairing_accept(&phone, NULL) == BT_SECURITY_ERR_SUCCESS);
		fake.auth->passkey_display(&phone, 123456);
	}
	connection_callbacks.security_changed(&phone, BT_SECURITY_L4,
					      can_pair ? BT_SECURITY_ERR_SUCCESS
						       : BT_SECURITY_ERR_AUTH_FAIL);
}

/* What MCUmgr does when a handler is done. */
static void command_done(uint16_t group, uint16_t id, int err)
{
	struct mgmt_evt_op_cmd_arg done = { .group = group, .id = id, .err = err };
	int32_t rc = 0;

	CHECK(notify(MGMT_EVT_OP_CMD_DONE, &done, sizeof(done), &rc) == MGMT_CB_OK);
}

/* What MCUmgr does with a command. Returns 0 if the handler got to run. */
static int command(uint16_t group, uint16_t id, uint8_t op_code)
{
	struct mgmt_evt_op_cmd_arg arg = { .group = group, .id = id, .op = op_code };
	int32_t rc = 0;

	if (notify(MGMT_EVT_OP_CMD_RECV, &arg, sizeof(arg), &rc) != MGMT_CB_OK) {
		CHECK(rc == MGMT_ERR_EACCESSDENIED);
		command_done(group, id, (int)rc);
		return (int)rc;
	}

	command_done(group, id, MGMT_ERR_EOK);
	return 0;
}

static int read_list(void)
{
	return command(MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_STATE, MGMT_OP_READ);
}

static void image_header(uint8_t *data, uint8_t major, uint8_t minor)
{
	const uint32_t magic = BT_OTA_IMAGE_MAGIC;

	memset(data, 0, BT_OTA_IMAGE_HEADER_LEN);
	memcpy(data, &magic, sizeof(magic));
	data[20] = major;
	data[21] = minor;
}

/* The hook on a piece of an upload. */
static int piece(const uint8_t *data, size_t len, size_t off, unsigned long long total,
		 uint32_t image)
{
	struct img_mgmt_upload_action action = { .size = total };
	struct img_mgmt_upload_req req = {
		.image = image,
		.off = off,
		.img_data = { .value = data, .len = len },
	};
	struct img_mgmt_upload_check check = { .action = &action, .req = &req };
	int32_t rc = 0;

	if (notify(MGMT_EVT_OP_IMG_MGMT_DFU_CHUNK, &check, sizeof(check), &rc) != MGMT_CB_OK) {
		CHECK(rc != 0);
		return (int)rc;
	}

	return 0;
}

static int first_piece(uint8_t major, uint8_t minor, unsigned long long total, uint32_t image)
{
	uint8_t data[BT_OTA_IMAGE_HEADER_LEN];

	image_header(data, major, minor);
	return piece(data, sizeof(data), 0, total, image);
}

static void upload_finishes(void)
{
	int32_t rc = 0;

	CHECK(notify(MGMT_EVT_OP_IMG_MGMT_DFU_PENDING, NULL, 0, &rc) == MGMT_CB_OK);
}

/* From a board at rest to an image waiting for a button. */
static void image_on_offer(void)
{
	open_by_hand();
	phone_pairs();
	bt_ota_on_tick();
	CHECK(window.phase == BT_OTA_LINKED);
	CHECK(command(MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_UPLOAD, MGMT_OP_WRITE) == 0);
	CHECK(first_piece(RUNNING_MAJOR, RUNNING_MINOR + 1, 700000, 0) == 0);
	upload_finishes();
	bt_ota_on_tick();
	CHECK(window.phase == BT_OTA_READY);
}

/* ---- what is wired up from the boot on --------------------------------------------------- */

static void test_the_hooks_are_on_from_the_boot_on(void)
{
	/* Through SYS_INIT alone: nothing has been pressed, and Bluetooth is not even on. */
	fresh_board();
	CHECK(fake.hook_count == 2);
	CHECK(fake.enables == 0);

	/* So a command that came in at this point would be refused, not run. */
	CHECK(read_list() != 0);
	CHECK(command(MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_UPLOAD, MGMT_OP_WRITE) != 0);
	CHECK(first_piece(RUNNING_MAJOR, RUNNING_MINOR + 1, 700000, 0) != 0);
}

static void test_every_event_reaches_a_hook_that_asked_for_it(void)
{
	static const uint32_t events[] = {
		MGMT_EVT_OP_CMD_RECV,
		MGMT_EVT_OP_CMD_DONE,
		MGMT_EVT_OP_IMG_MGMT_DFU_CHUNK,
		MGMT_EVT_OP_IMG_MGMT_DFU_PENDING,
	};

	fresh_board();

	for (size_t i = 0; i < ARRAY_SIZE(events); i++) {
		int hearing = 0;

		for (int hook = 0; hook < fake.hook_count; hook++) {
			hearing += MGMT_EVT_GET_GROUP(fake.hooks[hook]->event_id) ==
					   MGMT_EVT_GET_GROUP(events[i]) &&
				   (MGMT_EVT_GET_ID(fake.hooks[hook]->event_id) &
				    MGMT_EVT_GET_ID(events[i])) != 0;
		}

		CHECK(hearing == 1);
	}
}

/* ---- nothing without a person --------------------------------------------------------- */

static void test_only_a_real_press_opens_a_window(void)
{
	fresh_board();

	/* What the console's BUTTON command sends: the path of a button, and no button. */
	CHECK(!bt_ota_on_button(APP_BUTTON_1, false, false));
	CHECK(!bt_ota_on_button(APP_BUTTON_1, true, false));
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(fake.enables == 0);
	CHECK(fake.enters == 0);

	/* A short press is what a person does when an update is on offer. */
	CHECK(!bt_ota_on_button(APP_BUTTON_1, false, true));
	/* Holding Button 2 is the factory reset, and it stays that. */
	CHECK(!bt_ota_on_button(APP_BUTTON_2, true, true));
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(fake.enables == 0);

	hold_button_1();
	CHECK(window.phase == BT_OTA_OPEN);
	CHECK(fake.enables == 1);
	CHECK(fake.enters == 1);
}

static void test_a_tick_on_a_closed_board_does_nothing_on_the_air(void)
{
	fresh_board();

	for (int second = 0; second < 300; second++) {
		bt_ota_on_tick();
	}

	CHECK(fake.enables == 0);
	CHECK(fake.adv_starts == 0);
}

static void test_a_console_press_cannot_install_or_erase(void)
{
	fresh_board();
	image_on_offer();

	CHECK(!bt_ota_on_button(APP_BUTTON_1, false, false));
	CHECK(!bt_ota_on_button(APP_BUTTON_2, false, false));
	CHECK(window.phase == BT_OTA_READY);
	CHECK(fake.requests == 0);
	CHECK(fake.erases == 0);
}

static void test_refusals_are_said_and_leave_nothing_open(void)
{
	fresh_board();
	fake.factory = true;
	hold_button_1();
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(strstr(fake.console, "factory mode") != NULL);
	CHECK(fake.enables == 0);

	fresh_board();
	fake.has_network = false;
	hold_button_1();
	CHECK(window.phase == BT_OTA_CLOSED);

	fresh_board();
	fake.job_record = true;
	hold_button_1();
	CHECK(window.phase == BT_OTA_CLOSED);

	fresh_board();
	fake.ota = OTA_DOWNLOADING;
	hold_button_1();
	CHECK(window.phase == BT_OTA_CLOSED);

	/* The update manager did not start, and the bootloader has a revert coming. */
	fresh_board();
	fake.swap_type = BOOT_SWAP_TYPE_TEST;
	hold_button_1();
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(fake.enables == 0);
}

static void test_a_failed_start_of_the_controller_closes_the_window(void)
{
	fresh_board();
	hold_button_1();
	CHECK(window.phase == BT_OTA_OPEN);
	CHECK(fake.ota == OTA_BLUETOOTH);

	/* bt_enable() came back fine, and the controller did not answer after that. */
	on_bt_ready(-EIO);
	bt_ota_on_tick();
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(window.closed == BT_OTA_CLOSED_NO_CONTROLLER);
	CHECK(fake.ota == OTA_IDLE);
	CHECK(fake.leaves == 1);
	CHECK(fake.adv_starts == 0);
	CHECK(fake.erases == 0);
	CHECK(controller_failed);
	CHECK(atomic_get(&gate) == 0);
	CHECK(strstr(fake.console, "debug port") != NULL);

	/* And it is not tried again. */
	CHECK(bt_ota_on_button(APP_BUTTON_1, true, true));
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(fake.enables == 1);
	CHECK(fake.enters == 1);
}

static void test_the_failed_start_of_a_closed_window_still_counts(void)
{
	fresh_board();
	hold_button_1();
	CHECK(bt_ota_on_button(APP_BUTTON_2, false, true));
	CHECK(window.phase == BT_OTA_CLOSED);

	on_bt_ready(-EIO);
	bt_ota_on_tick();
	CHECK(controller_failed);
	CHECK(fake.leaves == 1);
}

static void test_a_phone_from_the_last_window_gets_no_way_into_the_next(void)
{
	fresh_board();
	open_by_hand();
	phone_pairs();
	CHECK(read_list() == 0);

	/* The host cannot disconnect it now: out of buffers, say. */
	fake.disconnect_result = -ENOBUFS;
	CHECK(bt_ota_on_button(APP_BUTTON_2, false, true));
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(atomic_get(&connected) == 1);
	CHECK(atomic_get(&secure) == 0);
	CHECK(read_list() != 0);

	/* It is not forgotten: the tick keeps at it, and a new window has to wait. */
	fake.disconnects = 0;
	bt_ota_on_tick();
	CHECK(fake.disconnects == 1);
	fake.console[0] = '\0';
	hold_button_1();
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(strstr(fake.console, "has not gone yet") != NULL);
	CHECK(fake.enters == 1);

	/* It goes, and a new window takes a new pairing. */
	fake.disconnect_result = 0;
	bt_ota_on_tick();
	CHECK(fake.disconnects == 2);
	phone_leaves();
	bt_ota_on_tick();
	CHECK(fake.disconnects == 2);
	hold_button_1();
	CHECK(window.phase == BT_OTA_OPEN);
	CHECK(read_list() != 0);
	CHECK(command(MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_UPLOAD, MGMT_OP_WRITE) != 0);
}

static void test_button_1_on_a_cloud_update_on_offer_stays_what_it_was(void)
{
	fresh_board();
	fake.ota = OTA_AWAITING_USER;

	/* Not for this module, however long it was held: ota_on_button() takes it. */
	CHECK(!bt_ota_on_button(APP_BUTTON_1, true, true));
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(fake.enables == 0);
}

static void test_a_network_core_without_a_controller_is_said_once_and_harmless(void)
{
	fresh_board();
	fake.enable_result = -ETIMEDOUT;

	CHECK(bt_ota_on_button(APP_BUTTON_1, true, true));
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(fake.enters == 0);
	CHECK(fake.ota == OTA_IDLE);
	CHECK(strstr(fake.console, "debug port") != NULL);

	/* bt_enable() cannot be called again after a failure. */
	CHECK(bt_ota_on_button(APP_BUTTON_1, true, true));
	CHECK(fake.enables == 1);
	CHECK(window.phase == BT_OTA_CLOSED);
}

/* ---- the window ----------------------------------------------------------------------- */

static void test_it_advertises_for_the_window_and_then_stops(void)
{
	fresh_board();
	open_by_hand();

	for (int second = 1; second < CONFIG_APP_BT_OTA_WINDOW_SECONDS; second++) {
		bt_ota_on_tick();
		CHECK(fake.advertising == 1);
		CHECK(window.phase == BT_OTA_OPEN);
	}
	CHECK(strstr(fake.console, "advertising as Cranium-ABAB") != NULL);

	bt_ota_on_tick();
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(fake.advertising == 0);
	CHECK(atomic_get(&gate) == 0);
	CHECK(fake.leaves == 1);
	CHECK(fake.ota == OTA_IDLE);
	CHECK(fake.erases == 0);
	/* Or a later upload of the same file would carry on where this one stopped. */
	CHECK(fake.upload_resets == 1);

	for (int second = 0; second < 300; second++) {
		bt_ota_on_tick();
	}
	CHECK(fake.advertising == 0);
}

static void test_it_waits_for_the_controller_before_advertising(void)
{
	fresh_board();
	hold_button_1();

	bt_ota_on_tick();
	CHECK(fake.adv_starts == 0);

	on_bt_ready(0);
	bt_ota_on_tick();
	CHECK(fake.adv_starts == 1);
}

static void test_a_late_connection_is_turned_away(void)
{
	fresh_board();
	phone_connects();
	CHECK(fake.disconnects == 1);
	CHECK(atomic_get(&connected) == 0);
}

static void test_pairing_is_only_accepted_while_open(void)
{
	fresh_board();
	open_by_hand();
	CHECK(fake.auth->pairing_accept(&phone, NULL) == BT_SECURITY_ERR_SUCCESS);

	CHECK(bt_ota_on_button(APP_BUTTON_2, false, true));
	CHECK(fake.auth->pairing_accept(&phone, NULL) == BT_SECURITY_ERR_PAIR_NOT_ALLOWED);
}

static void test_the_callbacks_are_registered_once_for_a_display_and_no_keyboard(void)
{
	fresh_board();
	CHECK(fake.auth == NULL);
	CHECK(fake.auth_info == NULL);

	open_by_hand();
	CHECK(fake.auth != NULL);
	CHECK(fake.auth_info != NULL);
	CHECK(fake.auth->passkey_display != NULL);
	CHECK(fake.auth->cancel != NULL);
	CHECK(fake.auth->pairing_accept != NULL);
	CHECK(fake.auth_info->pairing_failed != NULL);

	/* The next window does not ask again, which the host would refuse. */
	CHECK(bt_ota_on_button(APP_BUTTON_2, false, true));
	open_by_hand();
	CHECK(fake.enables == 1);
	CHECK(window.phase == BT_OTA_OPEN);
}

static void test_a_passkey_comes_out_on_the_main_loop(void)
{
	fresh_board();
	open_by_hand();
	phone_connects();
	fake.console[0] = '\0';
	fake.calls_posted = 0;

	/* This can come from the small thread that works out the keys: it must not print there. */
	fake.auth->passkey_display(&phone, 7);
	CHECK(fake.console[0] == '\0');
	CHECK(fake.calls_posted == 1);

	run_what_was_posted();
	CHECK(strstr(fake.console, "[BT] passkey 000007\n") != NULL);

	/* Said once, and not kept. */
	fake.console[0] = '\0';
	run_what_was_posted();
	CHECK(fake.console[0] == '\0');
	CHECK(atomic_get(&passkey_to_say) == 0);
}

static void test_a_full_queue_only_makes_it_wait_for_the_tick(void)
{
	fresh_board();
	open_by_hand();
	phone_connects();
	fake.console[0] = '\0';

	fake.event_queue_full = true;
	fake.auth->passkey_display(&phone, 999999);
	CHECK(fake.console[0] == '\0');
	bt_ota_on_tick();
	CHECK(strstr(fake.console, "[BT] passkey 999999\n") != NULL);
}

static void test_the_bluetooth_threads_do_not_print(void)
{
	fresh_board();
	open_by_hand();
	bt_ota_on_tick();
	fake.console[0] = '\0';

	fake.connected = true;
	connection_callbacks.connected(&phone, 0);
	connection_callbacks.security_changed(&phone, BT_SECURITY_L4, BT_SECURITY_ERR_SUCCESS);
	fake.auth->cancel(&phone);
	fake.auth_info->pairing_failed(&phone, BT_SECURITY_ERR_AUTH_FAIL);
	phone_leaves();
	CHECK(fake.console[0] == '\0');

	bt_ota_on_tick();
	CHECK(strstr(fake.console, "a phone connected") != NULL);
	CHECK(strstr(fake.console, "paired") != NULL);
	CHECK(strstr(fake.console, "pairing cancelled") != NULL);
	CHECK(strstr(fake.console, "pairing failed: 1") != NULL);
	CHECK(strstr(fake.console, "the phone is gone: reason 0x13") != NULL);
}

static void test_three_failed_pairings_close_it(void)
{
	fresh_board();
	open_by_hand();

	for (int attempt = 0; attempt < BT_OTA_MAX_FAILED_PAIRINGS; attempt++) {
		phone_connects();
		fake.auth_info->pairing_failed(&phone, BT_SECURITY_ERR_AUTH_FAIL);
		phone_leaves();
	}

	bt_ota_on_tick();
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(strstr(fake.console, "too many failed pairings") != NULL);
}

static void test_a_new_window_starts_with_a_clean_count(void)
{
	fresh_board();
	open_by_hand();
	fake.auth_info->pairing_failed(&phone, BT_SECURITY_ERR_AUTH_FAIL);
	fake.auth_info->pairing_failed(&phone, BT_SECURITY_ERR_AUTH_FAIL);
	fake.auth_info->pairing_failed(&phone, BT_SECURITY_ERR_AUTH_FAIL);
	bt_ota_on_tick();
	CHECK(window.phase == BT_OTA_CLOSED);

	open_by_hand();
	bt_ota_on_tick();
	CHECK(window.phase == BT_OTA_OPEN);
}

static void test_button_2_closes_it_and_a_link_goes_with_it(void)
{
	fresh_board();
	open_by_hand();
	phone_pairs();

	CHECK(bt_ota_on_button(APP_BUTTON_2, false, true));
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(fake.disconnects == 1);
	CHECK(fake.erases == 0);
	CHECK(fake.ota == OTA_IDLE);
}

/* ---- the link ------------------------------------------------------------------------- */

static void test_only_a_full_strength_link_counts(void)
{
	fresh_board();
	open_by_hand();
	phone_connects();

	/* Encrypted and authenticated, but not LE Secure Connections. */
	connection_callbacks.security_changed(&phone, BT_SECURITY_L3, BT_SECURITY_ERR_SUCCESS);
	CHECK(atomic_get(&secure) == 0);
	CHECK(fake.disconnects == 1);

	fake.info.security.flags = 0;
	connection_callbacks.security_changed(&phone, BT_SECURITY_L4, BT_SECURITY_ERR_SUCCESS);
	CHECK(atomic_get(&secure) == 0);
	CHECK(fake.disconnects == 2);

	/* A short key. */
	fake.info.security.flags = BT_SECURITY_FLAG_SC;
	fake.info.security.enc_key_size = 7;
	connection_callbacks.security_changed(&phone, BT_SECURITY_L4, BT_SECURITY_ERR_SUCCESS);
	CHECK(atomic_get(&secure) == 0);
	CHECK(fake.disconnects == 3);

	fake.info.security.enc_key_size = KEY_SIZE_REQUIRED;
	connection_callbacks.security_changed(&phone, BT_SECURITY_L4, BT_SECURITY_ERR_AUTH_FAIL);
	CHECK(atomic_get(&secure) == 0);
	CHECK(fake.disconnects == 4);

	connection_callbacks.security_changed(&phone, BT_SECURITY_L4, BT_SECURITY_ERR_SUCCESS);
	CHECK(atomic_get(&secure) == 1);
	CHECK(fake.disconnects == 4);
}

static void test_a_link_that_cannot_ask_for_security_is_dropped(void)
{
	fresh_board();
	open_by_hand();
	fake.set_security_result = -EIO;
	phone_connects();
	CHECK(fake.disconnects == 1);
}

static void test_a_new_connection_starts_with_nothing(void)
{
	fresh_board();
	open_by_hand();

	/* Whatever is left, a connection has to pair for itself. */
	atomic_set(&secure, 1);
	phone_connects();
	CHECK(atomic_get(&secure) == 0);
	CHECK(read_list() != 0);
}

static void test_security_that_gets_lost_is_gone(void)
{
	fresh_board();
	open_by_hand();
	phone_pairs();
	CHECK(atomic_get(&secure) == 1);
	CHECK(fake.disconnects == 0);

	connection_callbacks.security_changed(&phone, BT_SECURITY_L4, BT_SECURITY_ERR_AUTH_FAIL);
	CHECK(atomic_get(&secure) == 0);
	CHECK(fake.disconnects == 1);
	CHECK(read_list() != 0);
}

static void test_a_link_goes_when_the_phone_does(void)
{
	fresh_board();
	open_by_hand();
	phone_pairs();
	CHECK(atomic_get(&secure) == 1);
	phone_leaves();
	CHECK(atomic_get(&secure) == 0);
	CHECK(read_list() != 0);
}

/* ---- commands ------------------------------------------------------------------------- */

static void test_every_command_needs_the_link(void)
{
	fresh_board();
	CHECK(read_list() != 0);

	open_by_hand();
	CHECK(read_list() != 0);
	CHECK(command(MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_UPLOAD, MGMT_OP_WRITE) != 0);

	phone_connects();
	CHECK(read_list() != 0);

	connection_callbacks.security_changed(&phone, BT_SECURITY_L4, BT_SECURITY_ERR_SUCCESS);
	CHECK(read_list() == 0);
	CHECK(command(MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_UPLOAD, MGMT_OP_WRITE) == 0);
}

static void test_a_phone_can_ask_for_no_swap_no_confirm_and_no_erase(void)
{
	fresh_board();
	open_by_hand();
	phone_pairs();

	CHECK(command(MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_STATE, MGMT_OP_WRITE) != 0);
	CHECK(command(MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_ERASE, MGMT_OP_WRITE) != 0);
	CHECK(fake.requests == 0);
	CHECK(fake.erases == 0);
}

static void test_a_refusal_is_an_answer_and_only_a_good_answer_counts_as_a_read(void)
{
	fresh_board();
	open_by_hand();
	phone_pairs();

	/* Refused: the handler does not run, and MCUmgr says done with that error. */
	CHECK(command(MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_STATE, MGMT_OP_WRITE) ==
	      MGMT_ERR_EACCESSDENIED);
	CHECK(atomic_get(&list_reads) == 0);

	/* A handler that failed. */
	command_done(MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_STATE, MGMT_ERR_EBADSTATE);
	CHECK(atomic_get(&list_reads) == 0);

	/* Another command of this group, or the same number in another group. */
	command_done(MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_UPLOAD, MGMT_ERR_EOK);
	CHECK(atomic_get(&list_reads) == 0);
	command_done(MGMT_GROUP_ID_IMAGE + 1, IMG_MGMT_ID_STATE, MGMT_ERR_EOK);
	CHECK(atomic_get(&list_reads) == 0);

	command_done(MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_STATE, MGMT_ERR_EOK);
	CHECK(atomic_get(&list_reads) == 1);
}

static void test_a_closed_window_shuts_the_gate_on_a_link_still_up(void)
{
	fresh_board();
	open_by_hand();
	phone_pairs();
	CHECK(read_list() == 0);

	/* The disconnection has not come back yet, and the link no longer counts. */
	CHECK(bt_ota_on_button(APP_BUTTON_2, false, true));
	CHECK(atomic_get(&secure) == 0);
	CHECK(read_list() != 0);

	/* The gate does not lean on that: a late word from the host changes nothing. */
	atomic_set(&secure, 1);
	CHECK(read_list() != 0);
	CHECK(command(MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_UPLOAD, MGMT_OP_WRITE) != 0);
}

/* ---- uploads -------------------------------------------------------------------------- */

static void test_what_may_not_be_uploaded_is_refused_at_the_first_piece(void)
{
	fresh_board();
	open_by_hand();
	phone_pairs();

	CHECK(first_piece(RUNNING_MAJOR, RUNNING_MINOR, 700000, 0) != 0);
	CHECK(strstr(fake.console, "not newer") != NULL);
	CHECK(first_piece(RUNNING_MAJOR, RUNNING_MINOR + 1, 700000, 1) != 0);
	/* A file that reaches the trailer could bring its own swap request. */
	CHECK(first_piece(RUNNING_MAJOR, RUNNING_MINOR + 1, MAX_UPLOAD + 1, 0) != 0);
	CHECK(first_piece(RUNNING_MAJOR, RUNNING_MINOR + 1, MAX_UPLOAD, 0) == 0);
}

static void test_a_later_piece_is_not_taken_for_a_header(void)
{
	static const uint8_t middle_of_a_file[64];

	fresh_board();
	open_by_hand();
	phone_pairs();
	CHECK(first_piece(RUNNING_MAJOR, RUNNING_MINOR + 1, 700000, 0) == 0);

	/* It is checked once, at offset 0. Anything else would fail on this one. */
	fake.console[0] = '\0';
	CHECK(piece(middle_of_a_file, sizeof(middle_of_a_file), 4096, 700000, 0) == 0);
	CHECK(strstr(fake.console, "refused") == NULL);
	CHECK(strstr(fake.console, "upload started") == NULL);
}

static void test_a_piece_that_got_past_the_gate_stops_at_the_upload_hook(void)
{
	fresh_board();
	open_by_hand();
	phone_pairs();

	/* The command got through, and then the window shut before the handler got this far. */
	CHECK(command(MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_UPLOAD, MGMT_OP_WRITE) == 0);
	CHECK(bt_ota_on_button(APP_BUTTON_2, false, true));
	CHECK(first_piece(RUNNING_MAJOR, RUNNING_MINOR + 1, 700000, 0) == MGMT_ERR_EACCESSDENIED);

	/* The same goes for one in the middle of a file, and for a proof window. */
	CHECK(piece((const uint8_t *)"x", 1, 4096, 700000, 0) == MGMT_ERR_EACCESSDENIED);
}

static void test_when_it_has_arrived_nothing_more_goes_in(void)
{
	fresh_board();
	image_on_offer();

	CHECK(command(MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_UPLOAD, MGMT_OP_WRITE) != 0);
	CHECK(first_piece(RUNNING_MAJOR, RUNNING_MINOR + 1, 700000, 0) != 0);
	CHECK(read_list() == 0);
}

static void test_it_is_offered_and_says_what_it_is(void)
{
	fresh_board();
	image_on_offer();

	CHECK(strstr(fake.console, "firmware 0.1.0+0 has arrived, hash 5a5a5a5a5a5a5a5a") != NULL);
	CHECK(fake.requests == 0);
	CHECK(fake.reboots == 0);
	CHECK(fake.store_writes == 0);
	CHECK(fake.advertising == 0);
}

static void offered_but_no_good(int swap_type_by_then)
{
	open_by_hand();
	phone_pairs();
	bt_ota_on_tick();
	fake.swap_type = swap_type_by_then;
	upload_finishes();
	bt_ota_on_tick();
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(fake.erases == 1);
	CHECK(fake.requests == 0);
	CHECK(strstr(fake.console, "cannot be installed") != NULL);
	CHECK(fake.ota == OTA_IDLE);
}

static void test_what_arrived_is_looked_at_again_before_it_is_offered(void)
{
	fresh_board();
	fake.header_result = -EIO;
	offered_but_no_good(BOOT_SWAP_TYPE_NONE);

	fresh_board();
	fake.header_version = 2;
	offered_but_no_good(BOOT_SWAP_TYPE_NONE);

	fresh_board();
	fake.info_result = -EIO;
	offered_but_no_good(BOOT_SWAP_TYPE_NONE);

	fresh_board();
	fake.slot_version = (struct fw_version){ RUNNING_MAJOR, RUNNING_MINOR, 0, 0 };
	offered_but_no_good(BOOT_SWAP_TYPE_NONE);

	/* Something has asked for a swap, and it was not this firmware. */
	fresh_board();
	offered_but_no_good(BOOT_SWAP_TYPE_TEST);
}

/* ---- installing ------------------------------------------------------------------------ */

static void test_button_1_records_then_asks_for_a_trial_then_restarts(void)
{
	fresh_board();
	image_on_offer();
	fake.ops[0] = '\0';

	CHECK(bt_ota_on_button(APP_BUTTON_1, false, true));

	CHECK(strcmp(fake.ops, "store_write request_swap cloud_disconnect log_panic reboot ") == 0);
	CHECK(fake.request_permanent == BOOT_UPGRADE_TEST);
	CHECK(fake.stored);
	CHECK(fake.stored_record.magic == BT_OTA_RECORD_MAGIC);
	CHECK(fake.stored_record.phase == BT_OTA_RECORD_ARMED);
	CHECK(fake.stored_record.count == 1);
	CHECK(fake.stored_record.target.minor == RUNNING_MINOR + 1);
	CHECK(fake.stored_record.from.minor == RUNNING_MINOR);
	CHECK(fake.stored_record.hash[0] == 0x5a);
	CHECK(strstr(fake.console, "restarting into the bootloader: 0.1.0+0 from 0.0.0+0") != NULL);
}

static void test_the_count_goes_on(void)
{
	fresh_board();
	fake.stored = true;
	fake.stored_record = (struct bt_ota_record){
		.magic = BT_OTA_RECORD_MAGIC,
		.phase = BT_OTA_RECORD_DONE,
		.result = BT_OTA_RESULT_SUCCEEDED,
		.count = 4,
	};
	bt_ota_on_boot(false, true, false);
	image_on_offer();
	CHECK(bt_ota_on_button(APP_BUTTON_1, false, true));
	CHECK(fake.stored_record.count == 5);
}

static void test_a_swap_request_of_its_own_stops_the_install(void)
{
	fresh_board();
	image_on_offer();

	fake.swap_type = BOOT_SWAP_TYPE_TEST;
	CHECK(bt_ota_on_button(APP_BUTTON_1, false, true));
	CHECK(fake.requests == 0);
	CHECK(fake.reboots == 0);
	CHECK(fake.erases == 1);
	CHECK(window.phase == BT_OTA_CLOSED);
}

static void test_nothing_is_installed_without_a_record(void)
{
	fresh_board();
	image_on_offer();

	fake.store_write_result = -EIO;
	CHECK(bt_ota_on_button(APP_BUTTON_1, false, true));
	CHECK(fake.requests == 0);
	CHECK(fake.reboots == 0);
	CHECK(fake.erases == 1);
	CHECK(window.phase == BT_OTA_CLOSED);
}

static void test_a_refused_swap_is_said_and_recorded(void)
{
	fresh_board();
	image_on_offer();

	fake.request_result = -EIO;
	CHECK(bt_ota_on_button(APP_BUTTON_1, false, true));
	CHECK(fake.reboots == 0);
	CHECK(fake.erases == 1);
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(fake.stored_record.phase == BT_OTA_RECORD_DONE);
	CHECK(fake.stored_record.result == BT_OTA_RESULT_FLASH_ERROR);
	CHECK(fake.stored_record.target.minor == RUNNING_MINOR + 1);
	CHECK(fake.stored_record.count == 1);
}

static void test_button_2_erases_the_image(void)
{
	fresh_board();
	image_on_offer();

	CHECK(bt_ota_on_button(APP_BUTTON_2, false, true));
	CHECK(fake.erases == 1);
	CHECK(fake.requests == 0);
	CHECK(fake.reboots == 0);
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(fake.ota == OTA_IDLE);
	/* It never got as far as the record. */
	CHECK(!fake.stored);
}

static void test_what_the_policy_says_to_erase_is_erased(void)
{
	/* It has seen the image arrive: that does not hang on the flag still being up. */
	fresh_board();
	image_on_offer();
	atomic_set(&upload_done, 0);
	CHECK(bt_ota_on_button(APP_BUTTON_2, false, true));
	CHECK(fake.erases == 1);
}

static void test_an_offer_nobody_takes_is_erased(void)
{
	fresh_board();
	image_on_offer();

	for (int second = 0; second <= BT_OTA_OFFER_SECONDS; second++) {
		bt_ota_on_tick();
	}

	CHECK(fake.erases == 1);
	CHECK(fake.requests == 0);
	CHECK(window.phase == BT_OTA_CLOSED);
}

static void arrived_with_no_tick_yet(void)
{
	open_by_hand();
	phone_pairs();
	bt_ota_on_tick();
	CHECK(first_piece(RUNNING_MAJOR, RUNNING_MINOR + 1, 700000, 0) == 0);
	upload_finishes();
	fake.ops[0] = '\0';
}

static void test_a_whole_image_does_not_stay_behind_a_closed_window(void)
{
	/* Button 2 in the very second it arrives, before the main loop has seen it. */
	fresh_board();
	arrived_with_no_tick_yet();
	CHECK(window.phase == BT_OTA_LINKED);
	CHECK(bt_ota_on_button(APP_BUTTON_2, false, true));
	CHECK(fake.erases == 1);
	/* After the lock that a piece being written holds, or that piece could finish it. */
	CHECK(strstr(fake.ops, "reset_upload erase") != NULL);
	CHECK(atomic_get(&upload_done) == 0);

	/* Nothing has arrived: nothing to erase, because what is there may be the way back. */
	fresh_board();
	open_by_hand();
	phone_pairs();
	CHECK(first_piece(RUNNING_MAJOR, RUNNING_MINOR + 1, 700000, 0) == 0);
	CHECK(bt_ota_on_button(APP_BUTTON_2, false, true));
	CHECK(fake.erases == 0);
}

static void test_an_image_that_arrives_late_gets_the_whole_offer(void)
{
	fresh_board();
	arrived_with_no_tick_yet();
	window.session_left = 0;
	bt_ota_on_tick();
	CHECK(window.phase == BT_OTA_READY);
	CHECK(fake.erases == 0);

	for (int second = 0; second < BT_OTA_OFFER_SECONDS; second++) {
		bt_ota_on_tick();
		CHECK(window.phase == BT_OTA_READY);
	}

	bt_ota_on_tick();
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(fake.erases == 1);
}

/* ---- after the restart ----------------------------------------------------------------- */

static void stored_record(enum bt_ota_record_phase phase, uint8_t target_minor)
{
	fake.stored = true;
	fake.stored_record = (struct bt_ota_record){
		.magic = BT_OTA_RECORD_MAGIC,
		.phase = phase,
		.count = 1,
		.from = { RUNNING_MAJOR, RUNNING_MINOR, 0, 0 },
		.target = { RUNNING_MAJOR, target_minor, 0, 0 },
	};
}

static void test_what_became_of_it_is_worked_out_and_recorded(void)
{
	/* The target runs, on trial. */
	fresh_board();
	stored_record(BT_OTA_RECORD_ARMED, RUNNING_MINOR);
	bt_ota_on_boot(true, true, false);
	CHECK(bluetooth_trial);
	CHECK(fake.stored_record.phase == BT_OTA_RECORD_TESTING);

	/* It started, and it is another image that runs now: the bootloader went back. */
	fresh_board();
	stored_record(BT_OTA_RECORD_TESTING, RUNNING_MINOR + 1);
	bt_ota_on_boot(false, true, false);
	CHECK(!bluetooth_trial);
	CHECK(fake.stored_record.phase == BT_OTA_RECORD_DONE);
	CHECK(fake.stored_record.result == BT_OTA_RESULT_ROLLED_BACK);
	CHECK(strstr(fake.console, "rolled_back") != NULL);

	/* It never started: a bad signature, for one. */
	fresh_board();
	stored_record(BT_OTA_RECORD_ARMED, RUNNING_MINOR + 1);
	bt_ota_on_boot(false, true, false);
	CHECK(fake.stored_record.result == BT_OTA_RESULT_NOT_INSTALLED);

	/* Confirmed, and restarted before the record said so. */
	fresh_board();
	stored_record(BT_OTA_RECORD_TESTING, RUNNING_MINOR);
	bt_ota_on_boot(false, true, false);
	CHECK(fake.stored_record.result == BT_OTA_RESULT_SUCCEEDED);

	/* No trailer: a golden image restore was cut off, and nothing proved this image. */
	fresh_board();
	stored_record(BT_OTA_RECORD_TESTING, RUNNING_MINOR);
	bt_ota_on_boot(false, false, false);
	CHECK(fake.stored_record.result == BT_OTA_RESULT_TRIAL_LOST);

	/* A cloud job has taken over: this record cannot be what is on trial. */
	fresh_board();
	stored_record(BT_OTA_RECORD_ARMED, RUNNING_MINOR);
	bt_ota_on_boot(true, true, true);
	CHECK(!bluetooth_trial);
	CHECK(fake.stored_record.result == BT_OTA_RESULT_SUPERSEDED);
}

static void test_a_finished_record_is_only_told_again(void)
{
	fresh_board();
	stored_record(BT_OTA_RECORD_DONE, RUNNING_MINOR);
	fake.stored_record.result = BT_OTA_RESULT_SUCCEEDED;
	bt_ota_on_boot(false, true, false);
	CHECK(fake.store_writes == 0);
	CHECK(strstr(fake.console, "last update over Bluetooth") != NULL);
}

static void test_no_record_or_a_bad_one_is_nothing(void)
{
	fresh_board();
	bt_ota_on_boot(true, true, false);
	CHECK(!have_record);
	CHECK(!bluetooth_trial);

	fresh_board();
	stored_record(BT_OTA_RECORD_ARMED, RUNNING_MINOR);
	fake.stored_record.magic = 0;
	bt_ota_on_boot(true, true, false);
	CHECK(!have_record);
	CHECK(!bluetooth_trial);
}

/* ---- the trial ------------------------------------------------------------------------- */

static void on_bluetooth_trial(void)
{
	fresh_board();
	stored_record(BT_OTA_RECORD_ARMED, RUNNING_MINOR);
	bt_ota_on_boot(true, true, false);
	fake.ota = OTA_TESTING;
	fake.swap_type = BOOT_SWAP_TYPE_REVERT;
	fake.ops[0] = '\0';
	fake.console[0] = '\0';
}

/* The whole of a proof, ready for the last step. */
static void proof_up_to_the_list(void)
{
	open_by_hand();
	CHECK(window.proof_only);
	phone_pairs();
	bt_ota_on_tick();
	CHECK(window.phase == BT_OTA_LINKED);
}

static void test_nothing_is_confirmed_on_boot_or_by_itself(void)
{
	on_bluetooth_trial();
	fake.wifi_answered = true;

	for (int second = 0; second < 600; second++) {
		fake.uptime_ms += 1000;
		bt_ota_on_tick();
	}

	CHECK(fake.confirms == 0);
	CHECK(fake.enables == 0);
	CHECK(bluetooth_trial);
}

static void test_a_cloud_trial_cannot_be_proved_by_hand(void)
{
	fresh_board();
	fake.ota = OTA_TESTING;
	hold_button_1();
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(fake.enables == 0);
	CHECK(strstr(fake.console, "only the cloud") != NULL);
}

static void test_a_proof_window_is_not_a_way_in(void)
{
	on_bluetooth_trial();
	proof_up_to_the_list();

	/* The secondary slot holds the image to go back to. */
	CHECK(command(MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_UPLOAD, MGMT_OP_WRITE) != 0);
	CHECK(command(MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_ERASE, MGMT_OP_WRITE) != 0);
	CHECK(command(MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_STATE, MGMT_OP_WRITE) != 0);
	CHECK(fake.enters == 0);
	CHECK(fake.ota == OTA_TESTING);
}

static void test_a_person_proves_it_with_everything_in_place(void)
{
	on_bluetooth_trial();
	fake.wifi_answered = true;
	proof_up_to_the_list();

	/* A link alone is not it: the phone has to read the list over it. */
	bt_ota_on_tick();
	CHECK(fake.confirms == 0);

	CHECK(read_list() == 0);
	bt_ota_on_tick();
	CHECK(fake.confirms == 1);
	CHECK(!bluetooth_trial);
	CHECK(fake.stored_record.phase == BT_OTA_RECORD_DONE);
	CHECK(fake.stored_record.result == BT_OTA_RESULT_SUCCEEDED);
	CHECK(fake.stored_record.proof == BT_OTA_PROOF_BY_PERSON);
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(strstr(fake.console, "the trial is over") != NULL);
	/* The secondary slot holds the image that was replaced. */
	CHECK(fake.erases == 0);
}

static void test_closing_a_proof_window_never_erases_the_way_back(void)
{
	on_bluetooth_trial();
	proof_up_to_the_list();

	/* It cannot come to this: uploads are refused here. If it did, the slot still stays. */
	atomic_set(&upload_done, 1);
	CHECK(bt_ota_on_button(APP_BUTTON_2, false, true));
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(fake.erases == 0);
}

static void test_the_proof_looks_at_the_link_and_the_board_itself(void)
{
	/* Reached directly: the window would have noticed first, and this does not lean on that. */
	on_bluetooth_trial();
	fake.wifi_answered = true;
	proof_up_to_the_list();
	CHECK(read_list() == 0);

	atomic_set(&secure, 0);
	try_proof();
	CHECK(fake.confirms == 0);
	atomic_set(&secure, 1);

	fake.has_network = false;
	try_proof();
	CHECK(fake.confirms == 0);
	fake.has_network = true;

	fake.uptime_ms = 1000;
	try_proof();
	CHECK(fake.confirms == 0);
	fake.uptime_ms = 100000;

	try_proof();
	CHECK(fake.confirms == 1);
}

static void test_not_too_soon(void)
{
	on_bluetooth_trial();
	fake.wifi_answered = true;
	fake.uptime_ms = 20000;
	proof_up_to_the_list();
	CHECK(read_list() == 0);

	while (fake.uptime_ms < CONFIG_APP_BT_OTA_TRIAL_MIN_SECONDS * 1000 - 1000) {
		bt_ota_on_tick();
		CHECK(fake.confirms == 0);
		fake.uptime_ms += 1000;
	}
	CHECK(strstr(fake.console, "not run for long enough") != NULL);

	fake.uptime_ms += 1000;
	bt_ota_on_tick();
	CHECK(fake.confirms == 1);
}

static void test_not_with_wifi_up(void)
{
	on_bluetooth_trial();
	fake.wifi_answered = true;
	fake.wifi_up = true;
	proof_up_to_the_list();
	CHECK(read_list() == 0);

	for (int second = 0; second < 60; second++) {
		bt_ota_on_tick();
	}

	CHECK(fake.confirms == 0);
	CHECK(strstr(fake.console, "it has to reach the cloud") != NULL);
}

static void test_not_while_associated_with_no_address(void)
{
	/* The IP stack or DHCP is what is broken: no L4 event, and so not "up" in net.c's sense. */
	on_bluetooth_trial();
	fake.wifi_answered = true;
	fake.wifi_associated = true;
	proof_up_to_the_list();
	CHECK(read_list() == 0);

	for (int second = 0; second < 60; second++) {
		bt_ota_on_tick();
	}

	CHECK(fake.confirms == 0);
	CHECK(bluetooth_trial);
	CHECK(strstr(fake.console, "it has to reach the cloud") != NULL);

	/* The network goes away, and a person can go on. */
	fake.wifi_associated = false;
	bt_ota_on_tick();
	CHECK(fake.confirms == 1);
}

static void test_not_before_the_wifi_stack_has_answered(void)
{
	on_bluetooth_trial();
	proof_up_to_the_list();
	CHECK(read_list() == 0);
	bt_ota_on_tick();
	CHECK(fake.confirms == 0);

	fake.wifi_answered = true;
	bt_ota_on_tick();
	CHECK(fake.confirms == 1);
}

static void test_a_list_read_on_an_old_link_does_not_count(void)
{
	on_bluetooth_trial();
	proof_up_to_the_list();
	CHECK(read_list() == 0);
	phone_leaves();
	bt_ota_on_tick();
	CHECK(window.phase == BT_OTA_OPEN);

	fake.wifi_answered = true;
	phone_pairs();
	bt_ota_on_tick();
	bt_ota_on_tick();
	CHECK(fake.confirms == 0);
	CHECK(read_list() == 0);
	bt_ota_on_tick();
	CHECK(fake.confirms == 1);
}

static void test_a_confirmation_that_fails_stays_on_trial(void)
{
	on_bluetooth_trial();
	fake.wifi_answered = true;
	fake.confirm_result = -EIO;
	proof_up_to_the_list();
	CHECK(read_list() == 0);
	bt_ota_on_tick();
	CHECK(fake.confirms == 1);
	CHECK(bluetooth_trial);
	CHECK(fake.stored_record.phase == BT_OTA_RECORD_TESTING);
}

static void test_the_cloud_can_prove_it_with_a_window_open(void)
{
	on_bluetooth_trial();
	proof_up_to_the_list();

	fake.ota = OTA_IDLE;
	bt_ota_on_cloud_proof();
	CHECK(!bluetooth_trial);
	CHECK(fake.stored_record.result == BT_OTA_RESULT_SUCCEEDED);
	CHECK(fake.stored_record.proof == BT_OTA_PROOF_BY_CLOUD);
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(fake.confirms == 0);
}

static void test_a_cloud_proof_of_something_else_changes_nothing(void)
{
	fresh_board();
	bt_ota_on_cloud_proof();
	CHECK(fake.store_writes == 0);
}

/* ---- the report ------------------------------------------------------------------------ */

static void test_the_record_goes_to_the_shadow_when_the_cloud_is_there(void)
{
	fresh_board();
	stored_record(BT_OTA_RECORD_TESTING, RUNNING_MINOR + 1);
	bt_ota_on_boot(false, true, false);
	CHECK(fake.shadow_reports == 0);

	/* Not reachable: nothing goes out. */
	bt_ota_on_tick();
	CHECK(fake.shadow_reports == 0);

	/* The first try fails, and the tick has another go. */
	fake.cloud_up = true;
	fake.shadow_result = -EAGAIN;
	bt_ota_on_tick();
	CHECK(fake.shadow_reports == 1);
	fake.shadow_result = 0;
	bt_ota_on_tick();
	CHECK(fake.shadow_reports == 2);
	CHECK(strstr(fake.last_shadow, "\"result\":\"rolled_back\"") != NULL);
	CHECK(strstr(fake.last_shadow, "\"to\":\"0.1.0+0\"") != NULL);

	/* Told: it stops. */
	bt_ota_on_tick();
	CHECK(fake.shadow_reports == 2);

	/* And after every new connection, because the last report may have been lost. */
	bt_ota_on_cloud_up();
	CHECK(fake.shadow_reports == 3);
}

static void test_no_record_no_report(void)
{
	fresh_board();
	fake.cloud_up = true;
	bt_ota_on_tick();
	bt_ota_on_cloud_up();
	CHECK(fake.shadow_reports == 0);
}

/* ---- LED1 ------------------------------------------------------------------------------ */

static void test_what_led1_shows(void)
{
	fresh_board();
	CHECK(!bt_ota_is_open());

	open_by_hand();
	CHECK(bt_ota_is_open());
	CHECK(bt_ota_ui_state() == UI_BT_WINDOW);

	phone_pairs();
	bt_ota_on_tick();
	CHECK(bt_ota_ui_state() == UI_UPDATE_IN_PROGRESS);

	upload_finishes();
	bt_ota_on_tick();
	CHECK(bt_ota_ui_state() == UI_UPDATE_OFFERED);
}

int main(void)
{
	test_the_hooks_are_on_from_the_boot_on();
	test_every_event_reaches_a_hook_that_asked_for_it();

	test_only_a_real_press_opens_a_window();
	test_a_tick_on_a_closed_board_does_nothing_on_the_air();
	test_a_console_press_cannot_install_or_erase();
	test_refusals_are_said_and_leave_nothing_open();
	test_a_failed_start_of_the_controller_closes_the_window();
	test_the_failed_start_of_a_closed_window_still_counts();
	test_a_phone_from_the_last_window_gets_no_way_into_the_next();
	test_button_1_on_a_cloud_update_on_offer_stays_what_it_was();
	test_a_network_core_without_a_controller_is_said_once_and_harmless();

	test_it_advertises_for_the_window_and_then_stops();
	test_it_waits_for_the_controller_before_advertising();
	test_a_late_connection_is_turned_away();
	test_pairing_is_only_accepted_while_open();
	test_the_callbacks_are_registered_once_for_a_display_and_no_keyboard();
	test_a_passkey_comes_out_on_the_main_loop();
	test_a_full_queue_only_makes_it_wait_for_the_tick();
	test_the_bluetooth_threads_do_not_print();
	test_three_failed_pairings_close_it();
	test_a_new_window_starts_with_a_clean_count();
	test_button_2_closes_it_and_a_link_goes_with_it();

	test_only_a_full_strength_link_counts();
	test_a_link_that_cannot_ask_for_security_is_dropped();
	test_a_new_connection_starts_with_nothing();
	test_security_that_gets_lost_is_gone();
	test_a_link_goes_when_the_phone_does();

	test_every_command_needs_the_link();
	test_a_phone_can_ask_for_no_swap_no_confirm_and_no_erase();
	test_a_refusal_is_an_answer_and_only_a_good_answer_counts_as_a_read();
	test_a_closed_window_shuts_the_gate_on_a_link_still_up();

	test_what_may_not_be_uploaded_is_refused_at_the_first_piece();
	test_a_later_piece_is_not_taken_for_a_header();
	test_a_piece_that_got_past_the_gate_stops_at_the_upload_hook();
	test_when_it_has_arrived_nothing_more_goes_in();
	test_it_is_offered_and_says_what_it_is();
	test_what_arrived_is_looked_at_again_before_it_is_offered();

	test_button_1_records_then_asks_for_a_trial_then_restarts();
	test_the_count_goes_on();
	test_a_swap_request_of_its_own_stops_the_install();
	test_nothing_is_installed_without_a_record();
	test_a_refused_swap_is_said_and_recorded();
	test_button_2_erases_the_image();
	test_what_the_policy_says_to_erase_is_erased();
	test_an_offer_nobody_takes_is_erased();
	test_a_whole_image_does_not_stay_behind_a_closed_window();
	test_an_image_that_arrives_late_gets_the_whole_offer();

	test_what_became_of_it_is_worked_out_and_recorded();
	test_a_finished_record_is_only_told_again();
	test_no_record_or_a_bad_one_is_nothing();

	test_nothing_is_confirmed_on_boot_or_by_itself();
	test_a_cloud_trial_cannot_be_proved_by_hand();
	test_a_proof_window_is_not_a_way_in();
	test_a_person_proves_it_with_everything_in_place();
	test_closing_a_proof_window_never_erases_the_way_back();
	test_the_proof_looks_at_the_link_and_the_board_itself();
	test_not_too_soon();
	test_not_with_wifi_up();
	test_not_while_associated_with_no_address();
	test_not_before_the_wifi_stack_has_answered();
	test_a_list_read_on_an_old_link_does_not_count();
	test_a_confirmation_that_fails_stays_on_trial();
	test_the_cloud_can_prove_it_with_a_window_open();
	test_a_cloud_proof_of_something_else_changes_nothing();

	test_the_record_goes_to_the_shadow_when_the_cloud_is_there();
	test_no_record_no_report();

	test_what_led1_shows();

	printf("%d Bluetooth update checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
