/*
 * Serial recovery takes an image number from whoever is on the serial port, and MCUboot uses it
 * as an index into a two-entry table with no bounds check: bs_upload() in boot_serial.c, then
 * __flash_area_ids_for_slot() in sysflash.h. Whatever lies past the end of the table picks the
 * flash area that the upload erases and writes, with nothing locked yet. On this build that can be
 * the bootloader's own partition, TF-M's storage or the golden copy.
 *
 * This build has one image, so anything but image 0 gets an area id that no area has, and the
 * upload is answered with an error. This is not part of the golden image, and is built in with it
 * on or off.
 */

#include <errno.h>

#include "bootutil/boot_hooks.h"

int flash_area_id_from_multi_image_slot_hook(int image_index, int slot, int *area_id)
{
	(void)slot;

	if (image_index == 0) {
		return BOOT_HOOK_REGULAR;
	}

	*area_id = -EINVAL;
	return 0;
}
