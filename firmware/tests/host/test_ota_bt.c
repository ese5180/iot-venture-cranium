/*
 * Host-side tests of what firmware update over Bluetooth adds to ota.c: what the update manager
 * tells src/bt_ota.c, when a person's confirmation is refused, and that the state a Bluetooth
 * window holds keeps a cloud update out. The real file is compiled here, against a fake of the
 * download library, PSA, the bootloader's API and the cloud.
 *
 * This is not a test of ota.c as a whole. The rest of it, a cloud update from start to finish, is
 * for firmware/tests/hil/ota_bench.py, as before.
 */

#define CONFIG_APP_BT_OTA                         1
#define CONFIG_APP_LOG_LEVEL                      0
#define CONFIG_APP_DOWNLOAD_SEC_TAG               202
#define CONFIG_APP_OTA_DOWNLOAD_ATTEMPTS          5
#define CONFIG_APP_OTA_REQUIRE_USER_CONSENT       1

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

	/* src/bt_ota.c. */
	int boots;
	bool boot_on_trial;
	bool boot_has_trailer;
	bool boot_job_record;
	int cloud_proofs;
	int cloud_ups;

	int downloads;
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
	ARG_UNUSED(permanent);
	fake.swap_requests++;
	return 0;
}

int boot_erase_img_bank(uint8_t area_id)
{
	ARG_UNUSED(area_id);
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
	ARG_UNUSED(job_id);
	fake.job_updates++;
	strncpy(fake.last_update, body_json, sizeof(fake.last_update) - 1);
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
	CHECK(ota_state() == OTA_AWAITING_USER);
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
#endif

	printf("%d update manager checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
