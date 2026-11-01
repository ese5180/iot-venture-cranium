/*
 * What image_number_guard.c needs from MCUboot's header of this name. test_golden.py compares
 * this with the SDK's copy.
 */

#ifndef BOOT_HOOKS_STUB_H_
#define BOOT_HOOKS_STUB_H_

#define BOOT_HOOK_REGULAR 1

int flash_area_id_from_multi_image_slot_hook(int image_index, int slot, int *area_id);

#endif /* BOOT_HOOKS_STUB_H_ */
