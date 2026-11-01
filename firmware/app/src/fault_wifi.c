/*
 * A Wi-Fi chip that stops answering, on command or by itself, for firmware/tests/hil/ota_bench.py.
 * It is in an image built with CONFIG_APP_TEST_FAULT_WIFI_DEAD and in no other: the CMake line that
 * names this file is the only way in, and firmware/tests/hil/fault_check.py looks for it in a built
 * image.
 *
 * It takes BUCKEN low, which turns off the chip's buck regulator, and leaves IOVDD on. So the I/O rail stays powered,
 * and what the host keeps clocking over QSPI does not go into an unpowered chip. The driver does
 * not get to this state itself: rpu_pwroff() in rpu_hw_if.c takes IOVDD low and then BUCKEN, and
 * rpu_pwron() raises BUCKEN and then IOVDD, so it never has IOVDD on with BUCKEN off. Nothing in
 * this tree says what the chip makes of that. The datasheet is the place to look, and the bench
 * run is the place to find out.
 *
 * The power stays off because the driver's recovery is not built in, which CMake insists on. With
 * it, the driver's wake check fails, and it brings the interface down and up, and that powers the
 * chip again. A restart ends this: the driver powers the chip up at init.
 */

#include "fault_wifi.h"

#include <errno.h>
#include <string.h>

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>

#include "cloud.h"
#include "console.h"
#include "console_port.h"
#include "ota.h"
#include "store.h"
#include "version.h"

static const struct gpio_dt_spec bucken = GPIO_DT_SPEC_GET(DT_NODELABEL(nrf70), bucken_gpios);

/* All of this goes with a restart. */
static struct {
	bool done;
	uint32_t seconds;
	bool over;
} fault;

int console_port_wifi_dead(void)
{
	int err;

	if (fault.done) {
		return -EALREADY;
	}

	if (!ota_image_has_trailer()) {
		return -ENOTSUP;
	}

	err = gpio_pin_set_dt(&bucken, 0);
	if (err) {
		return err;
	}

	fault.done = true;
	console_event("WIFI", "test image: chip power cut");
	return 0;
}

#if CONFIG_APP_TEST_WIFI_DEAD_AFTER_SECONDS > 0
#define FIRED_MAGIC 0x46495245 /* "FIRE" */

/* What survives the restart. A newer install of this image has another version, and fires again. */
struct fired_record {
	uint32_t magic;
	struct fw_version version;
};

void fault_wifi_on_tick(void)
{
	struct fired_record record;

	if (fault.over) {
		return;
	}

	/* On trial this says OTA_TESTING, so the count starts at the confirmation. */
	if (ota_state() != OTA_IDLE) {
		fault.seconds = 0;
		return;
	}

	if (!cloud_is_connected() || ++fault.seconds < CONFIG_APP_TEST_WIFI_DEAD_AFTER_SECONDS) {
		return;
	}

	fault.over = true;

	if (!ota_image_has_trailer()) {
		console_event("WIFI", "test image: no trailer, so no revert could show: the chip stays on");
		return;
	}

	if (store_read(STORE_TEST_FAULT, &record, sizeof(record)) == 0 &&
	    record.magic == FIRED_MAGIC &&
	    fw_version_compare(&record.version, fw_version_running()) == 0) {
		return;
	}

	/* First the record: a board that cannot remember must not go round in a loop of these. */
	memset(&record, 0, sizeof(record));
	record.magic = FIRED_MAGIC;
	record.version = *fw_version_running();

	if (store_write(STORE_TEST_FAULT, &record, sizeof(record)) != 0) {
		console_event("WIFI", "test image: nothing to remember it by, so the chip stays on");
		return;
	}

	console_event("WIFI", "test image: the chip stops by itself now");
	(void)console_port_wifi_dead();
}
#else
void fault_wifi_on_tick(void)
{
}
#endif /* CONFIG_APP_TEST_WIFI_DEAD_AFTER_SECONDS */
