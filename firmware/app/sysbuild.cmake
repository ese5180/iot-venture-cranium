#
# Sysbuild hooks.
#

# Fail early, with a useful message, when the signing key is missing.
if("$ENV{HOME}" STREQUAL "")
  message(FATAL_ERROR
    "The HOME environment variable is not set. The firmware signing key is read from "
    "HOME/.cranium; on Windows set HOME to your user profile directory.")
endif()
set(cranium_signing_key "$ENV{HOME}/.cranium/mcuboot_signing_key.pem")
if(NOT EXISTS "${cranium_signing_key}")
  message(FATAL_ERROR
    "Firmware signing key not found at ${cranium_signing_key}\n"
    "Run `python tools/keys.py generate` to create one, or place the team key there. "
    "The key is deliberately kept outside the repository.")
endif()

# Building the network-core image does not start that core: the application has to
# release it from reset and hand over the LED pin.
if(SB_CONFIG_NETCORE_BLINKY)
  set_config_bool(${DEFAULT_IMAGE} CONFIG_SOC_NRF53_CPUNET_ENABLE y)
endif()

# Firmware update over Bluetooth LE, off unless bt_ota_sysbuild.conf is given.
if(SB_CONFIG_APP_BT_OTA)
  if(NOT SB_CONFIG_NETCORE_HCI_IPC)
    message(FATAL_ERROR "SB_CONFIG_APP_BT_OTA needs SB_CONFIG_NETCORE_HCI_IPC: use bt_ota_sysbuild.conf")
  endif()
  add_overlay_config(${DEFAULT_IMAGE} "${CMAKE_CURRENT_LIST_DIR}/bt_ota.conf")
endif()

# The golden image is a module of MCUboot, not of this application: it has to live with the
# bootloader's own code. With CONFIG_CRANIUM_GOLDEN off the golden image adds nothing to it, and
# the module still holds the bootloader's check on serial recovery's image number.
set(mcuboot_EXTRA_ZEPHYR_MODULES "${CMAKE_CURRENT_LIST_DIR}/sysbuild/mcuboot/golden" CACHE INTERNAL "")

# Keep the signed image of every build of this checkout in binaries/, where scripts/ota.sh
# and the console's upload page can find it. See tools/store_binary.py.
get_filename_component(cranium_repo "${APP_DIR}/../.." ABSOLUTE)
find_package(Python3 REQUIRED COMPONENTS Interpreter)
add_custom_target(cranium_store_binary ALL
  # -I: tools/ holds a secrets.py, which must not hide the standard library's module.
  COMMAND ${Python3_EXECUTABLE} -I "${cranium_repo}/tools/store_binary.py"
          --build "${CMAKE_BINARY_DIR}" --repo "${cranium_repo}"
  COMMENT "Keeping the signed image in binaries/"
  VERBATIM)
add_dependencies(cranium_store_binary ${DEFAULT_IMAGE})
