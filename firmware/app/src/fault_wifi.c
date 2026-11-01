/*
 * A Wi-Fi chip that stops answering, on command, for firmware/tests/hil/ota_bench.py. It is in an
 * image built with CONFIG_APP_TEST_FAULT_WIFI_DEAD and in no other: the CMake line that names this
 * file is the only way in, and firmware/tests/hil/fault_check.py looks for it in a built image.
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

#include <errno.h>

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>

#include "console.h"
#include "console_port.h"
#include "ota.h"

static const struct gpio_dt_spec bucken = GPIO_DT_SPEC_GET(DT_NODELABEL(nrf70), bucken_gpios);

int console_port_wifi_dead(void)
{
	static bool done;
	int err;

	if (done) {
		return -EALREADY;
	}

	if (!ota_image_has_trailer()) {
		return -ENOTSUP;
	}

	err = gpio_pin_set_dt(&bucken, 0);
	if (err) {
		return err;
	}

	done = true;
	console_event("WIFI", "test image: chip power cut");
	return 0;
}
