# Tests for the parts of the firmware that take input from outside the device: the update
# client's job parser and the serial console. They are plain C with no hardware dependency,
# so they run on the build machine, with the address and undefined-behaviour sanitizers on:
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
test: $(BUILD)/host_tests $(BUILD)/console_tests $(BUILD)/console_output_tests $(BUILD)/app_tests $(BUILD)/console_sim
	./$(BUILD)/host_tests
	./$(BUILD)/console_tests
	./$(BUILD)/console_output_tests
	./$(BUILD)/app_tests

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

$(BUILD)/app_tests: test_app.c $(SRC)/main.c $(SRC)/net.c $(CONSOLE_HEADERS)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) $(CONSOLE_DEFINES) -o $@ test_app.c

# The console on a pseudo-terminal, for firmware/tests/hil/test_board.py. No sanitizers
# are needed for that, and the tools' tests do not have to run with their runtime.
$(BUILD)/console_sim: console_sim.c $(CONSOLE_SOURCES) $(ZEPHYR_BASE)/lib/utils/base64.c $(CONSOLE_HEADERS)
	$(CC) -std=c11 -O1 -g -I$(SRC) -Istubs $(WARNINGS) $(CONSOLE_DEFINES) -o $@ $(filter %.c,$^)

clean:
	rm -rf $(BUILD)
