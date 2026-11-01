#include "golden_policy.h"

enum golden_gesture_result golden_gesture_step(struct golden_gesture *gesture, uint32_t now_ms,
					       bool pressed)
{
	if (!gesture->started) {
		gesture->started = true;
		if (!pressed) {
			return GOLDEN_GESTURE_NOT_PRESSED;
		}
	}

	if (pressed) {
		gesture->releasing = false;
		if (now_ms >= GOLDEN_GIVE_UP_MS) {
			return GOLDEN_GESTURE_STUCK;
		}
		return GOLDEN_GESTURE_WAIT;
	}

	if (!gesture->releasing) {
		gesture->releasing = true;
		gesture->released_at_ms = now_ms;
	}

	if (now_ms - gesture->released_at_ms < GOLDEN_RELEASE_MS) {
		return GOLDEN_GESTURE_WAIT;
	}

	/*
	 * The time counted is when the button came up, not when that was believed. A press at or
	 * after the cancel mark starts a new release, which is then too late for this.
	 */
	if (gesture->released_at_ms >= GOLDEN_ARMED_MS &&
	    gesture->released_at_ms < GOLDEN_CANCEL_MS) {
		return GOLDEN_GESTURE_FIRED;
	}

	return GOLDEN_GESTURE_NOT_COMPLETED;
}

bool golden_gesture_led(uint32_t now_ms)
{
	if (now_ms < GOLDEN_ARMED_MS || now_ms >= GOLDEN_CANCEL_MS) {
		return false;
	}

	return ((now_ms - GOLDEN_ARMED_MS) / GOLDEN_BLINK_MS) % 2U == 0U;
}

enum golden_action golden_decide(bool primary_ok, bool golden_ok)
{
	if (golden_ok) {
		return primary_ok ? GOLDEN_ACTION_NOTHING : GOLDEN_ACTION_RESTORE;
	}

	return primary_ok ? GOLDEN_ACTION_SEAL : GOLDEN_ACTION_REFUSE;
}

void golden_erase_steps(uint32_t slot_size, uint32_t sector_size,
			struct golden_erase_step steps[GOLDEN_ERASE_STEPS])
{
	steps[0] = (struct golden_erase_step){ slot_size - sector_size, sector_size };
	steps[1] = (struct golden_erase_step){ 0, sector_size };
	steps[2] = (struct golden_erase_step){ sector_size, slot_size - 2 * sector_size };
}
