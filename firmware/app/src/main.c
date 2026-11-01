/*
 * Cranium firmware, application core: the security domain of the product.
 *
 * This is the non-secure application that runs on top of Trusted Firmware-M. It joins
 * Wi-Fi, keeps an authenticated connection to AWS IoT, reports the device's state and
 * installs firmware updates. Everything is driven by one event loop.
 */

#include <string.h>

#include <cJSON_os.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/logging/log_ctrl.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/reboot.h>

#include "app_events.h"
#if defined(CONFIG_APP_BT_OTA)
#include "bt_ota.h"
#endif
#include "cloud.h"
#include "console.h"
#include "device.h"
#include "identity.h"
#include "factory.h"
#include "health.h"
#include "net.h"
#include "ota.h"
#include "ota_job.h"
#include "stuck.h"
#include "ui.h"
#include "version.h"

#if defined(CONFIG_APP_TEST_FAULT_WRECK_SLOTS)
#include <zephyr/storage/flash_map.h>
#include <zephyr/sys/util.h>
#endif

#if defined(CONFIG_APP_TEST_FAULT_GOLDEN_FLIP)
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/flash.h>
#endif

LOG_MODULE_REGISTER(app, CONFIG_APP_LOG_LEVEL);

#define CLOUD_SETTLE_SECONDS    3
#define CLOUD_BACKOFF_MAX       300

K_MSGQ_DEFINE(event_queue, sizeof(struct app_event), 32, 4);

static int cloud_retry_in = -1;
static int cloud_backoff = CONFIG_APP_CLOUD_RETRY_SECONDS;
static int seconds_since_report;
/* A tick is in the queue. A main loop that is held up must not come back to a queue full of them. */
static atomic_t tick_queued;

int app_event_post(const struct app_event *event)
{
	return k_msgq_put(&event_queue, event, K_NO_WAIT);
}

int app_event_post_simple(enum app_event_type type)
{
	const struct app_event event = { .type = type };

	return app_event_post(&event);
}

static void on_tick_timer(struct k_timer *timer)
{
	ARG_UNUSED(timer);

	/* Other events are lost if they find the queue full. What counts time goes by uptime. */
	if (atomic_cas(&tick_queued, 0, 1) && app_event_post_simple(APP_EVENT_TICK) != 0) {
		atomic_set(&tick_queued, 0);
	}
}

K_TIMER_DEFINE(tick_timer, on_tick_timer, NULL);

static bool provisioned(void)
{
	return identity_settings_get() != NULL && net_has_credentials();
}

static void update_ui(void)
{
#if defined(CONFIG_APP_BT_OTA)
	if (bt_ota_is_open()) {
		ui_set_state(bt_ota_ui_state());
		return;
	}
#endif

	switch (ota_state()) {
	case OTA_AWAITING_USER:
		ui_set_state(UI_UPDATE_OFFERED);
		return;
	case OTA_RETRY_WAIT:
	case OTA_REFRESHING:
	case OTA_STARTING:
	case OTA_DOWNLOADING:
	case OTA_VERIFYING:
	case OTA_COMMITTING:
	case OTA_REBOOTING:
		ui_set_state(UI_UPDATE_IN_PROGRESS);
		return;
	case OTA_TESTING:
		ui_set_state(UI_UPDATE_TESTING);
		return;
	default:
		break;
	}

	if (device_is_factory()) {
		ui_set_state(UI_FACTORY);
	} else if (!provisioned()) {
		ui_set_state(UI_UNPROVISIONED);
	} else if (!net_is_up()) {
		ui_set_state(UI_NETWORK_CONNECTING);
	} else if (!cloud_is_connected()) {
		ui_set_state(UI_CLOUD_CONNECTING);
	} else {
		ui_set_state(UI_ONLINE);
	}
}

/* Publish what the console shows for this device. Nothing here is secret. */
static void publish_report(void)
{
	char job[OTA_JOB_ID_MAX + 3] = "null";
	char reported[400];
	const char *job_id = ota_job_id();
	int written;

	if (!cloud_is_connected()) {
		return;
	}

	if (job_id != NULL) {
		(void)snprintk(job, sizeof(job), "\"%s\"", job_id);
	}

	written = snprintk(reported, sizeof(reported),
			   "{\"fw\":{\"version\":\"%s\",\"confirmed\":%s},"
			   "\"ota\":{\"state\":\"%s\",\"job\":%s,\"progress\":%d,"
			   "\"last\":\"%s\",\"error\":\"%s\"},"
			   "\"wifi\":{\"rssi\":%d},\"uptime\":%lld}",
			   fw_version_running_string(),
			   ota_state() == OTA_TESTING ? "false" : "true", ota_state_name(), job,
			   ota_progress(), ota_last_result(), ota_last_error(), net_rssi(),
			   k_uptime_get() / MSEC_PER_SEC);

	if (written > 0 && written < (int)sizeof(reported)) {
		(void)cloud_shadow_report(reported);
	}

	seconds_since_report = 0;
}

static void on_tick(void)
{
	health_feed();

	/* In factory mode the board stays off the network until INIT has been run. */
	if (!device_is_factory()) {
		net_tick();
	}

	if (net_is_up() && !cloud_is_connected() && identity_settings_get() != NULL) {
		/* The events that set this can be lost. Nobody would try again until the link drops. */
		if (cloud_retry_in < 0 && !cloud_is_connecting()) {
			cloud_retry_in = cloud_backoff;
		}

		if (cloud_retry_in >= 0 && --cloud_retry_in < 0) {
			cloud_connect();
		}
	}

	ota_on_tick();

#if defined(CONFIG_APP_BT_OTA)
	bt_ota_on_tick();
	update_ui();
#endif

	if (ota_take_changed()) {
		publish_report();
		update_ui();
	} else if (++seconds_since_report >= CONFIG_APP_SHADOW_INTERVAL_SECONDS) {
		publish_report();
	}

	stuck_on_tick();
}

static void on_button(const struct app_event *event)
{
#if defined(CONFIG_APP_BT_OTA)
	if (bt_ota_on_button(event->button.id, event->button.long_press, event->button.physical)) {
		return;
	}
#endif

	/* Holding Button 2 erases everything that was provisioned onto the device. */
	if (event->button.id == APP_BUTTON_2 && event->button.long_press) {
		if (ota_state() != OTA_IDLE) {
			LOG_WRN("Factory reset ignored while an update is in progress");
			return;
		}

		cloud_disconnect();
		(void)factory_reset();
		LOG_PANIC();
		sys_reboot(SYS_REBOOT_COLD);
	}

	ota_on_button(event->button.id);
}

static void on_job_message(void)
{
	enum cloud_job_message kind;
	const char *payload;
	size_t length;

	if (cloud_job_message_get(&kind, &payload, &length)) {
		ota_on_job_message(kind, payload, length);
	}

	if (cloud_job_message_done()) {
		/* Another jobs message arrived meanwhile and was dropped: ask again. */
		(void)cloud_jobs_request_next();
	}
}

static void decide_mode(void)
{
	switch (device_boot()) {
	case DEVICE_BOOT_MIGRATED:
		console_event("CONSOLE", "migrated: device id set to %s", device_id());
		break;
	case DEVICE_BOOT_MIGRATION_FAILED:
		LOG_ERR("The device id could not be stored; will try again at the next boot");
		break;
	case DEVICE_BOOT_UNREADABLE:
		LOG_ERR("Storage could not be read; running as provisioned, nothing was written");
		break;
	default:
		break;
	}
}

static void handle(const struct app_event *event)
{
	switch (event->type) {
	case APP_EVENT_NET_UP:
		LOG_INF("Network is up");
		net_report_up();
		cloud_retry_in = CLOUD_SETTLE_SECONDS;
		break;
	case APP_EVENT_NET_DOWN:
		LOG_INF("Network is down");
		net_report_down();
		cloud_disconnect();
		cloud_retry_in = -1;
		break;
	case APP_EVENT_NET_JOIN:
		stuck_on_new_settings();
		(void)net_connect();
		break;
	case APP_EVENT_NET_JOIN_FAILED:
		net_report_join_failed(event->join_failed.reason);
		break;
	case APP_EVENT_CLOUD_UP:
		LOG_INF("Connected to AWS IoT");
		cloud_backoff = CONFIG_APP_CLOUD_RETRY_SECONDS;
		cloud_retry_in = -1;
		ota_on_cloud_up();
		publish_report();
		break;
	case APP_EVENT_CLOUD_DOWN:
		LOG_INF("Disconnected from AWS IoT");
		if (net_is_up()) {
			cloud_retry_in = cloud_backoff;
			cloud_backoff = MIN(cloud_backoff * 2, CLOUD_BACKOFF_MAX);
		}
		break;
	case APP_EVENT_CLOUD_CHANGED:
		stuck_on_new_settings();
		cloud_backoff = CONFIG_APP_CLOUD_RETRY_SECONDS;
		cloud_retry_in = CLOUD_SETTLE_SECONDS;
		break;
	case APP_EVENT_JOB_MESSAGE:
		on_job_message();
		break;
	case APP_EVENT_JOB_ACK:
		ota_on_job_ack(event->job_ack.kind, event->job_ack.sequence, event->job_ack.accepted,
			       event->job_ack.permanent);
		break;
	case APP_EVENT_BUTTON:
		on_button(event);
		break;
	case APP_EVENT_DOWNLOAD:
		ota_on_download(event->download.what, event->download.value);
		break;
	case APP_EVENT_TICK:
		atomic_set(&tick_queued, 0);
		on_tick();
		return;
	case APP_EVENT_CALL:
		event->call.function();
		break;
	default:
		break;
	}

	update_ui();
}

#if defined(CONFIG_APP_TEST_FAULT_WRECK_SLOTS)
/* Where an MCUboot image keeps its metadata. See bootutil/image.h in MCUboot. */
#define IMAGE_HEADER_HDR_SIZE_OFFSET 8
#define IMAGE_TLV_INFO_MAGIC         0x6907
#define IMAGE_TLV_SHA256             0x10

struct image_sizes {
	uint16_t header;
	uint16_t protected_tlv;
	uint32_t image;
};

struct image_tlv_entry {
	uint8_t type;
	uint8_t unused;
	uint16_t length;
};

struct image_tlv_area {
	uint16_t magic;
	uint16_t total;
};

/* Writing zeros needs no erase: that is why anything with write access can do this. */
static void clear_word(const struct flash_area *area, off_t offset)
{
	const uint32_t zero = 0;
	int err = flash_area_write(area, offset, &zero, sizeof(zero));

	LOG_ERR("Test image: cleared the word at %ld of area %u: %d", (long)offset, area->fa_id, err);
}

/* The offset of the first whole word of the image's hash, or -1 if it cannot be found. */
static off_t find_hash(const struct flash_area *area)
{
	struct image_sizes sizes;
	struct image_tlv_area tlvs;
	struct image_tlv_entry entry;
	off_t offset;
	off_t end;

	if (flash_area_read(area, IMAGE_HEADER_HDR_SIZE_OFFSET, &sizes, sizeof(sizes)) != 0) {
		return -1;
	}

	offset = (off_t)sizes.header + sizes.image + sizes.protected_tlv;
	if (flash_area_read(area, offset, &tlvs, sizeof(tlvs)) != 0 ||
	    tlvs.magic != IMAGE_TLV_INFO_MAGIC) {
		return -1;
	}

	end = offset + tlvs.total;
	offset += sizeof(tlvs);

	while (offset < end && flash_area_read(area, offset, &entry, sizeof(entry)) == 0) {
		offset += sizeof(entry);
		if (entry.type == IMAGE_TLV_SHA256) {
			return ROUND_UP(offset, sizeof(uint32_t));
		}
		offset += entry.length;
	}

	return -1;
}

/* What a compromised application could do to the way back. It runs once: then nothing is valid. */
static void wreck_slots(void)
{
	const struct flash_area *area;
	off_t hash;

	if (flash_area_open(PARTITION_ID(slot0_partition), &area) == 0) {
		hash = find_hash(area);
		if (hash >= 0) {
			clear_word(area, hash);
		} else {
			LOG_ERR("Test image: the primary slot's hash was not found");
		}
		flash_area_close(area);
	}

	if (flash_area_open(PARTITION_ID(slot1_partition), &area) == 0) {
		clear_word(area, 0);
		flash_area_close(area);
	}
}
#endif /* CONFIG_APP_TEST_FAULT_WRECK_SLOTS */

#if defined(CONFIG_APP_TEST_FAULT_GOLDEN_FLIP)
/* golden_partition in MCUboot's overlay. This application has no area for it, on purpose. */
#define GOLDEN_FLASH_ADDRESS 0x700000

/* Clear one set bit: writing zeros needs no erase. Each boot of this image clears one more. */
static void damage_golden_copy(void)
{
	const struct device *flash = DEVICE_DT_GET(DT_NODELABEL(mx25r64));
	const off_t address = GOLDEN_FLASH_ADDRESS + CONFIG_APP_TEST_GOLDEN_FLIP_OFFSET;
	uint8_t before;
	uint8_t after;
	int err = device_is_ready(flash) ? flash_read(flash, address, &before, 1) : -ENODEV;

	if (err == 0 && before == 0) {
		LOG_ERR("Test image: the golden byte at %ld has no bit left to clear", (long)address);
		return;
	}

	if (err == 0) {
		after = before & (before - 1);
		err = flash_write(flash, address, &after, 1);
	}

	if (err != 0) {
		LOG_ERR("Test image: the golden copy could not be damaged: %d", err);
		return;
	}

	LOG_ERR("Test image: golden byte at %ld changed from %02x to %02x", (long)address, before,
		after);
}
#endif /* CONFIG_APP_TEST_FAULT_GOLDEN_FLIP */

int main(void)
{
	struct app_event event;

	LOG_INF("Cranium firmware %s", fw_version_running_string());

	cJSON_Init();

	if (health_init() != 0) {
		LOG_WRN("Running without a watchdog");
	}

	(void)ui_init();

	if (identity_init() != 0) {
		LOG_ERR("Device identity is not available");
	}

	LOG_INF("Thing name: %s", identity_thing_name());

	decide_mode();
	console_start();
	stuck_init();

	if (ota_init() != 0) {
		LOG_ERR("Update manager could not start");
	}

	if (net_init() != 0) {
		LOG_ERR("Networking could not start");
	}

	/*
	 * Whatever came of that. net_init() does not wait for the Wi-Fi stack, so this runs on a chip
	 * that did not come up as well. net_connect() tries the interface again from the tick, and
	 * the stuck timers restart the board if it stays that way.
	 */
	if (cloud_init() != 0) {
		LOG_ERR("The cloud connection could not start");
	}

	if (device_is_factory()) {
		LOG_WRN("Factory mode: send INIT|<id> on the console");
	} else if (net_has_credentials()) {
		(void)net_connect();
	}

	if (!device_is_factory() && !provisioned()) {
		LOG_WRN("This device is not provisioned yet (see tools/provision_device.py)");
	}

	update_ui();
	k_timer_start(&tick_timer, K_SECONDS(1), K_SECONDS(1));

	if (IS_ENABLED(CONFIG_APP_TEST_FAULT_CRASH)) {
		LOG_ERR("Test image: crashing on purpose");
		LOG_PANIC();
		k_oops();
	}

	if (IS_ENABLED(CONFIG_APP_TEST_FAULT_HANG)) {
		LOG_ERR("Test image: hanging on purpose, the watchdog will fire");
		while (true) {
			k_msleep(MSEC_PER_SEC);
		}
	}

#if defined(CONFIG_APP_TEST_FAULT_WRECK_SLOTS)
	LOG_ERR("Test image: damaging both image slots on purpose");
	wreck_slots();
	LOG_PANIC();
	sys_reboot(SYS_REBOOT_COLD);
#endif

#if defined(CONFIG_APP_TEST_FAULT_GOLDEN_FLIP)
	LOG_ERR("Test image: damaging the golden copy on purpose");
	damage_golden_copy();
#endif

	while (true) {
		(void)k_msgq_get(&event_queue, &event, K_FOREVER);
		handle(&event);
	}

	return 0;
}
