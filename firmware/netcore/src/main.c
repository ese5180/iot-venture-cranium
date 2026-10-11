/*
 * Network-core image: the base-function domain.
 *
 * The application core is the security domain: verified boot, TF-M, credentials, the
 * cloud connection and firmware updates all live there. This core only shows that the
 * product's ordinary work keeps running independently: it blinks LED2. The application
 * core hands it that one pin and releases it from reset; nothing else is shared.
 */

#include <zephyr/kernel.h>
#include <zephyr/drivers/gpio.h>

#define HEARTBEAT_PERIOD_MS 1000

static const struct gpio_dt_spec heartbeat_led = GPIO_DT_SPEC_GET(DT_ALIAS(led1), gpios);

int main(void)
{
	if (!gpio_is_ready_dt(&heartbeat_led)) {
		return 0;
	}

	if (gpio_pin_configure_dt(&heartbeat_led, GPIO_OUTPUT_INACTIVE) < 0) {
		return 0;
	}

	while (true) {
		(void)gpio_pin_toggle_dt(&heartbeat_led);
		k_msleep(HEARTBEAT_PERIOD_MS / 2);
	}

	return 0;
}
