/*
 * The golden image: a person can put one pinned image back, and nothing else can.
 *
 * MCUboot calls mcuboot_status_change() before it looks at any slot. If Button 2 is held
 * through a reset and let go in the right window, this stores the pinned image in external
 * flash, or copies it back into the primary slot from there. What decides is the digest
 * compiled in as CONFIG_CRANIUM_GOLDEN_SHA256 and the signature check that runs on the bytes
 * themselves, before anything is erased.
 *
 * This code cannot start an image. It has no access to what MCUboot boots, and after writing
 * anything it restarts the board, so the unchanged boot path checks the result as it checks
 * any image. The pin is the one rule of its own that it needs: MCUboot's downgrade check only
 * looks at swaps, and a direct copy is not one.
 */

#include <string.h>

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/kernel.h>
#include <zephyr/storage/flash_map.h>
#include <zephyr/sys/reboot.h>
#include <zephyr/sys/util.h>
#include <zephyr/toolchain.h>

#include "bootutil/bootutil_log.h"
#include "bootutil/crypto/sha.h"
#include "bootutil/fault_injection_hardening.h"
#include "bootutil/image.h"
#include "bootutil/mcuboot_status.h"
#include "mcuboot_config/mcuboot_config.h"
#include "src/bootutil_priv.h"

#include "golden_policy.h"

BOOT_LOG_MODULE_DECLARE(mcuboot);

BUILD_ASSERT(sizeof(CONFIG_CRANIUM_GOLDEN_SHA256) == 2 * IMAGE_HASH_SIZE + 1,
	     "CONFIG_CRANIUM_GOLDEN_SHA256 needs 64 hex digits: see tools/golden.py freeze");
BUILD_ASSERT(CONFIG_CRANIUM_GOLDEN_SIZE > 0 &&
	     CONFIG_CRANIUM_GOLDEN_SIZE <= PARTITION_SIZE(golden_partition),
	     "CONFIG_CRANIUM_GOLDEN_SIZE needs the size of the image: see tools/golden.py freeze");
BUILD_ASSERT(PARTITION_SIZE(golden_partition) == PARTITION_SIZE(slot0_partition),
	     "golden_partition has to hold anything the primary slot can");
BUILD_ASSERT(BOOT_IMAGE_NUMBER == 1, "One image is all this was written for");

#define PIN_SIZE        IMAGE_HASH_SIZE
/* After turning on the pull-up, before the first reading of the button. */
#define SETTLE_US       100
#define SLOW_BLINK_MS   500
#define TIMES_NOTHING   1
#define TIMES_REFUSED   3

static const struct gpio_dt_spec button = GPIO_DT_SPEC_GET(DT_ALIAS(sw1), gpios);
static const struct gpio_dt_spec led = GPIO_DT_SPEC_GET(DT_ALIAS(led0), gpios);

static uint8_t pin[PIN_SIZE];

/* Busy, because this build has no threads to sleep with, and the watchdog may be running. */
static void wait_ms(uint32_t ms)
{
	for (uint32_t waited = 0; waited < ms; waited += GOLDEN_SAMPLE_MS) {
		MCUBOOT_WATCHDOG_FEED();
		k_busy_wait(GOLDEN_SAMPLE_MS * USEC_PER_MSEC);
	}
}

static void blink(int times)
{
	for (int i = 0; i < times; i++) {
		(void)gpio_pin_set_dt(&led, 1);
		wait_ms(SLOW_BLINK_MS);
		(void)gpio_pin_set_dt(&led, 0);
		wait_ms(SLOW_BLINK_MS);
	}
}

/*
 * Follows the button until the gesture has been decided. Out of line and global, because this
 * is the first place where the pin is ready and not read yet: firmware/tests/hil/golden_bench.py
 * stops here to hold the button down from the debug port.
 */
__noinline enum golden_gesture_result golden_gesture_follow(void)
{
	struct golden_gesture gesture = { 0 };
	enum golden_gesture_result result;
	uint32_t now_ms = 0;
	bool led_ready = false;

	while (true) {
		result = golden_gesture_step(&gesture, now_ms, gpio_pin_get_dt(&button) > 0);
		if (result != GOLDEN_GESTURE_WAIT) {
			return result;
		}

		if (!led_ready) {
			led_ready = gpio_pin_configure_dt(&led, GPIO_OUTPUT_INACTIVE) == 0;
		}

		if (led_ready) {
			(void)gpio_pin_set_dt(&led, golden_gesture_led(now_ms));
		}

		MCUBOOT_WATCHDOG_FEED();
		k_busy_wait(GOLDEN_SAMPLE_MS * USEC_PER_MSEC);
		now_ms += GOLDEN_SAMPLE_MS;
	}
}

static bool gesture_fired(void)
{
	if (gpio_pin_configure_dt(&button, GPIO_INPUT) != 0) {
		return false;
	}

	k_busy_wait(SETTLE_US);

	switch (golden_gesture_follow()) {
	case GOLDEN_GESTURE_FIRED:
		BOOT_LOG_INF("golden: gesture completed");
		return true;
	case GOLDEN_GESTURE_NOT_COMPLETED:
		BOOT_LOG_INF("golden: Button 2 let go too early or too late, nothing done");
		return false;
	case GOLDEN_GESTURE_STUCK:
		BOOT_LOG_WRN("golden: Button 2 is still down after %d s, booting anyway",
			     GOLDEN_GIVE_UP_MS / MSEC_PER_SEC);
		return false;
	default:
		return false;
	}
}

static void pins_release(void)
{
	(void)gpio_pin_configure(button.port, button.pin, GPIO_DISCONNECTED);
	(void)gpio_pin_configure(led.port, led.pin, GPIO_DISCONNECTED);
}

/* The bytes in this area are the pinned image, and carry a good signature. */
static bool matches_pin(struct boot_loader_state *state, const struct flash_area *area)
{
	static uint8_t tmp[256];
	struct image_header header;
	struct image_tlv_iter iter;
	uint8_t hash[PIN_SIZE];
	FIH_DECLARE(rc, FIH_FAILURE);

	/* Validating takes seconds and does not feed the watchdog by itself. */
	MCUBOOT_WATCHDOG_FEED();

	if (boot_image_load_header(area, &header) != 0 || header.ih_magic != IMAGE_MAGIC) {
		return false;
	}

	/* A file of another size cannot be the pinned image, and comparing costs no hashing. */
	if (bootutil_tlv_iter_begin(&iter, &header, area, IMAGE_TLV_ANY, false) != 0 ||
	    iter.tlv_end != CONFIG_CRANIUM_GOLDEN_SIZE) {
		return false;
	}

	memset(hash, 0, sizeof(hash));
	FIH_CALL(bootutil_img_validate, rc, state, &header, area, tmp, sizeof(tmp), NULL, 0, hash);
	if (FIH_NOT_EQ(rc, FIH_SUCCESS)) {
		return false;
	}

	FIH_CALL(boot_fih_memequal, rc, hash, pin, sizeof(hash));
	return FIH_EQ(rc, FIH_SUCCESS);
}

/*
 * The primary slot goes first, in the order golden_erase_steps() gives. Then the secondary slot,
 * so that no pending or leftover image can swap over the pinned one.
 */
static FUNC_NORETURN void restore(struct boot_loader_state *state, const struct flash_area *gold)
{
	const struct flash_area *primary = BOOT_IMG_AREA(state, BOOT_SLOT_PRIMARY);
	const struct flash_area *secondary = BOOT_IMG_AREA(state, BOOT_SLOT_SECONDARY);
	struct golden_erase_step steps[GOLDEN_ERASE_STEPS];
	int rc = 0;

	(void)gpio_pin_set_dt(&led, 1);
	BOOT_LOG_INF("golden: restoring the pinned image");

	golden_erase_steps(flash_area_get_size(primary),
			   boot_img_sector_size(state, BOOT_SLOT_PRIMARY, 0), steps);
	for (int i = 0; i < GOLDEN_ERASE_STEPS && rc == 0; i++) {
		rc = boot_erase_region(primary, steps[i].off, steps[i].size, false);
	}

	if (rc != 0 || boot_erase_region(secondary, 0, flash_area_get_size(secondary), false) != 0 ||
	    boot_copy_region(state, gold, primary, 0, 0, CONFIG_CRANIUM_GOLDEN_SIZE) != 0) {
		BOOT_LOG_ERR("golden: flash error during the restore, restarting");
	} else if (matches_pin(state, primary)) {
		BOOT_LOG_INF("golden: restored, restarting");
	} else {
		BOOT_LOG_ERR("golden: the restored image does not match the pin, restarting");
	}

	sys_reboot(SYS_REBOOT_COLD);
}

static FUNC_NORETURN void seal(struct boot_loader_state *state, const struct flash_area *gold)
{
	const struct flash_area *primary = BOOT_IMG_AREA(state, BOOT_SLOT_PRIMARY);

	(void)gpio_pin_set_dt(&led, 1);
	BOOT_LOG_INF("golden: sealing the running image");

	if (boot_erase_region(gold, 0, flash_area_get_size(gold), false) != 0 ||
	    boot_copy_region(state, primary, gold, 0, 0, CONFIG_CRANIUM_GOLDEN_SIZE) != 0) {
		BOOT_LOG_ERR("golden: flash error while sealing, restarting");
	} else if (matches_pin(state, gold)) {
		BOOT_LOG_INF("golden: sealed, restarting");
	} else {
		BOOT_LOG_ERR("golden: the sealed copy does not match the pin, restarting");
	}

	sys_reboot(SYS_REBOOT_COLD);
}

static void golden_act(void)
{
	struct boot_loader_state *state = boot_get_loader_state();
	const struct flash_area *gold = NULL;
	bool primary_ok;
	bool golden_ok;
	int rc;

	if (hex2bin(CONFIG_CRANIUM_GOLDEN_SHA256, sizeof(CONFIG_CRANIUM_GOLDEN_SHA256) - 1, pin,
		    sizeof(pin)) != sizeof(pin)) {
		BOOT_LOG_ERR("golden: refused, the pin is not hexadecimal");
		blink(TIMES_REFUSED);
		return;
	}

	/* What serial recovery does before it validates an image: bs_list_set() in boot_serial.c.
	 * bootutil_img_validate() takes the largest allowed size from the sector layout.
	 */
	boot_state_clear(state);

	/* Closes what it opened if it fails, and a dead external flash ends here. */
	rc = boot_open_all_flash_areas(state);
	if (rc != 0) {
		BOOT_LOG_ERR("golden: refused, flash areas: %d", rc);
		blink(TIMES_REFUSED);
		boot_state_clear(state);
		return;
	}

	rc = boot_read_sectors(state, NULL);
	if (rc == 0) {
		rc = flash_area_open(PARTITION_ID(golden_partition), &gold);
	}

	if (rc != 0) {
		BOOT_LOG_ERR("golden: refused, flash layout: %d", rc);
		blink(TIMES_REFUSED);
		goto nothing_written;
	}

	primary_ok = matches_pin(state, BOOT_IMG_AREA(state, BOOT_SLOT_PRIMARY));
	golden_ok = matches_pin(state, gold);
	BOOT_LOG_INF("golden: primary slot %s the pin, golden copy %s it",
		     primary_ok ? "matches" : "does not match",
		     golden_ok ? "matches" : "does not match");

	/* Nothing has been erased up to here. */
	switch (golden_decide(primary_ok, golden_ok)) {
	case GOLDEN_ACTION_RESTORE:
		restore(state, gold);
	case GOLDEN_ACTION_SEAL:
		seal(state, gold);
	case GOLDEN_ACTION_NOTHING:
		BOOT_LOG_INF("golden: nothing to do");
		blink(TIMES_NOTHING);
		break;
	default:
		BOOT_LOG_ERR("golden: refused, neither copy is the pinned image");
		blink(TIMES_REFUSED);
		break;
	}

nothing_written:
	if (gold != NULL) {
		flash_area_close(gold);
	}

	boot_close_all_flash_areas(state);
	boot_state_clear(state);
}

void mcuboot_status_change(mcuboot_status_type_t status)
{
	if (status != MCUBOOT_STATUS_STARTUP || !gpio_is_ready_dt(&button) ||
	    !gpio_is_ready_dt(&led)) {
		return;
	}

	if (gesture_fired()) {
		golden_act();
	}

	pins_release();
}
