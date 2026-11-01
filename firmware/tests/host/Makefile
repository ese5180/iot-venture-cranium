# Tests for the parts of the firmware that take input from outside the device, such as the update
# client's job parser and the serial console, and for what it decides by itself, such as when it
# restarts. They are plain C with no hardware dependency, so they run on the build machine, with
# the address and undefined-behaviour sanitizers on:
#
#   make -C firmware/tests/host
#
# cJSON and the base64 library are taken from the nRF Connect SDK checkout (the same source
# the firmware uses).

ZEPHYR_BASE ?= $(error ZEPHYR_BASE is not set: run this from an nRF Connect SDK terminal)
CJSON_DIR ?= $(ZEPHYR_BASE)/../modules/lib/cjson
SRC := ../../app/src
BUILD := build

CC ?= cc
SANITIZE := -fsanitize=address,undefined -fno-sanitize-recover=undefined
CFLAGS := -std=c11 -O1 -g $(SANITIZE) -I$(SRC) -Istubs -I$(CJSON_DIR)
WARNINGS := -Wall -Wextra -Werror

# What the console's code expects from Kconfig.
CONSOLE_DEFINES := -D_GNU_SOURCE -DCONFIG_APP_CONSOLE=1 -DCONFIG_APP_LOG_LEVEL=0 \
	-DCONFIG_APP_THING_NAME_PREFIX=\"cranium-\" -DCONFIG_MQTT_HELPER_SEC_TAG=201 \
	-DCONFIG_APP_DOWNLOAD_SEC_TAG=202
CONSOLE_SOURCES := $(SRC)/console_cmd.c $(SRC)/console_parser.c $(SRC)/console_stream.c \
	$(SRC)/device.c $(SRC)/factory.c $(SRC)/identity.c $(SRC)/version.c console_fakes.c
CONSOLE_HEADERS := $(wildcard $(SRC)/*.h) console_fakes.h

.PHONY: test clean
test: $(BUILD)/host_tests $(BUILD)/console_tests $(BUILD)/console_output_tests $(BUILD)/app_tests $(BUILD)/console_sim \
		$(BUILD)/ui_tests $(BUILD)/golden_policy_tests $(BUILD)/bt_ota_policy_tests \
		$(BUILD)/bt_ota_tests $(BUILD)/ota_bt_tests $(BUILD)/ota_bt_no_confirm_tests \
		$(BUILD)/console_bt_tests $(BUILD)/app_bt_tests $(BUILD)/ui_bt_tests \
		$(BUILD)/stuck_policy_tests $(BUILD)/console_fault_tests $(BUILD)/console_sim_fault
	./$(BUILD)/host_tests
	./$(BUILD)/console_tests
	./$(BUILD)/console_output_tests
	./$(BUILD)/app_tests
	./$(BUILD)/ui_tests
	./$(BUILD)/golden_policy_tests
	./$(BUILD)/bt_ota_policy_tests
	./$(BUILD)/bt_ota_tests
	./$(BUILD)/ota_bt_tests
	./$(BUILD)/ota_bt_no_confirm_tests
	./$(BUILD)/console_bt_tests
	./$(BUILD)/app_bt_tests
	./$(BUILD)/ui_bt_tests
	./$(BUILD)/stuck_policy_tests
	./$(BUILD)/console_fault_tests

$(BUILD)/cJSON.o: $(CJSON_DIR)/cJSON.c
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -c -o $@ $<

$(BUILD)/base64.o: $(ZEPHYR_BASE)/lib/utils/base64.c
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -c -o $@ $<

$(BUILD)/host_tests: test_main.c $(SRC)/ota_job.c $(SRC)/version.c $(BUILD)/cJSON.o
	$(CC) $(CFLAGS) $(WARNINGS) -o $@ $^ -lm

$(BUILD)/console_tests: test_console.c $(CONSOLE_SOURCES) $(BUILD)/base64.o $(CONSOLE_HEADERS)
	$(CC) $(CFLAGS) $(WARNINGS) $(CONSOLE_DEFINES) -o $@ $(filter %.c %.o,$^)

# console.c on a fake UART, and main.c and net.c on a fake network stack. These test files
# include the real source files, to get at what they keep static.
$(BUILD)/console_output_tests: test_console_output.c $(SRC)/console.c $(SRC)/console_parser.c $(CONSOLE_HEADERS)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) $(CONSOLE_DEFINES) -o $@ test_console_output.c $(SRC)/console_parser.c

$(BUILD)/app_tests: test_app.c $(SRC)/main.c $(SRC)/net.c $(SRC)/stuck.c $(SRC)/stuck_policy.c $(CONSOLE_HEADERS)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) $(CONSOLE_DEFINES) -o $@ test_app.c $(SRC)/stuck_policy.c

# ui.c, included by its test to get at its input callback.
$(BUILD)/ui_tests: test_ui.c $(SRC)/ui.c $(SRC)/ui.h $(SRC)/app_events.h
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -DCONFIG_APP_LOG_LEVEL=0 -o $@ test_ui.c

# What the golden image's code in the bootloader decides, and the bootloader's check on serial
# recovery's image number. They need nothing but the C library and a stub of one MCUboot header.
GOLDEN_SRC := ../../app/sysbuild/mcuboot/golden/src
$(BUILD)/golden_policy_tests: test_golden_policy.c $(GOLDEN_SRC)/golden_policy.c $(GOLDEN_SRC)/golden_policy.h \
		$(GOLDEN_SRC)/image_number_guard.c stubs/bootutil/boot_hooks.h
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -I$(GOLDEN_SRC) -o $@ test_golden_policy.c $(GOLDEN_SRC)/golden_policy.c \
		$(GOLDEN_SRC)/image_number_guard.c

# Firmware update over Bluetooth: what it is allowed to do, then src/bt_ota.c on a fake of the
# Bluetooth host, MCUmgr and the bootloader's API. The last three are the same tests as above
# with CONFIG_APP_BT_OTA on, which is off everywhere else, to show what it changes there.
BT_DEFINES := -DCONFIG_APP_BT_OTA=1
$(BUILD)/bt_ota_policy_tests: test_bt_ota_policy.c $(SRC)/bt_ota_policy.c $(SRC)/bt_ota_policy.h $(SRC)/version.c
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -o $@ test_bt_ota_policy.c $(SRC)/bt_ota_policy.c $(SRC)/version.c

$(BUILD)/bt_ota_tests: test_bt_ota.c $(SRC)/bt_ota.c $(SRC)/bt_ota.h $(SRC)/bt_ota_policy.c $(SRC)/bt_ota_policy.h \
		$(SRC)/ota_job.c $(SRC)/version.c stubs/host_bt.h stubs/zephyr/kernel.h $(BUILD)/cJSON.o
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -o $@ test_bt_ota.c $(SRC)/bt_ota_policy.c $(SRC)/ota_job.c $(SRC)/version.c \
		$(BUILD)/cJSON.o -lm

# What it adds to ota.c, which is compiled for this and for nothing else here. The second one is
# a test image that never confirms itself.
$(BUILD)/ota_bt_tests: test_ota_bt.c $(SRC)/ota.c $(SRC)/ota.h $(SRC)/ota_job.c $(SRC)/version.c stubs/host_ota.h \
		stubs/host_bt.h $(BUILD)/cJSON.o
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -o $@ test_ota_bt.c $(SRC)/ota_job.c $(SRC)/version.c $(BUILD)/cJSON.o -lm

$(BUILD)/ota_bt_no_confirm_tests: test_ota_bt.c $(SRC)/ota.c $(SRC)/ota.h $(SRC)/ota_job.c $(SRC)/version.c \
		stubs/host_ota.h stubs/host_bt.h $(BUILD)/cJSON.o
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -DCONFIG_APP_TEST_FAULT_NO_CONFIRM=1 -o $@ test_ota_bt.c $(SRC)/ota_job.c \
		$(SRC)/version.c $(BUILD)/cJSON.o -lm

$(BUILD)/console_bt_tests: test_console.c $(CONSOLE_SOURCES) $(BUILD)/base64.o $(CONSOLE_HEADERS)
	$(CC) $(CFLAGS) $(WARNINGS) $(CONSOLE_DEFINES) $(BT_DEFINES) -o $@ $(filter %.c %.o,$^)

$(BUILD)/app_bt_tests: test_app.c $(SRC)/main.c $(SRC)/net.c $(SRC)/stuck.c $(SRC)/stuck_policy.c $(CONSOLE_HEADERS)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) $(CONSOLE_DEFINES) $(BT_DEFINES) -o $@ test_app.c $(SRC)/stuck_policy.c

$(BUILD)/ui_bt_tests: test_ui.c $(SRC)/ui.c $(SRC)/ui.h $(SRC)/app_events.h
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -DCONFIG_APP_LOG_LEVEL=0 $(BT_DEFINES) -o $@ test_ui.c

# When a board that is stuck gets restarted. tests/host/mutate_stuck.py shows that these tests
# notice when the policy is wrong: `make mutants` runs it. test_app.c has the wiring.
$(BUILD)/stuck_policy_tests: test_stuck_policy.c $(SRC)/stuck_policy.c $(SRC)/stuck_policy.h
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -o $@ test_stuck_policy.c $(SRC)/stuck_policy.c

.PHONY: mutants
mutants:
	CC=$(CC) python3 mutate_stuck.py

# The console of the test image that can stop the Wi-Fi chip. Every other build of it answers that
# the command does not exist, which test_console.c checks.
FAULT_DEFINES := -DCONFIG_APP_TEST_FAULT_WIFI_DEAD=1
$(BUILD)/console_fault_tests: test_console.c $(CONSOLE_SOURCES) $(BUILD)/base64.o $(CONSOLE_HEADERS)
	$(CC) $(CFLAGS) $(WARNINGS) $(CONSOLE_DEFINES) $(FAULT_DEFINES) -o $@ $(filter %.c %.o,$^)

# The console on a pseudo-terminal, for firmware/tests/hil/test_board.py. No sanitizers
# are needed for that, and the tools' tests do not have to run with their runtime.
$(BUILD)/console_sim: console_sim.c $(CONSOLE_SOURCES) $(ZEPHYR_BASE)/lib/utils/base64.c $(CONSOLE_HEADERS)
	$(CC) -std=c11 -O1 -g -I$(SRC) -Istubs $(WARNINGS) $(CONSOLE_DEFINES) -o $@ $(filter %.c,$^)

$(BUILD)/console_sim_fault: console_sim.c $(CONSOLE_SOURCES) $(ZEPHYR_BASE)/lib/utils/base64.c $(CONSOLE_HEADERS)
	$(CC) -std=c11 -O1 -g -I$(SRC) -Istubs $(WARNINGS) $(CONSOLE_DEFINES) $(FAULT_DEFINES) -o $@ $(filter %.c,$^)

clean:
	rm -rf $(BUILD)
