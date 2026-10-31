/*
 * The console's commands: one table, from which HELP and the factory-mode refusal are
 * generated, and the handlers. Commands look like COMMAND|arg1|arg2. Every command ends
 * with exactly one final line, "OK [details]" or "ERR <reason>"; lines of a multi-line
 * reply come before it. Nothing here touches hardware, so firmware/tests/host runs it.
 *
 * Everything here runs on the console task, except console_event().
 */

#ifndef CONSOLE_CMD_H_
#define CONSOLE_CMD_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "console.h"

enum console_section {
	SECTION_DEVICE,
	SECTION_WIFI,
	SECTION_CLOUD,
	SECTION_STATUS,
	SECTION_STREAM,
	SECTION_TEST,
	SECTION_COUNT,
};

struct console_command {
	const char *name;
	/* A second name for it, or NULL. */
	const char *alias;
	const char *usage;
	const char *description;
	enum console_section section;
	/* Available in factory mode. Everything else is refused there. */
	bool in_factory;
	uint8_t min_args;
	uint8_t max_args;
	void (*handler)(int argc, char **argv);
};

/* The table, for the tests that check that HELP and the refusals follow from it. */
const struct console_command *console_cmd_table(size_t *count);

/* Forget any half-typed line. Echo is on again. */
void console_cmd_init(void);

/* Take one received byte, and run the command if it completes a line. */
void console_cmd_feed(char byte);

/* Bytes were lost on the way in: the line they belong to must not run. */
void console_cmd_input_lost(void);

/* Called about once a second: gives up on a stream that has gone quiet. */
void console_cmd_tick(void);

/* The status box that a boot starts with. */
void console_cmd_boot_box(void);

/* For the handlers' helpers elsewhere: one more line of the reply under way. */
void console_reply_line(const char *format, ...) __printf_like(1, 2);

#endif /* CONSOLE_CMD_H_ */
