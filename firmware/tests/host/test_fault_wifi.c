/*
 * Host-side tests of a test image's fault that fires by itself: when it fires, that it fires once per
 * install, and that a board that cannot remember does not fire at all. The real file is compiled here,
 * and built twice: with a time, and with none, where only the console's command can do it.
 */

#define CONFIG_APP_TEST_FAULT_WIFI_DEAD 1
#define CONFIG_APP_CONSOLE              1

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fault_wifi.c"

static int failures;
static int checks;

#define CHECK(condition)                                                                     \
	do {                                                                                 \
		checks++;                                                                    \
		if (!(condition)) {                                                          \
			failures++;                                                          \
			printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);         \
		}                                                                            \
	} while (0)

static struct {
	enum ota_state state;
	bool cloud_up;
	bool trailer;
	/* Storage survives a restart. */
	bool stored;
	char record[64];
	size_t record_size;
	int read_result;
	int write_result;
	int writes;
	struct fw_version running;
	char console[256];
} world;

enum ota_state ota_state(void)
{
	return world.state;
}

bool ota_image_has_trailer(void)
{
	return world.trailer;
}

bool cloud_is_connected(void)
{
	return world.cloud_up;
}

void console_event(const char *tag, const char *format, ...)
{
	char line[128];
	va_list args;

	va_start(args, format);
	vsnprintf(line, sizeof(line), format, args);
	va_end(args);
	snprintf(world.console + strlen(world.console), sizeof(world.console) - strlen(world.console),
		 "[%s] %s\n", tag, line);
}

int store_read(enum store_id id, void *data, size_t size)
{
	CHECK(id == STORE_TEST_FAULT);

	if (world.read_result != 0) {
		return world.read_result;
	}

	if (!world.stored) {
		return -ENOENT;
	}

	if (world.record_size != size) {
		return -EBADMSG;
	}

	memcpy(data, world.record, size);
	return 0;
}

int store_write(enum store_id id, const void *data, size_t size)
{
	CHECK(id == STORE_TEST_FAULT);
	CHECK(size <= sizeof(world.record));
	world.writes++;

	if (world.write_result != 0) {
		return world.write_result;
	}

	memcpy(world.record, data, size);
	world.record_size = size;
	world.stored = true;
	return 0;
}

const struct fw_version *fw_version_running(void)
{
	return &world.running;
}

int fw_version_compare(const struct fw_version *a, const struct fw_version *b)
{
	return memcmp(a, b, sizeof(*a));
}

static void ticks(int count)
{
	for (int i = 0; i < count; i++) {
		fault_wifi_on_tick();
	}
}

/* A new image, on the cloud, confirmed. */
static void fresh_install(void)
{
	memset(&world, 0, sizeof(world));
	memset(&fault, 0, sizeof(fault));
	world.cloud_up = true;
	world.trailer = true;
	world.running.major = 1;
	world.running.minor = 6;
	world.running.revision = 9;
}

static bool fired(void)
{
	return fault.done;
}

#if CONFIG_APP_TEST_WIFI_DEAD_AFTER_SECONDS > 0
#define AFTER CONFIG_APP_TEST_WIFI_DEAD_AFTER_SECONDS

/* RAM goes, storage stays. What the chip does also goes. */
static void restart(void)
{
	memset(&fault, 0, sizeof(fault));
	world.console[0] = '\0';
	world.writes = 0;
}

static void test_it_fires_that_long_after_the_confirmation(void)
{
	fresh_install();

	/* On trial nothing counts. */
	world.state = OTA_TESTING;
	ticks(AFTER * 2);
	CHECK(!fired());
	CHECK(world.writes == 0);

	/* Confirmed: from here. */
	world.state = OTA_IDLE;
	ticks(AFTER - 1);
	CHECK(!fired());
	CHECK(world.writes == 0);
	ticks(1);
	CHECK(fired());
	CHECK(world.writes == 1);
	CHECK(strstr(world.console, "[WIFI] test image: the chip stops by itself now\n") != NULL);
	CHECK(strstr(world.console, "[WIFI] test image: chip power cut\n") != NULL);

	/* Once. */
	world.console[0] = '\0';
	ticks(AFTER * 3);
	CHECK(world.writes == 1);
	CHECK(world.console[0] == '\0');
}

static void test_it_fires_once_per_install(void)
{
	fresh_install();
	ticks(AFTER);
	CHECK(fired());

	/* The restart that this causes, and the ones after it. */
	for (int i = 0; i < 3; i++) {
		restart();
		ticks(AFTER * 3);
		CHECK(!fired());
		CHECK(world.writes == 0);
		CHECK(world.console[0] == '\0');
	}

	/* The next install of it is another version, and it fires there too. */
	restart();
	world.running.revision = 10;
	ticks(AFTER);
	CHECK(fired());
	CHECK(world.writes == 1);
}

static void test_a_board_that_cannot_remember_does_not_fire(void)
{
	fresh_install();
	world.write_result = -EIO;
	ticks(AFTER);
	CHECK(!fired());
	CHECK(world.writes == 1);
	CHECK(strstr(world.console, "the chip stays on") != NULL);

	/* It says so once, and tries no more. */
	ticks(AFTER * 2);
	CHECK(world.writes == 1);

	/* What cannot be read says nothing about having fired: it fires if it can write that it did. */
	fresh_install();
	world.read_result = -EIO;
	ticks(AFTER);
	CHECK(fired());
	CHECK(world.writes == 1);
}

static void test_a_record_that_is_not_a_record_is_no_record(void)
{
	/* The wrong magic number, with the right version in it. */
	fresh_install();
	ticks(AFTER);
	world.record[0] ^= 1;
	restart();
	ticks(AFTER);
	CHECK(fired());

	/* Of another size: from another layout. */
	fresh_install();
	ticks(AFTER);
	world.record_size = 1;
	restart();
	ticks(AFTER);
	CHECK(fired());
}

static void test_an_image_with_no_trailer_does_not_fire(void)
{
	fresh_install();
	world.trailer = false;
	ticks(AFTER);
	CHECK(!fired());
	CHECK(world.writes == 0);
	CHECK(strstr(world.console, "no trailer") != NULL);

	/* And no record says that it did. */
	restart();
	world.trailer = true;
	ticks(AFTER);
	CHECK(fired());
}

static void test_it_waits_for_an_update_to_end_and_for_the_cloud(void)
{
	/* An update starts the count over. */
	fresh_install();
	ticks(AFTER - 1);
	world.state = OTA_DOWNLOADING;
	ticks(AFTER * 2);
	CHECK(!fired());
	world.state = OTA_IDLE;
	ticks(AFTER - 1);
	CHECK(!fired());
	ticks(1);
	CHECK(fired());

	/* Without the cloud it does not count, and it does not start over either. */
	fresh_install();
	ticks(AFTER - 1);
	world.cloud_up = false;
	ticks(AFTER * 2);
	CHECK(!fired());
	world.cloud_up = true;
	ticks(1);
	CHECK(fired());
}

static void test_the_command_can_have_got_there_first(void)
{
	fresh_install();
	CHECK(console_port_wifi_dead() == 0);
	CHECK(console_port_wifi_dead() == -EALREADY);
	world.console[0] = '\0';
	ticks(AFTER);
	CHECK(world.writes == 1);
	CHECK(strstr(world.console, "chip power cut") == NULL);
}
#else
static void test_without_a_time_only_the_command_does_it(void)
{
	fresh_install();
	ticks(7200);
	CHECK(!fired());
	CHECK(world.writes == 0);
	CHECK(world.console[0] == '\0');
	CHECK(console_port_wifi_dead() == 0);
	CHECK(fired());
}
#endif

static void test_the_command_needs_a_trailer(void)
{
	fresh_install();
	world.trailer = false;
	CHECK(console_port_wifi_dead() == -ENOTSUP);
	CHECK(!fired());
}

int main(void)
{
#if CONFIG_APP_TEST_WIFI_DEAD_AFTER_SECONDS > 0
	test_it_fires_that_long_after_the_confirmation();
	test_it_fires_once_per_install();
	test_a_board_that_cannot_remember_does_not_fire();
	test_a_record_that_is_not_a_record_is_no_record();
	test_an_image_with_no_trailer_does_not_fire();
	test_it_waits_for_an_update_to_end_and_for_the_cloud();
	test_the_command_can_have_got_there_first();
#else
	test_without_a_time_only_the_command_does_it();
#endif
	test_the_command_needs_a_trailer();

	printf("%d test fault checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
