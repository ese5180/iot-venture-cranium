/*
 * Host-side tests of the serial console: the line reader, the command table, the order of
 * first-time setup, the migration of boards in the field and the loading of certificates.
 * The console's own code runs as it is, against the fake board in console_fakes.c.
 *
 * What a person types at this console can contain a password, so these tests also insist
 * that no secret ever comes back in a reply, and that none stays behind in the buffer.
 */

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <zephyr/sys/base64.h>

#include "console_cmd.h"
#include "console_fakes.h"
#include "console_parser.h"
#include "console_stream.h"
#include "device.h"
#include "factory.h"
#include "identity.h"
#include "store.h"
#include "version.h"

#define ENDPOINT "example-ats.iot.us-east-1.amazonaws.com"
#define PREFIX   "https://bucket.s3.us-east-1.amazonaws.com/firmware/"
#define PASSWORD "correct-horse-battery"
#define SOC_ID   "fe5b26c0c5b1dcd7"
/* Shaped like the name of an iPhone's hotspot: its apostrophe is three bytes of UTF-8. */
#define HOTSPOT  "Tester\xe2\x80\x99s iPhone"

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

#define CHECK_TEXT(actual, expected)                                                         \
	do {                                                                                 \
		const char *actual_ = (actual);                                              \
		checks++;                                                                    \
		if (strcmp(actual_, (expected)) != 0) {                                      \
			failures++;                                                          \
			printf("FAIL %s:%d: \"%s\", expected \"%s\"\n", __FILE__, __LINE__,  \
			       actual_, (expected));                                         \
		}                                                                            \
	} while (0)

/* ---- helpers -------------------------------------------------------------------- */

static void feed(const char *text)
{
	for (; *text != '\0'; text++) {
		console_cmd_feed(*text);
	}
}

static void feed_bytes(const char *data, size_t length)
{
	for (size_t i = 0; i < length; i++) {
		console_cmd_feed(data[i]);
	}
}

/* Send a command as a script does, and forget what came before it. */
static void command(const char *line)
{
	fake_clear_log();
	feed(line);
	feed("\r");
}

/* The last line that came out: the final line of the reply. */
static const char *final_line(void)
{
	static char line[512];
	size_t length = strlen(fake.output);
	const char *start;

	if (length == 0) {
		return "";
	}

	/* Step over the line ending of the last line. */
	start = fake.output + length - 1;
	while (start > fake.output && start[-1] != '\n') {
		start--;
	}

	snprintf(line, sizeof(line), "%.*s", (int)(fake.output + length - 1 - start), start);
	return line;
}

/* The value of one "key   value" line of a status listing. */
static const char *value_of(const char *key)
{
	static char value[256];
	const char *at = fake.output;

	while (at != NULL && *at != '\0') {
		const char *end = strchr(at, '\n');
		size_t key_length = strlen(key);

		if (strncmp(at, key, key_length) == 0 && at[key_length] == ' ') {
			const char *text = at + key_length;

			while (*text == ' ') {
				text++;
			}

			snprintf(value, sizeof(value), "%.*s", (int)(end - text), text);
			return value;
		}

		at = end != NULL ? end + 1 : NULL;
	}

	return "<none>";
}

/* What happens at a boot: the console starts over, and only storage has survived. */
static enum device_boot boot(void)
{
	enum device_boot result;

	fake.cut_after = -1;
	CHECK(identity_init() == 0);
	result = device_boot();
	console_cmd_init();
	feed("ECHO|OFF\r");
	fake_clear_log();
	return result;
}

static void blank_board(void)
{
	fake_reset();
	boot();
}

static void store_settings(void)
{
	CHECK(identity_settings_set(ENDPOINT, PREFIX) == 0);
}

/* A board that was set up with this firmware: flag, ID, Wi-Fi and the rest. */
static void operating_board(void)
{
	blank_board();
	command("INIT|ABC123");
	CHECK(fake.reboots == 1);
	boot();
	CHECK(!device_is_factory());

	store_settings();
	fake.wifi_stored = true;
	strcpy(fake.wifi_ssid, "MyNetwork");
	strcpy(fake.wifi_password, PASSWORD);
	fake.private_key = true;
	fake.certificate = true;
	fake.ca_cloud = true;
	fake.ca_download = true;
	fake_clear_log();
}

/* A board in the field, provisioned by firmware that knew nothing of the flag or the ID. */
static void old_provisioned_board(void)
{
	fake_reset();
	CHECK(identity_init() == 0);
	store_settings();
	fake.wifi_stored = true;
	strcpy(fake.wifi_ssid, "MyNetwork");
	fake.private_key = true;
	fake.certificate = true;
	fake.ca_cloud = true;
	fake.ca_download = true;
	fake_clear_log();
}

static bool ops_contain_in_order(const char *first, const char *second)
{
	const char *a = strstr(fake.ops, first);

	return a != NULL && strstr(a + strlen(first), second) != NULL;
}

/* ---- the reader, directly ------------------------------------------------------- */

static struct console_reader reader;
static char reader_echo[4096];
static char reader_last[CONSOLE_LINE_MAX + 1];

static void reader_echo_out(const char *text, size_t length)
{
	strncat(reader_echo, text, length);
}

static void reader_start(void)
{
	reader_echo[0] = '\0';
	console_reader_init(&reader, reader_echo_out);
}

/* Feed bytes and count the complete lines, the way the console takes them. */
static int lines_in(const char *data, size_t length)
{
	int lines = 0;

	for (size_t i = 0; i < length; i++) {
		if (console_reader_feed(&reader, data[i]) == CONSOLE_READ_LINE) {
			lines++;
			strcpy(reader_last, reader.line);
			console_reader_done(&reader);
		}
	}

	return lines;
}

static void test_line_endings(void)
{
	reader_start();
	CHECK(lines_in("A\r", 2) == 1);
	CHECK_TEXT(reader_last, "A");

	reader_start();
	CHECK(lines_in("A\n", 2) == 1);
	CHECK_TEXT(reader_last, "A");

	/* CRLF is one line ending. */
	reader_start();
	CHECK(lines_in("A\r\nB\r\n", 6) == 2);
	CHECK_TEXT(reader_last, "B");
	CHECK_TEXT(reader_echo, "A\r\nB\r\n");

	/* The same when the two bytes of a line ending arrive in separate reads. */
	reader_start();
	CHECK(lines_in("A\r", 2) == 1);
	CHECK(lines_in("\n", 1) == 0);
	CHECK(lines_in("B\n", 2) == 1);
	CHECK_TEXT(reader_last, "B");
	CHECK_TEXT(reader_echo, "A\r\nB\r\n");

	/* An LF that does not follow a CR at once is a line ending of its own. */
	reader_start();
	CHECK(lines_in("A\r", 2) == 1);
	CHECK(lines_in("B", 1) == 0);
	CHECK(lines_in("\n", 1) == 1);
	CHECK_TEXT(reader_last, "B");

	/* LF then CR: two endings, of which the second ends a blank line. */
	reader_start();
	CHECK(lines_in("A\n\r", 3) == 1);
	CHECK_TEXT(reader_echo, "A\r\n\r\n");

	/* Through the whole console, each way of ending a line runs one command. */
	blank_board();
	fake_clear_log();
	feed("GET_ID\r");
	CHECK(fake.finals == 1);
	feed("GET_ID\n");
	CHECK(fake.finals == 2);
	feed("GET_ID\r\n");
	CHECK(fake.finals == 3);
	feed("GET_ID\r");
	feed("\n");
	CHECK(fake.finals == 4);
	feed("\r\n\r\n");
	CHECK(fake.finals == 4);
}

static void test_blank_lines(void)
{
	reader_start();
	CHECK(lines_in("\r", 1) == 0);
	CHECK(lines_in("\n", 1) == 0);
	CHECK(lines_in("\r\n\r\n\n\n\r\r", 8) == 0);
	CHECK(lines_in("   \t  \r", 7) == 0);
	CHECK(lines_in("A\r", 2) == 1);

	blank_board();
	command("");
	CHECK(fake.finals == 0);
	command("    ");
	CHECK(fake.finals == 0);
	command("\t");
	CHECK(fake.finals == 0);
	CHECK_TEXT(fake.output, "");
}

static void test_overlong_lines(void)
{
	static char line[CONSOLE_LINE_MAX + 200];

	/* Exactly as long as the buffer: fine. */
	reader_start();
	memset(line, 'x', CONSOLE_LINE_MAX);
	line[CONSOLE_LINE_MAX] = '\r';
	CHECK(lines_in(line, CONSOLE_LINE_MAX + 1) == 1);
	CHECK(strlen(reader_last) == CONSOLE_LINE_MAX);

	/* One more: the whole line goes, and the next line works. */
	reader_start();
	memset(line, 'x', CONSOLE_LINE_MAX + 1);
	line[CONSOLE_LINE_MAX + 1] = '\r';
	for (size_t i = 0; i < CONSOLE_LINE_MAX + 1; i++) {
		CHECK(console_reader_feed(&reader, line[i]) == CONSOLE_READ_MORE);
	}
	CHECK(console_reader_feed(&reader, '\r') == CONSOLE_READ_TOO_LONG);
	CHECK(reader.length == 0);
	CHECK(lines_in("B\r", 2) == 1);
	CHECK_TEXT(reader_last, "B");

	/* What fits of the line is wiped at once, because it can hold a password. */
	reader_start();
	memcpy(line, "WIFI|net|" PASSWORD, strlen("WIFI|net|" PASSWORD));
	(void)lines_in(line, CONSOLE_LINE_MAX + 1);
	CHECK(memmem(reader.line, sizeof(reader.line), PASSWORD, strlen(PASSWORD)) == NULL);
	console_reader_done(&reader);

	/* A truncated command must not run: this one would, if it were cut at the limit. */
	operating_board();
	memset(line, ' ', sizeof(line));
	memcpy(line, "REBOOT", 6);
	line[CONSOLE_LINE_MAX + 10] = '\0';
	command(line);
	CHECK(fake.reboots == 0);
	CHECK(fake.finals == 1);
	CHECK(strncmp(final_line(), "ERR line too long", 17) == 0);

	/* And backspace cannot rescue it. */
	fake_clear_log();
	feed(line);
	for (int i = 0; i < 100; i++) {
		feed("\b");
	}
	feed("\r");
	CHECK(fake.reboots == 0);
	CHECK(strncmp(final_line(), "ERR line too long", 17) == 0);

	/* The next line is back to normal. */
	command("GET_ID");
	CHECK(strncmp(final_line(), "OK ABC123|", 10) == 0);

	/* The longest real commands fit. */
	memset(line, 'a', sizeof(line));
	memcpy(line, "CLOUD|", 6);
	line[CONSOLE_LINE_MAX] = '\0';
	command(line);
	CHECK(strstr(final_line(), "too long") == NULL);
}

static void test_control_characters(void)
{
	static const char nul_in_line[] = { 'G', 'E', 'T', '\0', '_', 'I', 'D', '\r' };

	operating_board();

	/* A NUL would cut the line short as a C string. */
	fake_clear_log();
	feed_bytes(nul_in_line, sizeof(nul_in_line));
	CHECK(fake.finals == 1);
	CHECK(strncmp(final_line(), "ERR line discarded", 18) == 0);

	/* An arrow key at a terminal. */
	command("GET_ID\x1b[A");
	CHECK(strncmp(final_line(), "ERR line discarded", 18) == 0);

	command("GET_ID");
	CHECK(strncmp(final_line(), "OK ", 3) == 0);

	/* Bytes lost on the way in: the line they belonged to must not run. */
	fake_clear_log();
	feed("REBO");
	console_cmd_input_lost();
	feed("OT\r");
	CHECK(fake.reboots == 0);
	CHECK(strncmp(final_line(), "ERR line discarded", 18) == 0);

	/* The next one runs. */
	command("GET_ID");
	CHECK(strncmp(final_line(), "OK ", 3) == 0);
}

static void test_leading_whitespace_and_case(void)
{
	operating_board();

	command("   GET_ID");
	CHECK(strncmp(final_line(), "OK ABC123|", 10) == 0);
	command("\t GET_ID");
	CHECK(strncmp(final_line(), "OK ABC123|", 10) == 0);
	command("GET_ID   ");
	CHECK(strncmp(final_line(), "OK ABC123|", 10) == 0);

	/* Command names in any case. */
	command("get_id");
	CHECK(strncmp(final_line(), "OK ABC123|", 10) == 0);
	command("Get_Id");
	CHECK(strncmp(final_line(), "OK ABC123|", 10) == 0);
	command("gEt_iD");
	CHECK(strncmp(final_line(), "OK ABC123|", 10) == 0);

	/* Arguments keep theirs. */
	command("set_id|AbCxYz9");
	CHECK_TEXT(final_line(), "OK id set to AbCxYz9");
	CHECK_TEXT(device_id(), "AbCxYz9");

	command("WIFI|MixedCase Net|MiXeD-PaSsWoRd");
	CHECK_TEXT(fake.wifi_ssid, "MixedCase Net");
	CHECK_TEXT(fake.wifi_password, "MiXeD-PaSsWoRd");
}

static void test_last_argument_with_separator(void)
{
	operating_board();

	command("WIFI|net|pass|word|with|bars");
	CHECK_TEXT(final_line(), "OK saved, connecting to net");
	CHECK_TEXT(fake.wifi_ssid, "net");
	CHECK_TEXT(fake.wifi_password, "pass|word|with|bars");

	command("WIFI_SEC|net|WPA3_SAE|another|pass|word");
	CHECK(fake.wifi_security == NET_SECURITY_WPA3_SAE);
	CHECK_TEXT(fake.wifi_password, "another|pass|word");
}

static void test_missing_and_extra_arguments(void)
{
	operating_board();

	command("WIFI");
	CHECK_TEXT(final_line(), "ERR usage: WIFI|<ssid>|<password>");
	command("WIFI|net");
	CHECK_TEXT(final_line(), "ERR usage: WIFI|<ssid>|<password>");
	command("WIFI_SEC|net|WPA2_PSK");
	CHECK(strncmp(final_line(), "ERR usage: WIFI_SEC|", 20) == 0);
	command("INIT");
	CHECK_TEXT(final_line(), "ERR usage: INIT|<id>");
	command("SET_ID");
	CHECK_TEXT(final_line(), "ERR usage: SET_ID|<id>");
	command("ECHO");
	CHECK(strncmp(final_line(), "ERR usage: ECHO", 15) == 0);
	command("STREAM_CHUNK|1");
	CHECK(strncmp(final_line(), "ERR usage: STREAM_CHUNK", 23) == 0);
	CHECK_TEXT(device_id(), "ABC123");

	/* A command that takes nothing does not take something. */
	command("GET_ID|x");
	CHECK_TEXT(final_line(), "ERR usage: GET_ID");
	command("REBOOT|now");
	CHECK_TEXT(final_line(), "ERR usage: REBOOT");
	CHECK(fake.reboots == 0);
	command("FACTORY_RESET|yes");
	CHECK_TEXT(final_line(), "ERR usage: FACTORY_RESET");
	CHECK(fake.wifi_stored);

	/* One argument too many ends up in the last one, where it fails validation. */
	command("SET_ID|ABC|DEF");
	CHECK(strncmp(final_line(), "ERR id must be", 14) == 0);
	CHECK_TEXT(device_id(), "ABC123");
	command("ECHO|ON|OFF");
	CHECK(strncmp(final_line(), "ERR usage: ECHO", 15) == 0);
}

static void test_backspace_and_del(void)
{
	operating_board();

	command("GET_IX\bD");
	CHECK(strncmp(final_line(), "OK ABC123|", 10) == 0);
	command("GET_IX\x7f" "D");
	CHECK(strncmp(final_line(), "OK ABC123|", 10) == 0);
	command("XXXX\b\b\b\bGET_ID");
	CHECK(strncmp(final_line(), "OK ABC123|", 10) == 0);

	/* On an empty line there is nothing to erase, and nothing is echoed. */
	command("\b\b\x7f\bGET_ID");
	CHECK(strncmp(final_line(), "OK ABC123|", 10) == 0);

	/* Everything typed and then erased is a blank line. */
	command("abc\b\b\b");
	CHECK(fake.finals == 0);

	reader_start();
	(void)lines_in("\b\x7f", 2);
	CHECK_TEXT(reader_echo, "");
	CHECK(reader.length == 0);
	(void)lines_in("ab\b\x7f", 4);
	CHECK_TEXT(reader_echo, "ab\b \b\b \b");
	CHECK(reader.length == 0);

	/* A character of several bytes is one key press to erase. */
	reader_start();
	(void)lines_in("a\xe2\x80\x99", 4);
	CHECK(reader.length == 4);
	(void)lines_in("\b", 1);
	CHECK(reader.length == 1);
	CHECK(strcmp(reader_echo, "a\xe2\x80\x99\b \b") == 0);
	console_reader_done(&reader);
}

static void test_echo(void)
{
	fake_reset();
	CHECK(identity_init() == 0);
	device_boot();
	console_cmd_init();

	/* On by default. */
	fake_clear_log();
	feed("GET_ID\r");
	CHECK_TEXT(fake.echo, "GET_ID\r\n");

	/* The reply is not part of the echo, and the echo is not part of the reply. */
	CHECK(strstr(fake.echo, "OK") == NULL);
	CHECK(strstr(fake.output, "GET_ID") == NULL);

	fake_clear_log();
	feed("ECHO|OFF\r");
	CHECK_TEXT(final_line(), "OK echo off");
	CHECK_TEXT(fake.echo, "ECHO|OFF\r\n");

	fake_clear_log();
	feed("GET_ID\rabc\bd\r");
	CHECK_TEXT(fake.echo, "");

	fake_clear_log();
	feed("ECHO|on\r");
	CHECK_TEXT(final_line(), "OK echo on");
	CHECK_TEXT(fake.echo, "");

	fake_clear_log();
	feed("G");
	CHECK_TEXT(fake.echo, "G");
	feed("\r");
	CHECK(fake.finals == 1);

	command("ECHO|MAYBE");
	CHECK(strncmp(final_line(), "ERR usage: ECHO", 15) == 0);

	/* After a boot it is on again. */
	console_cmd_init();
	fake_clear_log();
	feed("G");
	CHECK_TEXT(fake.echo, "G");
	feed("\b");
	fake_clear_log();
}

static void test_unknown_command(void)
{
	operating_board();

	command("FOO");
	CHECK_TEXT(final_line(), "ERR unknown command FOO, type HELP");

	/* Only the name, never its arguments: they could be anything. */
	command("FOO|" PASSWORD "|more");
	CHECK_TEXT(final_line(), "ERR unknown command FOO, type HELP");
	CHECK(strstr(fake.output, PASSWORD) == NULL);

	command("WIFIS|net|" PASSWORD);
	CHECK_TEXT(final_line(), "ERR unknown command WIFIS, type HELP");
	CHECK(strstr(fake.output, PASSWORD) == NULL);

	command("|something");
	CHECK_TEXT(final_line(), "ERR no command, type HELP");

	/* The name ends at a blank as well: people type spaces, also before a password. */
	command("WIFI MyNetwork " PASSWORD);
	CHECK_TEXT(final_line(), "ERR unknown command WIFI, type HELP");
	CHECK(strstr(fake.output, PASSWORD) == NULL);
	CHECK(strstr(fake.output, "MyNetwork") == NULL);

	command("wifi\t" PASSWORD);
	CHECK_TEXT(final_line(), "ERR unknown command wifi, type HELP");
	CHECK(strstr(fake.output, PASSWORD) == NULL);

	command("  FOO bar|" PASSWORD);
	CHECK_TEXT(final_line(), "ERR unknown command FOO, type HELP");

	/* The old shell's commands are no more, and their base64 passwords do not come back. */
	command("prov status");
	CHECK_TEXT(final_line(), "ERR unknown command prov, type HELP");
	command("prov wifi TXlOZXQ= WPA2_PSK aHVudGVyMjI=");
	CHECK_TEXT(final_line(), "ERR unknown command prov, type HELP");
	CHECK(strstr(fake.output, "aHVu") == NULL);

	/* A real command followed by something after a blank is not that command. */
	operating_board();
	command("FACTORY_RESET now");
	CHECK_TEXT(final_line(), "ERR unknown command FACTORY_RESET, type HELP");
	CHECK(fake.reboots == 0);
	CHECK(fake.wifi_stored);

	/* A very long name is shown only so far. */
	{
		char line[80];

		memset(line, 'N', 60);
		line[60] = '\0';
		command(line);
		CHECK_TEXT(final_line(), "ERR unknown command NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN, type HELP");
	}
}

/* ---- the table ------------------------------------------------------------------ */

static void test_the_table_drives_help(void)
{
	size_t count;
	const struct console_command *table = console_cmd_table(&count);

	CHECK(count >= 20);

	operating_board();
	command("HELP");
	CHECK(fake.finals == 1);
	CHECK_TEXT(final_line(), "OK");
	CHECK(strstr(fake.output, fw_version_running_string()) != NULL);

	for (size_t i = 0; i < count; i++) {
		char expected[160];
		const char *line;

		/* Every command is there, with its mark, its usage and its description. */
		snprintf(expected, sizeof(expected), "%c %s", table[i].in_factory ? '*' : ' ',
			 table[i].usage);
		line = strstr(fake.output, expected);
		CHECK(line != NULL);
		CHECK(strstr(fake.output, table[i].description) != NULL);
	}

	/* Grouped: each section's heading comes once, and before its commands. */
	CHECK(strstr(fake.output, "Device:\n") != NULL);
	CHECK(strstr(fake.output, "Wi-Fi:\n") != NULL);
	CHECK(strstr(fake.output, "Device:\n") < strstr(fake.output, "HELP "));
	CHECK(strstr(fake.output, "Wi-Fi:\n") < strstr(fake.output, "WIFI|<ssid>"));
	CHECK(strstr(fake.output, "Cloud:\n") < strstr(fake.output, "CLOUD|<endpoint>"));

	/* The alias works and is mentioned. */
	CHECK(strstr(fake.output, "also ?") != NULL);
	{
		char first[sizeof(fake.output)];

		strcpy(first, fake.output);
		command("?");
		CHECK_TEXT(fake.output, first);
	}

	/* RESET_CONFIG says what it keeps. */
	command("HELP");
	CHECK(strstr(fake.output, "keep id, wifi, certificates, key") != NULL);

	/* The numbers of arguments cannot drift from what the usage says. */
	for (size_t i = 0; i < count; i++) {
		int separators = 0;

		for (const char *c = table[i].usage; *c != '\0'; c++) {
			separators += *c == '|';
		}

		CHECK(separators == table[i].max_args);
		CHECK(table[i].min_args <= table[i].max_args);
		CHECK(table[i].max_args <= 4);
		CHECK(table[i].handler != NULL);
	}

	/* Exactly the commands the specification has in each mode. */
	static const char *const factory_ones[] = { "HELP", "INIT", "GET_ID", "THING", "ECHO",
						     "REBOOT", "ENTER_BOOTLOADER" };

	for (size_t i = 0; i < count; i++) {
		bool expected = false;

		for (size_t j = 0; j < sizeof(factory_ones) / sizeof(factory_ones[0]); j++) {
			expected = expected || strcmp(table[i].name, factory_ones[j]) == 0;
		}

		CHECK(table[i].in_factory == expected);
	}
}

static void test_factory_refusal_comes_from_the_table(void)
{
	size_t count;
	const struct console_command *table = console_cmd_table(&count);

	for (size_t i = 0; i < count; i++) {
		blank_board();
		CHECK(device_is_factory());

		/* With and without arguments, and in any case. */
		command(table[i].name);

		if (table[i].in_factory) {
			CHECK(strcmp(final_line(), "ERR factory mode, send INIT|<id> first") != 0);
		} else {
			CHECK_TEXT(final_line(), "ERR factory mode, send INIT|<id> first");
			CHECK(fake.finals == 1);

			char line[80];

			snprintf(line, sizeof(line), "%s|a|b|c|d", table[i].name);
			command(line);
			CHECK_TEXT(final_line(), "ERR factory mode, send INIT|<id> first");
		}

		CHECK(strstr(fake.ops, "W") == NULL);
	}

	/* The ones the owner's first check names. */
	blank_board();
	command("WIFI|a|b");
	CHECK_TEXT(final_line(), "ERR factory mode, send INIT|<id> first");
	CHECK(!fake.wifi_stored);
	command("GET_ID");
	CHECK(strncmp(final_line(), "OK |", 4) == 0);
	CHECK(strstr(final_line(), fw_version_running_string()) != NULL);
	command("THING");
	CHECK_TEXT(final_line(), "OK cranium-" SOC_ID);
}

static void test_every_command_ends_with_one_final_line(void)
{
	static const char *const argument_sets[] = { "", "|", "|a", "|a|b", "|a|b|c", "|a|b|c|d",
						     "|ON", "|OFF", "|1", "|2", "|REPLACE", "|wifi",
						     "|ABC123" };
	size_t count;
	const struct console_command *table = console_cmd_table(&count);

	for (size_t i = 0; i < count; i++) {
		for (size_t j = 0; j < sizeof(argument_sets) / sizeof(argument_sets[0]); j++) {
			char line[80];

			operating_board();
			snprintf(line, sizeof(line), "%s%s", table[i].name, argument_sets[j]);
			command(line);

			CHECK(fake.finals == 1);
			CHECK(strncmp(final_line(), "OK", 2) == 0 ||
			      strncmp(final_line(), "ERR ", 4) == 0);

			/* No reply line can be taken for a log line. */
			CHECK(fake.output[0] != '[');
			CHECK(strstr(fake.output, "\n[") == NULL);
		}
	}
}

/* ---- validation ----------------------------------------------------------------- */

static void test_id_validation(void)
{
	static const char *const good[] = { "A", "z", "7", "ABC123", "abcXYZ012",
					    "12345678901234567890123456789012" };
	static const char *const bad[] = { "", "bad id!", "with space", "under_score", "da-sh",
					   "dot.dot", "new\nline", "\xc3\xa9t\xc3\xa9",
					   "123456789012345678901234567890123", "a|b" };
	char line[80];

	for (size_t i = 0; i < sizeof(good) / sizeof(good[0]); i++) {
		CHECK(device_id_valid(good[i]));
	}

	for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
		CHECK(!device_id_valid(bad[i]));
	}

	operating_board();

	for (size_t i = 0; i < sizeof(good) / sizeof(good[0]); i++) {
		snprintf(line, sizeof(line), "SET_ID|%s", good[i]);
		command(line);
		CHECK(strncmp(final_line(), "OK id set to ", 13) == 0);
		CHECK_TEXT(device_id(), good[i]);
	}

	command("SET_ID|ABC123");

	command("SET_ID|");
	CHECK_TEXT(final_line(), "ERR id must be 1-32 letters or digits");
	command("SET_ID|bad id!");
	CHECK_TEXT(final_line(), "ERR id must be 1-32 letters or digits");
	command("SET_ID|123456789012345678901234567890123");
	CHECK_TEXT(final_line(), "ERR id must be 1-32 letters or digits");
	CHECK_TEXT(device_id(), "ABC123");

	/* Survives a restart, and SET_ID keeps everything else. */
	command("SET_ID|NEWNAME1");
	CHECK(boot() == DEVICE_BOOT_OPERATING);
	CHECK_TEXT(device_id(), "NEWNAME1");
	CHECK(fake.wifi_stored);
	CHECK(fake.private_key);
	CHECK(identity_settings_get() != NULL);

	/* A read-back that differs is a failure, even if the write said it worked. */
	fake.corrupt_read[STORE_DEVICE_ID] = true;
	command("SET_ID|OTHER");
	CHECK(strncmp(final_line(), "ERR id could not be stored", 26) == 0);
	CHECK_TEXT(device_id(), "NEWNAME1");
}

static void test_wifi_validation(void)
{
	char line[256];
	char long_ssid[40];
	char password[80];

	operating_board();

	/* SSID: bytes, not characters. */
	memset(long_ssid, 's', sizeof(long_ssid));
	long_ssid[32] = '\0';
	snprintf(line, sizeof(line), "WIFI|%s|%s", long_ssid, PASSWORD);
	command(line);
	CHECK(strncmp(final_line(), "OK saved, connecting to ", 24) == 0);
	CHECK_TEXT(fake.wifi_ssid, long_ssid);

	long_ssid[32] = 's';
	long_ssid[33] = '\0';
	strcpy(fake.wifi_ssid, "before");
	snprintf(line, sizeof(line), "WIFI|%s|%s", long_ssid, PASSWORD);
	command(line);
	CHECK_TEXT(final_line(), "ERR ssid must be 1-32 bytes");
	CHECK_TEXT(fake.wifi_ssid, "before");

	snprintf(line, sizeof(line), "WIFI||%s", PASSWORD);
	command(line);
	CHECK_TEXT(final_line(), "ERR ssid must be 1-32 bytes");
	CHECK_TEXT(fake.wifi_ssid, "before");

	command("WIFI|a|" PASSWORD);
	CHECK_TEXT(fake.wifi_ssid, "a");

	/* A name shaped like an iPhone's hotspot arrives byte for byte. */
	command("WIFI|" HOTSPOT "|" PASSWORD);
	CHECK_TEXT(fake.wifi_ssid, HOTSPOT);
	CHECK_TEXT(final_line(), "OK saved, connecting to " HOTSPOT);
	CHECK(strlen(HOTSPOT) == 17);

	/* Thirty bytes of 'x' and the apostrophe make 33 bytes in 31 characters. */
	memset(long_ssid, 'x', 30);
	memcpy(long_ssid + 30, "\xe2\x80\x99", 3);
	long_ssid[33] = '\0';
	strcpy(fake.wifi_ssid, "before");
	snprintf(line, sizeof(line), "WIFI|%s|%s", long_ssid, PASSWORD);
	command(line);
	CHECK_TEXT(final_line(), "ERR ssid must be 1-32 bytes");
	CHECK_TEXT(fake.wifi_ssid, "before");

	/* And in 29 of them it fits exactly. */
	memset(long_ssid, 'x', 29);
	memcpy(long_ssid + 29, "\xe2\x80\x99", 3);
	long_ssid[32] = '\0';
	snprintf(line, sizeof(line), "WIFI|%s|%s", long_ssid, PASSWORD);
	command(line);
	CHECK_TEXT(fake.wifi_ssid, long_ssid);

	/* Password: 8 to 63. */
	strcpy(fake.wifi_ssid, "before");
	command("WIFI|net|1234567");
	CHECK_TEXT(final_line(), "ERR password must be 8-63 characters");
	CHECK_TEXT(fake.wifi_ssid, "before");

	command("WIFI|net|12345678");
	CHECK(strncmp(final_line(), "OK saved", 8) == 0);
	CHECK_TEXT(fake.wifi_password, "12345678");

	memset(password, 'p', sizeof(password));
	password[63] = '\0';
	snprintf(line, sizeof(line), "WIFI|net|%s", password);
	command(line);
	CHECK(strncmp(final_line(), "OK saved", 8) == 0);
	CHECK_TEXT(fake.wifi_password, password);

	password[63] = 'p';
	password[64] = '\0';
	strcpy(fake.wifi_ssid, "before");
	snprintf(line, sizeof(line), "WIFI|net|%s", password);
	command(line);
	CHECK_TEXT(final_line(), "ERR password must be 8-63 characters");
	CHECK_TEXT(fake.wifi_ssid, "before");

	/* An empty password means an open network, and those are refused here. */
	command("WIFI|net|");
	CHECK_TEXT(final_line(), "ERR open networks are not allowed");
	CHECK_TEXT(fake.wifi_ssid, "before");
	CHECK(fake.joins == 0);
	command("WIFI_SEC|net|WPA2_PSK|");
	CHECK_TEXT(final_line(), "ERR open networks are not allowed");

	/* Security modes. */
	static const struct {
		const char *name;
		enum net_security security;
	} modes[] = {
		{ "WPA2_PSK", NET_SECURITY_WPA2_PSK },
		{ "WPA2_PSK_SHA256", NET_SECURITY_WPA2_PSK_SHA256 },
		{ "WPA3_SAE", NET_SECURITY_WPA3_SAE },
	};

	for (size_t i = 0; i < sizeof(modes) / sizeof(modes[0]); i++) {
		snprintf(line, sizeof(line), "WIFI_SEC|net|%s|%s", modes[i].name, PASSWORD);
		command(line);
		CHECK(strncmp(final_line(), "OK saved", 8) == 0);
		CHECK(fake.wifi_security == modes[i].security);
	}

	command("WIFI|net|" PASSWORD);
	CHECK(fake.wifi_security == NET_SECURITY_WPA2_PSK);

	strcpy(fake.wifi_ssid, "before");
	command("WIFI_SEC|net|WEP|" PASSWORD);
	CHECK_TEXT(final_line(), "ERR security must be WPA2_PSK, WPA2_PSK_SHA256 or WPA3_SAE");
	CHECK_TEXT(fake.wifi_ssid, "before");
	command("WIFI_SEC|net|NONE|" PASSWORD);
	CHECK(strncmp(final_line(), "ERR security must be", 20) == 0);

	/* The reply goes out first, and the join follows: the console is not held up by it. */
	command("WIFI|net|" PASSWORD);
	CHECK(ops_contain_in_order("wifi-set", "final"));
	CHECK(ops_contain_in_order("final", "join"));
	CHECK(fake.joins == 1);

	/* A store that fails says so and does not join. */
	fake.fail_wifi_set = true;
	command("WIFI|net|" PASSWORD);
	CHECK(strncmp(final_line(), "ERR the network could not be stored", 35) == 0);
	CHECK(fake.joins == 0);
	fake.fail_wifi_set = false;

	command("CLEAR_WIFI");
	CHECK(strncmp(final_line(), "OK network erased", 17) == 0);
	CHECK(!fake.wifi_stored);
	CHECK(fake.wifi_password[0] == '\0');
}

/* ---- secrets -------------------------------------------------------------------- */

static void test_no_secret_comes_back(void)
{
	static const char *const lines[] = {
		"WIFI|MyNetwork|" PASSWORD,
		"WIFI_SEC|MyNetwork|WPA3_SAE|" PASSWORD,
		"WIFI_SEC|MyNetwork|NOPE|" PASSWORD,
		"WIFI|123456789012345678901234567890123|" PASSWORD,
		"WIFI||" PASSWORD,
		"wifi|MyNetwork|" PASSWORD "|with|bars",
		"FOO|" PASSWORD,
		"WIFI net " PASSWORD,
		"wifi\tnet\t" PASSWORD,
		"FOO" PASSWORD,
		"GET_ID|" PASSWORD,
		"REBOOT|" PASSWORD,
		"STATUS|" PASSWORD,
		"ECHO|" PASSWORD,
		"BUTTON|" PASSWORD,
		"SET_ID|bad " PASSWORD,
		"CLOUD|" PASSWORD "|",
		"STREAM_START|" PASSWORD "|1|0|CA",
		"STREAM_CHUNK|0|" PASSWORD,
		"INIT|bad " PASSWORD,
	};
	static const char *const status_commands[] = { "STATUS", "STATUS|wifi", "NET", "STATS",
						       "HELP" };

	for (size_t i = 0; i < sizeof(lines) / sizeof(lines[0]); i++) {
		operating_board();
		command(lines[i]);
		CHECK(fake.finals == 1);

		/*
		 * With no '|' and no blank, a line is nothing but a command name, and the name
		 * of an unknown command is what the reply is there to show. A password typed
		 * right after a command name, with nothing between them, is the one case that
		 * comes back. Everything else is simply never sent back.
		 */
		if (strcmp(lines[i], "FOO" PASSWORD) != 0) {
			CHECK(strstr(fake.output, PASSWORD) == NULL);
		}
		CHECK(strstr(fake.echo, PASSWORD) == NULL);
		CHECK(strstr(fake.events, PASSWORD) == NULL);

		/* And nothing of it stays in the line buffer. */
		command("GET_ID");
		for (size_t j = 0; j < sizeof(status_commands) / sizeof(status_commands[0]); j++) {
			command(status_commands[j]);
			CHECK(strstr(fake.output, PASSWORD) == NULL);
		}
	}

	/* What a status listing shows of a stored password. */
	operating_board();
	command("STATUS");
	CHECK_TEXT(value_of("wifi password"), "set");
	CHECK_TEXT(value_of("private key"), "set");
	CHECK(strstr(fake.output, PASSWORD) == NULL);

	command("CLEAR_WIFI");
	command("STATUS|wifi");
	CHECK_TEXT(value_of("wifi password"), "unset");

	/* A key that is created is never printed, only the request for its certificate. */
	operating_board();
	command("KEYGEN|REPLACE");
	CHECK(strstr(fake.output, "PRIVATE KEY") == NULL);
	CHECK(strstr(fake.output, "CERTIFICATE REQUEST") != NULL);

	/* Echo on is the one exception: the characters a person types come back. */
	operating_board();
	feed("ECHO|ON\r");
	fake_clear_log();
	feed("WIFI|net|" PASSWORD "\r");
	CHECK(strstr(fake.echo, PASSWORD) != NULL);
	CHECK(strstr(fake.output, PASSWORD) == NULL);
}

static void test_line_buffer_is_wiped(void)
{
	/* The same steps as console_cmd_feed(): the line is wiped when it has been dealt with. */
	reader_start();
	(void)lines_in("WIFI|net|" PASSWORD "\r", strlen("WIFI|net|" PASSWORD "\r"));
	CHECK(strstr(reader_last, PASSWORD) != NULL);
	CHECK(memmem(reader.line, sizeof(reader.line), PASSWORD, strlen(PASSWORD)) == NULL);
	for (size_t i = 0; i < sizeof(reader.line); i++) {
		if (reader.line[i] != 0) {
			failures++;
			printf("FAIL: byte %zu of the line buffer was not wiped\n", i);
			break;
		}
	}
	checks++;

	/* Through the whole console: when the command is over, the password is gone. */
	operating_board();
	command("WIFI|net|" PASSWORD);
	CHECK(fake.password_argument != NULL);
	CHECK(fake.password_argument_length == strlen(PASSWORD));
	CHECK(memcmp(fake.password_argument, PASSWORD, strlen(PASSWORD)) != 0);
	for (size_t i = 0; i < strlen(PASSWORD); i++) {
		if (fake.password_argument[i] != 0) {
			failures++;
			printf("FAIL: byte %zu of the password is still in memory\n", i);
			break;
		}
	}
	checks++;

	/* Also when the command fails. */
	fake.fail_wifi_set = true;
	command("WIFI|net|" PASSWORD);
	CHECK(strncmp(final_line(), "ERR ", 4) == 0);
	CHECK(memcmp(fake.password_argument, PASSWORD, strlen(PASSWORD)) != 0);
	fake.fail_wifi_set = false;

	/* A line condemned half way loses what was already in the buffer right away. */
	reader_start();
	(void)lines_in("WIFI|net|" PASSWORD "\x01", strlen("WIFI|net|" PASSWORD) + 1);
	CHECK(memmem(reader.line, sizeof(reader.line), PASSWORD, strlen(PASSWORD)) == NULL);
}

/* ---- first-time setup ----------------------------------------------------------- */

static void test_init_validates_first(void)
{
	/* Check 2: a typo erases nothing, and does nothing at all to storage. */
	operating_board();
	command("INIT|bad id!");
	CHECK_TEXT(final_line(), "ERR id must be 1-32 letters or digits");
	CHECK(fake.reboots == 0);
	CHECK(strstr(fake.ops, "W") == NULL);
	CHECK(strstr(fake.ops, "E") == NULL);
	CHECK(strstr(fake.ops, "wifi-clear") == NULL);
	CHECK(strstr(fake.ops, "tls-delete") == NULL);
	CHECK(fake.wifi_stored);
	CHECK(fake.private_key);
	CHECK(identity_settings_get() != NULL);
	CHECK_TEXT(device_id(), "ABC123");
	CHECK(!device_is_factory());

	command("INIT|");
	CHECK_TEXT(final_line(), "ERR id must be 1-32 letters or digits");
	CHECK(strstr(fake.ops, "W") == NULL);
}

static void test_init_order(void)
{
	operating_board();
	command("INIT|NEWID7");

	CHECK_TEXT(final_line(), "OK initialised as NEWID7, rebooting");
	CHECK(fake.reboots == 1);
	CHECK(fake.finals == 1);

	/* The order the specification gives. */
	CHECK(ops_contain_in_order("wifi-clear", "W3"));
	CHECK(ops_contain_in_order("tls-delete", "W3"));
	CHECK(ops_contain_in_order("E1", "W3"));
	CHECK(ops_contain_in_order("E2", "W3"));
	CHECK(ops_contain_in_order("E3", "W3"));
	CHECK(ops_contain_in_order("W3", "R3"));
	CHECK(ops_contain_in_order("R3", "W4"));
	CHECK(ops_contain_in_order("W4", "final"));
	CHECK(ops_contain_in_order("final", "reboot"));

	/* The flag's last write is what comes after the read-back; nothing writes after it. */
	{
		const char *back = strstr(fake.ops, "R3");
		const char *flag = strstr(back, "W4");

		CHECK(strstr(flag + 2, "W") == NULL);
		CHECK(strstr(flag + 2, "E") == NULL);
	}

	/* Everything else is gone. */
	CHECK(!fake.wifi_stored);
	CHECK(!fake.private_key);
	CHECK(!fake.certificate);
	CHECK(!fake.ca_cloud);
	CHECK(!fake.ca_download);
	CHECK(!fake.records[STORE_DEVICE_CONFIG].present);
	CHECK(!fake.records[STORE_OTA_RECORD].present);

	/* Check 3. */
	CHECK(boot() == DEVICE_BOOT_OPERATING);
	CHECK(!device_is_factory());
	command("GET_ID");
	CHECK(strncmp(final_line(), "OK NEWID7|", 10) == 0);

	command("WIFI|a|b");
	CHECK(strncmp(final_line(), "ERR factory", 11) != 0);
}

static void test_init_failing_at_each_step(void)
{
	static const struct {
		const char *expected;
		int record;
		int how; /* 0: write fails, 1: read fails, 2: read differs, 3: erase fails */
	} steps[] = {
		{ "ERR init failed at step: erase settings", STORE_DEVICE_CONFIG, 3 },
		{ "ERR init failed at step: erase settings", STORE_OTA_RECORD, 3 },
		{ "ERR init failed at step: erase settings", STORE_INIT_FLAG, 3 },
		{ "ERR init failed at step: write id", STORE_DEVICE_ID, 0 },
		{ "ERR init failed at step: read back id", STORE_DEVICE_ID, 1 },
		{ "ERR init failed at step: read back id", STORE_DEVICE_ID, 2 },
	};

	for (size_t i = 0; i < sizeof(steps) / sizeof(steps[0]); i++) {
		blank_board();

		switch (steps[i].how) {
		case 0:
			fake.fail_write[steps[i].record] = true;
			break;
		case 1:
			fake.fail_read[steps[i].record] = true;
			break;
		case 2:
			fake.corrupt_read[steps[i].record] = true;
			break;
		default:
			fake.fail_erase[steps[i].record] = true;
			break;
		}

		command("INIT|ABC123");

		/* Names the step, stays up, does not reboot, and the flag is not there. */
		CHECK_TEXT(final_line(), steps[i].expected);
		CHECK(fake.finals == 1);
		CHECK(fake.reboots == 0);
		CHECK(device_is_factory());

		command("GET_ID");
		CHECK(strncmp(final_line(), "OK ", 3) == 0);

		/* The flag is not complete, so the board still boots into factory mode. */
		memset(fake.fail_write, 0, sizeof(fake.fail_write));
		memset(fake.fail_read, 0, sizeof(fake.fail_read));
		memset(fake.corrupt_read, 0, sizeof(fake.corrupt_read));
		memset(fake.fail_erase, 0, sizeof(fake.fail_erase));
		CHECK(boot() == DEVICE_BOOT_FACTORY);
	}

	/* The last step: the flag itself. */
	blank_board();
	fake.fail_write[STORE_INIT_FLAG] = true;
	command("INIT|ABC123");
	/* The first write of the flag is the wipe marker, which an erase step depends on. */
	CHECK(strncmp(final_line(), "ERR init failed at step: ", 25) == 0);
	CHECK(fake.reboots == 0);
	fake.fail_write[STORE_INIT_FLAG] = false;
	CHECK(boot() == DEVICE_BOOT_FACTORY);

	/* After a failure the same INIT can simply be sent again. */
	command("INIT|ABC123");
	CHECK(fake.reboots == 1);
	CHECK(boot() == DEVICE_BOOT_OPERATING);

	/* A failure of the wifi store during the erase names the erase. */
	operating_board();
	fake.fail_wifi_clear = true;
	command("INIT|ABC123");
	CHECK_TEXT(final_line(), "ERR init failed at step: erase settings");
	CHECK(fake.reboots == 0);
	CHECK(device_is_factory());
}

static void test_init_flag_failure_alone(void)
{
	/* Everything before the flag worked: it is the last step that gets named. */
	blank_board();
	fake.fail_flag_complete = true;
	command("INIT|ABC123");
	CHECK_TEXT(final_line(), "ERR init failed at step: write init flag");
	CHECK(fake.reboots == 0);
	CHECK(fake.finals == 1);
	CHECK(device_is_factory());

	/* It stays up, and the ID that did get written is not a finished setup. */
	command("GET_ID");
	CHECK(strncmp(final_line(), "OK ABC123|", 10) == 0);
	fake.fail_flag_complete = false;
	CHECK(boot() == DEVICE_BOOT_FACTORY);
}

static void test_power_loss_before_the_flag(void)
{
	/* Check 6: the simulated power loss of the test image. */
	blank_board();
	fake.lose_power_before_flag = true;
	command("INIT|ABC123");
	CHECK(boot() == DEVICE_BOOT_FACTORY);
	CHECK(device_is_factory());

	/* INIT still works afterwards. */
	fake.lose_power_before_flag = false;
	command("INIT|ABC123");
	CHECK(boot() == DEVICE_BOOT_OPERATING);
}

/* However far it got: unless the flag went out, the next boot is in factory mode. */
static void test_power_cut_at_every_step(void)
{
	int steps_of_init = 0;

	/* How many writes does INIT do? */
	operating_board();
	fake.cut_after = 1000;
	command("INIT|NEWID7");
	steps_of_init = 1000 - fake.cut_after;
	fake.cut_after = -1;
	CHECK(steps_of_init > 5);

	/* Not even the first write made it: nothing has changed. */
	operating_board();
	fake.cut_after = 0;
	command("INIT|NEWID7");
	CHECK(boot() == DEVICE_BOOT_OPERATING);
	CHECK_TEXT(device_id(), "ABC123");
	CHECK(fake.wifi_stored);

	for (int cut = 1; cut < steps_of_init; cut++) {
		operating_board();
		fake.cut_after = cut;
		command("INIT|NEWID7");
		CHECK(boot() == DEVICE_BOOT_FACTORY);
		CHECK(device_is_factory());
	}

	/* With every write through, it is done. */
	operating_board();
	fake.cut_after = steps_of_init;
	command("INIT|NEWID7");
	CHECK(boot() == DEVICE_BOOT_OPERATING);
	CHECK_TEXT(device_id(), "NEWID7");

	/* The same for a factory reset, by command or by Button 2. */
	operating_board();
	fake.cut_after = 1000;
	command("FACTORY_RESET");
	steps_of_init = 1000 - fake.cut_after;
	fake.cut_after = -1;

	CHECK(steps_of_init > 5);

	for (int cut = 1; cut <= steps_of_init; cut++) {
		operating_board();
		fake.cut_after = cut;
		command("FACTORY_RESET");
		CHECK(boot() == DEVICE_BOOT_FACTORY);
		CHECK(!fake.records[STORE_INIT_FLAG].present || !identity_settings_get() ||
		      device_is_factory());
	}

	/* And a power cut during migration just migrates at the next boot. */
	for (int cut = 0; cut < 2; cut++) {
		old_provisioned_board();
		CHECK(identity_init() == 0);
		fake.cut_after = cut;
		(void)device_boot();
		CHECK(boot() == DEVICE_BOOT_MIGRATED);
		CHECK(boot() == DEVICE_BOOT_OPERATING);
		CHECK_TEXT(device_id(), SOC_ID);
	}
}

static void test_factory_reset(void)
{
	/* Check 7. */
	operating_board();
	fake.link_up = true;
	command("FACTORY_RESET");
	CHECK_TEXT(final_line(), "OK erased, rebooting into factory mode");
	CHECK(fake.reboots == 1);
	CHECK(ops_contain_in_order("final", "reboot"));

	CHECK(!fake.records[STORE_DEVICE_ID].present);
	CHECK(!fake.records[STORE_INIT_FLAG].present);
	CHECK(!fake.records[STORE_DEVICE_CONFIG].present);
	CHECK(!fake.records[STORE_OTA_RECORD].present);
	CHECK(!fake.wifi_stored);
	CHECK(!fake.private_key);
	CHECK(!fake.certificate);
	CHECK(!fake.ca_cloud);
	CHECK(!fake.ca_download);

	CHECK(boot() == DEVICE_BOOT_FACTORY);
	command("GET_ID");
	CHECK(strncmp(final_line(), "OK |", 4) == 0);

	/* Button 2 calls factory_reset() itself: the same state, whatever was there. */
	operating_board();
	CHECK(factory_reset() == 0);
	CHECK(!fake.records[STORE_DEVICE_ID].present);
	CHECK(!fake.records[STORE_INIT_FLAG].present);
	CHECK(!fake.records[STORE_DEVICE_CONFIG].present);
	CHECK(!fake.records[STORE_OTA_RECORD].present);
	CHECK(!fake.wifi_stored);
	CHECK(!fake.private_key);
	CHECK(boot() == DEVICE_BOOT_FACTORY);

	/* Erasing what is not there is not an error. */
	CHECK(factory_reset() == 0);

	/* A failure is reported, and the rest is erased anyway. */
	operating_board();
	fake.fail_erase[STORE_DEVICE_CONFIG] = true;
	command("FACTORY_RESET");
	CHECK(strncmp(final_line(), "ERR not everything could be erased", 34) == 0);
	CHECK(fake.reboots == 0);
	CHECK(!fake.wifi_stored);
	CHECK(!fake.private_key);
	CHECK(device_is_factory());

	/* What the reply says to do works, there and then, without a restart. */
	CHECK(strstr(final_line(), "send INIT|<id>") != NULL);
	fake.fail_erase[STORE_DEVICE_CONFIG] = false;
	command("FACTORY_RESET");
	CHECK_TEXT(final_line(), "ERR factory mode, send INIT|<id> first");
	command("INIT|AGAIN1");
	CHECK_TEXT(final_line(), "OK initialised as AGAIN1, rebooting");
	CHECK(!fake.records[STORE_DEVICE_CONFIG].present);
	CHECK(fake.reboots == 1);
	CHECK(boot() == DEVICE_BOOT_OPERATING);

	/* And after a restart. */
	operating_board();
	fake.fail_erase[STORE_DEVICE_CONFIG] = true;
	command("FACTORY_RESET");
	fake.fail_erase[STORE_DEVICE_CONFIG] = false;
	CHECK(boot() == DEVICE_BOOT_FACTORY);
	command("INIT|AGAIN2");
	CHECK(fake.reboots == 1);
	CHECK(boot() == DEVICE_BOOT_OPERATING);
	CHECK_TEXT(device_id(), "AGAIN2");
}

/*
 * A reset that could not erase everything must not undo itself: a board that keeps its
 * settings, key and certificate must not come back looking like an old board to migrate.
 */
static void test_a_failed_reset_stays_in_factory_mode(void)
{
	uint32_t flag;

	/* Button 2 ignores the result and restarts. */
	operating_board();
	fake.fail_erase[STORE_DEVICE_CONFIG] = true;
	fake.fail_tls_delete = true;
	CHECK(factory_reset() == -EIO);

	CHECK(fake.private_key);
	CHECK(fake.certificate);
	CHECK(fake.records[STORE_DEVICE_CONFIG].present);
	CHECK(!fake.records[STORE_DEVICE_ID].present);

	/* The marker is still there. */
	CHECK(store_read(STORE_INIT_FLAG, &flag, sizeof(flag)) == 0);
	CHECK(flag == 0x57495045);

	fake.fail_erase[STORE_DEVICE_CONFIG] = false;
	fake.fail_tls_delete = false;
	CHECK(boot() == DEVICE_BOOT_FACTORY);
	CHECK(device_is_factory());
	CHECK_TEXT(device_id(), "");

	/* However often it boots. */
	CHECK(boot() == DEVICE_BOOT_FACTORY);

	/* INIT does what the reset could not, and leaves a clean board. */
	command("INIT|ABC123");
	CHECK_TEXT(final_line(), "OK initialised as ABC123, rebooting");
	CHECK(!fake.private_key);
	CHECK(!fake.certificate);
	CHECK(!fake.records[STORE_DEVICE_CONFIG].present);
	CHECK(boot() == DEVICE_BOOT_OPERATING);

	/* Only the deletes failing is enough to keep the marker. */
	operating_board();
	fake.fail_tls_delete = true;
	CHECK(factory_reset() == -EIO);
	fake.fail_tls_delete = false;
	CHECK(boot() == DEVICE_BOOT_FACTORY);

	/* While still failing, INIT names the step, and it can be sent again. */
	operating_board();
	fake.fail_tls_delete = true;
	command("INIT|ABC123");
	CHECK_TEXT(final_line(), "ERR init failed at step: erase settings");
	CHECK(fake.reboots == 0);
	fake.fail_tls_delete = false;
	CHECK(boot() == DEVICE_BOOT_FACTORY);

	/*
	 * The marker itself could not be written. The flag stays as it was, the ID goes, and an
	 * invalid ID is factory mode as well.
	 */
	operating_board();
	fake.fail_write[STORE_INIT_FLAG] = true;
	CHECK(factory_reset() == -EIO);
	fake.fail_write[STORE_INIT_FLAG] = false;
	CHECK(store_read(STORE_INIT_FLAG, &flag, sizeof(flag)) == 0);
	CHECK(flag == 0x494e4954);
	CHECK(!fake.records[STORE_DEVICE_ID].present);
	CHECK(boot() == DEVICE_BOOT_FACTORY);
}

static void test_reset_config(void)
{
	operating_board();
	command("RESET_CONFIG");
	CHECK(strncmp(final_line(), "OK cloud settings cleared", 25) == 0);
	CHECK(identity_settings_get() == NULL);
	CHECK(fake.cloud_disconnects > 0);

	/* It keeps the ID, Wi-Fi, the certificates and the key. */
	CHECK_TEXT(device_id(), "ABC123");
	CHECK(fake.wifi_stored);
	CHECK(fake.private_key);
	CHECK(fake.certificate);
	CHECK(fake.ca_cloud);
	CHECK(fake.reboots == 0);
	CHECK(boot() == DEVICE_BOOT_OPERATING);
}

/* ---- safety rules --------------------------------------------------------------- */

static void test_refused_during_an_update(void)
{
	static const char *const refused[] = {
		"FACTORY_RESET", "RESET_CONFIG", "INIT|NEWID", "SET_ID|NEWID", "CLEAR_WIFI",
		"WIFI|net|" PASSWORD, "WIFI_SEC|net|WPA3_SAE|" PASSWORD,
		"CLOUD|" ENDPOINT "|" PREFIX, "CLOUD|", "KEYGEN|REPLACE",
		"STREAM_START|100|1|1234|CERT",
	};
	static const enum ota_state states[] = { OTA_AWAITING_USER, OTA_RETRY_WAIT, OTA_DOWNLOADING,
						 OTA_VERIFYING, OTA_REBOOTING, OTA_TESTING };

	for (size_t i = 0; i < sizeof(refused) / sizeof(refused[0]); i++) {
		for (size_t j = 0; j < sizeof(states) / sizeof(states[0]); j++) {
			operating_board();
			fake.ota = states[j];
			command(refused[i]);

			CHECK_TEXT(final_line(), "ERR update in progress");
			CHECK(fake.reboots == 0);
			CHECK(strstr(fake.ops, "W") == NULL);
			CHECK(strstr(fake.ops, "E") == NULL);
			CHECK(strstr(fake.ops, "wifi-") == NULL);
			CHECK(strstr(fake.ops, "tls-") == NULL);
			CHECK(fake.wifi_stored);
			CHECK(fake.private_key);
			CHECK(!device_is_factory());
			CHECK(identity_settings_get() != NULL);
		}
	}

	/* A validation error comes before the refusal, and changes nothing either. */
	operating_board();
	fake.ota = OTA_TESTING;
	command("INIT|bad id!");
	CHECK_TEXT(final_line(), "ERR id must be 1-32 letters or digits");

	/* Reading is fine during an update. */
	command("STATUS");
	CHECK_TEXT(final_line(), "OK");
	CHECK_TEXT(value_of("update"), "testing (last: none)");
	command("GET_ID");
	CHECK(strncmp(final_line(), "OK ABC123|", 10) == 0);

	/* A certificate whose last chunk arrives after an update began goes nowhere. */
	operating_board();
	{
		static uint8_t der[100];
		char line[256];
		char base64[140];
		size_t length;

		der[0] = 0x30;
		CHECK(base64_encode((uint8_t *)base64, sizeof(base64), &length, der, sizeof(der)) ==
		      0);
		base64[length] = '\0';
		snprintf(line, sizeof(line), "STREAM_START|%zu|1|%04x|CERT", sizeof(der),
			 console_crc16(0xffff, der, sizeof(der)));
		command(line);
		CHECK(strncmp(final_line(), "OK ready", 8) == 0);
		fake.ota = OTA_DOWNLOADING;
		snprintf(line, sizeof(line), "STREAM_CHUNK|0|%s", base64);
		command(line);
		CHECK_TEXT(final_line(), "ERR update in progress");
		CHECK(fake.certificates_stored == 0);
	}

	/* A factory reset on the trial's record. */
	operating_board();
	CHECK(store_write(STORE_OTA_RECORD, "trial", 5) == 0);
	fake.ota = OTA_TESTING;
	command("FACTORY_RESET");
	CHECK_TEXT(final_line(), "ERR update in progress");
	CHECK(fake.records[STORE_OTA_RECORD].present);
}

/* ---- migration ------------------------------------------------------------------ */

static void test_migration(void)
{
	/* A board in the field, with everything but the flag: it must not need INIT. */
	old_provisioned_board();
	CHECK(device_boot() == DEVICE_BOOT_MIGRATED);
	CHECK(!device_is_factory());
	CHECK_TEXT(device_id(), SOC_ID);
	CHECK(strlen(device_id()) == 16);
	CHECK(device_id_valid(device_id()));

	/* In that order: the ID, reading it back, then the flag. */
	CHECK(ops_contain_in_order("W3", "R3"));
	{
		const char *back = strstr(fake.ops, "W3");

		CHECK(strstr(back, "R3") != NULL);
		CHECK(strstr(strstr(back, "R3"), "W4") != NULL);
	}

	/* The rest of what it had is untouched. */
	CHECK(fake.wifi_stored);
	CHECK(fake.private_key);
	CHECK(identity_settings_get() != NULL);

	/* Only once: from now on this is a normal board. */
	CHECK(boot() == DEVICE_BOOT_OPERATING);
	CHECK_TEXT(device_id(), SOC_ID);

	/* A trial image is not held up either: migration does not look at the update state. */
	old_provisioned_board();
	fake.ota = OTA_TESTING;
	CHECK(device_boot() == DEVICE_BOOT_MIGRATED);
	CHECK(!device_is_factory());

	/* Not provisioned means factory mode, whichever part is missing. */
	fake_reset();
	CHECK(identity_init() == 0);
	CHECK(device_boot() == DEVICE_BOOT_FACTORY);
	CHECK(!fake.records[STORE_DEVICE_ID].present);
	CHECK(!fake.records[STORE_INIT_FLAG].present);

	old_provisioned_board();
	fake.private_key = false;
	CHECK(device_boot() == DEVICE_BOOT_FACTORY);

	old_provisioned_board();
	fake.certificate = false;
	CHECK(device_boot() == DEVICE_BOOT_FACTORY);

	old_provisioned_board();
	CHECK(identity_settings_clear() == 0);
	CHECK(device_boot() == DEVICE_BOOT_FACTORY);

	/* A factory reset leaves nothing to migrate from. */
	operating_board();
	CHECK(factory_reset() == 0);
	CHECK(boot() == DEVICE_BOOT_FACTORY);

	/* A store that fails: the board still runs, and tries again next time. */
	old_provisioned_board();
	fake.fail_write[STORE_DEVICE_ID] = true;
	CHECK(device_boot() == DEVICE_BOOT_MIGRATION_FAILED);
	CHECK(!device_is_factory());
	CHECK_TEXT(device_id(), SOC_ID);
	fake.fail_write[STORE_DEVICE_ID] = false;
	CHECK(device_boot() == DEVICE_BOOT_MIGRATED);

	old_provisioned_board();
	fake.fail_write[STORE_INIT_FLAG] = true;
	CHECK(device_boot() == DEVICE_BOOT_MIGRATION_FAILED);
	CHECK(!device_is_factory());
	fake.fail_write[STORE_INIT_FLAG] = false;
	CHECK(device_boot() == DEVICE_BOOT_MIGRATED);

	/* A read-back that differs counts as a failure too. */
	old_provisioned_board();
	fake.corrupt_read[STORE_DEVICE_ID] = true;
	CHECK(device_boot() == DEVICE_BOOT_MIGRATION_FAILED);
	fake.corrupt_read[STORE_DEVICE_ID] = false;

	/* Half a migration: the ID is there, the flag is not. */
	old_provisioned_board();
	{
		char id[DEVICE_ID_MAX + 1] = "SOMETHINGELSE";

		CHECK(store_write(STORE_DEVICE_ID, id, sizeof(id)) == 0);
	}
	CHECK(device_boot() == DEVICE_BOOT_MIGRATED);
	CHECK_TEXT(device_id(), SOC_ID);
}

static void test_factory_mode_decision(void)
{
	char id[DEVICE_ID_MAX + 1] = { 0 };
	uint32_t complete = 0x494e4954;
	uint32_t wiping = 0x57495045;

	/* The flag and a valid ID. */
	fake_reset();
	CHECK(identity_init() == 0);
	strcpy(id, "ABC123");
	CHECK(store_write(STORE_DEVICE_ID, id, sizeof(id)) == 0);
	CHECK(store_write(STORE_INIT_FLAG, &complete, sizeof(complete)) == 0);
	CHECK(device_boot() == DEVICE_BOOT_OPERATING);
	CHECK_TEXT(device_id(), "ABC123");

	/* The flag and an invalid ID. */
	strcpy(id, "bad id!");
	CHECK(store_write(STORE_DEVICE_ID, id, sizeof(id)) == 0);
	CHECK(device_boot() == DEVICE_BOOT_FACTORY);
	CHECK_TEXT(device_id(), "");

	/* The flag, and an ID record without its terminator. */
	memset(id, 'A', sizeof(id));
	CHECK(store_write(STORE_DEVICE_ID, id, sizeof(id)) == 0);
	CHECK(device_boot() == DEVICE_BOOT_FACTORY);

	/* The flag and no ID. */
	CHECK(store_erase(STORE_DEVICE_ID) == 0);
	CHECK(device_boot() == DEVICE_BOOT_FACTORY);

	/* An ID and no flag. */
	memset(id, 0, sizeof(id));
	strcpy(id, "ABC123");
	CHECK(store_write(STORE_DEVICE_ID, id, sizeof(id)) == 0);
	CHECK(store_erase(STORE_INIT_FLAG) == 0);
	CHECK(device_boot() == DEVICE_BOOT_FACTORY);
	CHECK_TEXT(device_id(), "ABC123");

	/* A flag of the wrong size is not the flag. */
	CHECK(store_write(STORE_INIT_FLAG, "x", 1) == 0);
	CHECK(device_boot() == DEVICE_BOOT_FACTORY);

	/* The marker of a factory reset under way: never operating, never migrated. */
	old_provisioned_board();
	CHECK(store_write(STORE_INIT_FLAG, &wiping, sizeof(wiping)) == 0);
	CHECK(device_boot() == DEVICE_BOOT_FACTORY);

	/* Storage that cannot be read, on a board with nothing to lose: factory mode. */
	fake_reset();
	CHECK(identity_init() == 0);
	fake.fail_read[STORE_INIT_FLAG] = true;
	CHECK(device_boot() == DEVICE_BOOT_FACTORY);
}

/*
 * One failed read must not take a provisioned board off the network: a confirmed board
 * would stay offline until somebody came by, and a trial would roll back. It writes nothing,
 * because a read that failed says nothing about what is stored.
 */
static void test_a_failed_read_does_not_look_like_a_blank_board(void)
{
	static const int records[] = { STORE_INIT_FLAG, STORE_DEVICE_ID };
	uint32_t flag;

	for (size_t i = 0; i < sizeof(records) / sizeof(records[0]); i++) {
		operating_board();
		fake.fail_read[records[i]] = true;
		fake_clear_log();
		CHECK(identity_init() == 0);
		CHECK(device_boot() == DEVICE_BOOT_UNREADABLE);
		CHECK(!device_is_factory());
		CHECK(strstr(fake.ops, "W") == NULL);
		CHECK(strstr(fake.ops, "E") == NULL);

		/* It is all still there when the next boot can read it. */
		fake.fail_read[records[i]] = false;
		CHECK(boot() == DEVICE_BOOT_OPERATING);
		CHECK_TEXT(device_id(), "ABC123");
	}

	/* What it shows: the ID if that could be read, or else the SoC's identifier. */
	operating_board();
	fake.fail_read[STORE_INIT_FLAG] = true;
	CHECK(device_boot() == DEVICE_BOOT_UNREADABLE);
	CHECK_TEXT(device_id(), "ABC123");
	fake.fail_read[STORE_INIT_FLAG] = false;

	operating_board();
	fake.fail_read[STORE_DEVICE_ID] = true;
	CHECK(device_boot() == DEVICE_BOOT_UNREADABLE);
	CHECK_TEXT(device_id(), SOC_ID);
	fake.fail_read[STORE_DEVICE_ID] = false;

	/* An old board on trial, whose flag cannot be read. */
	old_provisioned_board();
	fake.ota = OTA_TESTING;
	fake.fail_read[STORE_INIT_FLAG] = true;
	CHECK(device_boot() == DEVICE_BOOT_UNREADABLE);
	CHECK(!device_is_factory());
	CHECK(!fake.records[STORE_INIT_FLAG].present);
	fake.fail_read[STORE_INIT_FLAG] = false;

	/* An old board whose missing flag can be read, and whose ID cannot: it migrates. */
	old_provisioned_board();
	fake.fail_read[STORE_DEVICE_ID] = true;
	CHECK(device_boot() == DEVICE_BOOT_MIGRATION_FAILED);
	CHECK(!device_is_factory());
	fake.fail_read[STORE_DEVICE_ID] = false;

	/* A wrong value is not a failed read: the marker of a reset still means factory mode. */
	old_provisioned_board();
	flag = 0x57495045;
	CHECK(store_write(STORE_INIT_FLAG, &flag, sizeof(flag)) == 0);
	fake.fail_read[STORE_DEVICE_ID] = true;
	CHECK(device_boot() == DEVICE_BOOT_FACTORY);
	fake.fail_read[STORE_DEVICE_ID] = false;

	/* Nor is a missing ID behind a good flag. */
	operating_board();
	CHECK(store_erase(STORE_DEVICE_ID) == 0);
	CHECK(boot() == DEVICE_BOOT_FACTORY);

	/* A board that has nothing to lose stays in factory mode. */
	blank_board();
	command("INIT|ABC123");
	fake.fail_read[STORE_DEVICE_ID] = true;
	CHECK(device_boot() == DEVICE_BOOT_FACTORY);
	fake.fail_read[STORE_DEVICE_ID] = false;
}

/* ---- status --------------------------------------------------------------------- */

static void test_status(void)
{
	operating_board();
	fake.link_up = true;
	fake.cloud_connected = true;

	command("STATUS");
	CHECK(fake.finals == 1);
	CHECK_TEXT(final_line(), "OK");

	/* What the tools rely on. */
	CHECK_TEXT(value_of("state"), "OPERATING");
	CHECK_TEXT(value_of("id"), "ABC123");
	CHECK_TEXT(value_of("thing name"), "cranium-" SOC_ID);
	CHECK_TEXT(value_of("firmware"), fw_version_running_string());
	CHECK_TEXT(value_of("wifi network"), "MyNetwork");
	CHECK_TEXT(value_of("wifi password"), "set");
	CHECK_TEXT(value_of("wifi link"), "up");
	CHECK_TEXT(value_of("wifi address"), "02:00:00:00:00:01");
	CHECK_TEXT(value_of("endpoint"), ENDPOINT);
	CHECK_TEXT(value_of("download from"), PREFIX);
	CHECK_TEXT(value_of("cloud"), "connected");
	CHECK_TEXT(value_of("root CA"), "set");
	CHECK_TEXT(value_of("private key"), "set");
	CHECK_TEXT(value_of("certificate"), "set");
	CHECK_TEXT(value_of("update"), "idle (last: none)");

	/* One section. */
	command("STATUS|wifi");
	CHECK_TEXT(final_line(), "OK");
	CHECK_TEXT(value_of("wifi link"), "up");
	CHECK_TEXT(value_of("endpoint"), "<none>");
	command("STATUS|CLOUD");
	CHECK_TEXT(value_of("endpoint"), ENDPOINT);
	CHECK_TEXT(value_of("wifi link"), "<none>");
	command("status|device");
	CHECK_TEXT(value_of("thing name"), "cranium-" SOC_ID);
	command("STATUS|certs");
	CHECK_TEXT(value_of("private key"), "set");
	command("STATUS|update");
	CHECK_TEXT(value_of("update"), "idle (last: none)");

	command("STATUS|nonsense");
	CHECK_TEXT(final_line(), "ERR unknown section, use one of: device wifi cloud certs update");
	CHECK(strstr(fake.output, "nonsense") == NULL);

	/* Without anything stored. */
	operating_board();
	fake.wifi_stored = false;
	fake.private_key = false;
	CHECK(identity_settings_clear() == 0);
	command("STATUS");
	CHECK_TEXT(value_of("wifi network"), "unset");
	CHECK_TEXT(value_of("wifi password"), "unset");
	CHECK_TEXT(value_of("wifi link"), "down");
	CHECK_TEXT(value_of("endpoint"), "unset");
	CHECK_TEXT(value_of("cloud"), "not connected");
	CHECK_TEXT(value_of("private key"), "unset");

	/* NET */
	operating_board();
	fake.link_up = true;
	command("NET");
	CHECK_TEXT(final_line(), "OK");
	CHECK_TEXT(value_of("state"), "connected");
	CHECK_TEXT(value_of("ssid"), "MyNetwork");
	CHECK_TEXT(value_of("ip"), "192.168.1.42");
	CHECK_TEXT(value_of("rssi"), "-51");
	CHECK_TEXT(value_of("mac"), "02:00:00:00:00:01");

	/* Connected, and the address went: never an empty value. */
	fake.link_up_without_address = true;
	command("NET");
	CHECK_TEXT(value_of("state"), "connected");
	CHECK_TEXT(value_of("ip"), "none");
	fake.link_up_without_address = false;

	fake.link_up = false;
	command("NET");
	CHECK_TEXT(value_of("state"), "not connected");
	CHECK_TEXT(value_of("ip"), "none");

	fake.wifi_stored = false;
	command("NET");
	CHECK_TEXT(value_of("state"), "no network stored");
	CHECK_TEXT(value_of("ssid"), "unset");

	/* STATS: a box with all of it. */
	operating_board();
	fake.now_ms = (2 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1000LL;
	command("STATS");
	CHECK_TEXT(final_line(), "OK");
	CHECK(strstr(fake.output, "OPERATING") != NULL);
	CHECK(strstr(fake.output, "ABC123") != NULL);
	CHECK(strstr(fake.output, fw_version_running_string()) != NULL);
	CHECK(strstr(fake.output, "MyNetwork") != NULL);
	CHECK(strstr(fake.output, "2d 03:04:05") != NULL);
	CHECK(strstr(fake.output, "12345 bytes") != NULL);
	CHECK(strstr(fake.output, "reset pin") != NULL);
	CHECK(strstr(fake.output, PASSWORD) == NULL);

	/* All lines of the box have the same width, also with the longest ID. */
	command("SET_ID|12345678901234567890123456789012");
	command("STATS");
	{
		char *line = fake.output;
		size_t width = 0;

		while (strncmp(line, "OK", 2) != 0) {
			char *end = strchr(line, '\n');

			if (width == 0) {
				width = (size_t)(end - line);
			}
			CHECK((size_t)(end - line) == width);
			line = end + 1;
		}
	}
}

static void test_boot_box(void)
{
	operating_board();
	fake_clear_log();
	console_cmd_boot_box();

	CHECK(strstr(fake.output, "OPERATING") != NULL);
	CHECK(strstr(fake.output, "ABC123") != NULL);
	CHECK(strstr(fake.output, "cranium-" SOC_ID) != NULL);
	CHECK(strstr(fake.output, fw_version_running_string()) != NULL);
	CHECK(strstr(fake.output, "MyNetwork") != NULL);
	CHECK(strstr(fake.output, "Type HELP") != NULL);
	CHECK(strstr(fake.output, PASSWORD) == NULL);

	/* The box is tagged, so that a script can tell it from a reply. */
	for (const char *line = fake.output; *line != '\0'; line = strchr(line, '\n') + 1) {
		CHECK(strncmp(line, "[BOOT] ", 7) == 0);
	}

	/* It releases the log lines held back behind it. */
	CHECK(fake.finals == 1);

	blank_board();
	console_cmd_boot_box();
	CHECK(strstr(fake.output, "FACTORY") != NULL);
	CHECK(strstr(fake.output, "unset") != NULL);
	CHECK(strstr(fake.output, "Type HELP") != NULL);

	/* The tag of an event. */
	fake_clear_log();
	console_event("WIFI", "connected ip=%s rssi=%d", "192.168.1.42", -51);
	CHECK_TEXT(fake.events, "[WIFI] connected ip=192.168.1.42 rssi=-51\n");

	/* An event too long for a line is marked, not silently cut. */
	{
		char text[400];

		memset(text, 'x', sizeof(text) - 1);
		text[sizeof(text) - 1] = '\0';
		fake_clear_log();
		console_event("CONSOLE", "%s", text);
		CHECK(strstr(fake.events, "...\n") != NULL);
		CHECK(strlen(fake.events) < 200);
	}
}

static void test_cloud_and_keygen(void)
{
	operating_board();
	CHECK(identity_settings_clear() == 0);

	command("CLOUD|" ENDPOINT "|" PREFIX);
	CHECK_TEXT(final_line(), "OK cloud settings saved");
	CHECK(fake.cloud_changes == 1);
	CHECK(identity_settings_get() != NULL);
	CHECK_TEXT(identity_settings_get()->endpoint, ENDPOINT);
	CHECK_TEXT(identity_settings_get()->download_url_prefix, PREFIX);

	/* The same rules as ever: refused values change nothing. */
	command("CLOUD|not a host|" PREFIX);
	CHECK(strncmp(final_line(), "ERR endpoint must be", 20) == 0);
	CHECK_TEXT(identity_settings_get()->endpoint, ENDPOINT);
	command("CLOUD|" ENDPOINT "|http://plain.example.com/x/");
	CHECK(strncmp(final_line(), "ERR endpoint must be", 20) == 0);
	command("CLOUD|" ENDPOINT "|https://host-without-a-path");
	CHECK(strncmp(final_line(), "ERR endpoint must be", 20) == 0);

	/* One value without the other. */
	command("CLOUD|" ENDPOINT "|");
	CHECK(strncmp(final_line(), "ERR usage: CLOUD", 16) == 0);
	command("CLOUD|" ENDPOINT);
	CHECK(strncmp(final_line(), "ERR usage: CLOUD", 16) == 0);
	command("CLOUD||" PREFIX);
	CHECK(strncmp(final_line(), "ERR usage: CLOUD", 16) == 0);
	CHECK_TEXT(identity_settings_get()->endpoint, ENDPOINT);

	/* An empty value clears it, in either spelling. */
	command("CLOUD|");
	CHECK_TEXT(final_line(), "OK cloud settings cleared");
	CHECK(identity_settings_get() == NULL);
	command("CLOUD|" ENDPOINT "|" PREFIX);
	command("CLOUD||");
	CHECK_TEXT(final_line(), "OK cloud settings cleared");
	CHECK(identity_settings_get() == NULL);

	/* Survives a restart. */
	command("CLOUD|" ENDPOINT "|" PREFIX);
	CHECK(boot() == DEVICE_BOOT_OPERATING);
	CHECK(identity_settings_get() != NULL);

	/* KEYGEN */
	operating_board();
	command("KEYGEN");
	CHECK_TEXT(final_line(), "ERR a device key exists, KEYGEN|REPLACE discards it and its certificate");
	CHECK(fake.certificate);

	command("KEYGEN|maybe");
	CHECK(strncmp(final_line(), "ERR usage: KEYGEN", 17) == 0);

	command("KEYGEN|REPLACE");
	CHECK_TEXT(final_line(), "OK key pair created");
	CHECK(strstr(fake.output, "-----BEGIN CERTIFICATE REQUEST-----\n") != NULL);
	CHECK(!fake.certificate);

	command("keygen|replace");
	CHECK_TEXT(final_line(), "OK key pair created");

	fake.private_key = false;
	command("KEYGEN");
	CHECK_TEXT(final_line(), "OK key pair created");

	CHECK(!fake.key_in_memory);

	fake.keygen_fails = true;
	command("KEYGEN|REPLACE");
	CHECK_TEXT(final_line(), "ERR key generation failed (-5)");
	CHECK(fake.private_key);
	fake.keygen_fails = false;

	/* An update begins while the key is being created: the old key and certificate stay. */
	operating_board();
	fake.update_starts_during_keygen = true;
	command("KEYGEN|REPLACE");
	CHECK_TEXT(final_line(), "ERR update in progress");
	CHECK(fake.finals == 1);
	CHECK(fake.key_stores == 0);
	CHECK(fake.private_key);
	CHECK(fake.certificate);
	CHECK(strstr(fake.ops, "tls-") == NULL);
	CHECK(strstr(fake.output, "CERTIFICATE REQUEST") == NULL);
	CHECK(!fake.key_in_memory);

	/* The old key goes on the main loop, behind the check of the update state. */
	operating_board();
	fake.main_calls = 0;
	command("KEYGEN|REPLACE");
	CHECK(fake.main_calls == 2);
	CHECK(fake.key_stores == 1);
	CHECK(ops_contain_in_order("tls-delete", "line"));

	/* Whatever goes wrong after the key was created, it does not stay in memory. */
	operating_board();
	fake.key_store_err = -5;
	command("KEYGEN|REPLACE");
	CHECK_TEXT(final_line(), "ERR private key could not be stored (-5)");
	CHECK(!fake.key_in_memory);
	fake.key_store_err = 0;

	operating_board();
	fake.key_print_err = -5;
	command("KEYGEN|REPLACE");
	CHECK_TEXT(final_line(), "ERR request could not be encoded (-5)");
	CHECK(!fake.key_in_memory);
	fake.key_print_err = 0;
}

static void test_button_and_restart(void)
{
	operating_board();

	command("BUTTON|1");
	CHECK_TEXT(final_line(), "OK button 1");
	CHECK(fake.button_presses == 1);
	CHECK(fake.last_button.type == APP_EVENT_BUTTON);
	CHECK(fake.last_button.button.id == APP_BUTTON_1);
	CHECK(!fake.last_button.button.long_press);

	command("BUTTON|2");
	CHECK(fake.last_button.button.id == APP_BUTTON_2);
	CHECK(!fake.last_button.button.long_press);

	command("BUTTON|3");
	CHECK_TEXT(final_line(), "ERR button must be 1 or 2");
	CHECK(fake.button_presses == 0);

	fake.event_queue_full = true;
	command("BUTTON|1");
	CHECK_TEXT(final_line(), "ERR the application is busy");
	fake.event_queue_full = false;

	command("REBOOT");
	CHECK_TEXT(final_line(), "OK rebooting");
	CHECK(fake.reboots == 1);
	CHECK(ops_contain_in_order("final", "reboot"));

	command("ENTER_BOOTLOADER");
	CHECK(strncmp(final_line(), "OK rebooting", 12) == 0);
	CHECK(strstr(final_line(), "tools/recover.py --console") != NULL);
	CHECK(fake.reboots == 1);
	CHECK(ops_contain_in_order("final", "reboot"));
}

/* ---- streams -------------------------------------------------------------------- */

static uint8_t certificate[1500];

static void make_certificate(size_t size)
{
	for (size_t i = 0; i < size; i++) {
		certificate[i] = (uint8_t)(i * 7 + 3);
	}

	certificate[0] = 0x30;
}

static void stream_start(size_t size, size_t chunks, const char *kind)
{
	char line[128];

	snprintf(line, sizeof(line), "STREAM_START|%zu|%zu|%04x|%s", size, chunks,
		 console_crc16(0xffff, certificate, size), kind);
	command(line);
}

static void stream_chunk(size_t index, const uint8_t *data, size_t length)
{
	char base64[400];
	char line[420];
	size_t encoded;

	CHECK(base64_encode((uint8_t *)base64, sizeof(base64), &encoded, data, length) == 0);
	base64[encoded] = '\0';
	snprintf(line, sizeof(line), "STREAM_CHUNK|%zu|%s", index, base64);
	command(line);
}

static void test_crc(void)
{
	/* The known check value of CRC-16/CCITT-FALSE. */
	CHECK(console_crc16(0xffff, (const uint8_t *)"123456789", 9) == 0x29b1);

	/* Nothing in, nothing changed. */
	CHECK(console_crc16(0xffff, NULL, 0) == 0xffff);

	/* In pieces, the same. */
	CHECK(console_crc16(console_crc16(0xffff, (const uint8_t *)"1234", 4),
			    (const uint8_t *)"56789", 5) == 0x29b1);
}

static void test_stream_in_order(void)
{
	const size_t size = 1200;
	const size_t chunk = 240;

	make_certificate(size);
	operating_board();
	fake.certificate = false;

	stream_start(size, size / chunk, "CERT");
	CHECK_TEXT(final_line(), "OK ready for 5 chunks");

	command("STREAM_STATUS");
	CHECK_TEXT(final_line(), "OK CERT chunk 0 of 5, 0 of 1200 bytes");

	for (size_t i = 0; i < size / chunk; i++) {
		/* Nothing is applied before the end. */
		CHECK(fake.certificates_stored == 0);
		CHECK(!fake.certificate);

		stream_chunk(i, certificate + i * chunk, chunk);
		CHECK(fake.finals == 1);
	}

	CHECK_TEXT(final_line(), "OK CERT stored (1200 bytes)");
	CHECK(fake.certificates_stored == 1);
	CHECK(fake.stored_kind == CONSOLE_STREAM_CERT);
	CHECK(fake.stored_length == size);
	CHECK(memcmp(fake.stored, certificate, size) == 0);
	CHECK(fake.certificate);

	command("STREAM_STATUS");
	CHECK_TEXT(final_line(), "OK idle");

	/* A root CA goes the same way, in chunks that are not all alike. */
	make_certificate(550);
	stream_start(550, 3, "ca");
	stream_chunk(0, certificate, 100);
	CHECK_TEXT(final_line(), "OK chunk 0 taken");
	command("STREAM_STATUS");
	CHECK_TEXT(final_line(), "OK CA chunk 1 of 3, 100 of 550 bytes");
	stream_chunk(1, certificate + 100, 200);
	stream_chunk(2, certificate + 300, 250);
	CHECK_TEXT(final_line(), "OK CA stored (550 bytes)");
	CHECK(fake.stored_kind == CONSOLE_STREAM_CA);
	CHECK(fake.ca_cloud);
	CHECK(fake.ca_download);
}

static void test_stream_failures(void)
{
	const size_t size = 400;

	make_certificate(size);
	operating_board();
	fake.certificate = false;

	/* No transfer. */
	stream_chunk(0, certificate, 10);
	CHECK_TEXT(final_line(), "ERR no transfer is under way");

	/* A wrong index aborts, and then there is nothing to go on with. */
	stream_start(size, 2, "CERT");
	stream_chunk(1, certificate, 200);
	CHECK_TEXT(final_line(), "ERR wrong chunk index, transfer aborted");
	stream_chunk(0, certificate, 200);
	CHECK_TEXT(final_line(), "ERR no transfer is under way");
	CHECK(fake.certificates_stored == 0);

	/* A chunk sent twice is a wrong index as well. */
	stream_start(size, 2, "CERT");
	stream_chunk(0, certificate, 200);
	stream_chunk(0, certificate, 200);
	CHECK_TEXT(final_line(), "ERR wrong chunk index, transfer aborted");
	CHECK(fake.certificates_stored == 0);

	/* Bad data: the CRC fails at the end, and nothing has been applied. */
	stream_start(size, 2, "CERT");
	stream_chunk(0, certificate, 200);
	certificate[300] ^= 0x40;
	stream_chunk(1, certificate + 200, 200);
	certificate[300] ^= 0x40;
	CHECK_TEXT(final_line(), "ERR crc mismatch, transfer aborted, nothing stored");
	CHECK(fake.certificates_stored == 0);
	CHECK(!fake.certificate);
	command("STREAM_STATUS");
	CHECK_TEXT(final_line(), "OK idle");

	/* Not base64. */
	stream_start(size, 2, "CERT");
	command("STREAM_CHUNK|0|!!!!");
	CHECK_TEXT(final_line(), "ERR chunk is not base64, transfer aborted");

	stream_start(size, 2, "CERT");
	command("STREAM_CHUNK|0|");
	CHECK_TEXT(final_line(), "ERR chunk is not base64, transfer aborted");

	/* Too much and too little. */
	stream_start(100, 2, "CERT");
	stream_chunk(0, certificate, 101);
	CHECK_TEXT(final_line(), "ERR more data than announced, transfer aborted");

	stream_start(size, 1, "CERT");
	stream_chunk(0, certificate, 200);
	CHECK_TEXT(final_line(), "ERR less data than announced, transfer aborted");
	CHECK(fake.certificates_stored == 0);

	/* The whole buffer cannot be overrun, whatever the numbers said. */
	CHECK(console_stream_start(CONSOLE_STREAM_MAX, CONSOLE_STREAM_MAX, 0, CONSOLE_STREAM_CERT, 0));
	{
		char base64[280];
		uint8_t data[192] = { 0 };
		size_t length;
		enum console_stream_result result = CONSOLE_STREAM_MORE;

		CHECK(base64_encode((uint8_t *)base64, sizeof(base64), &length, data, sizeof(data)) ==
		      0);
		base64[length] = '\0';

		for (uint32_t i = 0; i < 20 && result == CONSOLE_STREAM_MORE; i++) {
			result = console_stream_chunk(i, base64, 0);
		}

		CHECK(result == CONSOLE_STREAM_TOO_MUCH);
	}

	/* What cannot be right from the start. */
	command("STREAM_START|0|1|1234|CERT");
	CHECK(strncmp(final_line(), "ERR total_bytes must be", 23) == 0);
	command("STREAM_START|1801|1|1234|CERT");
	CHECK(strncmp(final_line(), "ERR total_bytes must be", 23) == 0);
	command("STREAM_START|100|0|1234|CERT");
	CHECK(strncmp(final_line(), "ERR total_bytes must be", 23) == 0);
	command("STREAM_START|100|101|1234|CERT");
	CHECK(strncmp(final_line(), "ERR total_bytes must be", 23) == 0);
	command("STREAM_START|99999999999|1|1234|CERT");
	CHECK(strncmp(final_line(), "ERR usage: STREAM_START", 23) == 0);
	command("STREAM_START|-1|1|1234|CERT");
	CHECK(strncmp(final_line(), "ERR usage: STREAM_START", 23) == 0);
	command("STREAM_START|100|1|xyz|CERT");
	CHECK(strncmp(final_line(), "ERR usage: STREAM_START", 23) == 0);
	command("STREAM_START|100|1|12345|CERT");
	CHECK(strncmp(final_line(), "ERR usage: STREAM_START", 23) == 0);
	command("STREAM_START|100|1|1234|KEY");
	CHECK_TEXT(final_line(), "ERR a stream is a CA or a CERT");
	command("STREAM_START|100|1|1234");
	CHECK(strncmp(final_line(), "ERR usage: STREAM_START", 23) == 0);
	command("STREAM_CHUNK|x|QUJD");
	CHECK_TEXT(final_line(), "ERR no transfer is under way");

	/* An index that is no number is a wrong index, and aborts like one. */
	static const char *const not_numbers[] = { "x", "", "-1", "1x", "99999999999" };

	for (size_t i = 0; i < sizeof(not_numbers) / sizeof(not_numbers[0]); i++) {
		char line[64];

		stream_start(size, 2, "CERT");
		snprintf(line, sizeof(line), "STREAM_CHUNK|%s|QUJD", not_numbers[i]);
		command(line);
		CHECK_TEXT(final_line(), "ERR wrong chunk index, transfer aborted");
		command("STREAM_STATUS");
		CHECK_TEXT(final_line(), "OK idle");
		stream_chunk(0, certificate, 200);
		CHECK_TEXT(final_line(), "ERR no transfer is under way");
	}

	/* The highest index there can be is no way in either. */
	stream_start(size, 2, "CERT");
	command("STREAM_CHUNK|4294967295|QUJD");
	CHECK_TEXT(final_line(), "ERR wrong chunk index, transfer aborted");
	CHECK(fake.certificates_stored == 0);

	/* Upper and lower case in the CRC. */
	command("STREAM_START|100|1|ABCD|CERT");
	CHECK(strncmp(final_line(), "OK ready", 8) == 0);
	command("STREAM_START|100|1|abcd|CERT");
	CHECK(strncmp(final_line(), "OK ready", 8) == 0);
	command("STREAM_START|100|1|1|CERT");
	CHECK(strncmp(final_line(), "OK ready", 8) == 0);

	/* A new start replaces the one under way. */
	stream_start(size, 2, "CERT");
	stream_chunk(0, certificate, 200);
	stream_start(size, 2, "CERT");
	stream_chunk(0, certificate, 200);
	CHECK_TEXT(final_line(), "OK chunk 0 taken");
	stream_chunk(1, certificate + 200, 200);
	CHECK_TEXT(final_line(), "OK CERT stored (400 bytes)");

	/* Cancel. */
	stream_start(size, 2, "CERT");
	command("STREAM_CANCEL");
	CHECK_TEXT(final_line(), "OK transfer cancelled");
	command("STREAM_CANCEL");
	CHECK_TEXT(final_line(), "OK nothing to cancel");
	stream_chunk(0, certificate, 200);
	CHECK_TEXT(final_line(), "ERR no transfer is under way");

	/* Something that is not a DER certificate is not stored, even with a good CRC. */
	fake.certificates_stored = 0;
	certificate[0] = 0x31;
	stream_start(size, 1, "CERT");
	{
		char base64[600];
		char line[620];
		size_t encoded;

		CHECK(base64_encode((uint8_t *)base64, sizeof(base64), &encoded, certificate, 240) == 0);
		base64[encoded] = '\0';
		snprintf(line, sizeof(line), "STREAM_START|240|1|%04x|CERT",
			 console_crc16(0xffff, certificate, 240));
		command(line);
		snprintf(line, sizeof(line), "STREAM_CHUNK|0|%s", base64);
		command(line);
		CHECK_TEXT(final_line(), "ERR the data is not a DER certificate");
		CHECK(fake.certificates_stored == 0);
	}
	certificate[0] = 0x30;

	/* Too short to be one. */
	stream_start(63, 1, "CERT");
	stream_chunk(0, certificate, 63);
	CHECK_TEXT(final_line(), "ERR the data is not a DER certificate");

	/* The store itself failing. */
	fake.certificate_store_fails = true;
	stream_start(240, 1, "CERT");
	stream_chunk(0, certificate, 240);
	CHECK(strncmp(final_line(), "ERR the certificate could not be stored", 39) == 0);
	fake.certificate_store_fails = false;
}

static void test_stream_idle_timeout(void)
{
	const size_t size = 400;

	make_certificate(size);
	operating_board();

	fake.now_ms = 1000;
	stream_start(size, 2, "CERT");
	stream_chunk(0, certificate, 200);

	/* Quiet, but not for long enough. */
	fake.now_ms += CONSOLE_STREAM_IDLE_MS - 1;
	fake_clear_log();
	console_cmd_tick();
	CHECK_TEXT(fake.events, "");
	command("STREAM_STATUS");
	CHECK(strncmp(final_line(), "OK CERT", 7) == 0);

	/* A chunk starts the wait over. */
	stream_start(size, 2, "CERT");
	fake.now_ms += CONSOLE_STREAM_IDLE_MS - 1;
	stream_chunk(0, certificate, 200);
	fake.now_ms += CONSOLE_STREAM_IDLE_MS - 1;
	fake_clear_log();
	console_cmd_tick();
	CHECK_TEXT(fake.events, "");

	/* Now it has been too long. */
	fake.now_ms += 1;
	fake_clear_log();
	console_cmd_tick();
	CHECK_TEXT(fake.events, "[CONSOLE] stream aborted: idle timeout\n");
	stream_chunk(1, certificate + 200, 200);
	CHECK_TEXT(final_line(), "ERR no transfer is under way");
	CHECK(fake.certificates_stored == 0);

	/* Only once. */
	fake_clear_log();
	console_cmd_tick();
	CHECK_TEXT(fake.events, "");
}

int main(void)
{
	fake_reset();

	test_line_endings();
	test_blank_lines();
	test_overlong_lines();
	test_control_characters();
	test_leading_whitespace_and_case();
	test_last_argument_with_separator();
	test_missing_and_extra_arguments();
	test_backspace_and_del();
	test_echo();
	test_unknown_command();
	test_the_table_drives_help();
	test_factory_refusal_comes_from_the_table();
	test_every_command_ends_with_one_final_line();
	test_id_validation();
	test_wifi_validation();
	test_no_secret_comes_back();
	test_line_buffer_is_wiped();
	test_init_validates_first();
	test_init_order();
	test_init_failing_at_each_step();
	test_init_flag_failure_alone();
	test_power_loss_before_the_flag();
	test_power_cut_at_every_step();
	test_factory_reset();
	test_a_failed_reset_stays_in_factory_mode();
	test_reset_config();
	test_refused_during_an_update();
	test_migration();
	test_factory_mode_decision();
	test_a_failed_read_does_not_look_like_a_blank_board();
	test_status();
	test_boot_box();
	test_cloud_and_keygen();
	test_button_and_restart();
	test_crc();
	test_stream_in_order();
	test_stream_failures();
	test_stream_idle_timeout();

	printf("%d console checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
