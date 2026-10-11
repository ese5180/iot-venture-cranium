# Tests for the parts of the update client that take input from outside the device.
# They are plain C with no hardware dependency, so they run on the build machine,
# with the address and undefined-behaviour sanitizers on:
#
#   make -C firmware/tests/host
#
# cJSON is taken from the nRF Connect SDK checkout (the same source the firmware uses).

ZEPHYR_BASE ?= $(error ZEPHYR_BASE is not set: run this from an nRF Connect SDK terminal)
CJSON_DIR ?= $(ZEPHYR_BASE)/../modules/lib/cjson
SRC := ../../app/src
BUILD := build

CC ?= cc
SANITIZE := -fsanitize=address,undefined -fno-sanitize-recover=undefined
CFLAGS := -std=c11 -O1 -g $(SANITIZE) -I$(SRC) -Istubs -I$(CJSON_DIR)
WARNINGS := -Wall -Wextra -Werror

.PHONY: test clean
test: $(BUILD)/host_tests
	./$(BUILD)/host_tests

$(BUILD)/cJSON.o: $(CJSON_DIR)/cJSON.c
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -c -o $@ $<

$(BUILD)/host_tests: test_main.c $(SRC)/ota_job.c $(SRC)/version.c $(BUILD)/cJSON.o
	$(CC) $(CFLAGS) $(WARNINGS) -o $@ $^ -lm

clean:
	rm -rf $(BUILD)
