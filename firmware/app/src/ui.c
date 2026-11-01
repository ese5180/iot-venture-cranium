#include "ui.h"

#include <zephyr/drivers/gpio.h>
#include <zephyr/input/input.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/atomic.h>

#include "app_events.h"

LOG_MODULE_REGISTER(ui, CONFIG_APP_LOG_LEVEL);

#define STEP_MS       125
#define STEPS         16
#define LONG_PRESS_MS 5000

static const struct gpio_dt_spec status_led = GPIO_DT_SPEC_GET(DT_ALIAS(led0), gpios);

/* One bit per 125 ms step, least significant bit first: a two-second cycle. */
static const uint16_t patterns[] = {
	[UI_FACTORY] = 0x000f,
	[UI_UNPROVISIONED] = 0x0001,
	[UI_NETWORK_CONNECTING] = 0x00ff,
	[UI_CLOUD_CONNECTING] = 0x0f0f,
	[UI_ONLINE] = 0xffff,
	[UI_UPDATE_OFFERED] = 0x5555,
	[UI_UPDATE_IN_PROGRESS] = 0x0505,
	[UI_UPDATE_TESTING] = 0x0015,
};

static atomic_t current_pattern = ATOMIC_INIT(0x0001);
static int64_t pressed_at[2];

static void led_step(struct k_timer *timer)
{
	static uint8_t step;
	uint16_t pattern = (uint16_t)atomic_get(&current_pattern);

	ARG_UNUSED(timer);

	(void)gpio_pin_set_dt(&status_led, (pattern >> step) & 1U);
	step = (step + 1) % STEPS;
}

K_TIMER_DEFINE(led_timer, led_step, NULL);

static void on_input(struct input_event *event, void *user_data)
{
	uint8_t button;

	ARG_UNUSED(user_data);

	if (event->type != INPUT_EV_KEY) {
		return;
	}

	if (event->code == INPUT_KEY_0) {
		button = APP_BUTTON_1;
	} else if (event->code == INPUT_KEY_1) {
		button = APP_BUTTON_2;
	} else {
		return;
	}

	if (event->value) {
		pressed_at[button] = k_uptime_get();
		return;
	}

	/*
	 * A release with no press seen: the button was already down when the input driver
	 * started, so its press was never reported. Holding it through a boot says nothing,
	 * and without this check the uptime alone would make it a long press, which is a
	 * factory reset.
	 */
	if (pressed_at[button] == 0) {
		return;
	}

	/* Act on release so that a long press can be told apart from a short one. */
	const struct app_event app_event = {
		.type = APP_EVENT_BUTTON,
		.button = {
			.id = button,
			.long_press = (k_uptime_get() - pressed_at[button]) >= LONG_PRESS_MS,
		},
	};

	pressed_at[button] = 0;

	(void)app_event_post(&app_event);
}

INPUT_CALLBACK_DEFINE(NULL, on_input, NULL);

int ui_init(void)
{
	int err;

	if (!gpio_is_ready_dt(&status_led)) {
		LOG_ERR("Status LED is not ready");
		return -ENODEV;
	}

	err = gpio_pin_configure_dt(&status_led, GPIO_OUTPUT_INACTIVE);
	if (err) {
		return err;
	}

	k_timer_start(&led_timer, K_MSEC(STEP_MS), K_MSEC(STEP_MS));
	return 0;
}

void ui_set_state(enum ui_state state)
{
	if ((size_t)state < ARRAY_SIZE(patterns)) {
		atomic_set(&current_pattern, patterns[state]);
	}
}
