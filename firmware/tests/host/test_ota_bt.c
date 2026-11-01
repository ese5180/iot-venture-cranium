/*
 * Host-side tests of ota.c: what firmware update over Bluetooth adds to it, what the update
 * manager tells src/bt_ota.c, when a person's confirmation is refused, that the state a Bluetooth
 * window holds keeps a cloud update out, and how a job goes with and without a button. The real
 * file is compiled here, against a fake of the download library, PSA, the bootloader's API and the
 * cloud. The Makefile builds this file three times: with CONFIG_APP_OTA_REQUIRE_USER_CONSENT on,
 * with it off (TEST_NO_CONSENT, which is what a build gets by default), and as a test image that
 * never confirms itself.
 *
 * A real download, flash and restart are for firmware/tests/hil/ota_bench.py, as before.
 */

#define CONFIG_APP_BT_OTA                         1
#define CONFIG_APP_LOG_LEVEL                      0
#define CONFIG_APP_DOWNLOAD_SEC_TAG               202
#define CONFIG_APP_OTA_DOWNLOAD_ATTEMPTS          5
#if !defined(TEST_NO_CONSENT)
#define CONFIG_APP_OTA_REQUIRE_USER_CONSENT       1
#endif

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ota.c"

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

#define URL_PREFIX "https://fw-bucket.s3.us-east-1.amazonaws.com/firmware/"

static struct {
	/* The bootloader. */
	int swap_type;
	bool confirmed;
	int confirm_result;
	int confirms;
	bool trailer;

	/* The record of a cloud update. */
	bool job_record;
	struct ota_record stored;

	/* The cloud. */
	bool cloud_up;
	int next_requests;
	int job_updates;
	char last_update[256];

	/* The update manager's other half. */
	int trials;
	int trials_passed;

	/* The slot holds what the job announced. */
	bool download_is_good;

	/* What can go wrong in ota_init() before it gets to the record. */
	bool crypto_fails;
	bool download_init_fails;
	int swap_requests;
	bool swap_permanent;
	int erases;
	int reboots;

	/* src/bt_ota.c. */
	int boots;
	bool boot_on_trial;
	bool boot_has_trailer;
	bool boot_job_record;
	int cloud_proofs;
	int cloud_ups;

	int downloads;
	int cancels;

	/* What the next job update answers, and who the last one was for. */
	int update_result;
	char last_job[OTA_JOB_ID_MAX + 1];
} fake;

/* ---- the bootloader and the flash ---------------------------------------------------- */

int boot_read_bank_header(uint8_t area_id, struct mcuboot_img_header *header, size_t header_size)
{
	ARG_UNUSED(area_id);
	ARG_UNUSED(header_size);

	if (!fake.download_is_good) {
		return -EIO;
	}

	/* The version that the job announced. Its digest is all zeros, as psa_hash_finish() has it. */
	memset(header, 0, sizeof(*header));
	header->mcuboot_version = 1;
	header->h.v1.sem_ver.major = ota.job.version.major;
	header->h.v1.sem_ver.minor = ota.job.version.minor;
	header->h.v1.sem_ver.revision = ota.job.version.revision;
	header->h.v1.sem_ver.build_num = ota.job.version.build;
	return 0;
}

int mcuboot_swap_type_multi(int image_index)
{
	ARG_UNUSED(image_index);
	return fake.swap_type;
}

int boot_request_upgrade_multi(int image_index, int permanent)
{
	ARG_UNUSED(image_index);
	fake.swap_permanent = permanent != 0;
	fake.swap_requests++;
	return 0;
}

int boot_erase_img_bank(uint8_t area_id)
{
	ARG_UNUSED(area_id);
	fake.erases++;
	return 0;
}

int boot_write_img_confirmed(void)
{
	fake.confirms++;
	return fake.confirm_result;
}

bool boot_is_img_confirmed(void)
{
	return fake.confirmed;
}

int flash_area_open(uint8_t id, const struct flash_area **area)
{
	static const struct flash_area primary = { .fa_size = 0xe4000 };

	ARG_UNUSED(id);
	*area = &primary;
	return 0;
}

int flash_area_read(const struct flash_area *area, long offset, void *data, size_t length)
{
	ARG_UNUSED(area);
	ARG_UNUSED(offset);
	memset(data, fake.trailer ? 0x77 : TRAILER_ERASED, length);
	return 0;
}

void flash_area_close(const struct flash_area *area)
{
	ARG_UNUSED(area);
}

/* ---- the download library and PSA, which these tests never get to ------------------------ */

int fota_download_init(fota_download_callback_t callback)
{
	ARG_UNUSED(callback);
	return fake.download_init_fails ? -EIO : 0;
}

int fota_download_start(const char *host, const char *file, int sec_tag, uint8_t pdn_id,
			size_t fragment_size)
{
	ARG_UNUSED(host);
	ARG_UNUSED(file);
	ARG_UNUSED(sec_tag);
	ARG_UNUSED(pdn_id);
	ARG_UNUSED(fragment_size);
	fake.downloads++;
	return 0;
}

int fota_download_cancel(void)
{
	fake.cancels++;
	return 0;
}

psa_status_t psa_crypto_init(void)
{
	return fake.crypto_fails ? -1 : PSA_SUCCESS;
}

psa_status_t psa_hash_setup(psa_hash_operation_t *operation, int algorithm)
{
	ARG_UNUSED(operation);
	ARG_UNUSED(algorithm);
	return fake.download_is_good ? PSA_SUCCESS : -1;
}

psa_status_t psa_hash_update(psa_hash_operation_t *operation, const uint8_t *data, size_t length)
{
	ARG_UNUSED(operation);
	ARG_UNUSED(data);
	ARG_UNUSED(length);
	return fake.download_is_good ? PSA_SUCCESS : -1;
}

psa_status_t psa_hash_finish(psa_hash_operation_t *operation, uint8_t *digest, size_t size,
			     size_t *length)
{
	ARG_UNUSED(operation);

	if (!fake.download_is_good) {
		return -1;
	}

	memset(digest, 0, size);
	*length = size;
	return PSA_SUCCESS;
}

psa_status_t psa_hash_abort(psa_hash_operation_t *operation)
{
	ARG_UNUSED(operation);
	return -1;
}

/* ---- the rest of the application -------------------------------------------------------- */

void host_log_panic(void)
{
}

void sys_reboot(int type)
{
	ARG_UNUSED(type);
	fake.reboots++;
}

int store_read(enum store_id id, void *data, size_t size)
{
	if (id != STORE_OTA_RECORD || !fake.job_record) {
		return -ENOENT;
	}

	CHECK(size == sizeof(fake.stored));
	memcpy(data, &fake.stored, size);
	return 0;
}

int store_write(enum store_id id, const void *data, size_t size)
{
	CHECK(id == STORE_OTA_RECORD && size == sizeof(fake.stored));
	memcpy(&fake.stored, data, size);
	fake.job_record = true;
	return 0;
}

int store_erase(enum store_id id)
{
	CHECK(id == STORE_OTA_RECORD);
	fake.job_record = false;
	return 0;
}

const struct identity_settings *identity_settings_get(void)
{
	static const struct identity_settings settings = {
		.endpoint = "example.invalid",
		.download_url_prefix = URL_PREFIX,
	};

	return &settings;
}

void health_trial_begin(void)
{
	fake.trials++;
}

void health_trial_passed(void)
{
	fake.trials_passed++;
}

void cloud_disconnect(void)
{
}

bool cloud_is_connected(void)
{
	return fake.cloud_up;
}

int cloud_jobs_request_next(void)
{
	fake.next_requests++;
	return 0;
}

int cloud_jobs_update(const char *job_id, const char *body_json)
{
	if (fake.update_result != 0) {
		return fake.update_result;
	}

	fake.job_updates++;
	strncpy(fake.last_update, body_json, sizeof(fake.last_update) - 1);
	strncpy(fake.last_job, job_id, sizeof(fake.last_job) - 1);
	return 0;
}

int app_event_post(const struct app_event *event)
{
	ARG_UNUSED(event);
	return 0;
}

void bt_ota_on_boot(bool on_trial, bool has_trailer, bool job_record)
{
	fake.boots++;
	fake.boot_on_trial = on_trial;
	fake.boot_has_trailer = has_trailer;
	fake.boot_job_record = job_record;
}

void bt_ota_on_cloud_proof(void)
{
	fake.cloud_proofs++;
}

void bt_ota_on_cloud_up(void)
{
	fake.cloud_ups++;
}

/* ---- a restart ---------------------------------------------------------------------------- */

static void fresh_fake(void)
{
	memset(&fake, 0, sizeof(fake));
	fake.swap_type = BOOT_SWAP_TYPE_NONE;
	fake.confirmed = true;
	fake.trailer = true;
}

static void restart(void)
{
	memset(&ota, 0, sizeof(ota));
	CHECK(ota_init() == 0);
}

static const char offer[] =
	"{\"clientToken\":\"x\",\"timestamp\":1760137000,\"execution\":{\"jobId\":\"job-2\","
	"\"status\":\"QUEUED\",\"queuedAt\":1760136000,\"lastUpdatedAt\":1760136000,"
	"\"versionNumber\":1,\"executionNumber\":1,\"jobDocument\":{\"op\":\"fw_update\",\"v\":1,"
	"\"fw\":{\"version\":\"9.0.0\",\"size\":1000,\"sha256\":\""
	"0000000000000000000000000000000000000000000000000000000000000000\",\"url\":\""
	URL_PREFIX "x.bin\"}}}}";

static void job_arrives(void)
{
	ota_on_job_message(CLOUD_JOB_GET_ACCEPTED, offer, strlen(offer));
}

#if !defined(CONFIG_APP_TEST_FAULT_NO_CONFIRM)
/* A cloud job's record, for an image that runs now: on trial or confirmed by the bootloader. */
static void with_job_record(void)
{
	memset(&fake.stored, 0, sizeof(fake.stored));
	fake.stored.magic = RECORD_MAGIC;
	fake.stored.phase = RECORD_ARMED;
	strcpy(fake.stored.job_id, "job-1");
	fake.stored.target = *fw_version_running();
	fake.job_record = true;
}

/* ---- what the update manager tells bt_ota.c at boot ---------------------------------------- */

static void test_it_says_what_the_bootloader_did(void)
{
	fresh_fake();
	restart();
	CHECK(fake.boots == 1);
	CHECK(!fake.boot_on_trial);
	CHECK(fake.boot_has_trailer);
	CHECK(!fake.boot_job_record);

	fresh_fake();
	fake.swap_type = BOOT_SWAP_TYPE_REVERT;
	fake.trailer = false;
	restart();
	CHECK(fake.boot_on_trial);
	CHECK(!fake.boot_has_trailer);
	CHECK(!fake.boot_job_record);
	CHECK(ota_state() == OTA_TESTING);
	CHECK(fake.trials == 1);
}

static void test_it_says_when_a_cloud_job_is_behind_this(void)
{
	fresh_fake();
	with_job_record();
	fake.swap_type = BOOT_SWAP_TYPE_REVERT;
	restart();
	CHECK(fake.boot_job_record);
	CHECK(ota_bt_has_job());
	CHECK(ota_state() == OTA_TESTING);

	fresh_fake();
	restart();
	CHECK(!ota_bt_has_job());
}

/* ---- a person's confirmation ---------------------------------------------------------------- */

static void test_a_person_can_confirm_what_is_on_trial(void)
{
	fresh_fake();
	fake.swap_type = BOOT_SWAP_TYPE_REVERT;
	restart();

	CHECK(ota_bt_confirm() == 0);
	CHECK(fake.confirms == 1);
	CHECK(fake.trials_passed == 1);
	CHECK(ota_state() == OTA_IDLE);
	CHECK(strcmp(ota_last_result(), "succeeded") == 0);
}

static void test_a_person_cannot_confirm_anything_else(void)
{
	/* Nothing is on trial. */
	fresh_fake();
	restart();
	CHECK(ota_bt_confirm() == -EPERM);
	CHECK(fake.confirms == 0);

	/* The window of an upload. */
	ota_bt_enter();
	CHECK(ota_bt_confirm() == -EPERM);
	CHECK(fake.confirms == 0);

	/* A cloud job installed this: only the cloud can prove it. */
	fresh_fake();
	with_job_record();
	fake.swap_type = BOOT_SWAP_TYPE_REVERT;
	restart();
	CHECK(ota_state() == OTA_TESTING);
	CHECK(ota_bt_confirm() == -EPERM);
	CHECK(fake.confirms == 0);
	CHECK(ota_state() == OTA_TESTING);
}

static void test_a_confirmation_that_fails_stays_on_trial(void)
{
	fresh_fake();
	fake.swap_type = BOOT_SWAP_TYPE_REVERT;
	restart();

	fake.confirm_result = -EIO;
	CHECK(ota_bt_confirm() == -EIO);
	CHECK(fake.trials_passed == 0);
	CHECK(ota_state() == OTA_TESTING);
}

/* ---- the cloud's proof ------------------------------------------------------------------------ */

static void test_the_cloud_proves_it_and_says_so(void)
{
	fresh_fake();
	fake.swap_type = BOOT_SWAP_TYPE_REVERT;
	restart();

	ota_on_cloud_up();
	CHECK(fake.confirms == 1);
	CHECK(fake.cloud_proofs == 1);
	CHECK(fake.cloud_ups == 1);
	CHECK(ota_state() == OTA_IDLE);

	/* Nothing on trial at the next connection: no proof of anything, and the report again. */
	ota_on_cloud_up();
	CHECK(fake.confirms == 1);
	CHECK(fake.cloud_proofs == 1);
	CHECK(fake.cloud_ups == 2);
}

static void test_a_failed_confirmation_is_no_proof(void)
{
	fresh_fake();
	fake.swap_type = BOOT_SWAP_TYPE_REVERT;
	fake.confirm_result = -EIO;
	restart();

	ota_on_cloud_up();
	CHECK(fake.cloud_proofs == 0);
	CHECK(ota_state() == OTA_TESTING);
}

/* ---- the state a window holds ------------------------------------------------------------------ */

static void test_a_window_keeps_a_cloud_update_out_and_lets_it_in_after(void)
{
	fresh_fake();
	fake.cloud_up = true;
	restart();

	ota_bt_enter();
	CHECK(ota_state() == OTA_BLUETOOTH);
	CHECK(strcmp(ota_state_name(), "bluetooth") == 0);
	CHECK(ota_take_changed());

	/* It stays queued in the cloud: no answer, no offer, and Button 1 does nothing. */
	job_arrives();
	CHECK(ota_state() == OTA_BLUETOOTH);
	CHECK(fake.job_updates == 0);
	ota_on_button(APP_BUTTON_1);
	ota_on_button(APP_BUTTON_2);
	CHECK(ota_state() == OTA_BLUETOOTH);
	CHECK(fake.job_updates == 0);
	CHECK(fake.downloads == 0);

	/* When the window closes it asks for the job again, and gets it. */
	fake.next_requests = 0;
	ota_bt_leave();
	CHECK(ota_state() == OTA_IDLE);
	CHECK(fake.next_requests == 1);
	job_arrives();
#if defined(TEST_NO_CONSENT)
	CHECK(ota_state() == OTA_STARTING);
#else
	CHECK(ota_state() == OTA_AWAITING_USER);
#endif
}

static void test_leaving_is_only_for_who_entered(void)
{
	/* A proof window closes on an image on trial: that state is not its to change. */
	fresh_fake();
	fake.swap_type = BOOT_SWAP_TYPE_REVERT;
	restart();
	ota_bt_leave();
	CHECK(ota_state() == OTA_TESTING);
	CHECK(fake.next_requests == 0);

	fresh_fake();
	restart();
	ota_bt_leave();
	CHECK(ota_state() == OTA_IDLE);
	CHECK(fake.next_requests == 0);
}

static void test_a_window_does_not_show_an_old_job(void)
{
	fresh_fake();
	restart();

	/* What a cloud update left behind. */
	strcpy(ota.job.id, "old-job");
	ota_bt_enter();
	CHECK(ota_job_id() == NULL);
	CHECK(ota_progress() == 0);
}

#endif /* !CONFIG_APP_TEST_FAULT_NO_CONFIRM */

#if !defined(CONFIG_APP_TEST_FAULT_NO_CONFIRM)
static void test_a_trial_has_its_deadline_whatever_else_goes_wrong(void)
{
	/* Neither of these leaves anything running that could ever confirm the image. */
	fresh_fake();
	fake.swap_type = BOOT_SWAP_TYPE_REVERT;
	fake.crypto_fails = true;
	memset(&ota, 0, sizeof(ota));
	CHECK(ota_init() == -EIO);
	CHECK(fake.trials == 1);
	CHECK(ota_state() == OTA_IDLE);

	fresh_fake();
	fake.swap_type = BOOT_SWAP_TYPE_REVERT;
	fake.download_init_fails = true;
	memset(&ota, 0, sizeof(ota));
	CHECK(ota_init() == -EIO);
	CHECK(fake.trials == 1);

	/* An image that is not on trial has no deadline, in those cases either. */
	fresh_fake();
	fake.swap_type = BOOT_SWAP_TYPE_NONE;
	fake.crypto_fails = true;
	memset(&ota, 0, sizeof(ota));
	CHECK(ota_init() == -EIO);
	CHECK(fake.trials == 0);

	/* And the usual way it starts only once. */
	fresh_fake();
	fake.swap_type = BOOT_SWAP_TYPE_REVERT;
	restart();
	CHECK(fake.trials == 1);
	CHECK(ota_state() == OTA_TESTING);

	fresh_fake();
	fake.swap_type = BOOT_SWAP_TYPE_NONE;
	restart();
	CHECK(fake.trials == 0);
}

static void test_what_counts_as_an_update_moving(void)
{
	struct fota_download_evt event = { .id = FOTA_DOWNLOAD_EVT_PROGRESS, .progress = 11 };
	uint32_t before;

	fresh_fake();
	restart();

	/* Every piece of the file, also the ones too small to make the main loop's 10%. */
	before = ota_stuck_progress();
	download_callback(&event);
	CHECK(ota_stuck_progress() == before + 1);
	event.progress = 12;
	download_callback(&event);
	CHECK(ota_stuck_progress() == before + 2);
	event.progress = 13;
	download_callback(&event);
	CHECK(ota_stuck_progress() == before + 3);

	/* A download that starts. */
	before = ota_stuck_progress();
	start_download();
	CHECK(ota_state() == OTA_DOWNLOADING);
	CHECK(ota_stuck_progress() == before + 1);

	/* The image is found good, which takes it on to asking the cloud. */
	fake.download_is_good = true;
	ota.job.size = 16;
	before = ota_stuck_progress();
	check_download();
	CHECK(ota_state() == OTA_COMMITTING);
	CHECK(ota_stuck_progress() == before + 1);

	/* An image that is not good is no progress, and it ends the update anyway. */
	fake.download_is_good = false;
	before = ota_stuck_progress();
	check_download();
	CHECK(ota_state() != OTA_COMMITTING);
	CHECK(ota_stuck_progress() == before);

	/* The cloud agrees to the installation. */
	before = ota_stuck_progress();
	begin_settling();
	CHECK(ota_state() == OTA_REBOOTING);
	CHECK(ota_stuck_progress() == before + 1);

	/* Asking again and again, which is what a stuck update does, is not moving. */
	fake.cloud_up = true;
	before = ota_stuck_progress();
	for (int i = 0; i < 1000; i++) {
		ota_on_tick();
	}
	CHECK(ota_stuck_progress() == before);

	/* All that time it had asked the bootloader for nothing: a restart here installs nothing. */
	CHECK(ota_state() == OTA_REBOOTING);
	CHECK(fake.swap_requests == 0);
	CHECK(!fake.job_record);

	enter(OTA_COMMITTING);
	for (int i = 0; i < 1000; i++) {
		ota_on_tick();
	}
	CHECK(ota_stuck_progress() == before);
	CHECK(fake.swap_requests == 0);
	CHECK(!fake.job_record);
}

static void test_a_job_left_behind_by_a_restart_is_closed_as_interrupted(void)
{
	/*
	 * What the cloud is told after a restart for a stalled update. The state is lost, there is
	 * no record, and the cloud lists the job as in progress.
	 */
	struct ota_job job = { .in_progress = true };

	fresh_fake();
	restart();
	strcpy(job.id, "cranium-job");
	job.version = (struct fw_version){ .major = 99 };
	on_job(&job);
	CHECK(strstr(fake.last_update, "\"status\":\"FAILED\"") != NULL);
	CHECK(strstr(fake.last_update, "\"reason\":\"interrupted\"") != NULL);
	CHECK(ota_state() == OTA_IDLE);
	CHECK(fake.swap_requests == 0);
}
#endif /* !CONFIG_APP_TEST_FAULT_NO_CONFIRM */

/* ---- what the cloud answers ------------------------------------------------------------------ */

#if !defined(CONFIG_APP_TEST_FAULT_NO_CONFIRM)
/* The cloud's answer to a request for the next job: this one. */
static void job_listed(const char *id, const char *status, const char *version)
{
	static char message[700];

	(void)snprintf(message, sizeof(message),
		       "{\"clientToken\":\"x\",\"timestamp\":1760137000,\"execution\":{\"jobId\":\"%s\","
		       "\"status\":\"%s\",\"queuedAt\":1760136000,\"lastUpdatedAt\":1760136000,"
		       "\"versionNumber\":1,\"executionNumber\":1,\"jobDocument\":{\"op\":\"fw_update\","
		       "\"v\":1,\"fw\":{\"version\":\"%s\",\"size\":1000,\"sha256\":\""
		       "0000000000000000000000000000000000000000000000000000000000000000\",\"url\":\""
		       URL_PREFIX "x.bin\"}}}}",
		       id, status, version);
	ota_on_job_message(CLOUD_JOB_GET_ACCEPTED, message, strlen(message));
}

/* The same answer when no job is pending. */
static void no_job_listed(void)
{
	static const char none[] = "{\"clientToken\":\"x\",\"timestamp\":1760137000}";

	ota_on_job_message(CLOUD_JOB_GET_ACCEPTED, none, strlen(none));
}

static void ticks(int seconds)
{
	for (int i = 0; i < seconds; i++) {
		ota_on_tick();
	}
}

static void a_board_on_the_cloud(void)
{
	fresh_fake();
	fake.cloud_up = true;
	restart();
}

static bool last_update_says(const char *text)
{
	return strstr(fake.last_update, text) != NULL;
}
#endif

/* ---- the option off, which is the default: a job starts by itself ------------------------------ */

#if defined(TEST_NO_CONSENT)
/* A job on the board, up to where the cloud has agreed that it starts and the download runs. */
static void a_download_running(const char *id)
{
	job_listed(id, "QUEUED", "9.0.0");
	CHECK(ota_state() == OTA_STARTING);
	ota_on_job_ack(TOKEN_START, ota.start_sequence, true, false);
	CHECK(ota_state() == OTA_DOWNLOADING);
}

static void test_a_job_starts_with_no_button(void)
{
	a_board_on_the_cloud();

	/* Right after the cloud connects: it asks, and the answer is all it takes. */
	ota_on_cloud_up();
	CHECK(fake.next_requests == 1);
	CHECK(ota_state() == OTA_IDLE);
	fake.next_requests = 0;

	job_listed("job-2", "QUEUED", "9.0.0");
	CHECK(ota_state() == OTA_STARTING);
	CHECK(strcmp(ota_state_name(), "downloading") == 0);
	CHECK(strcmp(ota_job_id(), "job-2") == 0);
	CHECK(fake.job_updates == 1);
	CHECK(last_update_says("\"status\":\"IN_PROGRESS\""));
	CHECK(last_update_says("\"step\":\"downloading\""));
	CHECK(strcmp(fake.last_job, "job-2") == 0);

	/* The link just came with the list, so it does not ask for it again. */
	CHECK(fake.next_requests == 0);

	/* Nothing is downloaded until the cloud has agreed. */
	CHECK(fake.downloads == 0);
	ota_on_job_ack(TOKEN_START, ota.start_sequence, true, false);
	CHECK(ota_state() == OTA_DOWNLOADING);
	CHECK(fake.downloads == 1);
	CHECK(fake.swap_requests == 0);
}

static void test_nothing_enters_the_state_of_an_offer(void)
{
	a_board_on_the_cloud();
	job_listed("job-2", "QUEUED", "9.0.0");
	CHECK(ota_state() != OTA_AWAITING_USER);
	CHECK(strcmp(ota_state_name(), "awaiting_user") != 0);
	CHECK(strcmp(ota_last_result(), "declined") != 0);
}

static void test_a_press_does_nothing_to_a_job(void)
{
	static const enum app_button buttons[] = { APP_BUTTON_1, APP_BUTTON_2 };

	for (size_t i = 0; i < ARRAY_SIZE(buttons); i++) {
		int updates;

		/* With nothing going on. */
		a_board_on_the_cloud();
		ota_on_button(buttons[i]);
		CHECK(ota_state() == OTA_IDLE);
		CHECK(fake.job_updates == 0);
		CHECK(fake.next_requests == 0);
		CHECK(strcmp(ota_last_result(), "none") == 0);

		/* While it starts: Button 2 declines nothing, and Button 1 does not hurry it. */
		job_listed("job-2", "QUEUED", "9.0.0");
		updates = fake.job_updates;
		ota_on_button(buttons[i]);
		CHECK(ota_state() == OTA_STARTING);
		CHECK(fake.job_updates == updates);
		CHECK(fake.next_requests == 0);
		CHECK(fake.downloads == 0);

		/* While it downloads. */
		ota_on_job_ack(TOKEN_START, ota.start_sequence, true, false);
		ota_on_button(buttons[i]);
		CHECK(ota_state() == OTA_DOWNLOADING);
		CHECK(fake.job_updates == updates);
		CHECK(fake.downloads == 1);
		CHECK(fake.cancels == 0);

		/* While it waits to install. */
		fake.download_is_good = true;
		ota_on_download(APP_DOWNLOAD_FINISHED, 0);
		CHECK(ota_state() == OTA_COMMITTING);
		updates = fake.job_updates;
		ota_on_button(buttons[i]);
		CHECK(ota_state() == OTA_COMMITTING);
		CHECK(fake.job_updates == updates);
		ota_on_job_ack(TOKEN_COMMIT, ota.commit_sequence, true, false);
		ota_on_button(buttons[i]);
		CHECK(ota_state() == OTA_REBOOTING);
		CHECK(fake.job_updates == updates);
		CHECK(fake.swap_requests == 0);
	}
}

static void test_it_goes_all_the_way_with_no_button(void)
{
	a_board_on_the_cloud();
	a_download_running("job-2");

	fake.download_is_good = true;
	ota_on_download(APP_DOWNLOAD_PROGRESS, 50);
	CHECK(ota_progress() == 50);
	ota_on_download(APP_DOWNLOAD_FINISHED, 0);
	CHECK(ota_state() == OTA_COMMITTING);
	CHECK(last_update_says("\"step\":\"rebooting\""));
	ota_on_job_ack(TOKEN_COMMIT, ota.commit_sequence, true, false);
	CHECK(ota_state() == OTA_REBOOTING);

	/* It looks at the job once more before it asks the bootloader for anything. */
	ticks(SETTLE_SECONDS - 1);
	CHECK(fake.swap_requests == 0);
	fake.next_requests = 0;
	ticks(1);
	CHECK(fake.next_requests == 1);
	CHECK(fake.swap_requests == 0);
	job_listed("job-2", "IN_PROGRESS", "9.0.0");

	/* A trial, on the record, and never a permanent swap. */
	CHECK(fake.swap_requests == 1);
	CHECK(!fake.swap_permanent);
	CHECK(fake.job_record);
	CHECK(fake.stored.phase == RECORD_ARMED);
	CHECK(strcmp(fake.stored.job_id, "job-2") == 0);
	CHECK(fake.reboots == 1);
}

static void test_a_start_that_gets_no_answer_is_asked_again(void)
{
	/* The service was busy: not an answer, and it asks again. */
	a_board_on_the_cloud();
	job_listed("job-2", "QUEUED", "9.0.0");
	ota_on_job_ack(TOKEN_START, ota.start_sequence, false, false);
	CHECK(ota_state() == OTA_STARTING);
	fake.next_requests = 0;
	ticks(ACK_TIMEOUT_SECONDS);
	CHECK(ota_state() == OTA_REFRESHING);
	CHECK(fake.next_requests == 1);
	job_listed("job-2", "QUEUED", "9.0.0");
	CHECK(ota_state() == OTA_STARTING);
	CHECK(fake.job_updates == 2);
	CHECK(fake.downloads == 0);

	/* The answer was lost, and the cloud had agreed: the list says so, and it goes on. */
	ticks(ACK_TIMEOUT_SECONDS);
	job_listed("job-2", "IN_PROGRESS", "9.0.0");
	CHECK(ota_state() == OTA_DOWNLOADING);
	CHECK(fake.downloads == 1);

	/* An answer that comes after that changes nothing. */
	ota_on_job_ack(TOKEN_START, ota.start_sequence, true, false);
	CHECK(fake.downloads == 1);

	/* The connection went as it started: the announcement cannot be sent. */
	a_board_on_the_cloud();
	fake.update_result = -ENOTCONN;
	job_listed("job-2", "QUEUED", "9.0.0");
	CHECK(ota_state() == OTA_STARTING);
	fake.update_result = 0;
	fake.next_requests = 0;
	ota_on_cloud_up();
	CHECK(fake.next_requests == 1);
	job_listed("job-2", "QUEUED", "9.0.0");
	CHECK(ota_state() == OTA_STARTING);
	ticks(ACK_TIMEOUT_SECONDS);
	job_listed("job-2", "QUEUED", "9.0.0");
	CHECK(ota_state() == OTA_STARTING);
	CHECK(last_update_says("\"status\":\"IN_PROGRESS\""));
	ota_on_job_ack(TOKEN_START, ota.start_sequence, true, false);
	CHECK(ota_state() == OTA_DOWNLOADING);
}

static void test_a_job_cancelled_at_once(void)
{
	/* The cancellation got there first: the cloud turns the announcement down. */
	a_board_on_the_cloud();
	job_listed("job-2", "QUEUED", "9.0.0");
	ota_on_job_ack(TOKEN_START, ota.start_sequence, false, true);
	CHECK(ota_state() == OTA_IDLE);
	CHECK(strcmp(ota_last_result(), "cancelled") == 0);
	CHECK(fake.downloads == 0);
	CHECK(fake.job_updates == 1);

	/* An older answer, on its way all that time, starts nothing. */
	ota_on_job_ack(TOKEN_START, ota.start_sequence, true, false);
	CHECK(ota_state() == OTA_IDLE);
	CHECK(fake.downloads == 0);

	/*
	 * A list with no job in it, while it starts: it may have been asked for before the job
	 * existed, so that alone does not end the update. The next answer does, one way or the other.
	 */
	a_board_on_the_cloud();
	job_listed("job-2", "QUEUED", "9.0.0");
	no_job_listed();
	CHECK(ota_state() == OTA_STARTING);
	CHECK(strcmp(ota_last_result(), "none") == 0);
	ota_on_job_ack(TOKEN_START, ota.start_sequence, true, false);
	CHECK(ota_state() == OTA_DOWNLOADING);

	/* No answer to the announcement either: the list decides, once it was asked for after it. */
	a_board_on_the_cloud();
	job_listed("job-2", "QUEUED", "9.0.0");
	no_job_listed();
	ticks(ACK_TIMEOUT_SECONDS);
	CHECK(ota_state() == OTA_REFRESHING);
	no_job_listed();
	CHECK(ota_state() == OTA_IDLE);
	CHECK(strcmp(ota_last_result(), "cancelled") == 0);
	CHECK(fake.downloads == 0);

	/* In mid-download, with force: the download stops, and the partial image stays unused. */
	a_board_on_the_cloud();
	a_download_running("job-2");
	no_job_listed();
	CHECK(ota_state() == OTA_IDLE);
	CHECK(fake.cancels == 1);
	CHECK(fake.erases == 0);
	CHECK(strcmp(ota_last_result(), "cancelled") == 0);
	ota_on_download(APP_DOWNLOAD_FINISHED, 0);
	CHECK(ota_state() == OTA_IDLE);
	CHECK(fake.swap_requests == 0);

	/* Downloaded, and cancelled while it waits to install: the image goes, and nothing is asked. */
	a_board_on_the_cloud();
	a_download_running("job-2");
	fake.download_is_good = true;
	ota_on_download(APP_DOWNLOAD_FINISHED, 0);
	CHECK(ota_state() == OTA_COMMITTING);
	no_job_listed();
	CHECK(ota_state() == OTA_IDLE);
	CHECK(fake.erases == 1);
	CHECK(fake.swap_requests == 0);

	a_board_on_the_cloud();
	a_download_running("job-2");
	fake.download_is_good = true;
	ota_on_download(APP_DOWNLOAD_FINISHED, 0);
	ota_on_job_ack(TOKEN_COMMIT, ota.commit_sequence, true, false);
	ticks(SETTLE_SECONDS);
	no_job_listed();
	CHECK(ota_state() == OTA_IDLE);
	CHECK(fake.erases == 1);
	CHECK(fake.swap_requests == 0);
	CHECK(!fake.job_record);

	/* Turned down at the last step. */
	a_board_on_the_cloud();
	a_download_running("job-2");
	fake.download_is_good = true;
	ota_on_download(APP_DOWNLOAD_FINISHED, 0);
	ota_on_job_ack(TOKEN_COMMIT, ota.commit_sequence, false, true);
	CHECK(ota_state() == OTA_IDLE);
	CHECK(fake.erases == 1);
	CHECK(fake.swap_requests == 0);
}

static void test_a_job_stays_out_during_a_trial(void)
{
	int updates;

	fresh_fake();
	with_job_record();
	fake.swap_type = BOOT_SWAP_TYPE_REVERT;
	fake.cloud_up = true;
	restart();
	CHECK(ota_state() == OTA_TESTING);

	/* Nothing starts on an image that has proved nothing: it stays queued. */
	job_listed("job-3", "QUEUED", "9.0.0");
	CHECK(ota_state() == OTA_TESTING);
	CHECK(fake.job_updates == 0);
	CHECK(fake.downloads == 0);

	/* The job on trial is no new job, whatever it is called in the list. */
	job_listed("job-1", "IN_PROGRESS", "9.0.0");
	job_listed("job-1", "QUEUED", "9.0.0");
	CHECK(ota_state() == OTA_TESTING);
	CHECK(fake.job_updates == 0);

	/* The cloud proves it: confirmed first, then the report, and only then the list. */
	fake.next_requests = 0;
	ota_on_cloud_up();
	CHECK(fake.confirms == 1);
	CHECK(ota_state() == OTA_IDLE);
	CHECK(last_update_says("\"status\":\"SUCCEEDED\""));
	CHECK(strcmp(fake.last_job, "job-1") == 0);
	CHECK(fake.next_requests == 1);
	updates = fake.job_updates;

	/* AWS IoT still lists the one in progress first: that is the report that is on its way. */
	job_listed("job-1", "IN_PROGRESS", "9.0.0");
	CHECK(ota_state() == OTA_IDLE);
	CHECK(fake.job_updates == updates);

	ota_on_job_ack(TOKEN_REPORT, ota.report_sequence, true, false);
	CHECK(!fake.job_record);
	job_listed("job-1", "IN_PROGRESS", "9.0.0");
	CHECK(ota_state() == OTA_IDLE);
	CHECK(fake.downloads == 0);

	/* The next one starts now, on an image that has been confirmed. */
	job_listed("job-3", "QUEUED", "9.0.0");
	CHECK(ota_state() == OTA_STARTING);
	CHECK(strcmp(fake.last_job, "job-3") == 0);
}

/* The record that a restart finds after the bootloader reverted the image. */
static void with_a_rollback_on_record(void)
{
	memset(&fake.stored, 0, sizeof(fake.stored));
	fake.stored.magic = RECORD_MAGIC;
	fake.stored.phase = RECORD_TESTING;
	strcpy(fake.stored.job_id, "job-1");
	fake.stored.target = (struct fw_version){ .major = 9 };
	fake.job_record = true;
}

static void test_a_job_that_rolled_back_does_not_install_again(void)
{
	int updates;

	fresh_fake();
	with_a_rollback_on_record();
	fake.cloud_up = true;
	restart();
	CHECK(ota_state() == OTA_IDLE);
	CHECK(strcmp(ota_last_result(), "rolled_back") == 0);

	ota_on_cloud_up();
	CHECK(last_update_says("\"status\":\"FAILED\""));
	CHECK(last_update_says("\"reason\":\"rolled_back\""));
	CHECK(strcmp(fake.last_job, "job-1") == 0);
	updates = fake.job_updates;

	/* However the list names it, this job does not start again. */
	job_listed("job-1", "IN_PROGRESS", "9.0.0");
	job_listed("job-1", "QUEUED", "9.0.0");
	CHECK(ota_state() == OTA_IDLE);
	CHECK(fake.job_updates == updates);
	CHECK(fake.downloads == 0);

	/* The report is lost: it goes out again by itself, across a restart too. */
	ticks(REPORT_RETRY_SECONDS);
	CHECK(fake.job_updates == updates + 1);
	CHECK(last_update_says("\"reason\":\"rolled_back\""));
	restart();
	CHECK(strcmp(ota_last_result(), "rolled_back") == 0);
	ota_on_cloud_up();
	CHECK(last_update_says("\"reason\":\"rolled_back\""));
	job_listed("job-1", "QUEUED", "9.0.0");
	CHECK(ota_state() == OTA_IDLE);
	CHECK(fake.downloads == 0);

	/* The answer comes. What is on its way still changes nothing. */
	ota_on_job_ack(TOKEN_REPORT, ota.report_sequence, true, false);
	CHECK(!fake.job_record);
	updates = fake.job_updates;
	job_listed("job-1", "QUEUED", "9.0.0");
	job_listed("job-1", "IN_PROGRESS", "9.0.0");
	CHECK(ota_state() == OTA_IDLE);
	CHECK(fake.job_updates == updates);
	CHECK(fake.downloads == 0);

	/*
	 * The cloud turned the report down for good, and still lists the job as in progress after a
	 * reconnect. It gets closed, every time. That is an answer, and not an installation.
	 */
	for (int i = 0; i < 3; i++) {
		ota_on_cloud_up();
		job_listed("job-1", "IN_PROGRESS", "9.0.0");
		CHECK(ota_state() == OTA_IDLE);
		CHECK(last_update_says("\"reason\":\"interrupted\""));
	}
	CHECK(fake.downloads == 0);
	CHECK(fake.swap_requests == 0);

	/* Deploying the same version again is somebody's new decision, and a new job. */
	job_listed("job-9", "QUEUED", "9.0.0");
	CHECK(ota_state() == OTA_STARTING);
}

static void test_a_job_that_failed_is_not_tried_for_ever(void)
{
	int downloads;

	/* The download fails: a limited number of attempts, with a fresh link each. */
	a_board_on_the_cloud();
	a_download_running("job-2");
	for (int attempt = 1; attempt < CONFIG_APP_OTA_DOWNLOAD_ATTEMPTS; attempt++) {
		ota_on_download(APP_DOWNLOAD_ERROR, -5);
		CHECK(ota_state() == OTA_RETRY_WAIT);
		ticks(RETRY_WAIT_SECONDS * attempt);
		CHECK(ota_state() == OTA_REFRESHING);
		job_listed("job-2", "IN_PROGRESS", "9.0.0");
		CHECK(ota_state() == OTA_DOWNLOADING);
	}
	CHECK(fake.downloads == CONFIG_APP_OTA_DOWNLOAD_ATTEMPTS);
	fake.next_requests = 0;
	ota_on_download(APP_DOWNLOAD_ERROR, -5);
	CHECK(ota_state() == OTA_IDLE);
	CHECK(last_update_says("\"status\":\"FAILED\""));
	CHECK(last_update_says("\"reason\":\"download_failed\""));
	CHECK(fake.next_requests == 1);

	/* The list that it asked for may still name it. */
	downloads = fake.downloads;
	job_listed("job-2", "IN_PROGRESS", "9.0.0");
	CHECK(ota_state() == OTA_IDLE);

	/* That answer was lost with the connection: the next one closes the job, and starts nothing. */
	ota_on_cloud_up();
	job_listed("job-2", "IN_PROGRESS", "9.0.0");
	CHECK(ota_state() == OTA_IDLE);
	CHECK(last_update_says("\"reason\":\"interrupted\""));
	CHECK(fake.downloads == downloads);

	/* A damaged download. */
	a_board_on_the_cloud();
	a_download_running("job-2");
	ota_on_download(APP_DOWNLOAD_FINISHED, 0);
	CHECK(ota_state() == OTA_IDLE);
	CHECK(last_update_says("\"status\":\"FAILED\""));
	CHECK(fake.erases == 1);
	CHECK(fake.swap_requests == 0);
	job_listed("job-2", "IN_PROGRESS", "9.0.0");
	CHECK(fake.downloads == 1);

	/* A restart in mid-download: in the cloud it is in progress, and that is the end of it. */
	a_board_on_the_cloud();
	a_download_running("job-2");
	restart();
	ota_on_cloud_up();
	job_listed("job-2", "IN_PROGRESS", "9.0.0");
	CHECK(ota_state() == OTA_IDLE);
	CHECK(last_update_says("\"reason\":\"interrupted\""));
	CHECK(fake.downloads == 1);
}

static void test_a_version_that_is_not_newer_is_refused(void)
{
	/* This host build runs 0.0.0+0. */
	a_board_on_the_cloud();
	job_listed("job-2", "QUEUED", "0.0.0+0");
	CHECK(ota_state() == OTA_IDLE);
	CHECK(last_update_says("\"status\":\"REJECTED\""));
	CHECK(last_update_says("\"reason\":\"not_newer\""));
	CHECK(strcmp(ota_last_result(), "refused") == 0);
	CHECK(strcmp(ota_last_error(), "not_newer") == 0);
	CHECK(fake.job_updates == 1);
	CHECK(fake.downloads == 0);

	/* Listed again, on its way from before that. */
	job_listed("job-2", "QUEUED", "0.0.0+0");
	CHECK(fake.job_updates == 1);

	/* The answer was lost with the connection: the same answer again, and nothing else. */
	ota_on_cloud_up();
	job_listed("job-2", "QUEUED", "0.0.0+0");
	CHECK(ota_state() == OTA_IDLE);
	CHECK(last_update_says("\"reason\":\"not_newer\""));
	CHECK(fake.job_updates == 2);
	CHECK(fake.downloads == 0);

	/* What it cannot use is refused as well, so that it does not hold up the next one. */
	a_board_on_the_cloud();
	{
		static const char other[] =
			"{\"execution\":{\"jobId\":\"job-5\",\"status\":\"QUEUED\",\"jobDocument\":"
			"{\"op\":\"reboot\",\"v\":1}}}";

		ota_on_job_message(CLOUD_JOB_GET_ACCEPTED, other, strlen(other));
	}
	CHECK(ota_state() == OTA_IDLE);
	CHECK(last_update_says("\"reason\":\"unsupported\""));
	CHECK(fake.downloads == 0);
}

static void test_a_second_job_while_one_runs(void)
{
	int updates;

	a_board_on_the_cloud();
	a_download_running("job-2");
	updates = fake.job_updates;

	/* The list names the one that runs, as AWS IoT does, and nothing happens. */
	job_listed("job-2", "IN_PROGRESS", "9.0.0");
	CHECK(ota_state() == OTA_DOWNLOADING);
	CHECK(fake.job_updates == updates);
	CHECK(fake.downloads == 1);
	CHECK(fake.cancels == 0);

	/* It names another: the one that ran is gone, so that one stops and the other starts. */
	job_listed("job-3", "QUEUED", "9.1.0");
	CHECK(fake.cancels == 1);
	CHECK(ota_state() == OTA_STARTING);
	CHECK(strcmp(ota_job_id(), "job-3") == 0);
	CHECK(strcmp(fake.last_job, "job-3") == 0);

	/* While it starts, the list names it again, as queued or in progress. */
	updates = fake.job_updates;
	job_listed("job-3", "QUEUED", "9.1.0");
	job_listed("job-3", "IN_PROGRESS", "9.1.0");
	CHECK(ota_state() == OTA_STARTING);
	CHECK(fake.job_updates == updates);

	/* The one after an update that failed starts when the list names it. */
	a_board_on_the_cloud();
	a_download_running("job-2");
	ota_on_download(APP_DOWNLOAD_FINISHED, 0);
	CHECK(ota_state() == OTA_IDLE);
	job_listed("job-3", "QUEUED", "9.1.0");
	CHECK(ota_state() == OTA_STARTING);
	CHECK(strcmp(fake.last_job, "job-3") == 0);

	/* A window holds it back, and it starts when the window closes. */
	a_board_on_the_cloud();
	ota_bt_enter();
	job_listed("job-3", "QUEUED", "9.1.0");
	CHECK(ota_state() == OTA_BLUETOOTH);
	CHECK(fake.job_updates == 0);
	ota_bt_leave();
	job_listed("job-3", "QUEUED", "9.1.0");
	CHECK(ota_state() == OTA_STARTING);
}
#elif !defined(CONFIG_APP_TEST_FAULT_NO_CONFIRM)

/* ---- the option on: an update waits for a person ------------------------------------------------ */

static void test_the_option_offers_and_waits(void)
{
	/* Offered, and nothing is sent: the job stays queued. */
	a_board_on_the_cloud();
	job_listed("job-2", "QUEUED", "9.0.0");
	CHECK(ota_state() == OTA_AWAITING_USER);
	CHECK(strcmp(ota_state_name(), "awaiting_user") == 0);
	CHECK(fake.job_updates == 0);
	ticks(600);
	CHECK(ota_state() == OTA_AWAITING_USER);
	CHECK(fake.job_updates == 0);

	/* Button 2 declines. */
	ota_on_button(APP_BUTTON_2);
	CHECK(ota_state() == OTA_IDLE);
	CHECK(last_update_says("\"status\":\"REJECTED\""));
	CHECK(last_update_says("\"reason\":\"declined\""));
	CHECK(strcmp(ota_last_result(), "declined") == 0);
	CHECK(fake.downloads == 0);

	/* Button 1 fetches the document again, for a fresh link, and then it starts. */
	a_board_on_the_cloud();
	job_listed("job-2", "QUEUED", "9.0.0");
	fake.next_requests = 0;
	ota_on_button(APP_BUTTON_1);
	CHECK(ota_state() == OTA_REFRESHING);
	CHECK(fake.next_requests == 1);
	CHECK(fake.job_updates == 0);
	job_listed("job-2", "QUEUED", "9.0.0");
	CHECK(ota_state() == OTA_STARTING);
	CHECK(last_update_says("\"status\":\"IN_PROGRESS\""));
	ota_on_job_ack(TOKEN_START, ota.start_sequence, true, false);
	CHECK(ota_state() == OTA_DOWNLOADING);
	CHECK(fake.downloads == 1);

	/* Withdrawn while on offer. */
	a_board_on_the_cloud();
	job_listed("job-2", "QUEUED", "9.0.0");
	no_job_listed();
	CHECK(ota_state() == OTA_IDLE);
	CHECK(strcmp(ota_last_result(), "cancelled") == 0);
	CHECK(fake.job_updates == 0);
}
#endif /* TEST_NO_CONSENT */

int main(void)
{
#if defined(CONFIG_APP_TEST_FAULT_NO_CONFIRM)
	/* A test image that must always go back. */
	fresh_fake();
	fake.swap_type = BOOT_SWAP_TYPE_REVERT;
	restart();
	CHECK(ota_bt_confirm() == -EPERM);
	CHECK(fake.confirms == 0);
	ota_on_cloud_up();
	CHECK(fake.confirms == 0);
	CHECK(fake.cloud_proofs == 0);

	/* It stays on trial, so no job gets in before the bootloader takes it back. */
	CHECK(ota_state() == OTA_TESTING);
	job_arrives();
	CHECK(ota_state() == OTA_TESTING);
	CHECK(fake.job_updates == 0);
	CHECK(fake.downloads == 0);
#else
	test_it_says_what_the_bootloader_did();
	test_it_says_when_a_cloud_job_is_behind_this();
	test_a_person_can_confirm_what_is_on_trial();
	test_a_person_cannot_confirm_anything_else();
	test_a_confirmation_that_fails_stays_on_trial();
	test_the_cloud_proves_it_and_says_so();
	test_a_failed_confirmation_is_no_proof();
	test_a_window_keeps_a_cloud_update_out_and_lets_it_in_after();
	test_leaving_is_only_for_who_entered();
	test_a_window_does_not_show_an_old_job();
	test_a_trial_has_its_deadline_whatever_else_goes_wrong();
	test_what_counts_as_an_update_moving();
	test_a_job_left_behind_by_a_restart_is_closed_as_interrupted();
#if defined(TEST_NO_CONSENT)
	test_a_job_starts_with_no_button();
	test_nothing_enters_the_state_of_an_offer();
	test_a_press_does_nothing_to_a_job();
	test_it_goes_all_the_way_with_no_button();
	test_a_start_that_gets_no_answer_is_asked_again();
	test_a_job_cancelled_at_once();
	test_a_job_stays_out_during_a_trial();
	test_a_job_that_rolled_back_does_not_install_again();
	test_a_job_that_failed_is_not_tried_for_ever();
	test_a_version_that_is_not_newer_is_refused();
	test_a_second_job_while_one_runs();
#else
	test_the_option_offers_and_waits();
#endif
#endif

	printf("%d update manager checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
