/*
 * Host-side tests of ui.c: what a button does, and above all what it must not do. A release
 * with no press seen has to be ignored, because a button held through a boot would otherwise
 * count as a long press, and a long press of Button 2 is a factory reset.
 *
 * The real file is compiled here, to get at its input callback, which is static.
 */

#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#include "ui.c"

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

static int64_t uptime_ms;
static struct app_event posted[8];
static int posted_count;

int64_t k_uptime_get(void)
{
	return uptime_ms;
}

int app_event_post(const struct app_event *event)
{
	if (posted_count < (int)ARRAY_SIZE(posted)) {
		posted[posted_count] = *event;
	}
	posted_count++;
	return 0;
}

void k_timer_start(struct k_timer *timer, k_timeout_t duration, k_timeout_t period)
{
	ARG_UNUSED(timer);
	ARG_UNUSED(duration);
	ARG_UNUSED(period);
}

static void key(uint16_t code, bool pressed)
{
	struct input_event event = { .type = INPUT_EV_KEY, .code = code, .value = pressed };

	host_input_callback(&event, NULL);
}

static void fresh_boot(void)
{
	pressed_at[APP_BUTTON_1] = 0;
	pressed_at[APP_BUTTON_2] = 0;
	posted_count = 0;
	uptime_ms = 0;
}

static void test_button_held_through_a_boot_is_no_factory_reset(void)
{
	fresh_boot();
	/* The driver saw the button down when it started, and reports no press for that. */
	uptime_ms = 70000;
	key(INPUT_KEY_1, false);
	CHECK(posted_count == 0);

	/* Button 1 the same way: it would have declined or accepted an update. */
	key(INPUT_KEY_0, false);
	CHECK(posted_count == 0);
}

static void test_the_next_press_after_that_counts_again(void)
{
	fresh_boot();
	uptime_ms = 70000;
	key(INPUT_KEY_1, false);
	CHECK(posted_count == 0);

	uptime_ms = 71000;
	key(INPUT_KEY_1, true);
	uptime_ms = 71200;
	key(INPUT_KEY_1, false);
	CHECK(posted_count == 1);
	CHECK(posted[0].type == APP_EVENT_BUTTON);
	CHECK(posted[0].button.id == APP_BUTTON_2);
	CHECK(!posted[0].button.long_press);
}

static void test_short_press(void)
{
	fresh_boot();
	uptime_ms = 10000;
	key(INPUT_KEY_0, true);
	CHECK(posted_count == 0);

	uptime_ms = 14999;
	key(INPUT_KEY_0, false);
	CHECK(posted_count == 1);
	CHECK(posted[0].button.id == APP_BUTTON_1);
	CHECK(!posted[0].button.long_press);
}

static void test_long_press_is_still_a_long_press(void)
{
	fresh_boot();
	uptime_ms = 10000;
	key(INPUT_KEY_1, true);
	uptime_ms = 15000;
	key(INPUT_KEY_1, false);
	CHECK(posted_count == 1);
	CHECK(posted[0].button.id == APP_BUTTON_2);
	CHECK(posted[0].button.long_press);
}

static void test_a_press_counts_once(void)
{
	fresh_boot();
	uptime_ms = 10000;
	key(INPUT_KEY_1, true);
	uptime_ms = 10100;
	key(INPUT_KEY_1, false);
	CHECK(posted_count == 1);

	/* The press has been used up: a second release must not be measured against it. */
	uptime_ms = 20000;
	key(INPUT_KEY_1, false);
	CHECK(posted_count == 1);
}

static void test_the_buttons_do_not_share_a_press(void)
{
	fresh_boot();
	uptime_ms = 10000;
	key(INPUT_KEY_0, true);

	/* Button 2 was down from before the boot; Button 1's press says nothing about it. */
	uptime_ms = 20000;
	key(INPUT_KEY_1, false);
	CHECK(posted_count == 0);

	key(INPUT_KEY_0, false);
	CHECK(posted_count == 1);
	CHECK(posted[0].button.id == APP_BUTTON_1);
	CHECK(posted[0].button.long_press);
}

#if defined(CONFIG_APP_BT_OTA)
static void test_a_real_press_says_it_is_one(void)
{
	fresh_boot();
	uptime_ms = 10000;
	key(INPUT_KEY_0, true);
	uptime_ms = 15000;
	key(INPUT_KEY_0, false);
	CHECK(posted_count == 1);
	CHECK(posted[0].button.physical);
	CHECK(posted[0].button.long_press);
}

static void test_the_window_has_a_pattern_of_its_own(void)
{
	for (size_t i = 0; i < ARRAY_SIZE(patterns); i++) {
		CHECK(i == UI_BT_WINDOW || patterns[i] != patterns[UI_BT_WINDOW]);
	}
}
#endif

static void test_other_input_is_ignored(void)
{
	struct input_event not_a_key = { .type = INPUT_EV_REL, .code = INPUT_KEY_1, .value = 1 };

	fresh_boot();
	uptime_ms = 10000;
	host_input_callback(&not_a_key, NULL);
	CHECK(pressed_at[APP_BUTTON_2] == 0);

	key(INPUT_KEY_2, true);
	key(INPUT_KEY_2, false);
	CHECK(posted_count == 0);
}

int main(void)
{
	test_button_held_through_a_boot_is_no_factory_reset();
	test_the_next_press_after_that_counts_again();
	test_short_press();
	test_long_press_is_still_a_long_press();
	test_a_press_counts_once();
	test_the_buttons_do_not_share_a_press();
	test_other_input_is_ignored();
#if defined(CONFIG_APP_BT_OTA)
	test_a_real_press_says_it_is_one();
	test_the_window_has_a_pattern_of_its_own();
#endif

	printf("%d button checks, %d failed\n", checks, failures);
	return failures ? 1 : 0;
}
