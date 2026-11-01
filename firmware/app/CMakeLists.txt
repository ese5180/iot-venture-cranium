#
# Cranium firmware: application-core image (TF-M + non-secure application).
#
# Based on the nRF Connect SDK v3.4.0 sample samples/net/aws_iot
# (Copyright (c) 2020 Nordic Semiconductor ASA, LicenseRef-Nordic-5-Clause).
#

cmake_minimum_required(VERSION 3.20.0)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(cranium_app)

target_sources(app PRIVATE
  src/main.c
  src/cloud.c
  src/device.c
  src/factory.c
  src/health.c
  src/identity.c
  src/join_policy.c
  src/net.c
  src/ota.c
  src/ota_job.c
  src/store.c
  src/stuck.c
  src/stuck_policy.c
  src/ui.c
  src/version.c
)

target_sources_ifdef(CONFIG_APP_CONSOLE app PRIVATE
  src/console.c
  src/console_cmd.c
  src/console_keys.c
  src/console_parser.c
  src/console_stream.c
)

target_sources_ifdef(CONFIG_APP_BT_OTA app PRIVATE
  src/bt_ota.c
  src/bt_ota_policy.c
)

# MCUmgr's image header needs MCUboot's.
if(CONFIG_APP_BT_OTA)
  target_link_libraries(app PRIVATE MCUBOOT_BOOTUTIL)
endif()

# Only bt_ota.conf turns Bluetooth on. Without the console APP_BT_OTA stays off, which Kconfig only
# warns about, and this would be an image with a Bluetooth host and nobody to read a passkey.
if(CONFIG_BT AND NOT CONFIG_APP_BT_OTA)
  message(FATAL_ERROR "Firmware update over Bluetooth needs the console: CONFIG_APP_CONSOLE is off")
endif()

target_sources_ifndef(CONFIG_APP_CONSOLE app PRIVATE src/log_discard.c)

# The driver's recovery would power the chip back up, so the timer under test would never fire.
target_sources_ifdef(CONFIG_APP_TEST_FAULT_WIFI_DEAD app PRIVATE src/fault_wifi.c)
target_sources_ifdef(CONFIG_APP_BOOT_DIARY app PRIVATE src/boot_diary.c)
if(CONFIG_APP_TEST_FAULT_WIFI_DEAD AND CONFIG_NRF_WIFI_RPU_RECOVERY)
  message(FATAL_ERROR "APP_TEST_FAULT_WIFI_DEAD needs -Dapp_CONFIG_NRF_WIFI_RPU_RECOVERY=n as well")
endif()

zephyr_linker_sources_ifdef(CONFIG_LOG SECTIONS src/log_backend_check.ld)

target_include_directories(app PRIVATE src)
