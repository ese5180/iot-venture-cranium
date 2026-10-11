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
