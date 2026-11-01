#include "stuck.h"

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/logging/log_ctrl.h>
#include <zephyr/sys/reboot.h>

#if defined(CONFIG_APP_BT_OTA)
#include "bt_ota.h"
#endif
#include "cloud.h"
#include "console.h"
#include "device.h"
#include "factory.h"
#include "health.h"
#include "identity.h"
#include "net.h"
#include "ota.h"
#include "store.h"
#include "stuck_policy.h"

LOG_MODULE_REGISTER(stuck, CONFIG_APP_LOG_LEVEL);

/* Asking TF-M about the key and the certificate takes a while, and they seldom change. */
#define KEYS_CHECK_SECONDS 60

static struct stuck_state state;
static struct {
	bool known;
	bool present;
	uint32_t checked_at;
} keys;

static uint32_t uptime_seconds(void)
{
	return (uint32_t)(k_uptime_get() / MSEC_PER_SEC);
}

static bool has_device_keys(uint32_t now)
{
	if (!keys.known || now - keys.checked_at >= KEYS_CHECK_SECONDS) {
		keys.known = true;
		keys.checked_at = now;
		keys.present = factory_has_private_key() && factory_has_certificate();
	}

	return keys.present;
}

/*
 * None of the watched states has asked the bootloader for anything. Of a cloud update, only
 * install_download() in ota.c asks for a swap, on the main loop, and it restarts in the same call.
 * The only other code that asks is install_image() in bt_ota.c, in a Bluetooth build, which runs
 * with a window open, and that holds every timer. So a restart in any of these states installs
 * nothing and leaves the image that runs in charge. If the job is in progress in the cloud by then,
 * settle_interrupted_job() closes it as `interrupted` after the restart, and one that is still
 * queued starts again, or is offered again in a build with CONFIG_APP_OTA_REQUIRE_USER_CONSENT.
 */
static enum stuck_update update_kind(void)
{
	switch (ota_state()) {
	case OTA_IDLE:
	case OTA_AWAITING_USER:
		return STUCK_UPDATE_NONE;
	case OTA_RETRY_WAIT:
	case OTA_REFRESHING:
	case OTA_STARTING:
	case OTA_DOWNLOADING:
	case OTA_COMMITTING:
	case OTA_REBOOTING:
		return STUCK_UPDATE_WATCHED;
	default:
		/*
		 * OTA_VERIFYING comes and goes within one event, so no tick sees it. A hash that
		 * blocks is for the watchdog. OTA_TESTING has the trial's deadline, and
		 * OTA_BLUETOOTH the limits of a window.
		 */
		return STUCK_UPDATE_BOUNDED;
	}
}

static void restart(uint32_t actions)
{
	console_event("STUCK", "restarting reason=%s count=%u", stuck_reason_text(state.reason),
		      (unsigned int)state.count);

	if (actions & STUCK_DO_WRITE) {
		struct stuck_record record = stuck_record_of(&state);

		/* If this fails the next restart comes sooner, and that is all that happens. */
		(void)store_write(STORE_STUCK, &record, sizeof(record));
	}

	/* The way health.c ends a trial. Nothing else is touched: it may be what is stuck. */
	LOG_PANIC();
	sys_reboot(SYS_REBOOT_COLD);
}

void stuck_init(void)
{
	struct stuck_record record;
	bool readable = store_read(STORE_STUCK, &record, sizeof(record)) == 0;

	stuck_state_init(&state, readable ? &record : NULL, uptime_seconds());

	if (state.reason != STUCK_REASON_NONE) {
		LOG_WRN("Restarted earlier for being stuck: reason=%s count=%u",
			stuck_reason_text(state.reason), (unsigned int)state.count);
	}
}

void stuck_on_tick(void)
{
	uint32_t now = uptime_seconds();
	struct stuck_board board = {
		.uptime_seconds = now,
		.factory = device_is_factory(),
		.network_stored = net_has_credentials(),
		.provisioned = identity_settings_get() != NULL && has_device_keys(now),
		.trial = health_trial_active(),
		.update = update_kind(),
		.link_up = net_is_up(),
		.cloud_up = cloud_is_connected(),
		.wifi_answers = net_wifi_answers(),
		.update_progress = ota_stuck_progress(),
	};
	uint32_t actions;

#if defined(CONFIG_APP_BT_OTA)
	board.bt_window = bt_ota_is_open();
#endif

	actions = stuck_tick(&state, &board);

	if (actions & STUCK_DO_ERASE) {
		LOG_INF("Well for long enough: the count of restarts goes back to 0");
		(void)store_erase(STORE_STUCK);
	}

	if (actions & STUCK_DO_RESTART) {
		restart(actions);
	}
}

void stuck_on_new_settings(void)
{
	stuck_settings_changed(&state);
}

uint8_t stuck_count(void)
{
	return state.count;
}

const char *stuck_reason_name(void)
{
	return stuck_reason_text(state.reason);
}
