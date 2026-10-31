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
  src/net.c
  src/ota.c
  src/ota_job.c
  src/store.c
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

target_sources_ifndef(CONFIG_APP_CONSOLE app PRIVATE src/log_discard.c)

zephyr_linker_sources_ifdef(CONFIG_LOG SECTIONS src/log_backend_check.ld)

target_include_directories(app PRIVATE src)
