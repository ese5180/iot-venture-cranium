/*
 * Host build: the UART, the log core and the other things console.c stands on, for
 * test_console_output.c, which defines the functions and plays the part of the hardware.
 */
#ifndef HOST_STUB_HW_H_
#define HOST_STUB_HW_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include <zephyr/kernel.h>

struct device {
	int unused;
};
extern const struct device host_uart;
#define DT_CHOSEN(name)        0
#define DEVICE_DT_GET(node)    (&host_uart)
#define SYS_INIT(function, level, priority)
bool device_is_ready(const struct device *dev);

typedef void (*uart_irq_callback_user_data_t)(const struct device *dev, void *user_data);
int uart_irq_callback_user_data_set(const struct device *dev, uart_irq_callback_user_data_t cb,
				    void *user_data);
int uart_irq_update(const struct device *dev);
int uart_irq_rx_ready(const struct device *dev);
int uart_irq_tx_ready(const struct device *dev);
void uart_irq_rx_enable(const struct device *dev);
void uart_irq_rx_disable(const struct device *dev);
void uart_irq_tx_enable(const struct device *dev);
void uart_irq_tx_disable(const struct device *dev);
int uart_fifo_read(const struct device *dev, uint8_t *data, int size);
int uart_fifo_fill(const struct device *dev, const uint8_t *data, int size);
int uart_err_check(const struct device *dev);
void uart_poll_out(const struct device *dev, unsigned char byte);

#define RESET_PIN            (1u << 0)
#define RESET_SOFTWARE       (1u << 1)
#define RESET_BROWNOUT       (1u << 2)
#define RESET_WATCHDOG       (1u << 4)
#define RESET_DEBUG          (1u << 5)
#define RESET_LOW_POWER_WAKE (1u << 6)
#define RESET_CPU_LOCKUP     (1u << 7)
int hwinfo_get_reset_cause(uint32_t *cause);
int hwinfo_clear_reset_cause(void);

#define SYS_REBOOT_COLD 1
void sys_reboot(int type);

#define LOG_LEVEL_NONE 0
#define LOG_LEVEL_ERR  1
#define LOG_LEVEL_WRN  2
#define LOG_LEVEL_INF  3
#define LOG_LEVEL_DBG  4

void host_log_panic(void);
#define LOG_PANIC() host_log_panic()

struct log_msg {
	int16_t source;
	uint8_t domain;
	uint8_t level;
	/* Stands in for the package: what it says, formatted already. */
	const char *text;
	size_t data_length;
};

union log_msg_generic {
	struct log_msg log;
};

static inline int16_t log_msg_get_source_id(struct log_msg *message)
{
	return message->source;
}

static inline uint8_t log_msg_get_domain(struct log_msg *message)
{
	return message->domain;
}

static inline uint8_t log_msg_get_level(struct log_msg *message)
{
	return message->level;
}

static inline uint8_t *log_msg_get_package(struct log_msg *message, size_t *length)
{
	*length = strlen(message->text);
	return (uint8_t *)message->text;
}

static inline uint8_t *log_msg_get_data(struct log_msg *message, size_t *length)
{
	*length = message->data_length;
	return NULL;
}

const char *log_source_name_get(uint32_t domain, uint32_t source);

static inline int cbpprintf(int (*out)(int c, void *context), void *context, void *package)
{
	for (const char *c = package; *c != '\0'; c++) {
		out(*c, context);
	}

	return 0;
}

struct log_backend;
struct log_backend_api {
	void (*process)(const struct log_backend *const backend, union log_msg_generic *message);
	void (*dropped)(const struct log_backend *const backend, uint32_t count);
	void (*panic)(const struct log_backend *const backend);
	int (*is_ready)(const struct log_backend *const backend);
};
#define LOG_BACKEND_DEFINE(name, api, autostart)                                             \
	__attribute__((unused)) static const struct log_backend_api *const name = &(api)

struct ring_buf {
	uint8_t *data;
	uint32_t size;
	uint32_t start;
	uint32_t count;
};

static inline void ring_buf_init(struct ring_buf *ring, uint32_t size, uint8_t *data)
{
	ring->data = data;
	ring->size = size;
	ring->start = 0;
	ring->count = 0;
}

static inline uint32_t ring_buf_space_get(const struct ring_buf *ring)
{
	return ring->size - ring->count;
}

static inline uint32_t ring_buf_size_get(const struct ring_buf *ring)
{
	return ring->count;
}

static inline uint32_t ring_buf_put(struct ring_buf *ring, const uint8_t *data, uint32_t length)
{
	uint32_t taken = MIN(length, ring_buf_space_get(ring));

	for (uint32_t i = 0; i < taken; i++) {
		ring->data[(ring->start + ring->count + i) % ring->size] = data[i];
	}

	ring->count += taken;
	return taken;
}

/* As Zephyr's: a claim stops where the storage wraps around. */
static inline uint32_t ring_buf_get_claim(struct ring_buf *ring, uint8_t **data, uint32_t length)
{
	uint32_t contiguous = MIN(ring->count, ring->size - ring->start);

	*data = ring->data + ring->start;
	return MIN(length, contiguous);
}

static inline int ring_buf_get_finish(struct ring_buf *ring, uint32_t length)
{
	ring->start = (ring->start + length) % ring->size;
	ring->count -= length;
	return 0;
}

static inline uint32_t ring_buf_get(struct ring_buf *ring, uint8_t *data, uint32_t length)
{
	uint32_t taken = MIN(length, ring->count);

	for (uint32_t i = 0; i < taken; i++) {
		data[i] = ring->data[(ring->start + i) % ring->size];
	}

	ring_buf_get_finish(ring, taken);
	return taken;
}

struct sys_memory_stats {
	size_t free_bytes;
};
struct sys_heap {
	int unused;
};
struct k_heap {
	struct sys_heap heap;
};
int sys_heap_runtime_stats_get(struct sys_heap *heap, struct sys_memory_stats *stats);

#endif
