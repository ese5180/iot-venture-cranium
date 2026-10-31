/*
 * Host-side tests of console.c, the part of the console that holds the transmit buffers, the
 * log backend and the receive path. The real file is compiled here, on a fake UART whose
 * interrupts run when the test says so: while the console task waits, and between lines,
 * which are the only places where another thread can get in between the spinlocks.
 *
 * What this cannot show is the real driver's timing. The fake does copy the behaviour that
 * matters: an interrupt for transmitting also reads what has been received, whether or not
 * receiving is enabled, as uart_nrfx_uarte.c does.
 */

#define CONFIG_APP_CONSOLE_TX_BUFFER_SIZE 1024
#define CONFIG_APP_CONSOLE_LOG_HOLD_SIZE  256
#define CONFIG_APP_CONSOLE_RX_BUFFER_SIZE 128
#define CONFIG_APP_CONSOLE_STACK_SIZE     1024
#define CONFIG_APP_CONSOLE_THREAD_PRIORITY 12

#include "console.c"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>

#include "console_parser.h"

#define PASSWORD "correct-horse-battery"
#define TX_PER_INTERRUPT 16

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

/* ---- the fake hardware ---------------------------------------------------------- */

const struct device host_uart;

static struct {
	bool tx_irq;
	bool rx_irq;
	/* Bytes the UART has received and not handed over yet. */
	char rx[4096];
	size_t rx_in;
	size_t rx_out;
	int pending_error;
	/* What went out on the wire. */
	char wire[32768];
	size_t wire_used;
	int waits;
	int reboots;
	int sleeps;
	void (*on_sleep)(void);
} hw;

/* What the command layer was given. */
static struct console_reader reader;
static char lines_run[4096];

bool device_is_ready(const struct device *dev)
{
	ARG_UNUSED(dev);
	return true;
}

int uart_irq_callback_user_data_set(const struct device *dev, uart_irq_callback_user_data_t cb,
				    void *user_data)
{
	ARG_UNUSED(dev);
	ARG_UNUSED(cb);
	ARG_UNUSED(user_data);
	return 0;
}

int uart_irq_update(const struct device *dev)
{
	ARG_UNUSED(dev);
	return 1;
}

int uart_irq_rx_ready(const struct device *dev)
{
	ARG_UNUSED(dev);
	return hw.rx_out < hw.rx_in;
}

int uart_irq_tx_ready(const struct device *dev)
{
	ARG_UNUSED(dev);
	return hw.tx_irq;
}

void uart_irq_rx_enable(const struct device *dev)
{
	ARG_UNUSED(dev);
	hw.rx_irq = true;
}

void uart_irq_rx_disable(const struct device *dev)
{
	ARG_UNUSED(dev);
	hw.rx_irq = false;
}

void uart_irq_tx_enable(const struct device *dev)
{
	ARG_UNUSED(dev);
	hw.tx_irq = true;
}

void uart_irq_tx_disable(const struct device *dev)
{
	ARG_UNUSED(dev);
	hw.tx_irq = false;
}

int uart_fifo_read(const struct device *dev, uint8_t *data, int size)
{
	ARG_UNUSED(dev);

	if (size > 0 && hw.rx_out < hw.rx_in) {
		*data = (uint8_t)hw.rx[hw.rx_out++];
		return 1;
	}

	return 0;
}

int uart_fifo_fill(const struct device *dev, const uint8_t *data, int size)
{
	int sent = MIN(size, TX_PER_INTERRUPT);

	ARG_UNUSED(dev);

	memcpy(hw.wire + hw.wire_used, data, (size_t)sent);
	hw.wire_used += (size_t)sent;
	hw.wire[hw.wire_used] = '\0';
	return sent;
}

int uart_err_check(const struct device *dev)
{
	int error = hw.pending_error;

	ARG_UNUSED(dev);

	hw.pending_error = 0;
	return error;
}

void uart_poll_out(const struct device *dev, unsigned char byte)
{
	ARG_UNUSED(dev);

	hw.wire[hw.wire_used++] = (char)byte;
	hw.wire[hw.wire_used] = '\0';
}

/* Interrupts come as long as the hardware has something to say. */
static void run_interrupts(void)
{
	while (hw.tx_irq || (hw.rx_irq && hw.rx_out < hw.rx_in)) {
		uart_interrupt(uart, NULL);
	}
}

static void deliver(const char *text)
{
	size_t length = strlen(text);

	memcpy(hw.rx + hw.rx_in, text, length);
	hw.rx_in += length;
}

int k_sem_take(struct k_sem *sem, k_timeout_t timeout)
{
	ARG_UNUSED(sem);
	ARG_UNUSED(timeout);

	/* Waiting lets the interrupts run. */
	hw.waits++;
	run_interrupts();
	return 0;
}

void k_sem_give(struct k_sem *sem)
{
	ARG_UNUSED(sem);
}

int32_t k_msleep(int32_t ms)
{
	ARG_UNUSED(ms);

	hw.sleeps++;
	if (hw.on_sleep != NULL) {
		hw.on_sleep();
	}

	run_interrupts();
	return 0;
}

void k_busy_wait(uint32_t us)
{
	ARG_UNUSED(us);
}

int64_t k_uptime_get(void)
{
	return 0;
}

void k_thread_create(struct k_thread *thread, char *stack, size_t size,
		     void (*entry)(void *, void *, void *), void *a, void *b, void *c, int priority,
		     int options, k_timeout_t delay)
{
	ARG_UNUSED(thread);
	ARG_UNUSED(stack);
	ARG_UNUSED(size);
	ARG_UNUSED(entry);
	ARG_UNUSED(a);
	ARG_UNUSED(b);
	ARG_UNUSED(c);
	ARG_UNUSED(priority);
	ARG_UNUSED(options);
	ARG_UNUSED(delay);
}

int k_thread_name_set(struct k_thread *thread, const char *name)
{
	ARG_UNUSED(thread);
	ARG_UNUSED(name);
	return 0;
}

int hwinfo_get_reset_cause(uint32_t *cause)
{
	*cause = RESET_PIN;
	return 0;
}

int hwinfo_clear_reset_cause(void)
{
	return 0;
}

void sys_reboot(int type)
{
	ARG_UNUSED(type);
	hw.reboots++;
}

void host_log_panic(void)
{
	backend_panic(NULL);
}

const char *log_source_name_get(uint32_t domain, uint32_t source)
{
	ARG_UNUSED(domain);
	return source == 0 ? "ota" : "net_dhcpv4";
}

struct k_heap _system_heap;

int sys_heap_runtime_stats_get(struct sys_heap *heap, struct sys_memory_stats *stats)
{
	ARG_UNUSED(heap);
	stats->free_bytes = 1234;
	return 0;
}

/* The main loop, which here runs a call as soon as it is posted. */
int app_event_post(const struct app_event *event)
{
	event->call.function();
	return 0;
}

/* ---- the command layer: the real reader, and a note of what would have run --------- */

void console_cmd_init(void)
{
	console_reader_init(&reader, console_port_echo);
}

void console_cmd_feed(char byte)
{
	enum console_read_result result = console_reader_feed(&reader, byte);
	const char *line = result == CONSOLE_READ_LINE ? reader.line : "<discarded>";

	if (result != CONSOLE_READ_MORE) {
		strcat(lines_run, line);
		strcat(lines_run, "\n");
	}

	if (result == CONSOLE_READ_LINE) {
		console_reader_done(&reader);
	}
}

void console_cmd_input_lost(void)
{
	console_reader_mark_lost(&reader);
}

void console_cmd_tick(void)
{
}

void console_cmd_boot_box(void)
{
	console_port_reply("[BOOT] box", 10, true);
}

void console_event(const char *tag, const char *format, ...)
{
	char line[200];
	int used = snprintf(line, sizeof(line), "[%s] ", tag);
	va_list args;

	va_start(args, format);
	used += vsnprintf(line + used, sizeof(line) - (size_t)used, format, args);
	va_end(args);

	console_port_event(line, (size_t)used);
}

/* ---- helpers -------------------------------------------------------------------- */

static void start_over(void)
{
	memset(&hw, 0, sizeof(hw));
	lines_run[0] = '\0';
	tx_running = false;
	polling = false;
	reply_open = false;
	input_on_screen = false;
	dropped_lines = 0;
	rx_open = false;
	rx_lost = false;
	atomic_set(&rx_thrown_away, 0);
	CHECK(console_output_init() == 0);
	console_cmd_init();
	reader.echo = false;
}

/* Up and running, past the moment when input starts to count. */
static void running_console(void)
{
	start_over();
	discard_boot_input();
	hw.sleeps = 0;
}

static void clear_wire(void)
{
	hw.wire_used = 0;
	hw.wire[0] = '\0';
}

static void log_message(int level, const char *text)
{
	union log_msg_generic message = {
		.log = { .source = 0, .level = (uint8_t)level, .text = text },
	};

	backend_process(NULL, &message);
}

static void reply(const char *text, bool final)
{
	console_port_reply(text, strlen(text), final);
}

static void event(const char *text)
{
	console_port_event(text, strlen(text));
}

/* What the console task does after a byte came in. */
static void task_runs(void)
{
	run_interrupts();
	handle_input();
}

/* ---- log lines ------------------------------------------------------------------ */

static void test_log_lines_look_as_they_should(void)
{
	running_console();

	log_message(LOG_LEVEL_INF, "Image verified");
	run_interrupts();
	CHECK_TEXT(hw.wire, "[ota] Image verified\r\n");

	clear_wire();
	log_message(LOG_LEVEL_WRN, "careful");
	log_message(LOG_LEVEL_ERR, "broken");
	log_message(LOG_LEVEL_DBG, "details");
	run_interrupts();
	CHECK_TEXT(hw.wire, "[ota] WRN: careful\r\n[ota] ERR: broken\r\n[ota] DBG: details\r\n");

	/* A module with an underscore in its name, as many in the stack have. */
	clear_wire();
	{
		union log_msg_generic message = {
			.log = { .source = 1, .level = LOG_LEVEL_INF, .text = "bound" },
		};

		backend_process(NULL, &message);
	}
	run_interrupts();
	CHECK_TEXT(hw.wire, "[net_dhcpv4] bound\r\n");

	/* printk, routed through the log, has no module. */
	clear_wire();
	{
		union log_msg_generic message = {
			.log = { .source = -1, .level = LOG_LEVEL_INF, .text = "from printk" },
		};

		backend_process(NULL, &message);
	}
	run_interrupts();
	CHECK_TEXT(hw.wire, "[printk] from printk\r\n");

	/* Line endings in a message: each part gets its tag, and none is empty. */
	clear_wire();
	log_message(LOG_LEVEL_WRN, "one\ntwo\r\nthree\n");
	run_interrupts();
	CHECK_TEXT(hw.wire, "[ota] WRN: one\r\n[ota] WRN: two\r\n[ota] WRN: three\r\n");

	/* Nothing to say: no line. */
	clear_wire();
	log_message(LOG_LEVEL_INF, "");
	log_message(LOG_LEVEL_INF, "\n");
	run_interrupts();
	CHECK_TEXT(hw.wire, "");

	/* Too long: one line, marked. */
	{
		char text[400];

		memset(text, 'x', sizeof(text) - 1);
		text[sizeof(text) - 1] = '\0';
		clear_wire();
		log_message(LOG_LEVEL_INF, text);
		run_interrupts();
		CHECK(hw.wire_used == LOG_LINE_MAX + 2);
		CHECK(strncmp(hw.wire, "[ota] xxx", 9) == 0);
		CHECK(strcmp(hw.wire + LOG_LINE_MAX - 3, "...\r\n") == 0);
	}

	/* A hex dump by its size alone. */
	clear_wire();
	{
		union log_msg_generic message = {
			.log = { .level = LOG_LEVEL_INF, .text = "packet", .data_length = 16 },
		};

		backend_process(NULL, &message);
	}
	run_interrupts();
	CHECK_TEXT(hw.wire, "[ota] packet (16 bytes)\r\n");
}

/* ---- whole lines ---------------------------------------------------------------- */

static void test_a_log_line_never_lands_in_a_reply(void)
{
	running_console();

	/* The log thread gets in between two lines of a reply. */
	reply("first", false);
	log_message(LOG_LEVEL_WRN, "in between");
	event("[WIFI] connected ip=1.2.3.4 rssi=-51");
	reply("second", false);
	reply("OK", true);
	run_interrupts();
	CHECK_TEXT(hw.wire, "first\r\nsecond\r\nOK\r\n[ota] WRN: in between\r\n"
			    "[WIFI] connected ip=1.2.3.4 rssi=-51\r\n");

	/* After the final line it is business as usual. */
	clear_wire();
	event("[x] next");
	run_interrupts();
	CHECK_TEXT(hw.wire, "[x] next\r\n");

	/* A reply of one line has nothing to be in the middle of. */
	clear_wire();
	reply("OK done", true);
	event("[x] after");
	run_interrupts();
	CHECK_TEXT(hw.wire, "OK done\r\n[x] after\r\n");

	/* The status box at boot ends like a reply. */
	start_over();
	event("[app] Cranium firmware 1.3.0+0");
	console_cmd_boot_box();
	event("[app] after the box");
	run_interrupts();
	CHECK_TEXT(hw.wire, "[app] Cranium firmware 1.3.0+0\r\n[BOOT] box\r\n[app] after the box\r\n");
}

static void test_a_log_line_starts_under_a_half_typed_one(void)
{
	running_console();
	reader.echo = true;

	deliver("GE");
	task_runs();
	log_message(LOG_LEVEL_INF, "something happened");
	run_interrupts();
	CHECK_TEXT(hw.wire, "GE\r\n[ota] something happened\r\n");

	/* The echo goes on where it was, and the line is still whole for the reader. */
	clear_wire();
	deliver("T_ID\r");
	task_runs();
	run_interrupts();
	CHECK_TEXT(hw.wire, "T_ID\r\n");
	CHECK_TEXT(lines_run, "GET_ID\n");
}

static void test_a_full_buffer_stalls_nobody_and_loses_no_reply(void)
{
	char text[64];

	running_console();

	/* Interrupts do not run here: only log lines come in, and none of them may wait. */
	for (int i = 0; i < 60; i++) {
		int length = snprintf(text, sizeof(text), "[x] line %02d of the same length here", i);

		console_port_event(text, (size_t)length);
	}

	CHECK(hw.waits == 0);
	CHECK(hw.sleeps == 0);
	CHECK(dropped_lines > 0);

	/* What did fit is there, whole, and the next line says how many are gone. */
	{
		uint32_t dropped = dropped_lines;
		char expected[64];

		run_interrupts();
		event("[x] one more");
		run_interrupts();
		snprintf(expected, sizeof(expected), "[CONSOLE] WRN: %u lines dropped\r\n[x] one more\r\n",
			 (unsigned int)dropped);
		CHECK(strstr(hw.wire, expected) != NULL);
		CHECK(dropped_lines == 0);
	}

	/* A log line's end is never missing. */
	for (const char *line = hw.wire; *line != '\0';) {
		const char *end = strstr(line, "\r\n");

		CHECK(end != NULL);
		CHECK(line[0] == '[');
		line = end + 2;
	}

	/* A reply larger than the buffer: the console task waits, and all of it goes out. */
	running_console();
	for (int i = 0; i < 100; i++) {
		int length = snprintf(text, sizeof(text), "reply line %03d of something rather long", i);

		console_port_reply(text, (size_t)length, false);

		/* Log lines meanwhile are held, or dropped if too many. */
		log_message(LOG_LEVEL_INF, "held back");
	}
	reply("OK", true);
	run_interrupts();
	CHECK(hw.waits > 0);
	{
		const char *at = hw.wire;

		for (int i = 0; i < 100; i++) {
			char expected[64];

			snprintf(expected, sizeof(expected), "reply line %03d of something rather long\r\n",
				 i);
			CHECK(strncmp(at, expected, strlen(expected)) == 0);
			at += strlen(expected);
		}

		CHECK(strncmp(at, "OK\r\n[ota] held back\r\n", 21) == 0);
		CHECK(strstr(at, "reply line") == NULL);
	}

	/* What was held can go out even when the buffer is nearly full at that moment. */
	running_console();
	for (int i = 0; i < 25; i++) {
		int length = snprintf(text, sizeof(text), "reply line %03d of something rather long", i);

		console_port_reply(text, (size_t)length, false);
	}
	for (int i = 0; i < 4; i++) {
		log_message(LOG_LEVEL_INF, "held back for a while, a long line");
	}
	hw.waits = 0;
	reply("OK", true);
	run_interrupts();
	CHECK(!reply_open);
	CHECK(strstr(hw.wire, "OK\r\n[ota] held back") != NULL);
}

static void test_output_before_a_restart(void)
{
	running_console();

	/* Queued, then a restart: all of it goes out in order, without interrupts. */
	reply("first", false);
	log_message(LOG_LEVEL_INF, "held");
	reply("OK rebooting", false);
	console_port_reboot();
	CHECK(hw.reboots == 1);
	CHECK(polling);
	CHECK(!hw.tx_irq);
	CHECK_TEXT(hw.wire, "first\r\nOK rebooting\r\n[ota] held\r\n");

	/* From then on every line goes straight to the wire. */
	clear_wire();
	event("[x] during the panic");
	reply("OK", true);
	CHECK_TEXT(hw.wire, "[x] during the panic\r\nOK\r\n");
}

/* ---- what comes in at boot -------------------------------------------------------- */

static void test_input_during_the_boot_is_discarded(void)
{
	start_over();
	event("[app] the log runs while the board boots");

	/* Sent while the board boots. A transmit interrupt reads it: receiving is not on yet. */
	deliver("FACTORY_RESET\r");
	hw.pending_error = 1;
	run_interrupts();
	CHECK(!hw.rx_irq);
	CHECK(hw.rx_out == hw.rx_in);
	CHECK(ring_buf_size_get(&rx_ring) == 0);

	discard_boot_input();
	task_runs();
	CHECK_TEXT(lines_run, "");
	CHECK(hw.rx_irq);

	/* The first thing sent after that is whole, with nothing in front of it. */
	deliver("GET_ID\r");
	task_runs();
	CHECK_TEXT(lines_run, "GET_ID\n");
}

static void late_byte_once(void)
{
	if (hw.sleeps == 1) {
		deliver("abc");
	}
}

static void late_byte_always(void)
{
	deliver("x");
}

static void test_what_the_uart_still_holds_is_discarded_too(void)
{
	/* Text without a line ending, still coming out of the UART after receiving went on. */
	start_over();
	deliver("abc");
	hw.on_sleep = late_byte_once;
	discard_boot_input();
	CHECK(hw.sleeps >= 2);
	hw.on_sleep = NULL;

	deliver("GET_ID\r");
	task_runs();
	CHECK_TEXT(lines_run, "GET_ID\n");

	/* Something that never stops does not keep the console from starting. */
	start_over();
	hw.on_sleep = late_byte_always;
	discard_boot_input();
	hw.on_sleep = NULL;
	CHECK(rx_open);
	CHECK(hw.sleeps == RX_QUIET_MAX_MS / RX_QUIET_MS);

	/* What comes next is the end of a line that lost its start: it must not run. */
	deliver("REBOOT\r");
	task_runs();
	CHECK_TEXT(lines_run, "<discarded>\n");

	deliver("GET_ID\r");
	task_runs();
	CHECK_TEXT(lines_run, "<discarded>\nGET_ID\n");
}

/* ---- losing bytes ----------------------------------------------------------------- */

static void test_a_damaged_line_gets_one_error_and_the_next_line_runs(void)
{
	/* An overrun in the middle of a line. */
	running_console();
	deliver("GET_ID\rREB");
	hw.pending_error = 1;
	run_interrupts();
	deliver("OOT\r");
	deliver("GET_ID\r");
	task_runs();
	CHECK_TEXT(lines_run, "GET_ID\n<discarded>\nGET_ID\n");

	/* An error after a whole line belongs to whatever comes next. */
	running_console();
	deliver("GET_ID\r");
	hw.pending_error = 1;
	task_runs();
	CHECK_TEXT(lines_run, "GET_ID\n");
	deliver("NET\r");
	task_runs();
	CHECK_TEXT(lines_run, "GET_ID\n<discarded>\n");

	/* A CR and an LF on either side of a loss still count as one line ending. */
	running_console();
	deliver("GET_ID\r");
	hw.pending_error = 1;
	run_interrupts();
	deliver("\n");
	task_runs();
	deliver("NET\r");
	task_runs();
	CHECK_TEXT(lines_run, "GET_ID\n<discarded>\n");
}

static void test_a_full_receive_buffer_cannot_splice_two_lines(void)
{
	char lots[CONFIG_APP_CONSOLE_RX_BUFFER_SIZE + 40];

	/* Whole lines ahead of the gap run, and what is on either side of it does not join up. */
	running_console();
	deliver("GET_ID\r");
	memset(lots, 'x', sizeof(lots) - 1);
	lots[sizeof(lots) - 1] = '\0';
	deliver(lots);
	run_interrupts();
	CHECK(ring_buf_space_get(&rx_ring) == 0);
	CHECK(rx_lost);

	handle_input();
	CHECK_TEXT(lines_run, "GET_ID\n");

	/* Room again: the mark goes in before the next byte. */
	deliver("y\r");
	task_runs();
	CHECK(!rx_lost);
	CHECK_TEXT(lines_run, "GET_ID\n<discarded>\n");

	/* A command cut in two by the gap would be another command. */
	running_console();
	memset(lots, ' ', sizeof(lots) - 1);
	lots[sizeof(lots) - 1] = '\0';
	memcpy(lots + CONFIG_APP_CONSOLE_RX_BUFFER_SIZE - 3, "REB", 3);
	deliver(lots);
	run_interrupts();
	handle_input();
	deliver("OOT\r");
	task_runs();
	CHECK_TEXT(lines_run, "<discarded>\n");

	/* The next command is fine. */
	deliver("GET_ID\r");
	task_runs();
	CHECK_TEXT(lines_run, "<discarded>\nGET_ID\n");
}

static void test_no_password_stays_in_a_buffer(void)
{
	running_console();
	reader.echo = true;

	deliver("WIFI|net|" PASSWORD "\r");
	task_runs();
	run_interrupts();

	CHECK(strstr(hw.wire, PASSWORD) != NULL);
	CHECK(memmem(rx_storage, sizeof(rx_storage), PASSWORD, strlen(PASSWORD)) == NULL);
	CHECK(memmem(tx_storage, sizeof(tx_storage), PASSWORD, strlen(PASSWORD)) == NULL);

	for (size_t i = 0; i < sizeof(tx_storage); i++) {
		if (tx_storage[i] != 0) {
			failures++;
			printf("FAIL: byte %zu of the transmit buffer was not wiped\n", i);
			break;
		}
	}
	checks++;

	/* The part of a damaged line that was read already goes at once. */
	running_console();
	deliver("WIFI|net|" PASSWORD);
	task_runs();
	console_cmd_input_lost();
	CHECK(memmem(reader.line, sizeof(reader.line), PASSWORD, strlen(PASSWORD)) == NULL);
}

static int thirty_two(void *arg)
{
	return *(int *)arg + 32;
}

static void test_a_call_on_the_main_loop(void)
{
	int ten = 10;

	running_console();
	CHECK(console_port_on_main(thirty_two, &ten) == 42);
	CHECK_TEXT(console_port_reset_reason(), "reset pin");
	CHECK(console_port_free_heap() == 1234);
}

int main(void)
{
	test_log_lines_look_as_they_should();
	test_a_log_line_never_lands_in_a_reply();
	test_a_log_line_starts_under_a_half_typed_one();
	test_a_full_buffer_stalls_nobody_and_loses_no_reply();
	test_output_before_a_restart();
	test_input_during_the_boot_is_discarded();
	test_what_the_uart_still_holds_is_discarded_too();
	test_a_damaged_line_gets_one_error_and_the_next_line_runs();
	test_a_full_receive_buffer_cannot_splice_two_lines();
	test_no_password_stays_in_a_buffer();
	test_a_call_on_the_main_loop();

	printf("%d console output checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
