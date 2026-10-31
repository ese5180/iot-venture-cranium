/*
 * The serial console's line reader and argument splitter.
 *
 * Bytes go in one at a time, whole lines come out. Nothing here touches hardware, so
 * firmware/tests/host runs this code as it is.
 *
 * CR, LF and CRLF each end one line, also when a CRLF arrives in two reads. Blank lines
 * are ignored. Backspace and DEL erase what was typed. A line that does not fit the
 * buffer, or that lost bytes on the way in, is discarded whole and reported, so that a
 * truncated command can never run.
 */

#ifndef CONSOLE_PARSER_H_
#define CONSOLE_PARSER_H_

#include <stdbool.h>
#include <stddef.h>

/* Room for the longest command: CLOUD with both values, or a chunk of a stream. */
#define CONSOLE_LINE_MAX 384

enum console_read_result {
	/* Nothing to do yet. */
	CONSOLE_READ_MORE,
	/* reader.line holds one complete line, ended with '\0'. */
	CONSOLE_READ_LINE,
	/* The line was discarded: it did not fit the buffer. */
	CONSOLE_READ_TOO_LONG,
	/* The line was discarded: it held a control character such as NUL or ESC. */
	CONSOLE_READ_INVALID,
	/* The line was discarded: bytes of it were lost before they got here. */
	CONSOLE_READ_LOST,
};

/* Sends typed characters back. Only called while echo is on. */
typedef void (*console_echo_fn)(const char *text, size_t length);

struct console_reader {
	char line[CONSOLE_LINE_MAX + 1];
	size_t length;
	console_echo_fn echo_out;
	bool echo;
	/* The line being read is already condemned; it is reported at its line ending. */
	enum console_read_result discard;
	/* The last byte was a CR, so an LF right after it belongs to the same line ending. */
	bool after_cr;
};

void console_reader_init(struct console_reader *reader, console_echo_fn echo_out);

/* Take one received byte. */
enum console_read_result console_reader_feed(struct console_reader *reader, char byte);

/* Bytes were lost: whatever line this is, it must not run. */
void console_reader_mark_lost(struct console_reader *reader);

/* Done with reader.line. Wipes it, because it may hold a password. */
void console_reader_done(struct console_reader *reader);

/* Overwrite memory that held a secret, in a way that the compiler cannot remove. */
void console_wipe(void *data, size_t size);

/*
 * Take the command name off a line: leading and trailing whitespace goes, and the line
 * is cut at the first '|'. Returns what follows that '|', or NULL if there is none.
 */
char *console_split_name(char *line, char **name);

/*
 * Split what console_split_name() returned on '|', at most max_args - 1 times, so that
 * the last argument can itself contain '|'. Returns the number of arguments found. A
 * command that takes none gets 1 back when rest is not NULL, which is one too many.
 */
int console_split_args(char *rest, char **argv, int max_args);

/* Compare without regard to case. Command names and keywords are ASCII. */
bool console_equal_nocase(const char *a, const char *b);

#endif /* CONSOLE_PARSER_H_ */
