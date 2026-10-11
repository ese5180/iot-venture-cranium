#include "health.h"

#include <zephyr/drivers/watchdog.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/logging/log_ctrl.h>
#include <zephyr/sys/reboot.h>

LOG_MODULE_REGISTER(health, CONFIG_APP_LOG_LEVEL);

static const struct device *const watchdog = DEVICE_DT_GET(DT_ALIAS(watchdog0));
static int watchdog_channel = -1;

static bool trial_active;
static int64_t trial_deadline;

int health_init(void)
{
	const struct wdt_timeout_cfg config = {
		.window.min = 0,
		.window.max = CONFIG_APP_WATCHDOG_TIMEOUT_SECONDS * MSEC_PER_SEC,
		.callback = NULL,
		.flags = WDT_FLAG_RESET_SOC,
	};
	int err;

	if (!device_is_ready(watchdog)) {
		LOG_ERR("Watchdog is not ready");
		return -ENODEV;
	}

	watchdog_channel = wdt_install_timeout(watchdog, &config);
	if (watchdog_channel < 0) {
		LOG_ERR("Watchdog timeout could not be installed: %d", watchdog_channel);
		return watchdog_channel;
	}

	err = wdt_setup(watchdog, WDT_OPT_PAUSE_HALTED_BY_DBG);
	if (err) {
		LOG_ERR("Watchdog could not be started: %d", err);
		watchdog_channel = -1;
		return err;
	}

	return 0;
}

void health_feed(void)
{
	if (watchdog_channel >= 0) {
		(void)wdt_feed(watchdog, watchdog_channel);
	}

	if (trial_active && k_uptime_get() > trial_deadline) {
		/*
		 * The new image did not prove that it can still reach the cloud. Resetting
		 * without confirming it makes the bootloader swap the previous image back.
		 */
		LOG_ERR("New image was not confirmed in %d s: rebooting to revert",
			CONFIG_APP_OTA_SELF_TEST_TIMEOUT_SECONDS);
		LOG_PANIC();
		sys_reboot(SYS_REBOOT_COLD);
	}
}

void health_trial_begin(void)
{
	trial_deadline = k_uptime_get() +
			 (int64_t)CONFIG_APP_OTA_SELF_TEST_TIMEOUT_SECONDS * MSEC_PER_SEC;
	trial_active = true;
}

void health_trial_passed(void)
{
	trial_active = false;
}

bool health_trial_active(void)
{
	return trial_active;
}
