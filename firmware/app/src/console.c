/*
 * The console's hardware side: the UART, the task, transmit buffering and the log backend.
 *
 * Transmitting never stalls anybody. Everything goes through one ring buffer that an
 * interrupt drains, and only whole lines are put into it, under a spinlock. The console
 * task may wait for room, so a reply is never lost. Other threads never wait: a log line
 * that does not fit is dropped, and the next one that fits says how many were. Log lines
 * that arrive while a reply is going out are held back in a second buffer, so that they
 * do not end up between its lines.
 */

#include "console.h"

#include <errno.h>
#include <string.h>

#include <zephyr/device.h>
#include <zephyr/drivers/hwinfo.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/init.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log_backend.h>
#include <zephyr/logging/log_core.h>
#include <zephyr/logging/log_ctrl.h>
#include <zephyr/logging/log_msg.h>
#include <zephyr/sys/cbprintf.h>
#include <zephyr/sys/reboot.h>
#include <zephyr/sys/ring_buffer.h>
#include <zephyr/sys/sys_heap.h>

#include "app_events.h"
#include "console_cmd.h"
#include "console_port.h"

#define LINE_ENDING       "\r\n"
#define LINE_ENDING_SIZE  2
#define LOG_LINE_MAX      200
#define DROPPED_LINE_MAX  48
#define TICK_MS           1000
/* Long enough for the last byte on the wire: one byte at 115200 is 87 microseconds. */
#define BYTE_TIME_US      100
/* The most that one transmission holds: the UART driver's own buffer. */
#ifdef CONFIG_UART_0_NRF_TX_BUFFER_SIZE
#define UART_HANDED_OVER_MAX CONFIG_UART_0_NRF_TX_BUFFER_SIZE
#else
#define UART_HANDED_OVER_MAX 32
#endif
/* Goes into the receive buffer where bytes were lost. No command can hold a control character. */
#define RX_LOST_MARK      0x18
/* What has to stay quiet at boot before input counts, and how long that may take at most. */
#define RX_QUIET_MS       5
#define RX_QUIET_MAX_MS   100

/* The held lines go out in one piece, so they have to be able to fit. */
BUILD_ASSERT(CONFIG_APP_CONSOLE_LOG_HOLD_SIZE <= CONFIG_APP_CONSOLE_TX_BUFFER_SIZE,
	     "the log hold buffer must not be larger than the transmit buffer");

static const struct device *const uart = DEVICE_DT_GET(DT_CHOSEN(zephyr_console));

static uint8_t tx_storage[CONFIG_APP_CONSOLE_TX_BUFFER_SIZE];
static uint8_t held_storage[CONFIG_APP_CONSOLE_LOG_HOLD_SIZE];
static uint8_t rx_storage[CONFIG_APP_CONSOLE_RX_BUFFER_SIZE];
static struct ring_buf tx_ring;
static struct ring_buf held_ring;
static struct ring_buf rx_ring;

/* Guards tx_ring, held_ring and the flags below. Held only for a copy of one line. */
static struct k_spinlock tx_lock;
static struct k_spinlock rx_lock;
static K_SEM_DEFINE(tx_space, 0, 1);
static K_SEM_DEFINE(rx_ready, 0, 1);

static bool output_ready;
static bool tx_running;
/* Interrupts cannot be relied on any more: every byte goes out by polling. */
static bool polling;
/* A reply is under way: log lines are held back. */
static bool reply_open;
/* Echoed input is on screen without a line ending: a log line has to start a new line. */
static bool input_on_screen;
static uint32_t dropped_lines;
/* Input counts from here on. Until then the interrupt throws it away. Guarded by rx_lock. */
static bool rx_open;
/* Bytes were lost, and the mark for that is not in the receive buffer yet. Guarded by rx_lock. */
static bool rx_lost;
static atomic_t rx_thrown_away;

static K_THREAD_STACK_DEFINE(console_stack, CONFIG_APP_CONSOLE_STACK_SIZE);
static struct k_thread console_thread_data;

static uint32_t last_reset_cause;

/* ---- the interrupt -------------------------------------------------------------- */

/*
 * The mark goes where the loss happened, as soon as there is room. So everything before it
 * is whole, with its line ending, and everything after it up to the next line ending is
 * not: the bytes on either side of a gap can never join up into a command.
 */
static void place_loss_mark_locked(void)
{
	static const uint8_t mark = RX_LOST_MARK;

	if (rx_lost && ring_buf_put(&rx_ring, &mark, 1) == 1) {
		rx_lost = false;
	}
}

/* Called for transmit interrupts too, so this runs long before receiving is enabled. */
static void rx_interrupt(const struct device *dev)
{
	k_spinlock_key_t key = k_spin_lock(&rx_lock);
	uint8_t byte;

	while (uart_fifo_read(dev, &byte, 1) == 1) {
		if (!rx_open) {
			atomic_inc(&rx_thrown_away);
			continue;
		}

		place_loss_mark_locked();
		if (rx_lost || ring_buf_put(&rx_ring, &byte, 1) != 1) {
			rx_lost = true;
		}
	}

	/* An overrun or a framing error lost a byte that nobody will ever see. */
	if (uart_err_check(dev) != 0 && rx_open) {
		rx_lost = true;
	}

	place_loss_mark_locked();
	k_spin_unlock(&rx_lock, key);
	k_sem_give(&rx_ready);
}

static void tx_interrupt(const struct device *dev)
{
	k_spinlock_key_t key = k_spin_lock(&tx_lock);
	uint8_t *data;
	uint32_t length = ring_buf_get_claim(&tx_ring, &data, CONFIG_APP_CONSOLE_TX_BUFFER_SIZE);

	if (length == 0) {
		uart_irq_tx_disable(dev);
		tx_running = false;
	} else {
		int sent = uart_fifo_fill(dev, data, (int)length);

		/* Sent bytes can be echoed input, which can be a password. */
		memset(data, 0, (size_t)sent);
		(void)ring_buf_get_finish(&tx_ring, (uint32_t)sent);
	}

	k_spin_unlock(&tx_lock, key);
	k_sem_give(&tx_space);
}

static void uart_interrupt(const struct device *dev, void *user_data)
{
	ARG_UNUSED(user_data);

	if (!uart_irq_update(dev)) {
		return;
	}

	if (uart_irq_rx_ready(dev)) {
		rx_interrupt(dev);
	}

	if (uart_irq_tx_ready(dev)) {
		tx_interrupt(dev);
	}
}

/* ---- the single point where lines become output ---------------------------------- */

static void start_tx_locked(void)
{
	if (!tx_running && !polling) {
		tx_running = true;
		uart_irq_tx_enable(uart);
	}
}

static void poll_out(const char *text, size_t length)
{
	for (size_t i = 0; i < length; i++) {
		uart_poll_out(uart, text[i]);
	}

	k_busy_wait(BYTE_TIME_US);
}

static bool line_fits(struct ring_buf *ring, size_t length)
{
	return ring_buf_space_get(ring) >= length + LINE_ENDING_SIZE;
}

static void put_line_locked(struct ring_buf *ring, const char *text, size_t length)
{
	(void)ring_buf_put(ring, (const uint8_t *)text, (uint32_t)length);
	(void)ring_buf_put(ring, (const uint8_t *)LINE_ENDING, LINE_ENDING_SIZE);
}

/* A half-typed line is on screen. It stays as it is, and a line can start under it. */
static void leave_input_line_locked(void)
{
	if (input_on_screen && line_fits(&tx_ring, 0)) {
		(void)ring_buf_put(&tx_ring, (const uint8_t *)LINE_ENDING, LINE_ENDING_SIZE);
		input_on_screen = false;
	}
}

/* Move what was held back to where it goes out, all at once. Waits for room. */
static void release_held_lines(void)
{
	while (true) {
		k_spinlock_key_t key = k_spin_lock(&tx_lock);
		uint32_t held = ring_buf_size_get(&held_ring);

		if (polling || ring_buf_space_get(&tx_ring) >= held) {
			uint8_t *data;
			uint32_t length;

			while ((length = ring_buf_get_claim(&held_ring, &data, held)) > 0) {
				(void)ring_buf_put(&tx_ring, data, length);
				(void)ring_buf_get_finish(&held_ring, length);
			}

			reply_open = false;
			start_tx_locked();
			k_spin_unlock(&tx_lock, key);
			return;
		}

		k_spin_unlock(&tx_lock, key);
		(void)k_sem_take(&tx_space, K_MSEC(TICK_MS));
	}
}

void console_port_reply(const char *text, size_t length, bool final)
{
	while (true) {
		k_spinlock_key_t key = k_spin_lock(&tx_lock);

		if (polling) {
			k_spin_unlock(&tx_lock, key);
			poll_out(text, length);
			poll_out(LINE_ENDING, LINE_ENDING_SIZE);
			break;
		}

		/* From here on log lines wait, so they cannot use up the room this line needs. */
		reply_open = true;

		if (line_fits(&tx_ring, length)) {
			put_line_locked(&tx_ring, text, length);
			start_tx_locked();
			k_spin_unlock(&tx_lock, key);
			break;
		}

		k_spin_unlock(&tx_lock, key);
		(void)k_sem_take(&tx_space, K_MSEC(TICK_MS));
	}

	if (final) {
		release_held_lines();
	}
}

static void say_how_many_dropped_locked(void)
{
	char text[DROPPED_LINE_MAX];
	int length;

	if (dropped_lines == 0) {
		return;
	}

	length = snprintk(text, sizeof(text), "[CONSOLE] WRN: %u lines dropped",
			  (unsigned int)dropped_lines);
	if (line_fits(&tx_ring, (size_t)length)) {
		put_line_locked(&tx_ring, text, (size_t)length);
		dropped_lines = 0;
	}
}

void console_port_event(const char *text, size_t length)
{
	k_spinlock_key_t key;

	if (!output_ready) {
		return;
	}

	key = k_spin_lock(&tx_lock);

	if (polling) {
		k_spin_unlock(&tx_lock, key);
		poll_out(text, length);
		poll_out(LINE_ENDING, LINE_ENDING_SIZE);
		return;
	}

	if (reply_open) {
		if (line_fits(&held_ring, length)) {
			put_line_locked(&held_ring, text, length);
		} else {
			dropped_lines++;
		}
	} else {
		leave_input_line_locked();
		say_how_many_dropped_locked();

		if (line_fits(&tx_ring, length)) {
			put_line_locked(&tx_ring, text, length);
		} else {
			dropped_lines++;
		}

		start_tx_locked();
	}

	k_spin_unlock(&tx_lock, key);
}

void console_port_echo(const char *text, size_t length)
{
	while (true) {
		k_spinlock_key_t key = k_spin_lock(&tx_lock);

		if (polling) {
			k_spin_unlock(&tx_lock, key);
			poll_out(text, length);
			return;
		}

		if (ring_buf_space_get(&tx_ring) >= length) {
			(void)ring_buf_put(&tx_ring, (const uint8_t *)text, (uint32_t)length);
			input_on_screen = text[length - 1] != '\n';
			start_tx_locked();
			k_spin_unlock(&tx_lock, key);
			return;
		}

		k_spin_unlock(&tx_lock, key);
		(void)k_sem_take(&tx_space, K_MSEC(TICK_MS));
	}
}

/*
 * Before a restart, or in a fatal error, where interrupts may not come any more: what is
 * in the buffers goes out by polling, and so does everything after it. The main loop's
 * restarts come through here as well, because they all call LOG_PANIC() first.
 */
static void switch_to_polling(void)
{
	k_spinlock_key_t key = k_spin_lock(&tx_lock);
	uint8_t byte;

	polling = true;
	reply_open = false;
	uart_irq_tx_disable(uart);
	tx_running = false;
	k_spin_unlock(&tx_lock, key);

	while (ring_buf_get(&tx_ring, &byte, 1) == 1) {
		uart_poll_out(uart, byte);
	}

	while (ring_buf_get(&held_ring, &byte, 1) == 1) {
		uart_poll_out(uart, byte);
	}

	/*
	 * Nothing above waits for what the interrupt path has already handed to the UART: a
	 * short reply can sit there whole, with the rings empty, and a restart would cut it off.
	 */
	k_busy_wait(BYTE_TIME_US * (UART_HANDED_OVER_MAX + 1));
}

/* ---- the log backend ------------------------------------------------------------ */

static struct {
	char text[LOG_LINE_MAX + 1];
	size_t length;
	/* Where the message starts, behind the tag. */
	size_t start;
	bool truncated;
} log_line;

static void log_line_begin(const char *tag, uint8_t level)
{
	static const char *const marks[] = {
		[LOG_LEVEL_ERR] = "ERR: ",
		[LOG_LEVEL_WRN] = "WRN: ",
		[LOG_LEVEL_INF] = "",
		[LOG_LEVEL_DBG] = "DBG: ",
	};
	const char *mark = level < ARRAY_SIZE(marks) && marks[level] != NULL ? marks[level] : "";

	log_line.start = (size_t)snprintk(log_line.text, sizeof(log_line.text), "[%s] %s", tag, mark);
	log_line.length = log_line.start;
	log_line.truncated = false;
}

static void log_line_end(void)
{
	if (log_line.truncated) {
		strcpy(log_line.text + LOG_LINE_MAX - 3, "...");
		log_line.length = LOG_LINE_MAX;
	}

	if (log_line.length > log_line.start) {
		console_port_event(log_line.text, log_line.length);
	}

	log_line.length = log_line.start;
	log_line.truncated = false;
}

/* A message with line endings in it becomes several lines, each with its tag. */
static int log_line_char(int c, void *context)
{
	ARG_UNUSED(context);

	if (c == '\n') {
		log_line_end();
	} else if (c != '\r') {
		if (log_line.length < LOG_LINE_MAX) {
			log_line.text[log_line.length++] = (char)c;
		} else {
			log_line.truncated = true;
		}
	}

	return c;
}

static void backend_process(const struct log_backend *const backend,
			    union log_msg_generic *generic)
{
	struct log_msg *message = &generic->log;
	int16_t source = log_msg_get_source_id(message);
	const char *tag =
		source >= 0 ? log_source_name_get(log_msg_get_domain(message), source) : "printk";
	size_t package_length;
	size_t data_length;
	uint8_t *package = log_msg_get_package(message, &package_length);

	ARG_UNUSED(backend);

	(void)log_msg_get_data(message, &data_length);

	log_line_begin(tag, log_msg_get_level(message));

	if (package_length > 0) {
		(void)cbpprintf(log_line_char, NULL, package);
	}

	/* A hex dump is shown by its size only: it is not meant for a line-based console. */
	if (data_length > 0) {
		char note[24];
		int written = snprintk(note, sizeof(note), " (%u bytes)", (unsigned int)data_length);

		for (int i = 0; i < written; i++) {
			(void)log_line_char(note[i], NULL);
		}
	}

	log_line_end();
}

static void backend_dropped(const struct log_backend *const backend, uint32_t count)
{
	k_spinlock_key_t key = k_spin_lock(&tx_lock);

	ARG_UNUSED(backend);

	dropped_lines += count;
	k_spin_unlock(&tx_lock, key);
}

static void backend_panic(const struct log_backend *const backend)
{
	ARG_UNUSED(backend);

	switch_to_polling();
}

static int backend_is_ready(const struct log_backend *const backend)
{
	ARG_UNUSED(backend);

	return output_ready ? 0 : -EBUSY;
}

static const struct log_backend_api backend_api = {
	.process = backend_process,
	.dropped = backend_dropped,
	.panic = backend_panic,
	.is_ready = backend_is_ready,
};

LOG_BACKEND_DEFINE(console_log_backend, backend_api, true);

/* ---- the rest of what the command code needs ------------------------------------- */

struct main_call {
	int (*function)(void *arg);
	void *arg;
	int result;
};

static struct main_call main_call;
static K_SEM_DEFINE(main_call_done, 0, 1);

static void run_main_call(void)
{
	main_call.result = main_call.function(main_call.arg);
	k_sem_give(&main_call_done);
}

int console_port_on_main(int (*function)(void *arg), void *arg)
{
	const struct app_event event = {
		.type = APP_EVENT_CALL,
		.call.function = run_main_call,
	};

	main_call.function = function;
	main_call.arg = arg;

	/* The event queue can be full for a moment. */
	while (app_event_post(&event) != 0) {
		k_msleep(10);
	}

	/*
	 * Without a limit: if the main loop hangs, the watchdog restarts the board. A limit
	 * would leave the main loop working with arguments that have gone out of scope.
	 */
	(void)k_sem_take(&main_call_done, K_FOREVER);
	return main_call.result;
}

void console_port_reboot(void)
{
	LOG_PANIC();
	sys_reboot(SYS_REBOOT_COLD);
}

void console_port_before_init_flag(void)
{
	if (IS_ENABLED(CONFIG_APP_TEST_FAULT_INIT_POWER_LOSS)) {
		console_event("CONSOLE", "test image: losing power before the init flag");
		console_port_reboot();
	}
}

int64_t console_port_uptime_ms(void)
{
	return k_uptime_get();
}

size_t console_port_free_heap(void)
{
	extern struct k_heap _system_heap;
	struct sys_memory_stats stats = { 0 };

	(void)sys_heap_runtime_stats_get(&_system_heap.heap, &stats);
	return stats.free_bytes;
}

const char *console_port_reset_reason(void)
{
	static const struct {
		uint32_t cause;
		const char *name;
	} reasons[] = {
		{ RESET_WATCHDOG, "watchdog" },
		{ RESET_CPU_LOCKUP, "CPU lockup" },
		{ RESET_SOFTWARE, "software" },
		{ RESET_PIN, "reset pin" },
		{ RESET_DEBUG, "debugger" },
		{ RESET_BROWNOUT, "brownout" },
		{ RESET_LOW_POWER_WAKE, "wake from off" },
	};

	for (size_t i = 0; i < ARRAY_SIZE(reasons); i++) {
		if (last_reset_cause & reasons[i].cause) {
			return reasons[i].name;
		}
	}

	return "power-on";
}

/* ---- the task ------------------------------------------------------------------- */

/*
 * Whatever was sent during the boot is not a command for this boot. The UART still holds
 * some of it, and hands it over a byte at a time, so input counts once the line has been
 * quiet for a moment. If it does not get quiet, what comes next is the rest of a line whose
 * start is gone, which is what a loss is.
 */
static void discard_boot_input(void)
{
	atomic_val_t seen;
	int waited = 0;
	k_spinlock_key_t key;

	uart_irq_rx_enable(uart);

	do {
		seen = atomic_get(&rx_thrown_away);
		k_msleep(RX_QUIET_MS);
		waited += RX_QUIET_MS;
	} while (atomic_get(&rx_thrown_away) != seen && waited < RX_QUIET_MAX_MS);

	key = k_spin_lock(&rx_lock);
	rx_open = true;
	rx_lost = atomic_get(&rx_thrown_away) != seen;
	k_spin_unlock(&rx_lock, key);
}

static void take_one_byte(char *byte, bool *got_one)
{
	k_spinlock_key_t key = k_spin_lock(&rx_lock);
	uint8_t *data;

	*got_one = ring_buf_get_claim(&rx_ring, &data, 1) == 1;
	if (*got_one) {
		*byte = (char)*data;
		*data = 0;
		(void)ring_buf_get_finish(&rx_ring, 1);
	}

	k_spin_unlock(&rx_lock, key);
}

static void handle_input(void)
{
	char byte;
	bool got_one;

	take_one_byte(&byte, &got_one);
	while (got_one) {
		if (byte == RX_LOST_MARK) {
			console_cmd_input_lost();
		} else {
			console_cmd_feed(byte);
		}

		take_one_byte(&byte, &got_one);
	}
}

static void console_thread(void *a, void *b, void *c)
{
	ARG_UNUSED(a);
	ARG_UNUSED(b);
	ARG_UNUSED(c);

	console_cmd_init();
	console_cmd_boot_box();
	discard_boot_input();

	while (true) {
		(void)k_sem_take(&rx_ready, K_MSEC(TICK_MS));
		console_cmd_tick();
		handle_input();
	}
}

void console_start(void)
{
	if (!output_ready) {
		return;
	}

	k_thread_create(&console_thread_data, console_stack, K_THREAD_STACK_SIZEOF(console_stack),
			console_thread, NULL, NULL, NULL,
			K_PRIO_PREEMPT(CONFIG_APP_CONSOLE_THREAD_PRIORITY), 0, K_NO_WAIT);
	(void)k_thread_name_set(&console_thread_data, "console");
}

/* As early as the log core starts, so that the log has somewhere to go from the start. */
static int console_output_init(void)
{
	if (!device_is_ready(uart)) {
		return -ENODEV;
	}

	ring_buf_init(&tx_ring, sizeof(tx_storage), tx_storage);
	ring_buf_init(&held_ring, sizeof(held_storage), held_storage);
	ring_buf_init(&rx_ring, sizeof(rx_storage), rx_storage);

	if (hwinfo_get_reset_cause(&last_reset_cause) == 0) {
		(void)hwinfo_clear_reset_cause();
	}

	uart_irq_rx_disable(uart);
	uart_irq_tx_disable(uart);
	(void)uart_irq_callback_user_data_set(uart, uart_interrupt, NULL);
	output_ready = true;
	return 0;
}

SYS_INIT(console_output_init, POST_KERNEL, 0);
