/*
 * The console's real code on standard input and output, with the fake board behind it.
 * firmware/tests/hil/test_board.py runs this on a pseudo-terminal, so that the tools and
 * the firmware's parser meet without a board.
 *
 * It behaves like the firmware in the ways the tools care about. A restart goes through
 * the same decision as a boot and prints the status box. Joining a network takes a moment
 * and then reports with a [WIFI] line: a password that starts with "wrong" fails, and
 * anything else connects. Log lines appear now and then, as on a real board.
 *
 * Not the real thing: main.c, net.c and console.c are not in here, and what is here about
 * joining is made up, to test the tools. test_app.c and test_console_output.c test those.
 *
 * For the tools' tests: SIM_WRONG_PASSWORD_REASONS lists what a wrong password gets, one
 * attempt after the other, separated by commas. SIM_KEEPS_BOOT_INPUT keeps what arrives during
 * a restart, as a console that fails to discard it would. SIM_BOOT_TIME_MS says how long a
 * restart takes. SIGUSR1 installs the test image that loses power before the init flag, and
 * SIGUSR2 the normal one.
 */

#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#include "console_cmd.h"
#include "console_fakes.h"
#include "console_port.h"
#include "device.h"
#include "identity.h"
#include "version.h"

#define BOOT_TIME_MS 50
#define JOIN_TIME_MS 150
#define LOG_EVERY_MS 400

static volatile sig_atomic_t image_installed;

static void on_install(int number)
{
	image_installed = number;
}

static long long milliseconds(void)
{
	struct timespec now;

	clock_gettime(CLOCK_MONOTONIC, &now);
	return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static void send_new_output(void)
{
	static size_t output_sent;
	static size_t events_sent;
	static size_t echo_sent;
	const char *text;

	/* The fake keeps everything and clears nothing here: send what has been added. */
	for (text = fake.echo + echo_sent; *text != '\0'; text++, echo_sent++) {
		putchar(*text);
	}

	for (text = fake.output + output_sent; *text != '\0'; text++, output_sent++) {
		if (*text == '\n') {
			putchar('\r');
		}
		putchar(*text);
	}

	for (text = fake.events + events_sent; *text != '\0'; text++, events_sent++) {
		if (*text == '\n') {
			putchar('\r');
		}
		putchar(*text);
	}

	fflush(stdout);

	/* Start over before the buffers fill up. */
	if (output_sent > FAKE_OUTPUT_MAX / 2 || events_sent > FAKE_OUTPUT_MAX / 2 ||
	    echo_sent > FAKE_OUTPUT_MAX / 2) {
		fake_clear_log();
		output_sent = 0;
		events_sent = 0;
		echo_sent = 0;
	}
}

static void boot(void)
{
	fake.link_up = false;
	fake.cloud_connected = false;
	fake.cut_after = -1;
	(void)identity_init();

	if (device_boot() == DEVICE_BOOT_MIGRATED) {
		console_event("CONSOLE", "migrated: device id set to %s", device_id());
	}

	console_cmd_init();
	console_event("app", "Cranium firmware %s", fw_version_running_string());
	console_cmd_boot_box();

	if (device_is_factory()) {
		console_event("app", "WRN: Factory mode: send INIT|<id> on the console");
	}
}

/* The next reason from the list, or NULL at its end. */
static const char *next_reason(const char **cursor)
{
	static char reason[64];
	size_t length;

	if (*cursor == NULL || **cursor == '\0') {
		return NULL;
	}

	length = strcspn(*cursor, ",");
	snprintf(reason, sizeof(reason), "%.*s", (int)length, *cursor);
	*cursor += length + ((*cursor)[length] == ',' ? 1 : 0);
	return reason;
}

int main(void)
{
	struct termios raw;
	long long now = milliseconds();
	long long join_at = -1;
	long long boot_at = -1;
	long long next_log = now + LOG_EVERY_MS;
	const char *reasons = getenv("SIM_WRONG_PASSWORD_REASONS");
	const char *boot_time = getenv("SIM_BOOT_TIME_MS");
	const char *reason_cursor = NULL;
	static char kept[1024];
	size_t kept_used = 0;
	bool link_was_up = false;

	if (reasons == NULL) {
		reasons = "wrong password";
	}

	(void)signal(SIGUSR1, on_install);
	(void)signal(SIGUSR2, on_install);

	if (tcgetattr(STDIN_FILENO, &raw) == 0) {
		cfmakeraw(&raw);
		(void)tcsetattr(STDIN_FILENO, TCSANOW, &raw);
	}

	fake_reset();
	boot();
	send_new_output();

	while (true) {
		fd_set inputs;
		struct timeval wait = { .tv_usec = 10000 };

		FD_ZERO(&inputs);
		FD_SET(STDIN_FILENO, &inputs);

		if (select(STDIN_FILENO + 1, &inputs, NULL, NULL, &wait) > 0) {
			char byte;

			if (read(STDIN_FILENO, &byte, 1) <= 0) {
				return 0;
			}

			/* Whatever arrives while the board restarts is lost, as on the real one. */
			if (boot_at < 0) {
				console_cmd_feed(byte);
			} else if (getenv("SIM_KEEPS_BOOT_INPUT") != NULL &&
				   kept_used < sizeof(kept)) {
				kept[kept_used++] = byte;
			}
		}

		now = milliseconds();
		fake.now_ms = now;

		if (image_installed != 0) {
			fake.lose_power_before_flag = image_installed == SIGUSR1;
			image_installed = 0;
			fake.reboots = 1;
		}

		if (fake.reboots > 0) {
			fake.reboots = 0;
			fake.joins = 0;
			join_at = -1;
			boot_at = now + (boot_time != NULL ? atoi(boot_time) : BOOT_TIME_MS);
		}

		if (boot_at >= 0 && now >= boot_at) {
			boot_at = -1;
			boot();
			link_was_up = false;

			for (size_t i = 0; i < kept_used; i++) {
				console_cmd_feed(kept[i]);
			}
			kept_used = 0;

			if (!device_is_factory() && fake.wifi_stored) {
				join_at = now + JOIN_TIME_MS;
				reason_cursor = reasons;
			}
		}

		if (fake.joins > 0) {
			fake.joins = 0;
			join_at = now + JOIN_TIME_MS;
			reason_cursor = reasons;

			/* Joining another network leaves the one it is on. */
			fake.link_up = false;
			fake.cloud_connected = false;
		}

		/* However the link went, the board says so. CLEAR_WIFI is one way. */
		if (link_was_up && !fake.link_up) {
			fake.cloud_connected = false;
			console_event("WIFI", "disconnected");
		}
		link_was_up = fake.link_up;

		if (join_at >= 0 && now >= join_at) {
			join_at = -1;

			if (strncmp(fake.wifi_password, "wrong", 5) == 0) {
				const char *reason = next_reason(&reason_cursor);

				/* One attempt after the other, until the list ends. */
				if (reason != NULL) {
					console_event("WIFI", "failed reason=%s", reason);
					join_at = now + JOIN_TIME_MS;
				}
			} else {
				fake.link_up = true;
				console_event("WIFI", "connected ip=192.168.1.42 rssi=-51");

				if (identity_settings_get() != NULL && fake.private_key &&
				    fake.certificate) {
					fake.cloud_connected = true;
				}
			}
		}

		if (now >= next_log) {
			next_log = now + LOG_EVERY_MS;
			console_port_event("[ota] Log line in between", 25);
			console_cmd_tick();
		}

		send_new_output();
	}
}
