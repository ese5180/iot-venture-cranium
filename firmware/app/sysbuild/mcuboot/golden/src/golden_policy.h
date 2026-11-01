/*
 * The decisions behind the golden image, with nothing else in them: no flash, no pins and no
 * Zephyr. firmware/tests/host/test_golden_policy.c runs them on the build machine.
 */

#ifndef GOLDEN_POLICY_H_
#define GOLDEN_POLICY_H_

#include <stdbool.h>
#include <stdint.h>

/* How often the button is read. */
#define GOLDEN_SAMPLE_MS  20
/* A release has to last this long before it counts. A shorter one is contact bounce. */
#define GOLDEN_RELEASE_MS 100
/* Let go between these two times after the first read: the gesture fires. */
#define GOLDEN_ARMED_MS   5000
#define GOLDEN_CANCEL_MS  10000
/* Still held after this: boot anyway, so that a stuck button cannot brick the board. */
#define GOLDEN_GIVE_UP_MS 60000
/* LED1 changes this often while a release would fire the gesture. */
#define GOLDEN_BLINK_MS   100

enum golden_gesture_result {
	/* Read the button again in GOLDEN_SAMPLE_MS. */
	GOLDEN_GESTURE_WAIT,
	/* The button was not down at the first read: a normal boot, and the usual case. */
	GOLDEN_GESTURE_NOT_PRESSED,
	/* It was let go too early or too late: a normal boot, nothing written. */
	GOLDEN_GESTURE_NOT_COMPLETED,
	/* It was let go in time. */
	GOLDEN_GESTURE_FIRED,
	/* It was never let go: a normal boot with the button still down. */
	GOLDEN_GESTURE_STUCK,
};

struct golden_gesture {
	bool started;
	bool releasing;
	uint32_t released_at_ms;
};

/*
 * Take one reading of the button. Start from a zeroed struct, with now_ms 0 at the first
 * reading. Once this has returned anything but GOLDEN_GESTURE_WAIT it is finished.
 */
enum golden_gesture_result golden_gesture_step(struct golden_gesture *gesture, uint32_t now_ms,
					       bool pressed);

/* Whether LED1 is on at this point: off until the gesture is armed, and off once cancelled. */
bool golden_gesture_led(uint32_t now_ms);

enum golden_action {
	/* The golden copy is good and the primary slot is not the pinned image. */
	GOLDEN_ACTION_RESTORE,
	/* The primary slot is the pinned image and the golden copy is not good yet. */
	GOLDEN_ACTION_SEAL,
	/* Both are good. */
	GOLDEN_ACTION_NOTHING,
	/* Neither holds the pinned image: nothing can be done, and nothing may be written. */
	GOLDEN_ACTION_REFUSE,
};

/* Each flag says that this area holds the pinned image and its signature is good. */
enum golden_action golden_decide(bool primary_ok, bool golden_ok);

#define GOLDEN_ERASE_STEPS 3

struct golden_erase_step {
	uint32_t off;
	uint32_t size;
};

/*
 * The order in which a restore erases the primary slot. The top sector first, for the trailer in
 * it. A trailer of a swap in progress must never sit over an erased secondary slot, which MCUboot
 * would take for a swap to resume. Then the bottom sector, for the image's header: an image with
 * no trailer and a good header still boots, and if it was on trial it would lose its revert and
 * count as confirmed. Doing this next leaves that state for the time of one sector erase. The rest
 * can go in any order.
 */
void golden_erase_steps(uint32_t slot_size, uint32_t sector_size,
			struct golden_erase_step steps[GOLDEN_ERASE_STEPS]);

#endif /* GOLDEN_POLICY_H_ */
