#
# Built into MCUboot only. With CONFIG_CRANIUM_GOLDEN off, the golden image adds nothing to it, and
# the one file built is the check on serial recovery's image number, which CONFIG_BOOT_FLASH_AREA_HOOKS
# in sysbuild/mcuboot/prj.conf calls for.
#
# src/golden.c includes src/bootutil_priv.h, which is private to MCUboot. The SDK is pinned,
# and an update that changes that header breaks this build loudly rather than silently.
#

zephyr_library()
zephyr_library_sources(src/image_number_guard.c)
zephyr_library_sources_ifdef(CONFIG_CRANIUM_GOLDEN src/golden.c src/golden_policy.c)
zephyr_library_link_libraries(MCUBOOT_BOOTUTIL)
