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
#include <zephyr/sys/reboot.h>

#include "app_events.h"
#include "cloud.h"
#include "console.h"
#include "device.h"
#include "identity.h"
#include "factory.h"
#include "health.h"
#include "net.h"
#include "ota.h"
#include "ota_job.h"
#include "ui.h"
#include "version.h"

LOG_MODULE_REGISTER(app, CONFIG_APP_LOG_LEVEL);

#define CLOUD_SETTLE_SECONDS    3
#define CLOUD_BACKOFF_MAX       300

K_MSGQ_DEFINE(event_queue, sizeof(struct app_event), 32, 4);

static int cloud_retry_in = -1;
static int cloud_backoff = CONFIG_APP_CLOUD_RETRY_SECONDS;
static int seconds_since_report;

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
	(void)app_event_post_simple(APP_EVENT_TICK);
}

K_TIMER_DEFINE(tick_timer, on_tick_timer, NULL);

static bool provisioned(void)
{
	return identity_settings_get() != NULL && net_has_credentials();
}

static void update_ui(void)
{
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

	if (net_is_up() && !cloud_is_connected() && identity_settings_get() != NULL &&
	    cloud_retry_in >= 0 && --cloud_retry_in < 0) {
		cloud_connect();
	}

	ota_on_tick();

	if (ota_take_changed()) {
		publish_report();
		update_ui();
	} else if (++seconds_since_report >= CONFIG_APP_SHADOW_INTERVAL_SECONDS) {
		publish_report();
	}
}

static void on_button(const struct app_event *event)
{
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

	if (ota_init() != 0) {
		LOG_ERR("Update manager could not start");
	}

	if (net_init() != 0 || cloud_init() != 0) {
		LOG_ERR("Networking could not start");
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

	while (true) {
		(void)k_msgq_get(&event_queue, &event, K_FOREVER);
		handle(&event);
	}

	return 0;
}
