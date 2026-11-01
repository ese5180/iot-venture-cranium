/*
 * Host-side tests of what the golden image's code in the bootloader decides: every timing of
 * the gesture, every row of the table that says what to do with the flash, and the order of a
 * restore's erase. And the bootloader's check on serial recovery's image number, which is built in
 * with or without the golden image.
 *
 * What this cannot show is that the pin and the LED do what these decisions ask of them, or
 * that the flash work is right. firmware/tests/hil/golden_bench.py reads the pins for that (G4,
 * G9), and looks at what an interrupted restore leaves (G11).
 */

#include <errno.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#include "bootutil/boot_hooks.h"
#include "golden_policy.h"

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

/* Run the gesture on a button that is down from 0 up to held_ms, then stays up. */
static enum golden_gesture_result run_hold(uint32_t held_ms, uint32_t *ended_at_ms)
{
	struct golden_gesture gesture = { 0 };
	enum golden_gesture_result result;
	uint32_t now_ms = 0;

	do {
		result = golden_gesture_step(&gesture, now_ms, now_ms < held_ms);
		if (result == GOLDEN_GESTURE_WAIT) {
			now_ms += GOLDEN_SAMPLE_MS;
		}
	} while (result == GOLDEN_GESTURE_WAIT);

	if (ended_at_ms != NULL) {
		*ended_at_ms = now_ms;
	}

	return result;
}

static void test_no_button_costs_one_reading(void)
{
	struct golden_gesture gesture = { 0 };

	CHECK(golden_gesture_step(&gesture, 0, false) == GOLDEN_GESTURE_NOT_PRESSED);
}

static void test_released_early_boots_normally(void)
{
	const uint32_t early[] = { 20, 100, 2000, 4000, 4900, 4980 };

	for (size_t i = 0; i < sizeof(early) / sizeof(early[0]); i++) {
		CHECK(run_hold(early[i], NULL) == GOLDEN_GESTURE_NOT_COMPLETED);
	}
}

static void test_released_in_the_window_fires(void)
{
	const uint32_t in_time[] = { 5000, 5020, 6000, 7500, 9000, 9980 };

	for (size_t i = 0; i < sizeof(in_time) / sizeof(in_time[0]); i++) {
		CHECK(run_hold(in_time[i], NULL) == GOLDEN_GESTURE_FIRED);
	}
}

static void test_held_past_the_window_cancels_and_waits_for_the_release(void)
{
	const uint32_t late[] = { 10000, 10020, 15000, 30000, 59980 };

	for (size_t i = 0; i < sizeof(late) / sizeof(late[0]); i++) {
		uint32_t ended_at_ms;

		CHECK(run_hold(late[i], &ended_at_ms) == GOLDEN_GESTURE_NOT_COMPLETED);
		/* The application must not start while the button is down. */
		CHECK(ended_at_ms >= late[i] + GOLDEN_RELEASE_MS);
	}
}

static void test_a_stuck_button_boots_anyway(void)
{
	uint32_t ended_at_ms;

	CHECK(run_hold(UINT32_MAX, &ended_at_ms) == GOLDEN_GESTURE_STUCK);
	CHECK(ended_at_ms == GOLDEN_GIVE_UP_MS);
}

static void test_the_release_is_dated_from_when_the_button_came_up(void)
{
	uint32_t ended_at_ms;

	/* Believed only after the 5 s mark, but it came up before it. */
	CHECK(run_hold(4960, &ended_at_ms) == GOLDEN_GESTURE_NOT_COMPLETED);
	CHECK(ended_at_ms >= GOLDEN_ARMED_MS);

	/* Believed only after the 10 s mark, but it came up before it. */
	CHECK(run_hold(9960, &ended_at_ms) == GOLDEN_GESTURE_FIRED);
	CHECK(ended_at_ms >= GOLDEN_CANCEL_MS);
}

static void test_a_short_release_is_contact_bounce(void)
{
	struct golden_gesture gesture = { 0 };

	CHECK(golden_gesture_step(&gesture, 0, true) == GOLDEN_GESTURE_WAIT);
	CHECK(golden_gesture_step(&gesture, 1000, false) == GOLDEN_GESTURE_WAIT);
	CHECK(golden_gesture_step(&gesture, 1080, false) == GOLDEN_GESTURE_WAIT);
	CHECK(golden_gesture_step(&gesture, 1100, true) == GOLDEN_GESTURE_WAIT);
	/* The 100 ms start again from here. */
	CHECK(golden_gesture_step(&gesture, 6000, false) == GOLDEN_GESTURE_WAIT);
	CHECK(golden_gesture_step(&gesture, 6080, false) == GOLDEN_GESTURE_WAIT);
	CHECK(golden_gesture_step(&gesture, 6100, false) == GOLDEN_GESTURE_FIRED);
}

static void test_exactly_the_release_time_counts(void)
{
	struct golden_gesture gesture = { 0 };

	CHECK(golden_gesture_step(&gesture, 0, true) == GOLDEN_GESTURE_WAIT);
	CHECK(golden_gesture_step(&gesture, 7000, false) == GOLDEN_GESTURE_WAIT);
	CHECK(golden_gesture_step(&gesture, 7000 + GOLDEN_RELEASE_MS - 1, false) ==
	      GOLDEN_GESTURE_WAIT);
	CHECK(golden_gesture_step(&gesture, 7000 + GOLDEN_RELEASE_MS, false) ==
	      GOLDEN_GESTURE_FIRED);
}

static void test_a_bounce_across_the_cancel_mark_does_not_fire(void)
{
	struct golden_gesture gesture = { 0 };

	CHECK(golden_gesture_step(&gesture, 0, true) == GOLDEN_GESTURE_WAIT);
	CHECK(golden_gesture_step(&gesture, 9960, false) == GOLDEN_GESTURE_WAIT);
	/* Down again: that release did not count, and now the 10 s have passed. */
	CHECK(golden_gesture_step(&gesture, 10000, true) == GOLDEN_GESTURE_WAIT);
	CHECK(golden_gesture_step(&gesture, 10020, false) == GOLDEN_GESTURE_WAIT);
	CHECK(golden_gesture_step(&gesture, 10120, false) == GOLDEN_GESTURE_NOT_COMPLETED);
}

static void test_held_at_the_cancel_mark_a_release_is_too_late(void)
{
	struct golden_gesture gesture = { 0 };

	CHECK(golden_gesture_step(&gesture, 0, true) == GOLDEN_GESTURE_WAIT);
	CHECK(golden_gesture_step(&gesture, 10000, true) == GOLDEN_GESTURE_WAIT);
	CHECK(golden_gesture_step(&gesture, 10020, false) == GOLDEN_GESTURE_WAIT);
	CHECK(golden_gesture_step(&gesture, 10120, false) == GOLDEN_GESTURE_NOT_COMPLETED);
}

static void test_the_led_shows_when_to_let_go(void)
{
	int changes = 0;

	CHECK(!golden_gesture_led(0));
	CHECK(!golden_gesture_led(GOLDEN_ARMED_MS - 1));

	/* 100 ms on and 100 ms off: what the README calls blinking fast. */
	CHECK(golden_gesture_led(5000));
	CHECK(golden_gesture_led(5099));
	CHECK(!golden_gesture_led(5100));
	CHECK(!golden_gesture_led(5199));
	CHECK(golden_gesture_led(5200));

	for (uint32_t now_ms = GOLDEN_ARMED_MS; now_ms + GOLDEN_SAMPLE_MS < GOLDEN_CANCEL_MS;
	     now_ms += GOLDEN_SAMPLE_MS) {
		if (golden_gesture_led(now_ms) != golden_gesture_led(now_ms + GOLDEN_SAMPLE_MS)) {
			changes++;
		}
	}

	CHECK(changes == 49);
	CHECK(!golden_gesture_led(GOLDEN_CANCEL_MS));
	CHECK(!golden_gesture_led(GOLDEN_GIVE_UP_MS));
}

static void test_the_table(void)
{
	CHECK(golden_decide(false, true) == GOLDEN_ACTION_RESTORE);
	CHECK(golden_decide(true, false) == GOLDEN_ACTION_SEAL);
	CHECK(golden_decide(true, true) == GOLDEN_ACTION_NOTHING);
	CHECK(golden_decide(false, false) == GOLDEN_ACTION_REFUSE);
}

/* A slot of 228 sectors of 4 KiB, as on this board, and one of the smallest that can have a plan. */
static void check_erase_steps(uint32_t sectors, uint32_t sector_size)
{
	enum { MAX_SECTORS = 256 };
	struct golden_erase_step steps[GOLDEN_ERASE_STEPS];
	const uint32_t slot_size = sectors * sector_size;
	int erased[MAX_SECTORS] = { 0 };

	golden_erase_steps(slot_size, sector_size, steps);

	/* The trailer is at the very end of the slot, and goes on its own, first. */
	CHECK(steps[0].off == slot_size - sector_size);
	CHECK(steps[0].size == sector_size);

	/* The image's header is at the very start. It goes on its own, next. */
	CHECK(steps[1].off == 0);
	CHECK(steps[1].size == sector_size);

	/* Everything is erased, once, on sector boundaries, and nothing outside the slot. */
	for (int i = 0; i < GOLDEN_ERASE_STEPS; i++) {
		CHECK(steps[i].off % sector_size == 0);
		CHECK(steps[i].size % sector_size == 0);
		CHECK(steps[i].off + steps[i].size <= slot_size);

		for (uint32_t off = steps[i].off; off < steps[i].off + steps[i].size; off += sector_size) {
			erased[off / sector_size]++;
		}
	}

	for (uint32_t sector = 0; sector < sectors; sector++) {
		CHECK(erased[sector] == 1);
	}
}

static void test_a_restore_erases_the_trailer_and_then_the_header(void)
{
	check_erase_steps(228, 4096);
	check_erase_steps(3, 4096);
	check_erase_steps(10, 8192);
}

static void test_serial_recovery_takes_image_zero_only(void)
{
	/* Each of these selects a flash area on a build without the guard, or nothing at all. */
	const int others[] = { 1, 2, 3, 4, 7, 89, 118, 608, 4095, INT_MAX, -1, INT_MIN };
	int id = 1234;

	CHECK(flash_area_id_from_multi_image_slot_hook(0, 0, &id) == BOOT_HOOK_REGULAR);
	CHECK(flash_area_id_from_multi_image_slot_hook(0, 1, &id) == BOOT_HOOK_REGULAR);
	CHECK(id == 1234);

	for (size_t i = 0; i < sizeof(others) / sizeof(others[0]); i++) {
		id = 1234;
		CHECK(flash_area_id_from_multi_image_slot_hook(others[i], 0, &id) == 0);
		CHECK(id == -EINVAL);
		/*
		 * flash_area_open() takes the id as a uint8_t. This build's flash map holds the
		 * ids 0 to 4, so what is left of it must not be one of them.
		 */
		CHECK((uint8_t)id > 4);
	}
}

int main(void)
{
	test_no_button_costs_one_reading();
	test_released_early_boots_normally();
	test_released_in_the_window_fires();
	test_held_past_the_window_cancels_and_waits_for_the_release();
	test_a_stuck_button_boots_anyway();
	test_the_release_is_dated_from_when_the_button_came_up();
	test_a_short_release_is_contact_bounce();
	test_exactly_the_release_time_counts();
	test_a_bounce_across_the_cancel_mark_does_not_fire();
	test_held_at_the_cancel_mark_a_release_is_too_late();
	test_the_led_shows_when_to_let_go();
	test_the_table();
	test_a_restore_erases_the_trailer_and_then_the_header();
	test_serial_recovery_takes_image_zero_only();

	printf("%d golden policy checks, %d failed\n", checks, failures);
	return failures ? 1 : 0;
}
